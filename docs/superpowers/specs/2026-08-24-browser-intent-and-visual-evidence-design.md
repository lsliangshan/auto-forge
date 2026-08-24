# Browser Intent Boundary and Hybrid Visual Evidence Design

## Goal

Correct two browser-continuation behaviors:

1. A request such as `查询北京工作居住证` runs the selected workflow and opens its
   target page, but does not automatically inspect that page and answer an
   unrelated field after the workflow has completed.
2. A later request such as `我上传了哪些附件` can understand relationships across
   the whole visible attachment page. Semantic page structure remains the first
   source; when that structure is insufficient, a vision-capable model receives
   a sanitized page image together with exact page-node identifiers and uses the
   visual layout as fallback evidence.

The visual fallback is not an unrestricted screenshot-to-prose channel. The
model may reason over the image, but Main remains authoritative for page
identity, evidence membership, exact answer values, ordering, and provenance.

## Success Criteria

- `查询北京工作居住证` completes the workflow and leaves the target page open
  without an automatic `browser_session_inspect` recovery call.
- An explicit browser tool call from the primary model remains allowed after a
  workflow when the same user request genuinely asks for both workflow execution
  and page reading.
- A new user turn that asks for page data still uses browser-route recovery when
  the primary model omits the required browser call.
- Semantic evidence selection remains the first and cheapest page-answer path.
- If semantic selection returns no answer and the active model supports image
  input, Main captures only bounded, readable, sanitized page imagery and invokes
  an isolated visual evidence resolver.
- The visual resolver receives the whole bounded page context: title, ordered
  semantic nodes, parent relationships, screen rectangles, and image tiles.
- For the attachment page, the resolver can associate each attachment name with
  the status in the same visual row, return the eight uploaded attachment-name
  node IDs in page order, and exclude `职称证书和评审材料`, whose status is
  `未上传`.
- Main renders only exact text already present in selected current-snapshot
  nodes. OCR or model-authored text never becomes an unverified answer value.
- Screenshots, OCR interpretations, unused page text, and model selections remain
  run-local and are not persisted.
- Models without image support continue to use the improved semantic path and
  fail closed when the relationship cannot be confirmed.

## Scope and Boundaries

### AgentOrchestrator

The orchestrator owns two policy decisions:

- whether automatic browser-route recovery is appropriate after the primary
  model stops;
- whether an empty semantic evidence result is eligible for visual fallback.

Automatic route recovery is skipped once the current run has attempted a
workflow execution. This affects only the orchestrator-created fallback call.
It does not reject an explicit `browser_session_inspect` tool call emitted by
the primary model.

For direct page questions, the orchestrator first invokes the existing semantic
resolver. It invokes the visual resolver only when all of the following hold:

- the inspection completed the current cursor chain;
- semantic selection is empty;
- the page has current answerable nodes;
- the active frozen model supports image input;
- the binding exposes a readable region that can be captured within the image
  and privacy budgets;
- the run has not been cancelled and the page identity is unchanged.

### BrowserPageInspector

The inspector continues to own extraction and sanitization. Its semantic graph
must preserve safe structural ancestors commonly produced by non-semantic web
layouts, including generic and layout-table containers. Empty structural names
are allowed for context nodes, but those nodes are never answerable.

For visual fallback, the inspector produces a run-local visual evidence bundle:

- one to three image tiles covering the visible/readable page region in document
  order;
- the current snapshot, binding, origin, navigation epoch, capture time, and tile
  viewport metadata;
- rectangles for retained semantic nodes that intersect a tile;
- opaque evidence IDs that correspond to current semantic node refs.

The inspector does not interpret the user question and does not classify a row
as uploaded.

### Chat Model Route

The existing multimodal router already resolves the exact `ModelInfo` before an
agent run begins. It adds an internal `supportsImageInput` flag to the resolved
text route, derived from the selected model's advertised input modalities. The
application passes that immutable flag into `AgentRunInput`; the orchestrator
does not query the provider catalog again and does not infer support from a
failed request. This is an internal execution contract and does not change the
desktop API.

### BrowserVisualEvidenceResolver

A new isolated module asks a vision-capable model to select page evidence. It
receives the trusted user request, sanitized image tiles, and the exact bounded
semantic graph with overlay IDs and rectangles.

