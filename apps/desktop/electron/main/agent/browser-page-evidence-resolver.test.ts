import { describe, expect, it, vi } from 'vitest'
import type { BrowserPageSnapshot } from '../browser/browser-continuation-types.js'
import type {
  ModelProviderSnapshot,
  ModelStreamEvent,
  ModelStreamRequest,
} from '../chat/model-provider.js'
import {
  ProviderUsageConsistencyError,
  type ProviderUsageRepository,
} from '../database/repositories.js'
import { resolveBrowserPageEvidence } from './browser-page-evidence-resolver.js'

const page: BrowserPageSnapshot = {
  snapshotId: 'snapshot_1',
  bindingId: 'binding_1',
  origin: 'https://fw.bjrcgz.gov.cn',
  url: 'https://fw.bjrcgz.gov.cn',
  title: '附件管理',
  capturedAt: '2026-08-24T08:00:00.000Z',
  navigationEpoch: 1,
  auth: 'authenticated',
  nodes: [
    { ref: 'ref_table', role: 'table', name: '附件列表', enabled: true, actions: [] },
    { ref: 'ref_header', parentRef: 'ref_table', role: 'row', name: '表头', enabled: true, actions: [] },
    { ref: 'ref_name_header', parentRef: 'ref_header', role: 'columnheader', name: '附件名称', enabled: true, actions: [] },
    { ref: 'ref_status_header', parentRef: 'ref_header', role: 'columnheader', name: '当前状态', enabled: true, actions: [] },
    { ref: 'ref_row_1', parentRef: 'ref_table', role: 'row', name: '学历证书 已上传', enabled: true, actions: [] },
    { ref: 'ref_degree', parentRef: 'ref_row_1', role: 'statictext', name: '学历证书', enabled: true, actions: [], answerable: true },
    { ref: 'ref_uploaded_1', parentRef: 'ref_row_1', role: 'statictext', name: '已上传', enabled: true, actions: [], answerable: true },
    { ref: 'ref_row_2', parentRef: 'ref_table', role: 'row', name: '学位证书 已上传', enabled: true, actions: [] },
    { ref: 'ref_degree_type', parentRef: 'ref_row_2', role: 'statictext', name: '学位证书', enabled: true, actions: [], answerable: true },
    { ref: 'ref_uploaded_2', parentRef: 'ref_row_2', role: 'statictext', name: '已上传', enabled: true, actions: [], answerable: true },
  ],
  serializedBytes: 1_234,
}

function harness(events: readonly ModelStreamEvent[], streamError?: unknown) {
  const stream = vi.fn(async function* (request: ModelStreamRequest) {
    void request
    for (const event of events) yield event
    if (streamError !== undefined) throw streamError
  })
  const providerSnapshot: ModelProviderSnapshot = {
    providerId: 'openrouter',
    apiKeyFingerprint: 'fingerprint_1',
    provider: {
      listModels: async () => [],
      validateCredential: async () => ({ valid: true }),
      stream,
    },
  }
  const providerUsage = {
    start: vi.fn((input) => input as never),
    bindIdentity: vi.fn((_key, input) => input as never),
    report: vi.fn((_key, input) => input as never),
    markUnknown: vi.fn((key) => key as never),
  } satisfies Pick<ProviderUsageRepository, 'start' | 'bindIdentity' | 'report' | 'markUnknown'>
  const run = (
    pages: readonly BrowserPageSnapshot[] = [page],
    signal: AbortSignal = new AbortController().signal,
  ) => resolveBrowserPageEvidence({
    trustedRequest: '我上传了哪些附件',
    pages,
    providerSnapshot,
    providerUsage,
    model: 'deepseek/deepseek-v4',
    userId: 'user_1',
    requestId: 'request_1',
    evidenceRevision: 1,
    chatRunId: 'run_1',
    signal,
    id: () => 'usage_1',
    now: () => 100,
  })
  return { run, stream, providerUsage }
}

const emptyResolution = {
  shape: 'list',
  selectedNodeIds: [],
  supportingNodeIds: [],
}

