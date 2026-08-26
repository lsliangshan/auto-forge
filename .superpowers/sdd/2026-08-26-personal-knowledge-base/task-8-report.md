# Task 8 Report: Agent routing, grounding, and citation UI

## Implementation

- Extended the Main-owned `AgentOrchestrator` without replacing its identity or existing workflow, conditional browser-continuation, and tool-unavailable policies. Exact unique workflow-only launches now suppress both browser and knowledge continuation for the whole request; composite requests offer knowledge only after a workflow completes, while failed or cancelled workflow status remains first and visible.
- Added fixed Main-owned Agent budgets: at most five workflow invocations, three knowledge searches, ten total model decisions (including active browser continuation), and eight aggregate evidence items. `knowledge_search` accepts only strict `query` plus optional `rewrite`; user/conversation identity, knowledge-base selection, paths, SQL, topK, index/generation IDs, consent, and provider are never model-controlled.
- Restricted knowledge routing to selected, immutable Main snapshots supplied only for text output on tool-capable models. `KnowledgeService.captureSearchSnapshot()` freezes owner/conversation selection, active ready version IDs, and any eligible CloudRetriever published-generation snapshot before mutable selection/import/replace/recycle activity can affect the turn. The opaque public token exposes only `selected` and strict/mixed mode; service-private scope lives in a `WeakMap` and is invalidated on close.
- Added snapshot-bound local retrieval by exact version IDs and preserved the Task 7 cloud kill switch and fail-closed local fallback. Each result is revalidated by the existing strict shared outcome schema before Agent accepts it.
- Added status-only search output, untrusted JSON evidence delimiters, provider-scoped first-use snippet disclosure consent, retrieval-only denial output, strict no-evidence refusal, explicitly labelled mixed-mode general claims, current-turn citation validation, and exactly one citation-repair attempt. Provider text remains buffered and invisible until tool/citation validation succeeds.
- Persisted only claim text plus immutable document/version/source coordinates. Snippets, evidence IDs in historical context, filenames, paths, permanent URLs, hidden chunks, provider controls, and mutable index/generation identifiers are excluded. Context compression serializes safe PDF, DOCX, Markdown/HTML, and TXT coordinates only.
- Added strict shared DTOs and authenticated IPC/Preload methods for consent and citation preview. Renderer submits only persisted message position (`conversationId`, `messageId`, `blockId`, `citationIndex`); Main resolves the owned persisted citation, and `KnowledgeService` verifies the exact document/version/chunk/coordinate tuple. Recycled or purged sources render unavailable.
- Added `KnowledgeStatusCard` and `KnowledgeAnswer` rendering with nearby citations, explicit mixed/general labelling, compact sources, controlled local previews, and source-specific coordinate labels. Live knowledge status now replaces by stable Main-owned block ID.
- Preserved separate TokenHub embedding consent, privacy-safe logs, cloud/beta defaults, kill-switch behavior, and all unrelated context-limit behavior. No real CloudBase or TokenHub endpoint was contacted and no external gate was enabled.

## Exact RED/GREEN evidence

### Baseline before production changes

- `pnpm test apps/desktop/electron/main/agent/agent-orchestrator.test.ts apps/desktop/electron/main/application.test.ts apps/desktop/electron/main/chat/conversation-context.test.ts packages/shared/src/contracts.test.ts apps/desktop/tests/components/chat.test.ts` -> 606 passed / 1 failed. The sole failure was the pre-existing `application.test.ts > bills real context-summary streams through the Application-supplied provider snapshot`, which returns `CONTEXT_LIMIT_EXCEEDED`.

### Intended RED before each minimal slice