The model uses visual reading/OCR to understand headings, columns, alignment,
rows, grouping, and surrounding context. It must return exactly one strict tool
call containing only:

```json
{
  "shape": "list",
  "selectedNodeIds": ["node_12", "node_18"],
  "supportingNodeIds": ["node_2", "node_9", "node_15"]
}
```

The resolver cannot return answer prose or introduce OCR text as an answer. It
validates IDs, uniqueness, answerability, shape, model output form, and input
bounds using the same fail-closed principles as the semantic resolver.

### BrowserContinuationToolExecutor

The executor exposes one internal, read-only visual-evidence operation to the
orchestrator. It accepts the exact binding ID, snapshot ID, bounded Main-owned
cursor pages, and existing run context; verifies the active run, lease, current
page identity, stored latest snapshot, and supplied page identity; and then
delegates capture to `BrowserPageInspector`. It returns either the bounded visual
bundle or the existing safe tool-error shape. This operation is not added to the
model tool catalog and cannot perform browser mutations.

### Existing Semantic Resolver

`BrowserPageEvidenceResolver` remains unchanged in responsibility and remains
the first model-based relationship resolver. Its input graph is improved by the
additional safe structural ancestors. This avoids screenshots for pages whose
DOM/accessibility structure is already sufficient.

## Why OCR Alone Is Not the Primary Path

OCR extracts text and approximate locations but does not reliably establish
table semantics, repeated-status ownership, nested groups, or reading order. It
may also misrecognize Chinese text. A raw OCR answer would weaken the current
guarantee that Main reproduces an exact page value.

The selected design therefore uses visual-model OCR for relationship reasoning
while requiring every final answer item to map back to an exact answerable page
node. Pixel-only text may support interpretation, but it is not answer authority
in this change. Supporting canvas-only answer values would require a separate
contract with OCR confidence, independent verification, and explicit user-facing
provenance; that is outside this scope.

## Visual Capture and Privacy Policy

The existing unrestricted full-page rejection remains the default safety rule.
Visual fallback introduces a dedicated bounded capture operation with these
constraints:

- capture only configured readable regions on the admitted HTTPS origin;
- at most three tiles and at most one million pixels per tile;
- no cross-origin frames;
- no hidden or offscreen content outside the chosen tile;
- reject any candidate tile that intersects password, one-time-code, CAPTCHA,
  file-input, authentication, payment, signature, secret-token,
  identity-number, or another restricted region;
- bind every tile to the current tab, run, snapshot, origin, and navigation epoch;
- abort on page change, origin change, cancellation, capture timeout, or budget
  overflow;
- keep image bytes in memory for the active resolver call only.

Page imagery and semantic text remain untrusted evidence. They cannot alter
tools, permissions, destinations, output schemas, or safety policy.

## Data Flow

1. The user submits a trusted request.
2. If the primary model executes a workflow, the orchestrator records the real
   execution and refreshes browser bindings after completion.
3. If the primary model then stops without an explicit browser call, the
   orchestrator returns its buffered completion and provenance. It does not run
   browser-route recovery in that same workflow run.
4. On a direct page-data request, normal browser routing selects the unique
   bound page and semantic inspection captures all bounded pages in the cursor
   chain.
5. The semantic resolver selects exact answer/support node IDs. A valid result is
   rendered immediately.
6. If semantic selection is empty and visual fallback is eligible, the inspector
   is reached through the current run's `BrowserContinuationToolExecutor`; it
   captures sanitized page tiles and node rectangles for the same snapshot.
7. The visual resolver uses the screenshots and graph together to select answer
   and supporting IDs.
8. Main revalidates the selection against the unchanged snapshot and maps the
   selected IDs back to exact page-node values.
9. Main orders list results by page/node order, appends page origin and capture
   time, and discards the visual evidence bundle.
10. If either resolver cannot uniquely confirm the answer, Main returns the
    existing unable-to-confirm response.

## Interface Contracts

The visual bundle is internal and run-local:

```ts
interface BrowserVisualEvidenceTile {
  readonly tileId: string
  readonly mediaType: 'image/png'
  readonly dataBase64: string
  readonly width: number
  readonly height: number
  readonly documentX: number
  readonly documentY: number
}

interface BrowserVisualNodePlacement {
  readonly nodeId: string
  readonly tileId: string
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

interface BrowserVisualEvidenceBundle {
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

The resolved text-model route and agent run gain one internal field:

```ts
interface ResolvedChatRoute {
  // existing fields omitted
  readonly supportsImageInput: boolean
}

