import { describe, expect, it, vi } from 'vitest'
import type {
  BrowserPageSnapshot,
  BrowserVisualEvidenceBundle,
} from '../browser/browser-continuation-types.js'
import type {
  ModelProviderSnapshot,
  ModelStreamEvent,
  ModelStreamRequest,
} from '../chat/model-provider.js'
import {
  ProviderUsageConsistencyError,
  type ProviderUsageRepository,
} from '../database/repositories.js'
import { resolveBrowserVisualEvidence } from './browser-visual-evidence-resolver.js'

const minimalPngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='

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
    { ref: 'ref_row_1', parentRef: 'ref_table', role: 'row', name: '条目', enabled: true, actions: [] },
    { ref: 'ref_degree', parentRef: 'ref_row_1', role: 'statictext', name: '学历证书', enabled: true, actions: [], answerable: true },
    { ref: 'ref_uploaded_1', parentRef: 'ref_row_1', role: 'statictext', name: '已上传', enabled: true, actions: [], answerable: true },
    { ref: 'ref_row_2', parentRef: 'ref_table', role: 'row', name: '条目', enabled: true, actions: [] },
    { ref: 'ref_degree_type', parentRef: 'ref_row_2', role: 'statictext', name: '学位证书', enabled: true, actions: [], answerable: true },
    { ref: 'ref_uploaded_2', parentRef: 'ref_row_2', role: 'statictext', name: '已上传', enabled: true, actions: [], answerable: true },
  ],
  serializedBytes: 1_234,
}

const bundle: BrowserVisualEvidenceBundle = {
  snapshotId: 'snapshot_1',
  bindingId: 'binding_1',
  origin: 'https://fw.bjrcgz.gov.cn',
  navigationEpoch: 1,
  capturedAt: '2026-08-24T08:00:01.000Z',
  pages: [page],
  tiles: [{
    tileId: 'tile_1',
    mediaType: 'image/png',
    dataBase64: minimalPngBase64,
    width: 1,
    height: 1,
    documentX: 0,
    documentY: 0,
  }],
  placements: [
    { nodeId: 'ref_degree', tileId: 'tile_1', x: 0.05, y: 0.05, width: 0.4, height: 0.1 },
    { nodeId: 'ref_uploaded_1', tileId: 'tile_1', x: 0.55, y: 0.05, width: 0.4, height: 0.1 },
    { nodeId: 'ref_degree_type', tileId: 'tile_1', x: 0.05, y: 0.5, width: 0.4, height: 0.1 },
    { nodeId: 'ref_uploaded_2', tileId: 'tile_1', x: 0.55, y: 0.5, width: 0.4, height: 0.1 },
  ],
}

const selectedArguments = {
  shape: 'list',
  selectedNodeIds: ['ref_degree', 'ref_degree_type'],
  supportingNodeIds: ['ref_uploaded_1', 'ref_uploaded_2'],
}

const successfulEvents: readonly ModelStreamEvent[] = [
  {
    type: 'tool_call', choiceIndex: 0, index: 0, id: 'call_1',
    name: 'report_browser_visual_evidence', arguments: selectedArguments,
  },
  { type: 'finish', choiceIndex: 0, reason: 'tool_calls' },
]