- `pnpm test packages/shared/src/contracts.test.ts --reporter=verbose` -> 2 failed / 78 passed: `knowledge_status` was not a valid block and the controlled citation-preview API was absent.
- `pnpm test apps/desktop/electron/main/knowledge/knowledge-service.test.ts -t "captures immutable selection|resolves an exact citation" --reporter=dot` -> 2 failed / 36 skipped because snapshot capture/search and Main citation preview did not exist.
- `pnpm test apps/desktop/electron/main/agent/agent-orchestrator.test.ts -t "Agent knowledge grounding" --reporter=dot` -> 12 failed / 3 passed / 191 skipped. Missing behavior covered KB-only and workflow-to-KB routing, strict/mixed grounding, scope rejection, 3/10/8 limits, untrusted evidence, citation repair, and disclosure consent; the three inherited boundaries already green were retained.
- Focused context-history RED -> 1 failed / 32 skipped with `Historical block type is invalid`, proving knowledge history was not yet serialized safely.
- Focused IPC RED -> 1 failed / 29 skipped because the authenticated provider-consent handler was absent.
- Focused Preload RED -> 1 failed / 17 skipped because `decideKnowledgeConsent` was absent.
- Focused Renderer RED -> 3 failed / 155 skipped because search status, nearby grounded claims/sources, and controlled unavailable preview were absent.
- Focused Application snapshot RED -> snapshot capture was called zero times, proving the text/tool routing boundary was not production-wired.
- Self-review RED command:

  `pnpm test apps/desktop/electron/main/application.test.ts apps/desktop/tests/components/chat.test.ts -t 'persists snippet-disclosure consent|renders both the DOCX heading|replaces live knowledge-search status' --reporter=dot`

  Result: 3 failed / 311 skipped. It proved a non-pending owned request could persist consent before Agent rejection, live status remained `searching`, and DOCX display omitted the paragraph coordinate.

### GREEN after implementation

- Every focused RED above passed after its corresponding minimal implementation.
- `pnpm test apps/desktop/electron/main/agent/agent-orchestrator.test.ts apps/desktop/electron/main/agent/workflow-tool-loop.test.ts apps/desktop/electron/main/chat/conversation-context.test.ts apps/desktop/electron/main/knowledge/knowledge-service.test.ts apps/desktop/electron/main/ipc/register-ipc.test.ts apps/desktop/electron/preload/bridge.test.ts packages/shared/src/contracts.test.ts apps/desktop/tests/components/chat.test.ts --reporter=dot` -> 8 files passed / 573 tests passed.
- `pnpm test apps/desktop/electron/main/application.test.ts -t 'captures one Main-owned knowledge snapshot|persists snippet-disclosure consent|resolves citation previews' --reporter=dot` -> 3 passed / 151 skipped. The snapshot case covers tool-capable text, non-tool text, and non-text image routing.
- Full `application.test.ts` -> 153 passed / exactly 1 preserved failure, the same unrelated `CONTEXT_LIMIT_EXCEEDED` baseline and no Task 8 regression.
- `pnpm typecheck` -> all four typed workspace projects passed.
- `pnpm lint` -> exit 0, 0 errors / 459 existing-style warnings.
- `pnpm build` -> shared/workflow packages and Electron Main, Preload, Renderer, and worker production builds passed.
- `pnpm --filter @autoforge/desktop smoke:knowledge-ui` on the exact final tree -> exit 0 with `{ "ok": true }`; the real Electron window imported and indexed TXT, rendered the knowledge workspace and selector, persisted strict selection, and restored it.
- `git diff --check` -> clean.

## Files changed

- Agent routing and budgets: `apps/desktop/electron/main/agent/agent-orchestrator.ts`, `workflow-tool-loop.ts`, and their tests.
- Main ownership and immutable retrieval: `apps/desktop/electron/main/application.ts`, `knowledge/knowledge-service.ts`, `knowledge/knowledge-types.ts`, `knowledge/local-retriever.ts`, and their tests.
- Safe history: `apps/desktop/electron/main/chat/conversation-context.ts` and its test.
- Shared/IPC/Preload: `packages/shared/src/events.ts`, `packages/shared/src/desktop-api.ts`, `packages/shared/src/contracts.test.ts`, `apps/desktop/electron/main/ipc/register-ipc.ts`, its test, `apps/desktop/electron/preload/bridge.ts`, and its test.
- Renderer: `KnowledgeStatusCard.vue`, `KnowledgeAnswer.vue`, `MessageBlock.vue`, `ChatView.vue`, `apps/desktop/src/stores/chat.ts`, and `apps/desktop/tests/components/chat.test.ts`.
- Evidence: this report. The controller-owned dirty `progress.md` was left untouched and is explicitly excluded from staging.

