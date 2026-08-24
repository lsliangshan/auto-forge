# Hybrid Browser Visual Evidence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Answer whole-page relationship questions with semantic evidence first and a bounded vision-model fallback when page structure is insufficient.

**Architecture:** Preserve more safe layout structure in `BrowserPageInspector`, then add a run-local visual bundle containing sanitized screenshot tiles and exact node placements. A strict multimodal resolver selects existing node IDs; `AgentOrchestrator` renders only the current Main-owned values behind those IDs.

**Tech Stack:** TypeScript 6, Electron 43 CDP, Zod 4, OpenAI-compatible multimodal messages, Vitest 4 under Electron's pinned Node ABI.

**Spec:** `docs/superpowers/specs/2026-08-24-browser-intent-and-visual-evidence-design.md`

## Global Constraints

- Execute after `docs/superpowers/plans/2026-08-24-workflow-browser-intent-boundary.md`.
- Preserve unrelated user changes; avoid adjacent refactors.
- Try semantic evidence before visual evidence.
- Allow at most three PNG tiles, one million pixels per tile, and 200 placed nodes.
- Capture only configured readable regions on the admitted HTTPS origin.
- Reject tiles intersecting protected content; do not modify or paint over the live page.
- OCR/vision text is context only; every final value maps to a current `answerable` node.
- Keep visual evidence run-local and revision-bound; never persist it.
- Skip visual fallback for models without image input.
- Do not change Renderer, database, workflow manifests, or public desktop APIs.
- Use headless/unit fixtures only.
- Write a failing test before each production change.

---

## File Structure

- `browser-continuation-types.ts`: run-local visual bundle types.
- `browser-page-inspector.ts`: layout ancestry, placements, tiling, and protected-region rejection.
- `electron-browser-workspace.ts`: current-page clip capture.
- `multimodal-router.ts` and `application.ts`: selected-model image capability propagation.
- `browser-continuation-tool-executor.ts`: current-run visual capture boundary.
- `browser-visual-evidence-resolver.ts`: strict multimodal node selector.
- `agent-orchestrator.ts`: semantic-first fallback, revision cache, and rendering integration.
- Corresponding `*.test.ts` files own focused regression coverage.

### Task 1: Preserve generic and layout-table context

**Files:**
- Modify: `apps/desktop/electron/main/browser/browser-page-inspector.test.ts`
- Modify: `apps/desktop/electron/main/browser/browser-page-inspector.ts`

**Interfaces:**
- Consumes: `BrowserInspectionNode.role`, `axNodeId`, and `parentAxNodeId`.
- Produces: existing `BrowserSemanticNode.parentRef`; no new public type.

- [ ] **Step 1: Write the failing layout-container test**

```ts
it('preserves unnamed generic and layout-table ancestors as context only', async () => {
  const port = new FakeCdpPort([
    node(10, 'main', '附件管理', { axNodeId: 'ax_main', parentAxNodeId: undefined }),
    node(20, 'generic', '', { axNodeId: 'ax_wrapper', parentAxNodeId: 'ax_main' }),
    node(21, 'LayoutTable', '', { axNodeId: 'ax_table', parentAxNodeId: 'ax_wrapper' }),
    node(22, 'LayoutTableRow', '', { axNodeId: 'ax_row', parentAxNodeId: 'ax_table' }),
    node(23, 'LayoutTableCell', '', { axNodeId: 'ax_name_cell', parentAxNodeId: 'ax_row' }),
    node(24, 'StaticText', '学历证书', { axNodeId: 'ax_name', parentAxNodeId: 'ax_name_cell' }),
    node(25, 'LayoutTableCell', '', { axNodeId: 'ax_status_cell', parentAxNodeId: 'ax_row' }),
    node(26, 'StaticText', '已上传', { axNodeId: 'ax_status', parentAxNodeId: 'ax_status_cell' }),
  ])
  const inspector = new BrowserPageInspector(port, { id: idSequence() })
  const snapshot = await inspector.inspect(input(binding(), { intent: '我上传了哪些附件' }))
  const wrapper = snapshot.nodes.find(({ role }) => role === 'generic')!
  const table = snapshot.nodes.find(({ role }) => role === 'layouttable')!
  const row = snapshot.nodes.find(({ role }) => role === 'layouttablerow')!
  const cells = snapshot.nodes.filter(({ role }) => role === 'layouttablecell')
  const name = snapshot.nodes.find(({ name }) => name === '学历证书')!
  const status = snapshot.nodes.find(({ name }) => name === '已上传')!

  expect(table.parentRef).toBe(wrapper.ref)
  expect(row.parentRef).toBe(table.ref)
  expect(name.parentRef).toBe(cells[0]!.ref)
  expect(status.parentRef).toBe(cells[1]!.ref)
  expect(wrapper.answerable).not.toBe(true)
  expect(table.answerable).not.toBe(true)
  expect(row.answerable).not.toBe(true)
  expect(name.answerable).toBe(true)
  expect(status.answerable).toBe(true)
})
```