function harness(events: readonly ModelStreamEvent[] = successfulEvents, streamError?: unknown) {
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
    visualBundle: BrowserVisualEvidenceBundle = bundle,
    trustedRequest = '我上传了哪些附件',
    signal: AbortSignal = new AbortController().signal,
  ) => resolveBrowserVisualEvidence({
    trustedRequest,
    bundle: visualBundle,
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

function withBundle(overrides: Partial<BrowserVisualEvidenceBundle>): BrowserVisualEvidenceBundle {
  return { ...bundle, ...overrides }
}

describe('resolveBrowserVisualEvidence', () => {
  it('selects existing answer nodes from ordered PNG visual evidence', async () => {
    const usage = { type: 'usage', inputTokens: 30, outputTokens: 8, totalTokens: 38, costUsd: '0.002' } as const
    const test = harness([...successfulEvents, usage])

    await expect(test.run()).resolves.toEqual({
      shape: 'list',
      selectedNodeIds: ['ref_degree', 'ref_degree_type'],
      supportingNodeIds: ['ref_uploaded_1', 'ref_uploaded_2'],
      usage,
    })
    const request = test.stream.mock.calls[0]![0]
    expect(request.messages.at(-1)).toEqual({
      role: 'user',
      content: [
        expect.objectContaining({ type: 'text', text: expect.stringContaining('我上传了哪些附件') }),
        { type: 'media', kind: 'image', mimeType: 'image/png', dataBase64: minimalPngBase64 },
      ],
    })
    const userContent = request.messages.at(-1)?.content
    expect(Array.isArray(userContent)).toBe(true)
    if (!Array.isArray(userContent) || userContent[0]?.type !== 'text') throw new Error('missing visual metadata')
    expect(JSON.parse(userContent[0].text)).toEqual({
      request: '我上传了哪些附件',
      pages: [page],
      placements: bundle.placements,
      tiles: [{
        tileId: 'tile_1', mediaType: 'image/png', width: 1, height: 1,
        documentX: 0, documentY: 0,
      }],
    })
    expect(userContent[0].text).not.toContain(minimalPngBase64)
    expect(request.tools).toEqual([expect.objectContaining({
      function: expect.objectContaining({
        name: 'report_browser_visual_evidence',
        parameters: expect.objectContaining({ additionalProperties: false }),
      }),
    })])
    expect(request.maxOutputTokens).toBe(512)
    expect(test.providerUsage.start).toHaveBeenCalledWith(expect.objectContaining({
      operationKey: 'agent:request_1:browser-visual-evidence:1',
      chatRunId: 'run_1',
      model: 'deepseek/deepseek-v4',
    }))
  })

  it.each([
    ['blank trusted request', bundle, '   '],
    ['more than three tiles', withBundle({ tiles: [
      ...bundle.tiles,
      { ...bundle.tiles[0]!, tileId: 'tile_2' },
      { ...bundle.tiles[0]!, tileId: 'tile_3' },
      { ...bundle.tiles[0]!, tileId: 'tile_4' },
    ] }), '我上传了哪些附件'],
    ['a tile over one million pixels', withBundle({
      tiles: [{ ...bundle.tiles[0]!, width: 1_001, height: 1_000 }],
    }), '我上传了哪些附件'],
    ['non-canonical base64', withBundle({
      tiles: [{ ...bundle.tiles[0]!, dataBase64: 'cG5n====' }],
    }), '我上传了哪些附件'],
    ['an invalid PNG signature', withBundle({
      tiles: [{ ...bundle.tiles[0]!, dataBase64: Buffer.from('not a png').toString('base64') }],
    }), '我上传了哪些附件'],
    ['a missing IHDR chunk', withBundle({
      tiles: [{
        ...bundle.tiles[0]!,
        dataBase64: (() => {
          const bytes = Buffer.from(minimalPngBase64, 'base64')
          bytes.write('IDAT', 12, 'ascii')
          return bytes.toString('base64')
        })(),
      }],
    }), '我上传了哪些附件'],
    ['PNG dimensions that disagree with tile metadata', withBundle({
      tiles: [{ ...bundle.tiles[0]!, width: 2 }],
    }), '我上传了哪些附件'],
    ['more than 200 placements', withBundle({
      placements: Array.from({ length: 201 }, (_, index) => ({
        nodeId: `ref_${index}`, tileId: 'tile_1', x: 0, y: 0, width: 1, height: 1,
      })),
    }), '我上传了哪些附件'],
    ['a placement outside its tile', withBundle({
      placements: [{ nodeId: 'ref_degree', tileId: 'tile_1', x: 0.9, y: 0, width: 0.2, height: 1 }],
    }), '我上传了哪些附件'],
    ['an unknown placement node ID', withBundle({
      placements: [{ nodeId: 'ref_missing', tileId: 'tile_1', x: 0, y: 0, width: 1, height: 1 }],
    }), '我上传了哪些附件'],
    ['an unknown placement tile ID', withBundle({
      placements: [{ nodeId: 'ref_degree', tileId: 'tile_missing', x: 0, y: 0, width: 1, height: 1 }],
    }), '我上传了哪些附件'],
    ['duplicate tile IDs', withBundle({
      tiles: [...bundle.tiles, { ...bundle.tiles[0]! }],
    }), '我上传了哪些附件'],
    ['duplicate placement node IDs', withBundle({
      placements: [bundle.placements[0]!, { ...bundle.placements[0]!, x: 20 }],
    }), '我上传了哪些附件'],
  ])('fails closed before provider invocation for %s', async (_case, visualBundle, trustedRequest) => {
    const test = harness()

    await expect(test.run(visualBundle, trustedRequest)).resolves.toEqual(emptyResolution)
    expect(test.stream).not.toHaveBeenCalled()
  })

  it.each([
    ['unknown selected ID', { shape: 'list', selectedNodeIds: ['missing'], supportingNodeIds: [] }],
    ['unknown supporting ID', { shape: 'list', selectedNodeIds: ['ref_degree'], supportingNodeIds: ['missing'] }],
    ['duplicate selected ID', { shape: 'list', selectedNodeIds: ['ref_degree', 'ref_degree'], supportingNodeIds: [] }],
    ['duplicate supporting ID', { shape: 'list', selectedNodeIds: ['ref_degree'], supportingNodeIds: ['ref_uploaded_1', 'ref_uploaded_1'] }],
    ['overlapping selected and supporting IDs', { shape: 'list', selectedNodeIds: ['ref_degree'], supportingNodeIds: ['ref_degree'] }],
    ['non-answerable selected ID', { shape: 'list', selectedNodeIds: ['ref_table'], supportingNodeIds: [] }],
    ['multiple scalar IDs', { shape: 'scalar', selectedNodeIds: ['ref_degree', 'ref_degree_type'], supportingNodeIds: [] }],
    ['unknown output key', { shape: 'list', selectedNodeIds: ['ref_degree'], supportingNodeIds: [], answer: '学历证书' }],
    ['empty selection', { shape: 'list', selectedNodeIds: [], supportingNodeIds: [] }],
  ])('fails closed for %s', async (_case, argumentsValue) => {
    const test = harness([
      {
        type: 'tool_call', choiceIndex: 0, index: 0, id: 'call_1',
        name: 'report_browser_visual_evidence', arguments: argumentsValue,
      },
      { type: 'finish', choiceIndex: 0, reason: 'tool_calls' },
    ])

    await expect(test.run()).resolves.toEqual(emptyResolution)
  })

  it.each([
    ['ordinary prose', [
      { type: 'text_delta', choiceIndex: 0, text: '学历证书' },
      successfulEvents[0]!,
      successfulEvents[1]!,
    ]],
    ['wrong finish reason', [
      successfulEvents[0]!,
      { type: 'finish', choiceIndex: 0, reason: 'stop' },
    ]],
    ['wrong tool', [
      {
        type: 'tool_call', choiceIndex: 0, index: 0, id: 'call_1',
        name: 'report_browser_page_evidence', arguments: selectedArguments,
      },
      successfulEvents[1]!,
    ]],
    ['no tool call', [{ type: 'finish', choiceIndex: 0, reason: 'stop' }]],
    ['multiple tool calls', [successfulEvents[0]!, successfulEvents[0]!, successfulEvents[1]!]],
  ] satisfies ReadonlyArray<readonly [string, readonly ModelStreamEvent[]]>)('fails closed for %s', async (_case, events) => {
    const test = harness(events)

    await expect(test.run()).resolves.toEqual(emptyResolution)
  })

  it('fails closed on ordinary provider errors but propagates billing consistency failures', async () => {
    const ordinary = harness([], new Error('provider unavailable'))
    await expect(ordinary.run()).resolves.toEqual(emptyResolution)

    const consistency = harness()
    consistency.providerUsage.start.mockImplementationOnce(() => {
      throw new ProviderUsageConsistencyError()
    })
    await expect(consistency.run()).rejects.toBeInstanceOf(ProviderUsageConsistencyError)
  })

  it('rejects pre-stream cancellation', async () => {
    const test = harness([])
    const controller = new AbortController()
    controller.abort()

    await expect(test.run(bundle, '我上传了哪些附件', controller.signal))
      .rejects.toMatchObject({ code: 'CANCELLED' })
    expect(test.stream).not.toHaveBeenCalled()
  })

  it('propagates cancellation observed during the provider stream', async () => {
    const controller = new AbortController()
    const test = harness([])
    test.stream.mockImplementationOnce(async function* () {
      yield { type: 'finish', choiceIndex: 0, reason: 'stop' }
      controller.abort()
      throw new Error('provider aborted')
    })

    await expect(test.run(bundle, '我上传了哪些附件', controller.signal))
      .rejects.toMatchObject({ code: 'CANCELLED' })
  })

  it('rejects cancellation observed after a valid stream completes cleanly', async () => {
    const controller = new AbortController()
    const test = harness([])
    test.stream.mockImplementationOnce(async function* () {
      for (const event of successfulEvents) yield event
      controller.abort()
    })

    await expect(test.run(bundle, '我上传了哪些附件', controller.signal))
      .rejects.toMatchObject({ code: 'CANCELLED' })
  })
})
