import { describe, expect, it, vi } from 'vitest'
import type { WorkflowDetail } from '@autoforge/shared'
import { createWorkflowCatalog, type WorkflowCandidate } from './workflow-catalog.js'
import { WorkflowRouter, type WorkflowRoutingRequest } from './workflow-router.js'
import { createWorkflowSourceSelectorVault } from '../workflows/workflow-source-selector.js'

function detail(index: number, options: {
  schemaPadding?: number
  descriptionPadding?: number
} = {}): WorkflowDetail {
  return {
    id: `workflow.${index}`,
    version: '1.0.0',
    name: `工作流 ${index}`,
    description: `处理任务 ${index}${'说明'.repeat(options.descriptionPadding ?? 0)}`,
    author: 'AutoForge',
    category: 'test',
    enabled: true,
    source: 'installed',
    integrity: 'valid',
    updatedAt: '2026-08-22T00:00:00.000Z',
    codeSha256: String(index).padStart(64, '0'),
    cities: index % 2 === 0 ? ['北京'] : [],
    runtimeIdentity: { id: `workflow.${index}`, version: '1.0.0', source: 'installed' },
    timeoutMs: 30_000,
    permissions: [],
    activationExamples: [`执行任务 ${index}`],
    activationNegativeExamples: [`不要执行任务 ${index}`],
    inputSchema: {
      type: 'object',
      properties: {
        value: {
          type: 'string',
          description: 'x'.repeat(options.schemaPadding ?? 0),
        },
      },
      additionalProperties: false,
    },
    outputSchema: { type: 'object' },
  }
}

async function candidates(
  count: number,
  options: Parameters<typeof detail>[1] = {},
): Promise<WorkflowCandidate[]> {
  const vault = createWorkflowSourceSelectorVault()
  return createWorkflowCatalog({
    workflows: { list: async () => Array.from({ length: count }, (_, index) => detail(index + 1, options)) },
    selectorFor: vault.create,
  }).create({ developerMode: false })
}

const signal = () => new AbortController().signal