- [ ] **Step 2: Run it and verify RED**

```bash
cd apps/desktop
node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts \
  electron/main/browser/browser-page-inspector.test.ts \
  -t "preserves unnamed generic and layout-table ancestors"
```

Expected: FAIL because the unnamed structural nodes are omitted.

- [ ] **Step 3: Retain only the required structural roles**

```ts
const layoutStructuralRoles = [
  'generic', 'layouttable', 'layouttablecell', 'layouttablerow',
] as const
```

Insert `...layoutStructuralRoles` immediately before the closing `])` of both existing sets, without changing their current entries.

Replace the unconditional empty-name rejection with:

```ts
const name = structuredField?.name ?? safeText(node.name) ?? ''
if (!name && !structuralRoles.has(role)) return []
```

Do not add these roles to action sets. Existing answerability logic keeps them context-only.

- [ ] **Step 4: Run the complete inspector tests**

```bash
cd apps/desktop
node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts \
  electron/main/browser/browser-page-inspector.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/electron/main/browser/browser-page-inspector.ts \
  apps/desktop/electron/main/browser/browser-page-inspector.test.ts
git commit -m "fix(browser): preserve layout context for page evidence"
```

### Task 2: Propagate image-input capability

**Files:**
- Modify: `apps/desktop/electron/main/chat/multimodal-router.ts`
- Modify: `apps/desktop/electron/main/chat/multimodal-router.test.ts`
- Modify: `apps/desktop/electron/main/application.ts`
- Modify: `apps/desktop/electron/main/application.test.ts`
- Modify: `apps/desktop/electron/main/agent/agent-orchestrator.ts`
- Modify: `apps/desktop/electron/main/agent/agent-orchestrator.test.ts`

**Interfaces:**
- Produces: `ResolvedChatRoute.supportsImageInput: boolean`.
- Produces: `AgentRunInput.supportsImageInput: boolean` and `ActiveAgentRun.supportsImageInput: boolean`.

- [ ] **Step 1: Add a failing route test**

```ts
it('reports image-input support from the exact selected text model', () => {
  const vision = model({
    id: 'openrouter/vision', inputModalities: ['text', 'image'],
    outputModalities: ['text'], supportsTools: true,
  })
  const textOnly = model({
    id: 'openrouter/text', inputModalities: ['text'],
    outputModalities: ['text'], supportsTools: true,
  })

  expect(resolveChatRoute(input({ requestedModel: vision.id, models: [vision] })))
    .toMatchObject({ supportsImageInput: true })
  expect(resolveChatRoute(input({ requestedModel: textOnly.id, models: [textOnly] })))
    .toMatchObject({ supportsImageInput: false })
})
```

- [ ] **Step 2: Run it and verify RED**

```bash
cd apps/desktop
node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts \
  electron/main/chat/multimodal-router.test.ts -t "reports image-input support"
```

Expected: FAIL because the route field is absent.

- [ ] **Step 3: Add the route field**

```ts
export interface ResolvedChatRoute {
  provider: ModelProviderId
  model: string
  contextLength?: number
  supportsTools: boolean
  supportsImageInput: boolean
  outputType: ConcreteOutput
  assets: ResolvedMediaAsset[]
  generation: GenerationOptions
  imageParameterSupport?: ModelImageParameterSupport
  videoFrameImages?: VideoFrameType[]
  videoUsesInputReferences?: boolean
}
```

Add this exact return property in `route()`:

```ts
supportsImageInput: output === 'text' && model.inputModalities.includes('image'),
```

- [ ] **Step 4: Add application propagation coverage**

Use the existing application runtime fixture and `visionTextModelInfo` helper:

```ts
const run = vi.spyOn(AgentOrchestrator.prototype, 'run').mockResolvedValue({
  requestId: 'vision_request', status: 'completed',
})
const root = await mkdtemp(join(tmpdir(), 'autoforge-vision-route-'))
directories.push(root)
const provider = snapshotProvider('openrouter', {
  listModels: vi.fn(async () => [visionTextModelInfo('openrouter/vision')]),
  validateCredential: vi.fn(async () => ({ valid: true })),
  stream: vi.fn(async function* () {
    yield { type: 'finish' as const, choiceIndex: 0, reason: 'stop' }
  }),
})
const runtime = createApplicationRuntime(options(root, {
  modelProviders: { openrouter: provider },
}))
await authenticate(runtime)
await runtime.services.settings.saveProviderApiKey('openrouter', 'sk-openrouter')
const settings = await runtime.services.settings.get()
await runtime.services.settings.update({
  activeProvider: 'openrouter',
  defaultModels: {
    ...settings.defaultModels,
    openrouter: { text: 'openrouter/vision' },
  },
})
const conversation = await runtime.services.chat.createConversation()
await runtime.services.chat.send(chatInput(conversation.id, '读取附件页面'))
await vi.waitFor(() => expect(run).toHaveBeenCalled())
expect(run).toHaveBeenCalledWith(expect.objectContaining({ supportsImageInput: true }))
await runtime.close()
```

- [ ] **Step 5: Pass and freeze the capability**

```ts
readonly supportsImageInput: boolean
```

Insert that property in both `AgentRunInput` and `ActiveAgentRun`. Pass `supportsImageInput: route.supportsImageInput` from `application.ts`, copy it into the active initializer, and add `supportsImageInput: false` to the `textRunInput` test helper.

- [ ] **Step 6: Run affected suites**

```bash
cd apps/desktop
node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts \
  electron/main/chat/multimodal-router.test.ts \
  electron/main/application.test.ts \
  electron/main/agent/agent-orchestrator.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/electron/main/chat/multimodal-router.ts \
  apps/desktop/electron/main/chat/multimodal-router.test.ts \
  apps/desktop/electron/main/application.ts \
  apps/desktop/electron/main/application.test.ts \
  apps/desktop/electron/main/agent/agent-orchestrator.ts \
  apps/desktop/electron/main/agent/agent-orchestrator.test.ts
git commit -m "feat(browser): propagate vision input capability"
```

### Task 3: Add an identity-checked page clip primitive

**Files:**
- Modify: `apps/desktop/electron/main/browser/browser-page-inspector.ts`
- Modify: `apps/desktop/electron/main/browser/electron-browser-workspace.ts`
- Modify: `apps/desktop/electron/main/browser/electron-browser-workspace.test.ts`

**Interfaces:**
- Produces `BrowserPageCdpPort.capturePageScreenshot(input): Promise<string>`.

- [ ] **Step 1: Define the input and write failing workspace tests**

```ts
interface BrowserPageScreenshotInput extends BrowserPageReadInput {
  readonly clip: Pick<BrowserInspectionNodeBox, 'x' | 'y' | 'width' | 'height'>
}
```

Add this assertion to a new workspace test using the existing `workspace.acquire(executionInput())` fixture sequence:

```ts
const tab = await workspace.acquire(executionInput())
await tab.open('https://www.baidu.com/detail', ['https://www.baidu.com'])
await workspace.releaseExecution('e1')
await workspace.acquireContinuation(tab.id, 'run_1')

await expect(workspace.capturePageScreenshot({
  tabId: tab.id, runId: 'run_1', expectedOrigin: 'https://www.baidu.com',
  expectedNavigationEpoch: tab.navigationEpoch, locators: [],
  clip: { x: 10, y: 20, width: 500, height: 300 },
})).resolves.toBe('cG5n')

expect(target.debugger.commands).toContainEqual({
  method: 'Page.captureScreenshot',
  params: {
    format: 'png', fromSurface: true, captureBeyondViewport: true,
    clip: { x: 10, y: 20, width: 500, height: 300, scale: 1 },
  },
})
```

Mock `Page.captureScreenshot` as `{ data: 'cG5n' }`. Add a second test that changes navigation epoch before the command returns and expects `PAGE_CHANGED`.

- [ ] **Step 2: Run and verify RED**

```bash
cd apps/desktop
node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts \
  electron/main/browser/electron-browser-workspace.test.ts \
  -t "bounded page clip|page clip changes"
```

Expected: FAIL because the method is absent.

- [ ] **Step 3: Implement the clip primitive**

```ts
async capturePageScreenshot(
  input: Parameters<BrowserPageCdpPort['capturePageScreenshot']>[0],
): Promise<string> {
  const state = this.continuationState(input)
  return this.restricted(state, [input.expectedOrigin], async () => {
    this.assertContinuationState(state, input)
    const { x, y, width, height } = input.clip
    if (![x, y, width, height].every(Number.isFinite)
      || x < 0 || y < 0 || width <= 0 || height <= 0
      || width * height > 1_000_000) throw failure('UNSUPPORTED_CONTROL')
    const screenshot = await this.command(state, 'Page.captureScreenshot', {
      format: 'png', fromSurface: true, captureBeyondViewport: true,
      clip: { x, y, width, height, scale: 1 },
    }) as { data?: unknown }
    this.assertContinuationState(state, input)
    if (typeof screenshot.data !== 'string' || screenshot.data.length === 0) {
      throw failure('INTERNAL_ERROR')
    }
    return screenshot.data
  })
}
```

