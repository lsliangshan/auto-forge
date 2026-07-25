import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApplicationRuntime, MaintenanceGate } from './application.js'
import { openAppDatabase } from './database/client.js'
import { SecretStore } from './security/secret-store.js'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('createApplicationRuntime', () => {
  it('stores provider credentials separately and routes new chats to the active provider default', async () => {
    const root = await mkdtemp(join(tmpdir(), 'autoforge-application-'))
    directories.push(root)
    const openrouter = {
      listModels: vi.fn(async () => [{ id: 'openrouter/model', name: 'OpenRouter model' }]),
      validateCredential: vi.fn(async () => ({ valid: true })),
      stream: vi.fn(async function* () {
        yield { type: 'finish' as const, choiceIndex: 0, reason: 'stop' }
      }),
    }
    const deepseek = {
      listModels: vi.fn(async () => [{ id: 'deepseek-v4-flash', name: 'deepseek-v4-flash' }]),
      validateCredential: vi.fn(async () => ({ valid: true })),
      stream: vi.fn(async function* () {
        yield { type: 'finish' as const, choiceIndex: 0, reason: 'stop' }
      }),
    }
    const runtime = createApplicationRuntime({
      paths: {
        database: join(root, 'autoforge.sqlite'), data: root, logs: join(root, 'logs'),
        projects: join(root, 'projects'), installations: join(root, 'workflows'),
        workflowRunner: join(root, 'workflow-runner.cjs'), temporary: root,
      },
      safeStorage: {
        isAvailable: async () => true,
        encrypt: async (value) => Buffer.from(value),
        decrypt: async (value) => ({ value: value.toString(), shouldReEncrypt: false }),
      },
      modelProviders: { openrouter, deepseek },
      chooseProjectDirectory: async () => undefined,
      openExternal: async () => undefined,
      emitChat: vi.fn(),
      emitExecution: vi.fn(),
      browserRuntime: { packaged: false },
    })

    await expect(runtime.services.settings.get()).resolves.toMatchObject({
      activeProvider: 'deepseek',
      defaultModels: {
        deepseek: { text: 'deepseek-v4-flash' },
        openrouter: { text: 'openai/gpt-4.1-mini' },
      },
    })
    await runtime.services.settings.saveProviderApiKey('openrouter', 'sk-openrouter')
    await runtime.services.settings.saveProviderApiKey('deepseek', 'sk-deepseek')
    await runtime.services.settings.update({ activeProvider: 'deepseek' })
    await expect(runtime.services.settings.listProviderModels('deepseek')).resolves.toEqual([
      { id: 'deepseek-v4-flash', name: 'deepseek-v4-flash' },
    ])

    const conversation = await runtime.services.chat.createConversation()
    await runtime.services.chat.send({ conversationId: conversation.id, content: 'hello' })
    await vi.waitFor(() => expect(deepseek.stream).toHaveBeenCalled())
    expect(openrouter.stream).not.toHaveBeenCalled()
    expect(deepseek.stream).toHaveBeenCalledWith(expect.objectContaining({
      model: 'deepseek-v4-flash',
    }))

    await runtime.services.settings.clearProviderApiKey('deepseek')
    await expect(runtime.services.settings.validateProviderCredential('deepseek'))
      .resolves.toMatchObject({ provider: 'deepseek', configured: false, validation: 'unchecked' })
    await expect(runtime.services.settings.validateProviderCredential('openrouter'))
      .resolves.toMatchObject({ provider: 'openrouter', configured: true, validation: 'valid' })
    openrouter.validateCredential.mockRejectedValueOnce({
      code: 'MODEL_PROVIDER_ACCESS_DENIED',
      message: 'The model provider denied access.',
    })
    await expect(runtime.services.settings.validateProviderCredential('openrouter'))
      .resolves.toMatchObject({ provider: 'openrouter', configured: true, validation: 'denied' })
    await runtime.close()
  })

  it('persists both provider credentials in the local database across a restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'autoforge-application-'))
    directories.push(root)
    const openrouter = {
      listModels: vi.fn(async () => []),
      validateCredential: vi.fn(async () => ({ valid: true })),
      stream: vi.fn(async function* () {
        yield { type: 'finish' as const, choiceIndex: 0, reason: 'stop' }
      }),
    }
    const deepseek = {
      listModels: vi.fn(async () => []),
      validateCredential: vi.fn(async () => ({ valid: true })),
      stream: vi.fn(async function* () {
        yield { type: 'finish' as const, choiceIndex: 0, reason: 'stop' }
      }),
    }
    const options: Parameters<typeof createApplicationRuntime>[0] = {
      paths: {
        database: join(root, 'autoforge.sqlite'), data: root, logs: join(root, 'logs'),
        projects: join(root, 'projects'), installations: join(root, 'workflows'),
        workflowRunner: join(root, 'workflow-runner.cjs'), temporary: root,
      },
      safeStorage: {
        isAvailable: async () => true,
        encrypt: async (value) => Buffer.from(`encrypted:${value}`),
        decrypt: async (value) => ({
          value: value.toString().replace(/^encrypted:/, ''),
          shouldReEncrypt: false,
        }),
      },
      modelProviders: { openrouter, deepseek },
      chooseProjectDirectory: async () => undefined,
      openExternal: async () => undefined,
      emitChat: vi.fn(),
      emitExecution: vi.fn(),
      browserRuntime: { packaged: false },
    }
    const runtime = createApplicationRuntime(options)
    await runtime.services.settings.saveProviderApiKey('openrouter', 'sk-openrouter')
    await runtime.services.settings.saveProviderApiKey('deepseek', 'sk-deepseek')
    await runtime.close()

    const database = openAppDatabase(options.paths.database)
    const secretStore = new SecretStore(database.encryptedSecrets, options.safeStorage)
    await expect(secretStore.get('openrouter_api_key')).resolves.toBe('sk-openrouter')
    await expect(secretStore.get('deepseek_api_key')).resolves.toBe('sk-deepseek')
    database.close()

    const restarted = createApplicationRuntime(options)
    await expect(restarted.services.settings.validateProviderCredential('openrouter'))
      .resolves.toMatchObject({ provider: 'openrouter', configured: true, validation: 'valid' })
    await expect(restarted.services.settings.validateProviderCredential('deepseek'))
      .resolves.toMatchObject({ provider: 'deepseek', configured: true, validation: 'valid' })
    await restarted.close()
  })

  it('reports local credential persistence without waiting for online validation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'autoforge-application-'))
    directories.push(root)
    const validation = new Promise<{ valid: boolean }>(() => undefined)
    const deepseek = {
      listModels: vi.fn(async () => []),
      validateCredential: vi.fn(() => validation),
      stream: vi.fn(async function* () {
        yield { type: 'finish' as const, choiceIndex: 0, reason: 'stop' }
      }),
    }
    const runtime = createApplicationRuntime({
      paths: {
        database: join(root, 'autoforge.sqlite'), data: root, logs: join(root, 'logs'),
        projects: join(root, 'projects'), installations: join(root, 'workflows'),
        workflowRunner: join(root, 'workflow-runner.cjs'), temporary: root,
      },
      safeStorage: {
        isAvailable: async () => true,
        encrypt: async (value) => Buffer.from(`encrypted:${value}`),
        decrypt: async (value) => ({
          value: value.toString().replace(/^encrypted:/, ''),
          shouldReEncrypt: false,
        }),
      },
      modelProviders: {
        deepseek,
        openrouter: {
          listModels: vi.fn(async () => []),
          validateCredential: vi.fn(async () => ({ valid: true })),
          stream: vi.fn(async function* () {
            yield { type: 'finish' as const, choiceIndex: 0, reason: 'stop' }
          }),
        },
      },
      chooseProjectDirectory: async () => undefined,
      openExternal: async () => undefined,
      emitChat: vi.fn(),
      emitExecution: vi.fn(),
      browserRuntime: { packaged: false },
    })
    let status: Awaited<ReturnType<typeof runtime.services.settings.saveProviderApiKey>> | undefined
    void runtime.services.settings.saveProviderApiKey('deepseek', 'sk-deepseek')
      .then((value) => { status = value })

    await vi.waitFor(() => expect(status).toEqual({
      provider: 'deepseek',
      configured: true,
      validation: 'unchecked',
    }))
    expect(deepseek.validateCredential).not.toHaveBeenCalled()
    await runtime.close()
  })

  it('composes real persistence-backed DesktopAPI services and recovers before use', async () => {
    const root = await mkdtemp(join(tmpdir(), 'autoforge-application-'))
    directories.push(root)
    const openExternal = vi.fn().mockResolvedValue(undefined)
    const chatEvents: Array<{ type: string; status?: string }> = []
    const runtime = createApplicationRuntime({
      paths: {
        database: join(root, 'autoforge.sqlite'), data: root, logs: join(root, 'logs'),
        projects: join(root, 'projects'), installations: join(root, 'workflows'),
        workflowRunner: join(root, 'workflow-runner.cjs'), temporary: root,
      },
      safeStorage: {
        isAvailable: async () => true,
        encrypt: async (value) => Buffer.from(value),
        decrypt: async (value) => ({ value: value.toString(), shouldReEncrypt: false }),
      },
      openRouter: {
        listModels: async () => [],
        validateCredential: async () => ({ valid: true }),
        stream: async function* () { yield { type: 'finish' as const, choiceIndex: 0, reason: 'stop' } },
      },
      chooseProjectDirectory: async () => undefined,
      openExternal,
      emitChat: (event) => { chatEvents.push(event) },
      emitExecution: vi.fn(),
      browserRuntime: { packaged: false },
    })

    await runtime.recover()
    await runtime.services.settings.update({ activeProvider: 'openrouter' })
    const conversation = await runtime.services.chat.createConversation()
    expect(await runtime.services.chat.listConversations()).toEqual([conversation])
    expect(await runtime.services.chat.listMessages(conversation.id)).toEqual([])
    expect(await runtime.services.chat.renameConversation(conversation.id, 'Renamed')).toMatchObject({ title: 'Renamed' })
    await runtime.services.chat.send({ conversationId: conversation.id, content: 'persist me' })
    for (let index = 0; index < 30 && !chatEvents.some((event) => event.status === 'completed'); index += 1) await Promise.resolve()
    expect(await runtime.services.chat.listMessages(conversation.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'user', blocks: [{ type: 'text', text: 'persist me' }] }),
      expect.objectContaining({ role: 'assistant' }),
    ]))
    expect(await runtime.services.settings.saveProviderApiKey('openrouter', 'sk-local'))
      .toMatchObject({ provider: 'openrouter', configured: true, validation: 'unchecked' })
    const longNameProject = await runtime.services.developer.createProject(`${'a'.repeat(47)} b`)
    expect(longNameProject.name).toBe(`${'a'.repeat(47)} b`)
    await mkdir(join(longNameProject.rootPath, 'node_modules/private-package'), { recursive: true })
    await writeFile(join(longNameProject.rootPath, 'node_modules/private-package/index.js'), 'generated dependency')
    expect(await runtime.services.developer.listProjects()).toEqual([
      expect.objectContaining({ id: longNameProject.id, files: expect.arrayContaining(['src/index.ts', 'workflow.json']) }),
    ])
    expect((await runtime.services.developer.listProjects())[0]?.files.some((file) => file.startsWith('node_modules/'))).toBe(false)
    const manifest = JSON.parse(await runtime.services.developer.readFile(longNameProject.id, 'workflow.json')) as Record<string, unknown>
    manifest.inputSchema = {
      type: 'object', additionalProperties: false, required: ['keyword'],
      properties: { keyword: { type: 'string', minLength: 1 } },
    }
    await runtime.services.developer.writeFile(longNameProject.id, 'workflow.json', JSON.stringify(manifest))
    await expect(runtime.services.developer.run({ projectId: longNameProject.id, input: {} }))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await runtime.services.system.openExternal('https://example.com/')
    expect(openExternal).toHaveBeenCalledWith('https://example.com/')

    for (const domain of ['chat', 'workflows', 'developer', 'executions', 'permissions', 'settings', 'system'] as const) {
      expect(Object.values(runtime.services[domain]).every((member) => typeof member === 'function')).toBe(true)
    }
    await runtime.close()

    const restarted = createApplicationRuntime({
      paths: {
        database: join(root, 'autoforge.sqlite'), data: root, logs: join(root, 'logs'),
        projects: join(root, 'projects'), installations: join(root, 'workflows'),
        workflowRunner: join(root, 'workflow-runner.cjs'), temporary: root,
      },
      safeStorage: {
        isAvailable: async () => true,
        encrypt: async (value) => Buffer.from(value),
        decrypt: async (value) => ({ value: value.toString(), shouldReEncrypt: false }),
      },
      openRouter: {
        listModels: async () => [], validateCredential: async () => ({ valid: true }),
        stream: async function* () { yield { type: 'finish' as const, choiceIndex: 0, reason: 'stop' } },
      },
      chooseProjectDirectory: async () => undefined,
      openExternal,
      emitChat: vi.fn(), emitExecution: vi.fn(), browserRuntime: { packaged: false },
    })
    await restarted.recover()
    expect(await restarted.services.chat.listMessages(conversation.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'user', blocks: [{ type: 'text', text: 'persist me' }] }),
    ]))
    await restarted.close()
  })

  it('rejects conversation cleanup during a streaming chat and succeeds after terminalization', async () => {
    const root = await mkdtemp(join(tmpdir(), 'autoforge-application-'))
    directories.push(root)
    let finishStream!: () => void
    const streamFinished = new Promise<void>((resolve) => { finishStream = resolve })
    const chatEvents: Array<{ type: string; status?: string }> = []
    const runtime = createApplicationRuntime({
      paths: {
        database: join(root, 'autoforge.sqlite'), data: root, logs: join(root, 'logs'),
        projects: join(root, 'projects'), installations: join(root, 'workflows'),
        workflowRunner: join(root, 'workflow-runner.cjs'), temporary: root,
      },
      safeStorage: {
        isAvailable: async () => true,
        encrypt: async (value) => Buffer.from(value),
        decrypt: async (value) => ({ value: value.toString(), shouldReEncrypt: false }),
      },
      openRouter: {
        listModels: async () => [], validateCredential: async () => ({ valid: true }),
        stream: async function* () {
          await streamFinished
          yield { type: 'finish' as const, choiceIndex: 0, reason: 'stop' }
        },
      },
      chooseProjectDirectory: async () => undefined,
      openExternal: async () => undefined,
      emitChat: (event) => { chatEvents.push(event) },
      emitExecution: vi.fn(),
      browserRuntime: { packaged: false },
    })
    await runtime.services.settings.update({ activeProvider: 'openrouter' })
    const conversation = await runtime.services.chat.createConversation()
    await runtime.services.chat.send({ conversationId: conversation.id, content: 'hello' })

    await expect(runtime.services.settings.clearLocalData('conversations'))
      .rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(runtime.services.workflows.remove('workflow.active', '1.0.0'))
      .rejects.toMatchObject({ code: 'CONFLICT' })
    expect(await runtime.services.chat.listConversations()).toHaveLength(1)

    finishStream()
    for (let index = 0; index < 20 && !chatEvents.some((event) => event.status === 'completed'); index += 1) {
      await Promise.resolve()
    }
    await runtime.services.settings.clearLocalData('conversations')
    expect(await runtime.services.chat.listConversations()).toEqual([])
    await runtime.close()
  })

  it('atomically excludes maintenance from starts and active execution or browser work', () => {
    const gate = new MaintenanceGate()
    const releaseStart = gate.beginStart()
    const clear = vi.fn()
    expect(() => gate.clearLocalData(() => false, clear)).toThrow(expect.objectContaining({ code: 'CONFLICT' }))
    expect(clear).not.toHaveBeenCalled()
    releaseStart()

    let executionActive = true
    let browserActive = true
    expect(() => gate.clearLocalData(() => executionActive || browserActive, clear))
      .toThrow(expect.objectContaining({ code: 'CONFLICT' }))
    expect(clear).not.toHaveBeenCalled()

    executionActive = false
    browserActive = false
    gate.clearLocalData(() => false, () => {
      expect(() => gate.beginStart()).toThrow(expect.objectContaining({ code: 'CONFLICT' }))
      clear()
    })
    expect(clear).toHaveBeenCalledTimes(1)
  })

  it('keeps a removal-style exclusive operation atomic against a new start', async () => {
    const gate = new MaintenanceGate()
    let finish!: () => void
    const operation = gate.runExclusive(() => false, () => new Promise<void>((resolve) => { finish = resolve }))
    expect(() => gate.beginStart()).toThrow(expect.objectContaining({ code: 'CONFLICT' }))
    finish()
    await operation
    const release = gate.beginStart()
    release()
  })

  it('runs the exact development project even when an installed workflow has the same identity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'autoforge-application-'))
    directories.push(root)
    const runtime = createApplicationRuntime({
      paths: {
        database: join(root, 'autoforge.sqlite'), data: root, logs: join(root, 'logs'),
        projects: join(root, 'projects'), installations: join(root, 'workflows'),
        workflowRunner: join(import.meta.dirname, '../workers/workflow-runner.ts'), temporary: root,
      },
      safeStorage: {
        isAvailable: async () => true,
        encrypt: async (value) => Buffer.from(value),
        decrypt: async (value) => ({ value: value.toString(), shouldReEncrypt: false }),
      },
      openRouter: {
        listModels: async () => [], validateCredential: async () => ({ valid: true }),
        stream: async function* () { yield { type: 'finish' as const, choiceIndex: 0, reason: 'stop' } },
      },
      chooseProjectDirectory: async () => undefined,
      openExternal: async () => undefined,
      emitChat: vi.fn(), emitExecution: vi.fn(), browserRuntime: { packaged: false },
    })
    const installedProject = await runtime.services.developer.createProject('Installed Debug Source')
    const selectedProject = await runtime.services.developer.createProject('Selected Debug Source')
    for (const [projectId, marker] of [[installedProject.id, 'installed'], [selectedProject.id, 'selected']] as const) {
      const manifest = JSON.parse(await runtime.services.developer.readFile(projectId, 'workflow.json')) as Record<string, unknown>
      Object.assign(manifest, { id: 'debug.same-identity', version: '1.0.0', permissions: [] })
      await runtime.services.developer.writeFile(projectId, 'workflow.json', `${JSON.stringify(manifest, null, 2)}\n`)
      await runtime.services.developer.writeFile(projectId, 'src/index.ts', [
        "import { defineWorkflow } from '@autoforge/workflow-sdk'",
        `export default defineWorkflow({ async run() { return { marker: '${marker}' } } })`,
      ].join('\n'))
    }
    await runtime.services.developer.build(installedProject.id)
    await runtime.services.workflows.installProject(installedProject.id)

    const { executionId } = await runtime.services.developer.run({ projectId: selectedProject.id, input: {} })
    let execution = await runtime.services.executions.get(executionId)
    for (let attempt = 0; attempt < 100 && !['completed', 'failed', 'cancelled'].includes(execution.status); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10))
      execution = await runtime.services.executions.get(executionId)
    }

    expect(execution.status).toBe('completed')
    expect(execution.output).toEqual({ marker: 'selected' })
    await runtime.close()
  })
})