describe('resolveBrowserPageEvidence', () => {
  it('lets the model select multiple answer nodes from the complete page hierarchy', async () => {
    const usage = { type: 'usage', inputTokens: 30, outputTokens: 8, totalTokens: 38, costUsd: '0.002' } as const
    const test = harness([
      {
        type: 'tool_call', choiceIndex: 0, index: 0, id: 'call_1',
        name: 'report_browser_page_evidence',
        arguments: {
          shape: 'list',
          selectedNodeIds: ['ref_degree', 'ref_degree_type'],
          supportingNodeIds: ['ref_name_header', 'ref_status_header', 'ref_uploaded_1', 'ref_uploaded_2'],
        },
      },
      { type: 'finish', choiceIndex: 0, reason: 'tool_calls' },
      usage,
    ])

    await expect(test.run()).resolves.toEqual({
      shape: 'list',
      selectedNodeIds: ['ref_degree', 'ref_degree_type'],
      supportingNodeIds: ['ref_name_header', 'ref_status_header', 'ref_uploaded_1', 'ref_uploaded_2'],
      usage,
    })
    const request = test.stream.mock.calls[0]![0]
    expect(JSON.stringify(request.messages)).toContain('我上传了哪些附件')
    expect(JSON.stringify(request.messages)).toContain('parentRef')
    expect(JSON.stringify(request.messages)).toContain('学历证书')
    expect(JSON.stringify(request.messages)).toContain('已上传')
    expect(request.tools).toEqual([expect.objectContaining({
      function: expect.objectContaining({ name: 'report_browser_page_evidence' }),
    })])
    expect(test.providerUsage.start).toHaveBeenCalledWith(expect.objectContaining({
      operationKey: 'agent:request_1:browser-page-evidence:1',
    }))
  })

  it.each([
    ['unknown selected ID', { shape: 'list', selectedNodeIds: ['missing'], supportingNodeIds: [] }],
    ['duplicate selected ID', { shape: 'list', selectedNodeIds: ['ref_degree', 'ref_degree'], supportingNodeIds: [] }],
    ['overlapping support ID', { shape: 'list', selectedNodeIds: ['ref_degree'], supportingNodeIds: ['ref_degree'] }],
    ['non-answerable selection', { shape: 'list', selectedNodeIds: ['ref_table'], supportingNodeIds: [] }],
    ['multiple scalar values', { shape: 'scalar', selectedNodeIds: ['ref_degree', 'ref_degree_type'], supportingNodeIds: [] }],
  ])('fails closed for %s', async (_case, argumentsValue) => {
    const test = harness([
      {
        type: 'tool_call', choiceIndex: 0, index: 0, id: 'call_1',
        name: 'report_browser_page_evidence', arguments: argumentsValue,
      },
      { type: 'finish', choiceIndex: 0, reason: 'tool_calls' },
    ])

    await expect(test.run()).resolves.toEqual(emptyResolution)
  })

  it('fails closed when refs are duplicated across cursor pages', async () => {
    const test = harness([
      {
        type: 'tool_call', choiceIndex: 0, index: 0, id: 'call_1',
        name: 'report_browser_page_evidence',
        arguments: { shape: 'list', selectedNodeIds: ['ref_degree'], supportingNodeIds: [] },
      },
      { type: 'finish', choiceIndex: 0, reason: 'tool_calls' },
    ])
    const duplicatePage = { ...page, nodes: [page.nodes[5]!] }

    await expect(test.run([page, duplicatePage])).resolves.toEqual(emptyResolution)
    expect(test.stream).not.toHaveBeenCalled()
  })

  it.each([
    ['ordinary prose', [
      { type: 'text_delta', choiceIndex: 0, text: '学历证书' },
      {
        type: 'tool_call', choiceIndex: 0, index: 0, id: 'call_1',
        name: 'report_browser_page_evidence',
        arguments: { shape: 'list', selectedNodeIds: ['ref_degree'], supportingNodeIds: [] },
      },
      { type: 'finish', choiceIndex: 0, reason: 'tool_calls' },
    ]],
    ['wrong finish reason', [
      {
        type: 'tool_call', choiceIndex: 0, index: 0, id: 'call_1',
        name: 'report_browser_page_evidence',
        arguments: { shape: 'list', selectedNodeIds: ['ref_degree'], supportingNodeIds: [] },
      },
      { type: 'finish', choiceIndex: 0, reason: 'stop' },
    ]],
    ['no tool call', [{ type: 'finish', choiceIndex: 0, reason: 'stop' }]],
  ] satisfies ReadonlyArray<readonly [string, readonly ModelStreamEvent[]]>)('fails closed for %s', async (_case, events) => {
    const test = harness(events)

    await expect(test.run()).resolves.toEqual(emptyResolution)
  })

  it('rejects multiple tool calls and pre-stream cancellation', async () => {
    const multiple = harness([
      {
        type: 'tool_call', choiceIndex: 0, index: 0, id: 'call_1',
        name: 'report_browser_page_evidence',
        arguments: { shape: 'list', selectedNodeIds: ['ref_degree'], supportingNodeIds: [] },
      },
      {
        type: 'tool_call', choiceIndex: 0, index: 1, id: 'call_2',
        name: 'report_browser_page_evidence',
        arguments: { shape: 'list', selectedNodeIds: [], supportingNodeIds: [] },
      },
      { type: 'finish', choiceIndex: 0, reason: 'tool_calls' },
    ])
    await expect(multiple.run()).resolves.toEqual(emptyResolution)

    const cancelled = harness([])
    const controller = new AbortController()
    controller.abort()
    await expect(cancelled.run([page], controller.signal)).rejects.toMatchObject({ code: 'CANCELLED' })
    expect(cancelled.stream).not.toHaveBeenCalled()
  })

  it('propagates cancellation observed during the provider stream', async () => {
    const controller = new AbortController()
    const test = harness([])
    test.stream.mockImplementationOnce(async function* () {
      yield { type: 'finish', choiceIndex: 0, reason: 'stop' }
      controller.abort()
      throw new Error('provider aborted')
    })

    await expect(test.run([page], controller.signal)).rejects.toMatchObject({ code: 'CANCELLED' })
  })

  it('fails closed on ordinary provider errors but propagates billing consistency failures', async () => {
    const ordinary = harness([], new Error('provider unavailable'))
    await expect(ordinary.run()).resolves.toEqual(emptyResolution)

    const consistency = harness([])
    consistency.providerUsage.start.mockImplementationOnce(() => {
      throw new ProviderUsageConsistencyError()
    })
    await expect(consistency.run()).rejects.toBeInstanceOf(ProviderUsageConsistencyError)
  })
})