## Verification details

- Verified both `allowTools` policy paths: tool-enabled requests retain the approved assistant/workflow/browser policies plus conditional grounding policy; tool-disabled requests retain the approved assistant and tools-unavailable policies with no knowledge catalog.
- Verified exact workflow-only requests expose only the workflow tool on every provider turn, while a composite request exposes knowledge only after successful workflow completion. Failed workflow status precedes any model explanation and knowledge search is never invoked.
- Verified the model-visible search schema and Main parser reject every forbidden authority field, including owner/conversation/base IDs, path, SQL, topK, index/generation ID, consent, and provider.
- Verified the global decision limit applies to active browser continuation as well as workflow/knowledge turns; knowledge searches stop at three; workflow starts stop at five; current-turn evidence remains capped at eight.
- Verified evidence containing prompt-injection instructions remains a JSON-escaped `untrusted_knowledge_evidence` tool result under a system policy that forbids policy/tool/scope changes.
- Verified no assistant prose is emitted during search or consent pause. Denial makes no synthesis provider call and persists references without snippets. Grant sends snippets only after explicit provider-scoped consent.
- Verified strict mode accepts only knowledge-supported claims with current-turn evidence; mixed unsupported claims are stored with `support: general`; invalid IDs get one repair and then fail closed.
- Verified citation previews for PDF page/offset, DOCX heading/paragraph, Markdown/HTML node, and TXT line/character DTOs. Main looks up citation position from an owned persisted assistant message and Renderer cannot supply document/version/chunk/path scope.
- Verified safe historical serialization retains document/version/coordinates but omits evidence IDs, snippets, block/request IDs, filenames, paths, URLs, and hidden chunks.
- Verified snapshot search continues using the originally selected ready version after document replacement and conversation selection switch, while ordinary search sees the new mutable selection. Recycled preview becomes unavailable.

## External gates

- The ruling forbids real CloudBase/TokenHub access. No production Function, TokenHub credential, external embedding, live published-generation snapshot, PostgreSQL/RLS, or cloud concurrency behavior was exercised.
- Beta/cloud availability and the cloud kill switch remain at their fail-closed defaults. No gate or entitlement was enabled for this task.
- Live provider synthesis/citation behavior remains guarded by Main validation but was exercised only with deterministic provider doubles. The real Electron smoke intentionally covered the local Renderer/Preload/IPC/Main/parser/persistence boundary without an external chat or cloud credential.

## Self-review

- Re-read the full production and test diff against every binding requirement and the prior Agent/context ownership decisions. No identity, workflow, browser, tools-unavailable, privacy-log, cloud-gate, or unrelated context-limit policy was removed.
- Corrected the total-decision implementation so active browser continuation no longer bypasses the global ten-decision bound.
- Corrected cancellation status cleanup after a focused regression exposed an out-of-scope insertion in the workflow updater; the full 214-test Agent/WorkflowLoop suite then passed.
- Corrected live knowledge status replacement, non-pending consent persistence, DOCX paragraph display, explicit non-text coverage, and full forbidden-scope coverage during final hardening.
- Reviewed every Renderer-originating field and confirmed authority remains in authenticated IPC/Main. Reviewed persisted blocks and historical serialization for snippet/path/name/URL leakage.
- Reviewed the staged scope plan: only the files listed above plus this report will be committed; controller `progress.md` and all unrelated changes remain unstaged.
- The normal review skill calls for a reviewer subagent, but the task ruling explicitly forbids subagents. A full inline requirement/diff review was performed instead; no open Critical or Important issue remains.

## Concerns

- The unrelated Application context-summary test still fails with exactly the required `CONTEXT_LIMIT_EXCEEDED` baseline.
- Real CloudBase/TokenHub/PostgreSQL/RLS and real provider behavior remain unverified external release gates by ruling; they were neither accessed nor enabled.
- The Electron smoke covers the real local knowledge UI and persistence boundary, while citation synthesis/repair uses deterministic provider doubles because no real provider credential may be used in this task.
