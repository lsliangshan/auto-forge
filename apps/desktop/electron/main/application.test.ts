import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChatSendInput, ModelInfo } from '@autoforge/shared'
import { createApplicationRuntime, MaintenanceGate } from './application.js'
import type { ModelStreamRequest } from './chat/model-provider.js'
import { openAppDatabase } from './database/client.js'
import { SecretStore } from './security/secret-store.js'

const directories: string[] = []

function chatInput(conversationId: string, content: string): ChatSendInput {
  return {
    conversationId,
    content,
    assetIds: [],
    outputType: 'auto',
    generation: {
      image: { count: 1, resolution: '1K', aspectRatio: 'auto', format: 'png' },
      audio: { format: 'mp3' },
      video: { durationSeconds: 5, resolution: '720p', aspectRatio: 'auto', generateAudio: false },
    },
  }
}

function modelInfo(id: string, name: string): ModelInfo {
  return { id, name, inputModalities: ['text'], outputModalities: ['text'], supportsTools: false, generation: {} }
}

function imageModelInfo(id: string): ModelInfo {
  return {
    id,
    name: id,
    inputModalities: ['text', 'image'],
    outputModalities: ['image'],
    supportsTools: false,
    generation: {
      image: {
        resolutions: ['1K'],
        aspectRatios: ['auto'],
        formats: ['png'],
        maxCount: 1,
      },
    },
  }
}

function audioModelInfo(id: string): ModelInfo {
  return {
    id,
    name: id,
    inputModalities: ['text', 'audio'],
    outputModalities: ['audio'],
    supportsTools: false,
    generation: { audio: { voices: [], formats: ['mp3'] } },
  }
}

function videoModelInfo(id: string): ModelInfo {
  return {
    id,
    name: id,
    inputModalities: ['text', 'image'],
    outputModalities: ['video'],
    supportsTools: false,
    generation: {
      video: {
        resolutions: ['720p'],
        aspectRatios: ['auto'],
        durations: [5],
        supportsAudio: false,
      },
    },
  }
}