interface AgentRunInput {
  // existing fields omitted
  readonly supportsImageInput: boolean
}
```

The resolver returns the existing selection shape so final rendering has one
authority path:

```ts
interface BrowserPageEvidenceResolution {
  readonly shape: 'scalar' | 'list'
  readonly selectedNodeIds: readonly string[]
  readonly supportingNodeIds: readonly string[]
  readonly usage?: ModelUsageEvent
}
```

No database, workflow-manifest, renderer, or public desktop API contract changes
are required.

## Failure Handling

- A model without image support skips visual fallback.
- Screenshot capture failure, intersection with protected content, missing geometry, oversized
  imagery, invalid media, provider error, prose output, multiple tool calls,
  unknown IDs, duplicate IDs, selected context-only nodes, or stale page identity
  all produce an empty visual selection.
- Cancellation and provider-usage consistency errors retain their existing
  explicit behavior.
- Visual fallback runs at most once per evidence revision. Repeated model stops
  cannot recapture the same unchanged page indefinitely.
- The visual path cannot perform clicks, navigation, form filling, uploads, or
  other mutations.

## Testing

### Workflow intent regression

- A completed workflow that creates or refreshes a binding followed by a normal
  model stop does not invoke route recovery or browser inspection.
- The workflow completion text and provenance remain present.
- An explicit browser inspect tool call after a workflow still executes.
- A direct page question with no workflow execution still uses isolated browser
  route recovery.

### Semantic structure regression

- Generic and layout-table ancestors with empty accessible names are retained as
  context-only nodes.
- Attachment names and statuses retain a shared row/container lineage.
- Structural nodes never become answer values or action authority.
- Existing protected-content and raw-tree budget tests remain green.

### Visual capture tests

- Capture is limited to readable regions, three tiles, and the pixel budget.
- Any tile intersecting a restricted rectangle is rejected before image bytes
  can enter a model request.
- Full-page, cross-origin, stale, restricted, oversized, and cancelled captures
  fail closed.
- Tile placements reference only current known semantic node IDs.
- Image bytes and OCR reasoning are not persisted.

### Visual resolver tests

- A vision request contains the trusted question, complete sanitized graph,
  ordered tiles, and placements.
- The resolver accepts known answer/support IDs and rejects prose, hallucinated
  text, unknown or duplicate IDs, invalid shapes, stale evidence, and ordinary
  provider failures.
- The attachment fixture selects the eight uploaded names and excludes the
  not-uploaded row even when semantic parent relationships are deliberately
  ambiguous but visual row alignment is clear.

### End-to-end verification

- Run focused inspector, semantic resolver, visual resolver, and orchestrator
  tests.
- Run Electron Main type checking and the complete relevant test suite.
- Use headless fixtures only; no visible browser is required.

## Expected Files

- `apps/desktop/electron/main/agent/agent-orchestrator.ts`
- `apps/desktop/electron/main/agent/agent-orchestrator.test.ts`
- `apps/desktop/electron/main/agent/browser-visual-evidence-resolver.ts` (new)
- `apps/desktop/electron/main/agent/browser-visual-evidence-resolver.test.ts` (new)
- `apps/desktop/electron/main/agent/browser-continuation-tool-executor.ts`
- `apps/desktop/electron/main/agent/browser-continuation-tool-executor.test.ts`
- `apps/desktop/electron/main/browser/browser-continuation-types.ts`
- `apps/desktop/electron/main/browser/browser-page-inspector.ts`
- `apps/desktop/electron/main/browser/browser-page-inspector.test.ts`
- `apps/desktop/electron/main/browser/electron-browser-workspace.ts`
- `apps/desktop/electron/main/browser/electron-browser-workspace.test.ts`
- `apps/desktop/electron/main/chat/multimodal-router.ts`
- `apps/desktop/electron/main/chat/multimodal-router.test.ts`
- `apps/desktop/electron/main/application.ts`
- `apps/desktop/electron/main/application.test.ts`

No unrelated refactoring, renderer changes, workflow edits, or database changes
are in scope.