- [ ] **Step 4: Run workspace and inspector suites**

```bash
cd apps/desktop
node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts \
  electron/main/browser/electron-browser-workspace.test.ts \
  electron/main/browser/browser-page-inspector.test.ts
```

Add a `capturePageScreenshot` stub to every `BrowserPageCdpPort` fixture that TypeScript reports. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/electron/main/browser/browser-page-inspector.ts \
  apps/desktop/electron/main/browser/electron-browser-workspace.ts \
  apps/desktop/electron/main/browser/electron-browser-workspace.test.ts \
  apps/desktop/electron/main/browser/browser-page-inspector.test.ts
git commit -m "feat(browser): capture bounded page evidence clips"
```

### Task 4: Build safe visual bundles in the inspector

**Files:**
- Modify: `apps/desktop/electron/main/browser/browser-continuation-types.ts`
- Modify: `apps/desktop/electron/main/browser/browser-page-inspector.ts`
- Modify: `apps/desktop/electron/main/browser/browser-page-inspector.test.ts`

**Interfaces:**
- Produces the spec's `BrowserVisualEvidenceTile`, `BrowserVisualNodePlacement`, and `BrowserVisualEvidenceBundle`.
- Produces:

```ts
export interface BrowserVisualEvidenceInput extends BrowserPageContextInput {
  readonly pages: readonly BrowserPageSnapshot[]
}

captureVisualEvidence(input: BrowserVisualEvidenceInput): Promise<BrowserVisualEvidenceBundle>
```

- [ ] **Step 1: Add the run-local value types**

```ts
export interface BrowserVisualEvidenceTile {
  readonly tileId: string
  readonly mediaType: 'image/png'
  readonly dataBase64: string
  readonly width: number
  readonly height: number
  readonly documentX: number
  readonly documentY: number
}