function visionTextModelInfo(id: string): ModelInfo {
  return {
    ...modelInfo(id, id),
    inputModalities: ['text', 'image'],
    supportsTools: true,
  }
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('createApplicationRuntime', () => {
  it('keeps media paths in main while using explicit media ports and exact conversation preferences', async () => {
    const root = await mkdtemp(join(tmpdir(), 'autoforge-application-media-'))
    directories.push(root)
    const source = join(root, 'private-source.png')
    const copied = join(root, 'copied.png')
    const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('payload')])
    await writeFile(source, png)
    const chooseMediaFiles = vi.fn<(remainingSlots: number) => Promise<string[]>>(async () => [])
    const chooseMediaSavePath = vi.fn(async () => copied)
    const revealPath = vi.fn()
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
      chooseProjectDirectory: async () => undefined,
      chooseMediaFiles,
      readClipboardImage: () => ({ bytes: png, mimeType: 'image/png', name: 'clipboard.png' }),
      chooseMediaSavePath,
      revealPath,
      openExternal: async () => undefined,
      emitChat: vi.fn(), emitExecution: vi.fn(), browserRuntime: { packaged: false },
    })
    const conversation = await runtime.services.chat.createConversation()
    expect(await runtime.services.chat.getGenerationPreferences(conversation.id)).toMatchObject({
      outputType: 'auto', models: {},
    })
    const preferences = {
      outputType: 'image' as const, models: { image: 'image-model' },
      generation: {
        image: { count: 1, resolution: '1K', aspectRatio: 'auto', format: 'png' },
        audio: { format: 'mp3' },
        video: { durationSeconds: 5, resolution: '720p', aspectRatio: 'auto', generateAudio: false },
      },
    } as const
    await expect(runtime.services.chat.updateGenerationPreferences(conversation.id, preferences)).resolves.toEqual(preferences)
    await expect(runtime.services.media.pickFiles({ conversationId: conversation.id, existingAssetIds: [] })).resolves.toEqual([])
    chooseMediaFiles.mockResolvedValueOnce([source])
    const [picked] = await runtime.services.media.pickFiles({ conversationId: conversation.id, existingAssetIds: [] })
    const [clipboard] = await runtime.services.media.importClipboardImage({ conversationId: conversation.id, existingAssetIds: [picked!.id] })
    expect(JSON.stringify([picked, clipboard])).not.toContain(root)
    await runtime.services.media.saveCopy(picked!.id)
    await runtime.services.media.reveal(picked!.id)
    expect(chooseMediaSavePath).toHaveBeenCalledWith(picked!.name)
    expect(revealPath).toHaveBeenCalledWith(expect.stringContaining(`${conversation.id}/`))
    await expect(runtime.services.media.saveCopy('missing_asset')).rejects.toMatchObject({ code: 'MEDIA_ASSET_UNAVAILABLE' })
    await runtime.close()
  })

  it('stores provider credentials separately and routes new chats to the active provider default', async () => {
    const root = await mkdtemp(join(tmpdir(), 'autoforge-application-'))
    directories.push(root)
    const openrouter = {
      listModels: vi.fn(async () => [
        modelInfo('openrouter/model', 'OpenRouter model'),
        modelInfo('openrouter/text-default', 'OpenRouter text default'),
      ]),
      validateCredential: vi.fn(async () => ({ valid: true })),
      stream: vi.fn(async function* () {
        yield { type: 'finish' as const, choiceIndex: 0, reason: 'stop' }
      }),
    }
    const deepseek = {
      listModels: vi.fn(async () => [modelInfo('deepseek-v4-flash', 'deepseek-v4-flash')]),
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
      chooseMediaFiles: async () => [],
      readClipboardImage: () => undefined,
      chooseMediaSavePath: async () => undefined,
      revealPath: () => undefined,
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
      modelInfo('deepseek-v4-flash', 'deepseek-v4-flash'),
    ])

    const conversation = await runtime.services.chat.createConversation()
    await runtime.services.chat.send(chatInput(conversation.id, 'hello'))
    await vi.waitFor(() => expect(deepseek.stream).toHaveBeenCalled())
    expect(openrouter.stream).not.toHaveBeenCalled()
    expect(deepseek.stream).toHaveBeenCalledWith(expect.objectContaining({
      model: 'deepseek-v4-flash',
    }))

    const currentSettings = await runtime.services.settings.get()
    await runtime.services.settings.update({
      activeProvider: 'openrouter',
      defaultModels: {
        ...currentSettings.defaultModels,
        openrouter: { text: 'openrouter/text-default' },
      },
    })
    const openRouterConversation = await runtime.services.chat.createConversation()
    await runtime.services.chat.send(chatInput(openRouterConversation.id, 'hello from OpenRouter'))
    await vi.waitFor(() => expect(openrouter.stream).toHaveBeenCalled())
    expect(openrouter.stream).toHaveBeenCalledWith(expect.objectContaining({
      model: 'openrouter/text-default',
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

  it('sends only same-conversation history to the second text turn without changing chat send output', async () => {
    const root = await mkdtemp(join(tmpdir(), 'autoforge-application-context-history-'))
    directories.push(root)
    const captured: ModelStreamRequest[] = []
    const stream = vi.fn(async function* (request: ModelStreamRequest) {
      captured.push(request)
      if (captured.length === 1) {
        yield { type: 'text_delta' as const, choiceIndex: 0, text: '第一轮回答' }
      }
      yield { type: 'finish' as const, choiceIndex: 0, reason: 'stop' }
    })
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
      modelProviders: {
        openrouter: {
          listModels: vi.fn(async () => [{ ...modelInfo('openrouter/context', 'Context model'), contextLength: 128_000 }]),
          validateCredential: vi.fn(async () => ({ valid: true })),
          stream,
        },
      },
      chooseProjectDirectory: async () => undefined,
      chooseMediaFiles: async () => [],
      readClipboardImage: () => undefined,
      chooseMediaSavePath: async () => undefined,
      revealPath: () => undefined,
      openExternal: async () => undefined,
      emitChat: vi.fn(),
      emitExecution: vi.fn(),
      browserRuntime: { packaged: false },
    })
    await runtime.services.settings.saveProviderApiKey('openrouter', 'sk-openrouter')
    const settings = await runtime.services.settings.get()
    await runtime.services.settings.update({
      activeProvider: 'openrouter',
      defaultModels: { ...settings.defaultModels, openrouter: { text: 'openrouter/context' } },
    })

    const conversation = await runtime.services.chat.createConversation()
    await expect(runtime.services.chat.send(chatInput(conversation.id, '第一轮问题')))
      .resolves.toEqual({ requestId: expect.any(String) })
    await vi.waitFor(() => expect(captured).toHaveLength(1))
    await vi.waitFor(async () => expect(await runtime.services.chat.listMessages(conversation.id))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ role: 'assistant', blocks: [{ type: 'text', text: '第一轮回答' }] }),
      ])))

    await runtime.services.chat.send(chatInput(conversation.id, '第二轮追问'))
    await vi.waitFor(() => expect(captured).toHaveLength(2))
    expect(captured[1]?.messages).toEqual([
      { role: 'user', content: '第一轮问题' },
      { role: 'assistant', content: '第一轮回答' },
      { role: 'user', content: '第二轮追问' },
    ])

    const isolated = await runtime.services.chat.createConversation()
    await runtime.services.chat.send(chatInput(isolated.id, '独立问题'))
    await vi.waitFor(() => expect(captured).toHaveLength(3))
    expect(captured[2]?.messages).toEqual([{ role: 'user', content: '独立问题' }])
    await runtime.close()
  })

  it('replaces historical media bytes and paths with a safe marker on a text follow-up', async () => {
    const root = await mkdtemp(join(tmpdir(), 'autoforge-application-context-media-'))
    directories.push(root)
    const source = join(root, 'image.png')
    const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('private-image-payload')])
    await writeFile(source, png)
    const captured: ModelStreamRequest[] = []
    const stream = vi.fn(async function* (request: ModelStreamRequest) {
      captured.push(request)
      if (captured.length === 1) yield { type: 'text_delta' as const, choiceIndex: 0, text: '我看到了图片' }
      yield { type: 'finish' as const, choiceIndex: 0, reason: 'stop' }
    })
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
      modelProviders: {
        openrouter: {
          listModels: vi.fn(async () => [{ ...visionTextModelInfo('openrouter/vision-context'), contextLength: 128_000 }]),
          validateCredential: vi.fn(async () => ({ valid: true })),
          stream,
        },
      },
      chooseProjectDirectory: async () => undefined,
      chooseMediaFiles: async () => [source],
      readClipboardImage: () => undefined,
      chooseMediaSavePath: async () => undefined,
      revealPath: () => undefined,
      openExternal: async () => undefined,
      emitChat: vi.fn(),
      emitExecution: vi.fn(),
      browserRuntime: { packaged: false },
    })
    await runtime.services.settings.saveProviderApiKey('openrouter', 'sk-openrouter')
    const settings = await runtime.services.settings.get()
    await runtime.services.settings.update({
      activeProvider: 'openrouter',
      defaultModels: { ...settings.defaultModels, openrouter: { text: 'openrouter/vision-context' } },
    })
    const conversation = await runtime.services.chat.createConversation()
    const [asset] = await runtime.services.media.pickFiles({ conversationId: conversation.id, existingAssetIds: [] })
    await runtime.services.chat.send({
      ...chatInput(conversation.id, '第一轮图片问题'), assetIds: [asset!.id], outputType: 'text',
    })
    await vi.waitFor(() => expect(captured).toHaveLength(1))
    expect(JSON.stringify(captured[0]?.messages)).toContain(png.toString('base64'))
    await vi.waitFor(async () => expect(await runtime.services.chat.listMessages(conversation.id))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ role: 'assistant', blocks: [{ type: 'text', text: '我看到了图片' }] }),
      ])))

    await runtime.services.chat.send(chatInput(conversation.id, '第二轮只问文字'))
    await vi.waitFor(() => expect(captured).toHaveLength(2))
    const followUp = JSON.stringify(captured[1]?.messages)
    expect(followUp).toContain('名称: image.png')
    expect(followUp).not.toContain(png.toString('base64'))
    expect(followUp).not.toContain(source)
    await runtime.close()
  })

  it('routes an explicit image request to OpenRouter image generation without invoking text chat', async () => {
    const root = await mkdtemp(join(tmpdir(), 'autoforge-application-image-route-'))
    directories.push(root)
    const generateImage = vi.fn(async () => ({
      outputs: [{
        type: 'base64' as const,
        mimeType: 'image/png',
        dataBase64: Buffer.concat([
          Buffer.from('89504e470d0a1a0a', 'hex'),
          Buffer.from('generated'),
        ]).toString('base64'),
      }],
    }))
    const stream = vi.fn(async function* () {
      yield { type: 'finish' as const, choiceIndex: 0, reason: 'stop' }
    })
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
      modelProviders: {
        openrouter: {
          listModels: vi.fn(async () => [imageModelInfo('openrouter/image')]),
          validateCredential: vi.fn(async () => ({ valid: true })),
          stream,
          generateImage,
        },
      },
      chooseProjectDirectory: async () => undefined,
      chooseMediaFiles: async () => [],
      readClipboardImage: () => undefined,
      chooseMediaSavePath: async () => undefined,
      revealPath: () => undefined,
      openExternal: async () => undefined,
      emitChat: vi.fn(),
      emitExecution: vi.fn(),
      browserRuntime: { packaged: false },
    })
    await runtime.services.settings.saveProviderApiKey('openrouter', 'sk-openrouter')
    await runtime.services.settings.update({
      activeProvider: 'openrouter',
      defaultModels: {
        deepseek: { text: 'deepseek-v4-flash' },
        openrouter: { text: 'openrouter/text', image: 'openrouter/image' },
      },
    })
    const conversation = await runtime.services.chat.createConversation()

    await runtime.services.chat.send({
      ...chatInput(conversation.id, 'make an image'),
      outputType: 'image',
    })

    await vi.waitFor(() => expect(generateImage).toHaveBeenCalledTimes(1))
    expect(stream).not.toHaveBeenCalled()
    await runtime.close()
  })

  it('routes audio, video, automatic output, and conversation model preferences without fallbacks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'autoforge-application-media-routes-'))
    directories.push(root)
    const source = join(root, 'reference.png')
    const png = Buffer.from('89504e470d0a1a0a', 'hex')
    await writeFile(source, png)
    const mp3 = Buffer.from('49443304000000000000', 'hex')
    const generateImage = vi.fn(async () => ({
      outputs: [{
        type: 'base64' as const,
        mimeType: 'image/png',
        dataBase64: Buffer.from('89504e470d0a1a0a', 'hex').toString('base64'),
      }],
    }))
    const submitVideo = vi.fn(async () => ({
      providerJobId: 'provider_video_1',
      status: 'pending' as const,
    }))
    const stream = vi.fn(async function* (request: { output?: { type: string } }) {
      if (request.output?.type === 'audio') {
        yield {
          type: 'audio_delta' as const,
          choiceIndex: 0,
          dataBase64: mp3.toString('base64'),
        }
      }
      yield { type: 'finish' as const, choiceIndex: 0, reason: 'stop' }
    })
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
      modelProviders: {
        openrouter: {
          listModels: vi.fn(async () => [
            visionTextModelInfo('openrouter/text'),
            imageModelInfo('openrouter/image'),
            imageModelInfo('openrouter/image-preferred'),
            audioModelInfo('openrouter/audio'),
            videoModelInfo('openrouter/video'),
          ]),
          validateCredential: vi.fn(async () => ({ valid: true })),
          stream,
          generateImage,
          submitVideo,
        },
      },
      chooseProjectDirectory: async () => undefined,
      chooseMediaFiles: async () => [source],
      readClipboardImage: () => undefined,
      chooseMediaSavePath: async () => undefined,
      revealPath: () => undefined,
      openExternal: async () => undefined,
      emitChat: vi.fn(),
      emitExecution: vi.fn(),
      browserRuntime: { packaged: false },
    })
    await runtime.services.settings.saveProviderApiKey('openrouter', 'sk-openrouter')
    await runtime.services.settings.update({
      activeProvider: 'openrouter',
      defaultModels: {
        deepseek: { text: 'deepseek-v4-flash' },
        openrouter: {
          text: 'openrouter/text',
          image: 'openrouter/image',
          audio: 'openrouter/audio',
          video: 'openrouter/video',
        },
      },
    })

    const textConversation = await runtime.services.chat.createConversation()
    const [textAsset] = await runtime.services.media.pickFiles({
      conversationId: textConversation.id,
      existingAssetIds: [],
    })
    await runtime.services.chat.send({
      ...chatInput(textConversation.id, 'describe this image'),
      assetIds: [textAsset!.id],
      outputType: 'text',
    })
    await vi.waitFor(() => expect(stream).toHaveBeenCalledWith(expect.objectContaining({
      model: 'openrouter/text',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'describe this image' },
          {
            type: 'media',
            kind: 'image',
            mimeType: 'image/png',
            dataBase64: png.toString('base64'),
          },
        ],
      }],
    })))
    expect(JSON.stringify(await runtime.services.chat.listMessages(textConversation.id)))
      .not.toContain(png.toString('base64'))

    const audioConversation = await runtime.services.chat.createConversation()
    await runtime.services.chat.send({
      ...chatInput(audioConversation.id, 'speak'),
      outputType: 'audio',
    })
    await vi.waitFor(() => expect(stream).toHaveBeenCalledWith(expect.objectContaining({
      model: 'openrouter/audio',
      output: expect.objectContaining({ type: 'audio', format: 'mp3' }),
    })))

    const videoConversation = await runtime.services.chat.createConversation()
    await runtime.services.chat.send({
      ...chatInput(videoConversation.id, 'make a video'),
      outputType: 'video',
    })
    expect(submitVideo).toHaveBeenCalledWith(expect.objectContaining({
      model: 'openrouter/video',
      options: expect.objectContaining({ durationSeconds: 5, resolution: '720p' }),
    }))

    submitVideo.mockRejectedValueOnce({ code: 'MODEL_PROVIDER_REQUEST_FAILED' })
    const failedVideoConversation = await runtime.services.chat.createConversation()
    await expect(runtime.services.chat.send({
      ...chatInput(failedVideoConversation.id, 'fail this video'),
      outputType: 'video',
    })).resolves.toEqual({ requestId: expect.any(String) })
    expect(await runtime.services.chat.listMessages(failedVideoConversation.id))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ role: 'user' }),
        expect.objectContaining({
          role: 'assistant',
          blocks: [expect.objectContaining({
            type: 'media_generation',
            kind: 'video',
            status: 'failed',
            errorCode: 'MODEL_PROVIDER_REQUEST_FAILED',
          })],
        }),
      ]))

    const automaticConversation = await runtime.services.chat.createConversation()
    await runtime.services.chat.send({
      ...chatInput(automaticConversation.id, 'make an automatic image'),
      model: 'openrouter/image',
    })
    await vi.waitFor(() => expect(generateImage).toHaveBeenCalledTimes(1))

    const preferredConversation = await runtime.services.chat.createConversation()
    await runtime.services.chat.updateGenerationPreferences(preferredConversation.id, {
      outputType: 'image',
      models: { image: 'openrouter/image-preferred' },
      generation: chatInput(preferredConversation.id, '').generation,
    })
    await runtime.services.chat.send({
      ...chatInput(preferredConversation.id, 'use my preference'),
      outputType: 'image',
    })
    await vi.waitFor(() => expect(generateImage).toHaveBeenCalledWith(expect.objectContaining({
      model: 'openrouter/image-preferred',
    })))

    const settingsWithoutImageDefault = await runtime.services.settings.get()
    await runtime.services.settings.update({
      defaultModels: {
        ...settingsWithoutImageDefault.defaultModels,
        openrouter: {
          text: 'openrouter/text',
          audio: 'openrouter/audio',
          video: 'openrouter/video',
        },
      },
    })
    const missingDefaultConversation = await runtime.services.chat.createConversation()
    await expect(runtime.services.chat.send({
      ...chatInput(missingDefaultConversation.id, 'choose an image model'),
      outputType: 'image',
    })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(generateImage).toHaveBeenCalledTimes(2)
    await runtime.close()
  })

  it('rejects missing, invalid, and unsupported provider requests before inference', async () => {
    const root = await mkdtemp(join(tmpdir(), 'autoforge-application-route-rejections-'))
    directories.push(root)
    const source = join(root, 'input.png')
    await writeFile(source, Buffer.from('89504e470d0a1a0a', 'hex'))
    const stream = vi.fn(async function* () {
      yield { type: 'finish' as const, choiceIndex: 0, reason: 'stop' }
    })
    const validateCredential = vi.fn(async () => ({ valid: false }))
    const listModels = vi.fn(async () => [modelInfo('deepseek-v4-flash', 'DeepSeek')])
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
      modelProviders: {
        deepseek: {
          listModels,
          validateCredential,
          stream,
        },
      },
      chooseProjectDirectory: async () => undefined,
      chooseMediaFiles: async () => [source],
      readClipboardImage: () => undefined,
      chooseMediaSavePath: async () => undefined,
      revealPath: () => undefined,
      openExternal: async () => undefined,
      emitChat: vi.fn(),
      emitExecution: vi.fn(),
      browserRuntime: { packaged: false },
    })
    const conversation = await runtime.services.chat.createConversation()
    await expect(runtime.services.chat.send(chatInput(conversation.id, 'missing key')))
      .rejects.toMatchObject({ code: 'CREDENTIAL_UNAVAILABLE' })
    expect(validateCredential).not.toHaveBeenCalled()
    expect(stream).not.toHaveBeenCalled()

    await runtime.services.settings.saveProviderApiKey('deepseek', 'invalid')
    await expect(runtime.services.chat.send(chatInput(conversation.id, 'invalid key')))
      .rejects.toMatchObject({ code: 'CREDENTIAL_INVALID' })
    expect(stream).not.toHaveBeenCalled()

    await expect(runtime.services.chat.send({
      ...chatInput(conversation.id, 'make an image'),
      outputType: 'image',
    })).rejects.toMatchObject({ code: 'MODEL_MODALITY_UNSUPPORTED' })
    expect(validateCredential).toHaveBeenCalledTimes(1)
    expect(listModels).not.toHaveBeenCalled()
    expect(stream).not.toHaveBeenCalled()

    const [asset] = await runtime.services.media.pickFiles({
      conversationId: conversation.id,
      existingAssetIds: [],
    })
    await expect(runtime.services.chat.send({
      ...chatInput(conversation.id, 'analyze this image'),
      assetIds: [asset!.id],
      outputType: 'text',
    })).rejects.toMatchObject({ code: 'MODEL_MODALITY_UNSUPPORTED' })
    expect(validateCredential).toHaveBeenCalledTimes(1)
    expect(listModels).not.toHaveBeenCalled()
    expect(stream).not.toHaveBeenCalled()

    validateCredential.mockRejectedValueOnce({ code: 'MODEL_PROVIDER_ACCESS_DENIED' })
    await expect(runtime.services.chat.send(chatInput(conversation.id, 'forbidden')))
      .rejects.toMatchObject({ code: 'MODEL_PROVIDER_ACCESS_DENIED' })
    expect(stream).not.toHaveBeenCalled()
    await runtime.close()
  })

  it('quarantines media for conversation deletion and preserves it for executions-only clear', async () => {
    const root = await mkdtemp(join(tmpdir(), 'autoforge-application-media-delete-'))
    directories.push(root)
    const source = join(root, 'source.png')
    await writeFile(source, Buffer.from('89504e470d0a1a0a', 'hex'))
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
      chooseProjectDirectory: async () => undefined,
      chooseMediaFiles: async () => [source],
      readClipboardImage: () => undefined,
      chooseMediaSavePath: async () => undefined,
      revealPath: () => undefined,
      openExternal: async () => undefined,
      emitChat: vi.fn(),
      emitExecution: vi.fn(),
      browserRuntime: { packaged: false },
    })

    const deleted = await runtime.services.chat.createConversation()
    await runtime.services.media.pickFiles({
      conversationId: deleted.id,
      existingAssetIds: [],
    })
    const deletedDirectory = join(root, 'media', deleted.id)
    await expect(access(deletedDirectory)).resolves.toBeUndefined()
    await runtime.services.chat.deleteConversation(deleted.id)
    await expect(access(deletedDirectory)).rejects.toMatchObject({ code: 'ENOENT' })

    const preserved = await runtime.services.chat.createConversation()
    await runtime.services.media.pickFiles({
      conversationId: preserved.id,
      existingAssetIds: [],
    })
    const preservedDirectory = join(root, 'media', preserved.id)
    await runtime.services.settings.clearLocalData('executions')
    await expect(access(preservedDirectory)).resolves.toBeUndefined()
    expect(await runtime.services.chat.listConversations()).toHaveLength(1)

    await runtime.services.settings.clearLocalData('all')
    await expect(access(preservedDirectory)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await runtime.services.chat.listConversations()).toEqual([])
    await runtime.close()
  })

  it('strictly normalizes and persists generation preferences across restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'autoforge-application-preferences-'))
    directories.push(root)
    const options: Parameters<typeof createApplicationRuntime>[0] = {
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
      chooseProjectDirectory: async () => undefined,
      chooseMediaFiles: async () => [],
      readClipboardImage: () => undefined,
      chooseMediaSavePath: async () => undefined,
      revealPath: () => undefined,
      openExternal: async () => undefined,
      emitChat: vi.fn(),
      emitExecution: vi.fn(),
      browserRuntime: { packaged: false },
    }
    const runtime = createApplicationRuntime(options)
    const conversation = await runtime.services.chat.createConversation()
    await expect(runtime.services.chat.updateGenerationPreferences(
      conversation.id,
      {
        outputType: 'image',
        models: { image: 'openrouter/image' },
        generation: {
          image: { count: 1 },
          audio: {},
          video: {},
        },
      } as Parameters<typeof runtime.services.chat.updateGenerationPreferences>[1],
    )).resolves.toEqual({
      outputType: 'image',
      models: { image: 'openrouter/image' },
      generation: {
        image: { count: 1, resolution: '1K', aspectRatio: 'auto', format: 'png' },
        audio: { format: 'mp3' },
        video: { durationSeconds: 5, resolution: '720p', aspectRatio: 'auto', generateAudio: false },
      },
    })
    await expect(runtime.services.chat.updateGenerationPreferences(
      conversation.id,
      {
        ...(await runtime.services.chat.getGenerationPreferences(conversation.id)),
        unexpected: true,
      } as never,
    )).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(runtime.services.chat.getGenerationPreferences('missing_conversation'))
      .rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(runtime.services.chat.updateGenerationPreferences(
      'missing_conversation',
      await runtime.services.chat.getGenerationPreferences(conversation.id),
    )).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await runtime.close()

    const restarted = createApplicationRuntime(options)
    await expect(restarted.services.chat.getGenerationPreferences(conversation.id))
      .resolves.toMatchObject({
        outputType: 'image',
        models: { image: 'openrouter/image' },
      })
    await restarted.close()
  })

  it('cancels synchronous media work before closing and rejects unsafe deletion while it is active', async () => {
    const root = await mkdtemp(join(tmpdir(), 'autoforge-application-cancel-media-'))
    directories.push(root)
    const generateImage = vi.fn(({ signal }: { signal?: AbortSignal }) => (
      new Promise<never>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject({ code: 'CANCELLED' }), { once: true })
      })
    ))
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
      modelProviders: {
        openrouter: {
          listModels: vi.fn(async () => [imageModelInfo('openrouter/image')]),
          validateCredential: vi.fn(async () => ({ valid: true })),
          stream: vi.fn(async function* () {
            yield { type: 'finish' as const, choiceIndex: 0, reason: 'stop' }
          }),
          generateImage,
        },
      },
      chooseProjectDirectory: async () => undefined,
      chooseMediaFiles: async () => [],
      readClipboardImage: () => undefined,
      chooseMediaSavePath: async () => undefined,
      revealPath: () => undefined,
      openExternal: async () => undefined,
      emitChat: vi.fn(),
      emitExecution: vi.fn(),
      browserRuntime: { packaged: false },
    })
    await runtime.services.settings.saveProviderApiKey('openrouter', 'sk-openrouter')
    await runtime.services.settings.update({
      activeProvider: 'openrouter',
      defaultModels: {
        deepseek: { text: 'deepseek-v4-flash' },
        openrouter: { image: 'openrouter/image' },
      },
    })
    const conversation = await runtime.services.chat.createConversation()
    const { requestId } = await runtime.services.chat.send({
      ...chatInput(conversation.id, 'generate until cancelled'),
      outputType: 'image',
    })
    await vi.waitFor(() => expect(generateImage).toHaveBeenCalledTimes(1))
    await expect(runtime.services.chat.deleteConversation(conversation.id))
      .rejects.toMatchObject({ code: 'CONFLICT' })

    await runtime.services.chat.cancel(requestId)
    await runtime.close()
  })

  it('excludes conversation deletion while a send is still in provider preflight', async () => {
    const root = await mkdtemp(join(tmpdir(), 'autoforge-application-delete-preflight-'))
    directories.push(root)
    let finishValidation!: (value: { valid: boolean }) => void
    const validateCredential = vi.fn(() => new Promise<{ valid: boolean }>((resolve) => {
      finishValidation = resolve
    }))
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
      modelProviders: {
        deepseek: {
          listModels: vi.fn(async () => [modelInfo('deepseek-v4-flash', 'DeepSeek')]),
          validateCredential,
          stream: vi.fn(async function* () {
            yield { type: 'finish' as const, choiceIndex: 0, reason: 'stop' }
          }),
        },
      },
      chooseProjectDirectory: async () => undefined,
      chooseMediaFiles: async () => [],
      readClipboardImage: () => undefined,
      chooseMediaSavePath: async () => undefined,
      revealPath: () => undefined,
      openExternal: async () => undefined,
      emitChat: vi.fn(),
      emitExecution: vi.fn(),
      browserRuntime: { packaged: false },
    })
    await runtime.services.settings.saveProviderApiKey('deepseek', 'sk-deepseek')
    const conversation = await runtime.services.chat.createConversation()
    const sending = runtime.services.chat.send(chatInput(conversation.id, 'preflight'))
    await vi.waitFor(() => expect(validateCredential).toHaveBeenCalledTimes(1))

    await expect(runtime.services.chat.deleteConversation(conversation.id))
      .rejects.toMatchObject({ code: 'CONFLICT' })
    let closed = false
    const closing = runtime.close().then(() => { closed = true })
    await new Promise<void>((resolve) => { setImmediate(resolve) })
    expect(closed).toBe(false)
    finishValidation({ valid: true })
    await sending
    await closing
  })

  it('uses the video runner for pause/resume and stops polling timers before database close', async () => {
    vi.useFakeTimers()
    try {
      const root = await mkdtemp(join(tmpdir(), 'autoforge-application-video-stop-'))
      directories.push(root)
      const pollVideo = vi.fn(async () => ({ status: 'pending' as const }))
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
        modelProviders: {
          openrouter: {
            listModels: vi.fn(async () => [videoModelInfo('openrouter/video')]),
            validateCredential: vi.fn(async () => ({ valid: true })),
            stream: vi.fn(async function* () {
              yield { type: 'finish' as const, choiceIndex: 0, reason: 'stop' }
            }),
            submitVideo: vi.fn(async () => ({
              providerJobId: 'provider_video_pause',
              status: 'pending' as const,
            })),
            pollVideo,
          },
        },
        chooseProjectDirectory: async () => undefined,
        chooseMediaFiles: async () => [],
        readClipboardImage: () => undefined,
        chooseMediaSavePath: async () => undefined,
        revealPath: () => undefined,
        openExternal: async () => undefined,
        emitChat: vi.fn(),
        emitExecution: vi.fn(),
        browserRuntime: { packaged: false },
      })
      await runtime.services.settings.saveProviderApiKey('openrouter', 'sk-openrouter')
      await runtime.services.settings.update({
        activeProvider: 'openrouter',
        defaultModels: {
          deepseek: { text: 'deepseek-v4-flash' },
          openrouter: { video: 'openrouter/video' },
        },
      })
      const conversation = await runtime.services.chat.createConversation()
      const { requestId } = await runtime.services.chat.send({
        ...chatInput(conversation.id, 'make a video'),
        outputType: 'video',
      })
      await expect(runtime.services.chat.deleteConversation(conversation.id))
        .rejects.toMatchObject({ code: 'CONFLICT' })
      await runtime.services.media.pauseVideoJob(requestId)
      await runtime.services.media.resumeVideoJob(requestId)
      await runtime.services.media.pauseVideoJob(requestId)
      await runtime.services.chat.deleteConversation(conversation.id)

      await runtime.close()
      await vi.advanceTimersByTimeAsync(20_000)
      expect(pollVideo).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('recovers persisted video polling only after restart recovery runs', async () => {
    vi.useFakeTimers()
    try {
      const root = await mkdtemp(join(tmpdir(), 'autoforge-application-video-recover-'))
      directories.push(root)
      const pollVideo = vi.fn(async () => ({ status: 'pending' as const }))
      const provider = {
        listModels: vi.fn(async () => [videoModelInfo('openrouter/video')]),
        validateCredential: vi.fn(async () => ({ valid: true })),
        stream: vi.fn(async function* () {
          yield { type: 'finish' as const, choiceIndex: 0, reason: 'stop' }
        }),
        submitVideo: vi.fn(async () => ({
          providerJobId: 'provider_video_recover',
          status: 'pending' as const,
        })),
        pollVideo,
      }
      const options: Parameters<typeof createApplicationRuntime>[0] = {
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
        modelProviders: { openrouter: provider },
        chooseProjectDirectory: async () => undefined,
        chooseMediaFiles: async () => [],
        readClipboardImage: () => undefined,
        chooseMediaSavePath: async () => undefined,
        revealPath: () => undefined,
        openExternal: async () => undefined,
        emitChat: vi.fn(),
        emitExecution: vi.fn(),
        browserRuntime: { packaged: false },
      }
      const runtime = createApplicationRuntime(options)
      await runtime.services.settings.saveProviderApiKey('openrouter', 'sk-openrouter')
      await runtime.services.settings.update({
        activeProvider: 'openrouter',
        defaultModels: {
          deepseek: { text: 'deepseek-v4-flash' },
          openrouter: { video: 'openrouter/video' },
        },
      })
      const conversation = await runtime.services.chat.createConversation()
      await runtime.services.chat.send({
        ...chatInput(conversation.id, 'recover this video'),
        outputType: 'video',
      })
      await runtime.close()

      const restarted = createApplicationRuntime(options)
      await vi.advanceTimersByTimeAsync(10_000)
      expect(pollVideo).not.toHaveBeenCalled()
      await restarted.recover()
      await vi.advanceTimersByTimeAsync(2_000)
      expect(pollVideo).toHaveBeenCalledWith('provider_video_recover', expect.any(AbortSignal))
      await restarted.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('fails interrupted non-video generation blocks during application recovery', async () => {
    const root = await mkdtemp(join(tmpdir(), 'autoforge-application-image-recover-'))
    directories.push(root)
    const databasePath = join(root, 'autoforge.sqlite')
    const database = openAppDatabase(databasePath)
    database.conversations.insert({ id: 'conversation_interrupted_image', title: 'Interrupted' })
    database.messages.insert({
      id: 'assistant_interrupted_image',
      conversationId: 'conversation_interrupted_image',
      role: 'assistant',
      blocks: [{
        type: 'media_generation',
        blockId: 'block_interrupted_image',
        jobId: 'request_interrupted_image',
        kind: 'image',
        status: 'in_progress',
      }],
      createdAt: 1,
    })
    database.chatRuns.insert({
      id: 'run_interrupted_image',
      conversationId: 'conversation_interrupted_image',
      requestId: 'request_interrupted_image',
      model: 'openrouter/image',
      status: 'running',
      startedAt: 1,
    })
    database.close()

    const runtime = createApplicationRuntime({
      paths: {
        database: databasePath, data: root, logs: join(root, 'logs'),
        projects: join(root, 'projects'), installations: join(root, 'workflows'),
        workflowRunner: join(root, 'workflow-runner.cjs'), temporary: root,
      },
      safeStorage: {
        isAvailable: async () => true,
        encrypt: async (value) => Buffer.from(value),
        decrypt: async (value) => ({ value: value.toString(), shouldReEncrypt: false }),
      },
      chooseProjectDirectory: async () => undefined,
      chooseMediaFiles: async () => [],
      readClipboardImage: () => undefined,
      chooseMediaSavePath: async () => undefined,
      revealPath: () => undefined,
      openExternal: async () => undefined,
      emitChat: vi.fn(),
      emitExecution: vi.fn(),
      browserRuntime: { packaged: false },
    })
    await runtime.recover()
    await expect(runtime.services.chat.listMessages('conversation_interrupted_image'))
      .resolves.toEqual([
        expect.objectContaining({
          blocks: [{
            type: 'media_generation',
            blockId: 'block_interrupted_image',
            jobId: 'request_interrupted_image',
            kind: 'image',
            status: 'failed',
            errorCode: 'MEDIA_GENERATION_FAILED',
          }],
        }),
      ])
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
      chooseMediaFiles: async () => [],
      readClipboardImage: () => undefined,
      chooseMediaSavePath: async () => undefined,
      revealPath: () => undefined,
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
      chooseMediaFiles: async () => [],
      readClipboardImage: () => undefined,
      chooseMediaSavePath: async () => undefined,
      revealPath: () => undefined,
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
        listModels: async () => [modelInfo('openrouter/text', 'OpenRouter text')],
        validateCredential: async () => ({ valid: true }),
        stream: async function* () { yield { type: 'finish' as const, choiceIndex: 0, reason: 'stop' } },
      },
      chooseProjectDirectory: async () => undefined,
      chooseMediaFiles: async () => [],
      readClipboardImage: () => undefined,
      chooseMediaSavePath: async () => undefined,
      revealPath: () => undefined,
      openExternal,
      emitChat: (event) => { chatEvents.push(event) },
      emitExecution: vi.fn(),
      browserRuntime: { packaged: false },
    })

    await runtime.recover()
    await runtime.services.settings.update({ activeProvider: 'openrouter' })
    await runtime.services.settings.saveProviderApiKey('openrouter', 'sk-openrouter')
    const applicationSettings = await runtime.services.settings.get()
    await runtime.services.settings.update({
      defaultModels: {
        ...applicationSettings.defaultModels,
        openrouter: { text: 'openrouter/text' },
      },
    })
    const conversation = await runtime.services.chat.createConversation()
    expect(await runtime.services.chat.listConversations()).toEqual([conversation])
    expect(await runtime.services.chat.listMessages(conversation.id)).toEqual([])
    expect(await runtime.services.chat.renameConversation(conversation.id, 'Renamed')).toMatchObject({ title: 'Renamed' })
    await runtime.services.chat.send(chatInput(conversation.id, 'persist me'))
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
        listModels: async () => [modelInfo('openrouter/text', 'OpenRouter text')], validateCredential: async () => ({ valid: true }),
        stream: async function* () { yield { type: 'finish' as const, choiceIndex: 0, reason: 'stop' } },
      },
      chooseProjectDirectory: async () => undefined,
      chooseMediaFiles: async () => [],
      readClipboardImage: () => undefined,
      chooseMediaSavePath: async () => undefined,
      revealPath: () => undefined,
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
        listModels: async () => [modelInfo('openrouter/text', 'OpenRouter text')], validateCredential: async () => ({ valid: true }),
        stream: async function* () {
          await streamFinished
          yield { type: 'finish' as const, choiceIndex: 0, reason: 'stop' }
        },
      },
      chooseProjectDirectory: async () => undefined,
      chooseMediaFiles: async () => [],
      readClipboardImage: () => undefined,
      chooseMediaSavePath: async () => undefined,
      revealPath: () => undefined,
      openExternal: async () => undefined,
      emitChat: (event) => { chatEvents.push(event) },
      emitExecution: vi.fn(),
      browserRuntime: { packaged: false },
    })
    await runtime.services.settings.update({ activeProvider: 'openrouter' })
    await runtime.services.settings.saveProviderApiKey('openrouter', 'sk-openrouter')
    const cleanupSettings = await runtime.services.settings.get()
    await runtime.services.settings.update({
      defaultModels: {
        ...cleanupSettings.defaultModels,
        openrouter: { text: 'openrouter/text' },
      },
    })
    const conversation = await runtime.services.chat.createConversation()
    await runtime.services.chat.send(chatInput(conversation.id, 'hello'))

    await expect(runtime.services.settings.clearLocalData('conversations'))
      .rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(runtime.services.workflows.remove('workflow.active', '1.0.0'))
      .rejects.toMatchObject({ code: 'CONFLICT' })
    expect(await runtime.services.chat.listConversations()).toHaveLength(1)

    finishStream()
    for (let index = 0; index < 20 && !chatEvents.some((event) => event.status === 'completed'); index += 1) {
      await Promise.resolve()
    }
    await new Promise<void>((resolve) => { setImmediate(resolve) })
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

  it('drains an in-progress exclusive operation before shutdown admission closes', async () => {
    const gate = new MaintenanceGate()
    let finish!: () => void
    const operation = gate.runExclusive(
      () => false,
      () => new Promise<void>((resolve) => { finish = resolve }),
    )
    let drained = false
    const draining = gate.stopAndDrain().then(() => { drained = true })
    await Promise.resolve()
    expect(drained).toBe(false)

    finish()
    await operation
    await draining
    expect(() => gate.beginStart()).toThrow(expect.objectContaining({ code: 'CONFLICT' }))
  })

  it('runs the exact development project even when an installed workflow has the same identity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'autoforge-application-'))
    directories.push(root)
    let markCleanupStarted!: () => void
    let finishCleanup!: () => void
    const cleanupStarted = new Promise<void>((resolve) => { markCleanupStarted = resolve })
    const cleanupFinished = new Promise<void>((resolve) => { finishCleanup = resolve })
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
      chooseMediaFiles: async () => [],
      readClipboardImage: () => undefined,
      chooseMediaSavePath: async () => undefined,
      revealPath: () => undefined,
      openExternal: async () => undefined,
      emitChat: vi.fn(), emitExecution: vi.fn(), browserRuntime: { packaged: false },
      removeExecutionTemporaryDirectory: async (path: string) => {
        markCleanupStarted()
        await cleanupFinished
        await rm(path, { recursive: true, force: true })
      },
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
    await cleanupStarted
    let closed = false
    const closing = runtime.close().then(() => { closed = true })
    await new Promise<void>((resolve) => { setImmediate(resolve) })
    expect(closed).toBe(false)
    finishCleanup()
    await closing
  })
})