describe('WorkflowRouter', () => {
  it('returns every complete candidate unchanged without routing when all tools fit', async () => {
    const available = await candidates(2)
    const select = vi.fn(async () => JSON.stringify([available[1]!.key]))

    const routed = await new WorkflowRouter().route({
      query: '执行任务', candidates: available, contextLength: 32_000, select, signal: signal(),
    })

    expect(routed).toEqual(available)
    expect(routed[0]).toBe(available[0])
    expect(routed[1]).toBe(available[1])
    expect(select).not.toHaveBeenCalled()
  })

  it('uses the model order and deduplicates a semantic shortlist when all complete tools exceed budget', async () => {
    const available = await candidates(3, { schemaPadding: 5_000 })
    const select = vi.fn(async () => JSON.stringify([
      available[2]!.key,
      available[0]!.key,
      available[2]!.key,
    ]))

    const routed = await new WorkflowRouter().route({
      query: '第三个，再第一个', candidates: available, contextLength: 32_000, select, signal: signal(),
    })

    expect(routed.map(({ key }) => key)).toEqual([available[2]!.key, available[0]!.key])
    expect(select).toHaveBeenCalledTimes(1)
  })

  it('treats an empty valid selection as direct chat', async () => {
    const available = await candidates(3, { schemaPadding: 5_000 })

    await expect(new WorkflowRouter().route({
      query: '普通问题', candidates: available, contextLength: 32_000,
      select: async () => '[]', signal: signal(),
    })).resolves.toEqual([])
  })

  it('caps a valid ordered model selection at twenty candidates', async () => {
    const available = await candidates(25, { schemaPadding: 1_000 })
    const selected = [...available].reverse().map(({ key }) => key)

    const routed = await new WorkflowRouter().route({
      query: '选择多个工作流', candidates: available, contextLength: 92_000,
      select: async () => JSON.stringify(selected), signal: signal(),
    })

    expect(routed).toHaveLength(20)
    expect(routed.map(({ key }) => key)).toEqual(selected.slice(0, 20))
  })

  it.each([
    ['unknown key', (available: WorkflowCandidate[]) => JSON.stringify([available[0]!.key, 'unknown'])],
    ['non-array JSON', () => JSON.stringify({ key: 'workflow' })],
    ['non-string key', (available: WorkflowCandidate[]) => JSON.stringify([available[0]!.key, 1])],
    ['invalid JSON', () => '```json\n[]\n```'],
  ])('rejects a malformed routing selection: %s', async (_name, output) => {
    const available = await candidates(3, { schemaPadding: 5_000 })

    await expect(new WorkflowRouter().route({
      query: '执行任务', candidates: available, contextLength: 32_000,
      select: async () => output(available), signal: signal(),
    })).rejects.toMatchObject({ code: 'MODEL_PROVIDER_REQUEST_FAILED' })
  })

  it('fails before selection when the complete compact request exceeds the normal input budget', async () => {
    const available = await candidates(2, { schemaPadding: 5_000, descriptionPadding: 10_000 })
    const select = vi.fn(async () => '[]')

    await expect(new WorkflowRouter().route({
      query: '执行任务', candidates: available, contextLength: 32_000, select, signal: signal(),
    })).rejects.toMatchObject({ code: 'CONTEXT_LIMIT_EXCEEDED' })
    expect(select).not.toHaveBeenCalled()
  })

  it('sends only compact metadata plus the query to selection', async () => {
    const available = await candidates(3, { schemaPadding: 5_000 })
    let request: WorkflowRoutingRequest | undefined

    await new WorkflowRouter().route({
      query: '执行第三个任务', candidates: available, contextLength: 32_000,
      select: async (value) => { request = value; return '[]' }, signal: signal(),
    })

    expect(request).toBeDefined()
    expect(request).not.toHaveProperty('tools')
    expect(request!.signal).toBeInstanceOf(AbortSignal)
    const userMessage = request!.messages.at(-1)
    expect(userMessage?.role).toBe('user')
    expect(typeof userMessage?.content).toBe('string')
    const body = JSON.parse(userMessage!.content as string) as { request: string; candidates: unknown[] }
    expect(body.request).toBe('执行第三个任务')
    expect(body.candidates).toHaveLength(available.length)
    expect(Object.keys(body.candidates[0] as object)).toEqual([
      'key', 'identity', 'name', 'description', 'cities', 'category',
      'activationExamples', 'activationNegativeExamples',
    ])
    expect(body.candidates[0]).toMatchObject({
      key: available[0]!.key,
      identity: available[0]!.workflow.runtimeIdentity,
      name: available[0]!.workflow.name,
      cities: available[0]!.workflow.cities,
    })
    expect(JSON.stringify(body)).not.toContain('inputSchema')
    expect(JSON.stringify(body)).not.toContain('permissions')
  })

  it('takes the longest ordered complete-tool prefix that fits the tool budget', async () => {
    const available = await candidates(4, { schemaPadding: 5_000 })

    const routed = await new WorkflowRouter().route({
      query: '按顺序选择', candidates: available, contextLength: 32_000,
      select: async () => JSON.stringify(available.map(({ key }) => key)), signal: signal(),
    })

    expect(routed.map(({ key }) => key)).toEqual(available.slice(0, 2).map(({ key }) => key))
  })

  it('fails closed when the first selected complete tool cannot fit', async () => {
    const available = await candidates(2, { schemaPadding: 20_000 })

    await expect(new WorkflowRouter().route({
      query: '执行任务', candidates: available, contextLength: 32_000,
      select: async () => JSON.stringify([available[0]!.key]), signal: signal(),
    })).rejects.toMatchObject({ code: 'CONTEXT_LIMIT_EXCEEDED' })
  })

  it('does not select or return candidates after cancellation', async () => {
    const available = await candidates(3, { schemaPadding: 5_000 })
    const before = new AbortController()
    before.abort()
    const selectBefore = vi.fn(async () => '[]')

    await expect(new WorkflowRouter().route({
      query: '执行任务', candidates: available, contextLength: 32_000,
      select: selectBefore, signal: before.signal,
    })).rejects.toMatchObject({ code: 'CANCELLED' })
    expect(selectBefore).not.toHaveBeenCalled()

    const during = new AbortController()
    await expect(new WorkflowRouter().route({
      query: '执行任务', candidates: available, contextLength: 32_000,
      select: async () => { during.abort(); return JSON.stringify([available[0]!.key]) },
      signal: during.signal,
    })).rejects.toMatchObject({ code: 'CANCELLED' })
  })
})