export interface BrowserVisualNodePlacement {
  readonly nodeId: string
  readonly tileId: string
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export interface BrowserVisualEvidenceBundle {
  readonly snapshotId: string
  readonly bindingId: string
  readonly origin: string
  readonly navigationEpoch: number
  readonly capturedAt: string
  readonly pages: readonly BrowserPageSnapshot[]
  readonly tiles: readonly BrowserVisualEvidenceTile[]
  readonly placements: readonly BrowserVisualNodePlacement[]
}
```

- [ ] **Step 2: Write failing success and rejection tests**

Build a readable attachment fixture with deterministic `getNodeBox` results. Assert:

```ts
const bundle = await inspector.captureVisualEvidence({
  lease, tabId: 'tab_1', navigationEpoch: 1,
  origin: 'https://fw.bjrcgz.gov.cn', pages: [snapshot],
})

expect(bundle).toMatchObject({
  snapshotId: snapshot.snapshotId,
  bindingId: snapshot.bindingId,
  origin: snapshot.origin,
  navigationEpoch: snapshot.navigationEpoch,
  tiles: [expect.objectContaining({
    mediaType: 'image/png', dataBase64: 'cG5n', width: 1_000,
  })],
})
expect(bundle.placements.map(({ nodeId }) => nodeId)).toEqual(
  expect.arrayContaining(snapshot.nodes.filter(({ answerable }) => answerable).map(({ ref }) => ref)),
)
```

Add table-driven rejections for: cursor present; mismatched snapshot/binding/origin/epoch; over 200 nodes; more than three one-megapixel tiles; missing answerable-node geometry; and protected geometry intersecting a tile. For protected intersection, assert `capturePageScreenshot` was not called.

- [ ] **Step 3: Run and verify RED**

```bash
cd apps/desktop
node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts \
  electron/main/browser/browser-page-inspector.test.ts \
  -t "visual evidence bundle|visual evidence rejects"
```

Expected: FAIL because the method does not exist.

- [ ] **Step 4: Implement identity and geometry validation**

```ts
const maxVisualTiles = 3
const maxVisualNodes = 200
const maxVisualTilePixels = 1_000_000

const [firstPage] = input.pages
if (!firstPage
  || input.pages.some((page) => page.cursor !== undefined
    || page.snapshotId !== firstPage.snapshotId
    || page.bindingId !== firstPage.bindingId
    || page.origin !== firstPage.origin
    || page.navigationEpoch !== firstPage.navigationEpoch)) {
  throw failure('INVALID_INPUT')
}

const located = input.pages.flatMap((page) => page.nodes.map((node) => ({
  node,
  state: this.refs.get(node.ref),
})))
if (located.length === 0 || located.length > maxVisualNodes) {
  throw failure('ACTION_LIMIT_EXCEEDED')
}
if (located.some(({ state }) => !state || !this.sameIdentity(state, {
  runId: input.lease.ownerRunId,
  bindingId: firstPage.bindingId,
  tabId: input.tabId,
  snapshotId: firstPage.snapshotId,
  navigationEpoch: firstPage.navigationEpoch,
  origin: firstPage.origin,
}))) throw failure('PAGE_CHANGED')
```

Re-read the AX snapshot with `policyLocators(binding)`, verify identity, call `getNodeBox` for each retained non-restricted state, and require geometry for every answerable node. Compute the minimal union and split vertically so `width * height <= maxVisualTilePixels`; reject more than `maxVisualTiles`.

Use this exact intersection predicate against boxes of `visibleNodes.filter(imageRestrictedNode)` before capture:

```ts
function rectanglesIntersect(left: BrowserInspectionNodeBox, right: BrowserInspectionNodeBox): boolean {
  return left.x < right.x + right.width
    && left.x + left.width > right.x
    && left.y < right.y + right.height
    && left.y + left.height > right.y
}
```

Call `capturePageScreenshot` once per accepted tile. Freeze arrays. Never store image bytes in refs, cursors, snapshots, or logs.

- [ ] **Step 5: Run all inspector tests**

```bash
cd apps/desktop
node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts \
  electron/main/browser/browser-page-inspector.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/electron/main/browser/browser-continuation-types.ts \
  apps/desktop/electron/main/browser/browser-page-inspector.ts \
  apps/desktop/electron/main/browser/browser-page-inspector.test.ts
git commit -m "feat(browser): assemble safe visual evidence bundles"
```

### Task 5: Enforce current-run capture through the executor

**Files:**
- Modify: `apps/desktop/electron/main/agent/browser-continuation-tool-executor.ts`
- Modify: `apps/desktop/electron/main/agent/browser-continuation-tool-executor.test.ts`

**Interfaces:**
- Consumes: `BrowserPageInspector.captureVisualEvidence`.
- Produces:

```ts
export type BrowserVisualEvidenceResult =
  | { readonly kind: 'success'; readonly data: BrowserVisualEvidenceBundle }
  | { readonly kind: 'tool_error'; readonly code: AppErrorCode }

captureVisualEvidence(
  input: {
    readonly bindingId: string
    readonly snapshotId: string
    readonly pages: readonly BrowserPageSnapshot[]
  },
  context: BrowserContinuationRunContext,
): Promise<BrowserVisualEvidenceResult>
```

- [ ] **Step 1: Write failing executor tests**

Extend the executor harness inspector with a `captureVisualEvidence` mock. After an ordinary semantic inspection has stored `snapshot_1`, assert:

```ts
await expect(test.executor.captureVisualEvidence({
  bindingId: 'binding_1', snapshotId: 'snapshot_1', pages: [snapshot],
}, context())).resolves.toEqual({ kind: 'success', data: visualBundle })

expect(test.inspector.captureVisualEvidence).toHaveBeenCalledWith(expect.objectContaining({
  lease: expect.objectContaining({ ownerRunId: 'agent_run_1' }),
  tabId: 'tab_1', navigationEpoch: 1,
  origin: 'https://permit.example.gov.cn',
  pages: [expect.objectContaining({ snapshotId: 'snapshot_1' })],
}))
```

Add failures for unknown run, wrong binding, unknown snapshot, stale workspace state, aborted context, and inspector failure.

- [ ] **Step 2: Run and verify RED**

```bash
cd apps/desktop
node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts \
  electron/main/agent/browser-continuation-tool-executor.test.ts -t "visual evidence"
```

Expected: FAIL because the executor method is absent.

- [ ] **Step 3: Implement the read-only bridge**

Validate `context.runId` against `this.runs`, `isRunActive`, exact binding, active lease, stored latest snapshot, and `workspace.getContinuationState`. Require all supplied pages to share the input snapshot/binding/origin/epoch, require the final supplied page to equal the executor's stored latest snapshot, and require the workspace origin/epoch to match. Delegate with the supplied pages in their existing order.

Use this error boundary:

```ts
try {
  const data = await this.dependencies.inspector.captureVisualEvidence(captureInput)
  if (!this.isRunActive(context.runId) || context.signal?.aborted) {
    return { kind: 'tool_error', code: 'CANCELLED' }
  }
  return { kind: 'success', data }
} catch (error) {
  return { kind: 'tool_error', code: toSafeAppError(error).code }
}
```

Do not add the method to `BrowserContinuationToolName`, the model catalog, mutation budgets, or browser action audits.

- [ ] **Step 4: Run executor tests**

```bash
cd apps/desktop
node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts \
  electron/main/agent/browser-continuation-tool-executor.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/electron/main/agent/browser-continuation-tool-executor.ts \
  apps/desktop/electron/main/agent/browser-continuation-tool-executor.test.ts
git commit -m "feat(browser): expose run-bound visual evidence capture"
```

### Task 6: Implement the strict multimodal resolver

**Files:**
- Create: `apps/desktop/electron/main/agent/browser-visual-evidence-resolver.ts`
- Create: `apps/desktop/electron/main/agent/browser-visual-evidence-resolver.test.ts`
- Modify: `apps/desktop/electron/main/agent/browser-page-evidence-resolver.ts` only to export the existing resolution interface if required

**Interfaces:**
- Consumes: trusted request, `BrowserVisualEvidenceBundle`, provider snapshot/usage, model/run identity, revision, cancellation signal, ID, and clock.
- Produces: `BrowserPageEvidenceResolution`.

- [ ] **Step 1: Write the resolver success test**

Build one PNG tile, ambiguous semantic parents, and placements for names/statuses. Mock `report_browser_visual_evidence` selecting two name IDs. Assert:

```ts
const request = stream.mock.calls[0]![0]
expect(request.messages.at(-1)).toEqual({
  role: 'user',
  content: [
    expect.objectContaining({ type: 'text', text: expect.stringContaining('我上传了哪些附件') }),
    { type: 'media', kind: 'image', mimeType: 'image/png', dataBase64: 'cG5n' },
  ],
})
expect(result).toEqual({
  shape: 'list',
  selectedNodeIds: ['ref_degree', 'ref_degree_type'],
  supportingNodeIds: ['ref_uploaded_1', 'ref_uploaded_2'],
  usage,
})
```

- [ ] **Step 2: Add strict failure tests**

Cover invalid request, more than three tiles, over one million pixels, invalid base64, over 200 placements, placement outside tile, unknown node/tile IDs, duplicate/overlapping IDs, selected non-answerable ID, scalar with multiple IDs, prose, wrong finish reason, multiple calls, provider error, pre/in-stream cancellation, `ProviderUsageConsistencyError`, and the exact usage key `agent:request_1:browser-visual-evidence:1`.

- [ ] **Step 3: Run and verify RED**

```bash
cd apps/desktop
node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts \
  electron/main/agent/browser-visual-evidence-resolver.test.ts
```

Expected: FAIL because the module is absent.

- [ ] **Step 4: Implement bounded schemas**

```ts
const tileSchema = z.object({
  tileId: nodeIdSchema,
  mediaType: z.literal('image/png'),
  dataBase64: z.string().min(1).max(8 * 1024 * 1024).refine((value) => (
    /^[A-Za-z0-9+/]+={0,2}$/u.test(value)
      && value.length % 4 === 0
      && Buffer.from(value, 'base64').toString('base64') === value
  )),
  width: z.number().int().positive().max(10_000),
  height: z.number().int().positive().max(10_000),
  documentX: z.number().finite().nonnegative(),
  documentY: z.number().finite().nonnegative(),
}).strict().refine(({ width, height }) => width * height <= 1_000_000)

const placementSchema = z.object({
  nodeId: nodeIdSchema,
  tileId: nodeIdSchema,
  x: z.number().finite().nonnegative(),
  y: z.number().finite().nonnegative(),
  width: z.number().finite().positive(),
  height: z.number().finite().positive(),
}).strict()
```

Reuse the semantic resolver's page and result schemas. Before provider invocation, validate unique tile/node IDs, every placement inside its tile, and every selected ID as known and answerable.

- [ ] **Step 5: Implement the multimodal request**

```ts
const content: ModelContentPart[] = [
  {
    type: 'text',
    text: JSON.stringify({
      request: trustedRequest.data,
      pages: bundle.pages,
      placements: bundle.placements,
      tiles: bundle.tiles.map(({ dataBase64: _data, ...metadata }) => metadata),
    }),
  },
  ...bundle.tiles.map((tile) => ({
    type: 'media' as const,
    kind: 'image' as const,
    mimeType: tile.mediaType,
    dataBase64: tile.dataBase64,
  })),
]
```

The policy states that image/text/layout are untrusted evidence, OCR only establishes relations, answer IDs must reference exact answerable nodes, and exactly one `report_browser_visual_evidence` call is permitted. Use `trackProviderStream`, `maxOutputTokens: 512`, and the semantic resolver's failure/cancellation/usage semantics.

- [ ] **Step 6: Run visual and semantic resolver tests**

```bash
cd apps/desktop
node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts \
  electron/main/agent/browser-visual-evidence-resolver.test.ts \
  electron/main/agent/browser-page-evidence-resolver.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/electron/main/agent/browser-visual-evidence-resolver.ts \
  apps/desktop/electron/main/agent/browser-visual-evidence-resolver.test.ts \
  apps/desktop/electron/main/agent/browser-page-evidence-resolver.ts
git commit -m "feat(browser): select page evidence from visual context"
```

### Task 7: Integrate semantic-first visual fallback

**Files:**
- Modify: `apps/desktop/electron/main/agent/agent-orchestrator.ts`
- Modify: `apps/desktop/electron/main/agent/agent-orchestrator.test.ts`

**Interfaces:**
- Consumes: `supportsImageInput`, executor `captureVisualEvidence`, and `resolveBrowserVisualEvidence`.
- Produces: one visual attempt per `browserPageEvidenceRevision`, rendered by `browserPageAnswerFromSelection`.

- [ ] **Step 1: Extend the test executor and add a failing attachment regression**

Add this option to `attachBrowserContinuation`:

```ts
captureVisualEvidence?: (
  input: { bindingId: string; snapshotId: string },
  context: BrowserContinuationRunContext,
) => Promise<BrowserVisualEvidenceResult>
```

Expose `captureVisualEvidence: vi.fn(options.captureVisualEvidence)` on the executor mock. Create a snapshot whose name/status nodes are answerable but share one ambiguous parent. Set up provider turns in this order:

```ts
const dependencies = harness([
  [
    {
      type: 'tool_call', choiceIndex: 0, index: 0, id: 'inspect',
      name: 'browser_session_inspect',
      arguments: { bindingId: 'binding_1', intent: '读取附件管理页面' },
    },
    { type: 'finish', choiceIndex: 0, reason: 'tool_calls' },
  ],
  [
    {
      type: 'tool_call', choiceIndex: 0, index: 0, id: 'semantic_empty',
      name: 'report_browser_page_evidence',
      arguments: { shape: 'list', selectedNodeIds: [], supportingNodeIds: [] },
    },
    { type: 'finish', choiceIndex: 0, reason: 'tool_calls' },
  ],
  [
    {
      type: 'tool_call', choiceIndex: 0, index: 0, id: 'visual_answer',
      name: 'report_browser_visual_evidence',
      arguments: {
        shape: 'list',
        selectedNodeIds: uploadedAttachmentNodeIds,
        supportingNodeIds: uploadedStatusNodeIds,
      },
    },
    { type: 'finish', choiceIndex: 0, reason: 'tool_calls' },
  ],
])
```

Return `inspectedSnapshot(flatAttachmentNodes)` from `execute` and `{ kind: 'success', data: visualBundle }` from `captureVisualEvidence`. Run with `supportsImageInput: true`. Assert all eight uploaded names, absence of `职称证书和评审材料`, original page order, provenance, one capture, and no screenshot/base64 in persisted terminal blocks.

- [ ] **Step 2: Add failing eligibility and cache cases**

Use `it.each` to assert `captureVisualEvidence` is not called when semantic selection succeeds, `supportsImageInput` is false, a cursor remains, there are no answerable nodes, or the user authorized navigation/mutation. Add capture-error and empty-visual-selection cases. Allow the normal model stop to call `browserAnswer` after an empty early result and assert only one capture/resolver request for the unchanged revision.

- [ ] **Step 3: Run and verify RED**

```bash
cd apps/desktop
node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts \
  electron/main/agent/agent-orchestrator.test.ts \
  -t "visual attachment|visual fallback|vision input"
```

Expected: FAIL because the fallback is not wired.

- [ ] **Step 4: Add revision-bound state**

```ts
browserVisualEvidenceMatchRevision?: number
browserVisualEvidenceSelection?: BrowserPageEvidenceResolution
```

Insert both properties in `ActiveAgentRun`. Clear both fields in `clearBrowserPageEvidence` and in existing navigation/manual-resume snapshot supersession paths.

- [ ] **Step 5: Implement visual fallback**

```ts
private async matchedBrowserVisualPageAnswer(active: ActiveAgentRun): Promise<string | undefined> {
  if (!active.supportsImageInput
    || active.browserEvidencePages.length === 0
    || active.browserEvidencePages.at(-1)?.cursor !== undefined
    || !active.browserEvidencePages.some((page) => page.nodes.some(({ answerable }) => answerable === true))
    || active.browserAuthorization.mutationTypes.length > 0
    || active.browserAuthorization.navigationUrls.size > 0) return undefined

  if (active.browserVisualEvidenceMatchRevision === active.browserPageEvidenceRevision) {
    return this.browserPageAnswerFromSelection(active, active.browserVisualEvidenceSelection)
  }
  const revision = active.browserPageEvidenceRevision
  const snapshot = active.browserEvidencePages[0]!
  const browser = this.dependencies.browserContinuation
  if (!browser) return undefined
  const captured = await browser.executor.captureVisualEvidence({
    bindingId: snapshot.bindingId,
    snapshotId: snapshot.snapshotId,
    pages: Object.freeze([...active.browserEvidencePages]),
  }, {
    userId: active.userId,
    conversationId: active.conversationId,
    runId: active.runId,
    currentUser: active.currentUser,
    signal: active.controller.signal,
  })
  if (captured.kind !== 'success') {
    active.browserVisualEvidenceMatchRevision = revision
    active.browserVisualEvidenceSelection = undefined
    return undefined
  }
  const selection = await resolveBrowserVisualEvidence({
    trustedRequest: active.browserAuthorization.trustedRequest,
    bundle: captured.data,
    providerSnapshot: active.providerSnapshot,
    providerUsage: this.dependencies.providerUsage,
    model: active.model,
    userId: active.userId,
    requestId: active.requestId,
    evidenceRevision: revision,
    chatRunId: active.runId,
    signal: active.controller.signal,
    id: this.id,
    now: this.now,
  })
  if (selection.usage) this.addUsage(active, selection.usage)
  if (active.cancelled || active.controller.signal.aborted) throw appFailure('CANCELLED')
  if (active.browserPageEvidenceRevision !== revision) return undefined
  active.browserVisualEvidenceMatchRevision = revision
  active.browserVisualEvidenceSelection = selection
  return this.browserPageAnswerFromSelection(active, selection)
}
```

- [ ] **Step 6: Preserve resolver order in both answer paths**

In early inspection and `browserAnswer`, use:

```ts
const answer = await this.matchedBrowserEvidenceAnswer(active)
  ?? await this.matchedBrowserPageAnswer(active)
  ?? await this.matchedBrowserVisualPageAnswer(active)
```

Use `answer` in the existing early-return or final-answer branch. Do not put bundle bytes in `active.messages`, browser tool results, blocks, persistence, logs, or provenance.

- [ ] **Step 7: Run affected Agent suites**

```bash
cd apps/desktop
node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts \
  electron/main/agent/agent-orchestrator.test.ts \
  electron/main/agent/browser-page-evidence-resolver.test.ts \
  electron/main/agent/browser-visual-evidence-resolver.test.ts \
  electron/main/agent/browser-continuation-tool-executor.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/desktop/electron/main/agent/agent-orchestrator.ts \
  apps/desktop/electron/main/agent/agent-orchestrator.test.ts
git commit -m "feat(browser): fall back to visual page evidence"
```

### Task 8: Final verification

**Files:**
- Verify every file named in this plan.

**Interfaces:**
- Consumes: Tasks 1-7.
- Produces: verified hybrid evidence behavior ready on `v2`.

- [ ] **Step 1: Run every directly affected Main test**

```bash
cd apps/desktop
node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts \
  electron/main/browser/browser-page-inspector.test.ts \
  electron/main/browser/electron-browser-workspace.test.ts \
  electron/main/chat/multimodal-router.test.ts \
  electron/main/agent/browser-page-evidence-resolver.test.ts \
  electron/main/agent/browser-visual-evidence-resolver.test.ts \
  electron/main/agent/browser-continuation-tool-executor.test.ts \
  electron/main/agent/agent-orchestrator.test.ts \
  electron/main/application.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run type checking and lint**

```bash
pnpm --filter @autoforge/desktop typecheck
pnpm lint
```

Expected: PASS. If root lint exposes an unrelated existing failure, rerun ESLint on only changed TypeScript files and report both results separately.

- [ ] **Step 3: Run the full repository tests**

```bash
pnpm test
```

Expected: PASS.

- [ ] **Step 4: Build and inspect repository state**

```bash
pnpm build
git diff --check
git status --short
```

Expected: build PASS, no whitespace errors, and no unintended files.

- [ ] **Step 5: Handle any change-related verification failure test-first**

For a change-related failure, return to the task that owns the failing interface, add a focused regression assertion, confirm it fails, make the smallest correction, and rerun that task's focused command plus Steps 1-4 above. Commit through that owning task's explicit file list. Do not create an empty verification commit. Report exact test counts and clearly separate any reproduced pre-existing failure.
