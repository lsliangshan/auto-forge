# Task 8 Report: Agent routing, grounding, and citation UI

## Implementation

- Extended the Main-owned `AgentOrchestrator` without replacing its identity or existing workflow, conditional browser-continuation, and tool-unavailable policies. Exact unique workflow-only launches now suppress both browser and knowledge continuation for the whole request; composite requests offer knowledge only after a workflow completes, while failed or cancelled workflow status remains first and visible.
- Added fixed Main-owned Agent budgets: at most five workflow invocations, three knowledge searches, ten total model decisions (including active browser continuation), and eight aggregate evidence items. `knowledge_search` accepts only strict `query` plus optional `rewrite`; user/conversation identity, knowledge-base selection, paths, SQL, topK, index/generation IDs, consent, and provider are never model-controlled.
- Restricted knowledge routing to selected, immutable Main snapshots supplied only for text output on tool-capable models. `KnowledgeService.captureSearchSnapshot()` freezes owner/conversation selection, active ready version IDs, and any eligible CloudRetriever published-generation snapshot before mutable selection/import/replace/recycle activity can affect the turn. The opaque public token exposes only `selected` and strict/mixed mode; service-private scope lives in a `WeakMap` and is invalidated on close.
- Added snapshot-bound local retrieval by exact version IDs and preserved the Task 7 cloud kill switch and fail-closed local fallback. Each result is revalidated by the existing strict shared outcome schema before Agent accepts it.
- Added status-only search output, untrusted JSON evidence delimiters, provider-scoped first-use snippet disclosure consent, retrieval-only denial output, strict no-evidence refusal, explicitly labelled mixed-mode general claims, current-turn citation validation, deterministic Main-only support validation, and exactly one citation-repair attempt. Provider text remains buffered and invisible until tool/citation/support validation succeeds.
- Persisted only claim text plus immutable document/version/source coordinates. Snippets, support excerpts, evidence/chunk IDs, filenames, paths, permanent URLs, provider controls, and mutable index/generation identifiers are excluded from ChatBlocks, Renderer DTOs, and historical context. Context compression serializes safe PDF text-item, DOCX, Markdown/HTML, and TXT coordinates only.
- Added strict shared DTOs and authenticated IPC/Preload methods for consent and citation preview. Renderer submits only persisted message position (`conversationId`, `messageId`, `blockId`, `citationIndex`); Main resolves the owned persisted citation, and `KnowledgeService` verifies the exact document/version/structural-coordinate tuple against the immutable source block without accepting a chunk/evidence ID. Recycled or purged sources render unavailable.
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
- Verified strict mode accepts only claims conservatively supported by the specifically cited current-turn snippets; mixed unsupported claims are stored with `support: general`; invalid IDs, negation contradictions, and numeric mismatches get one repair and then fail closed.
- Verified citation previews for PDF page/text-item, DOCX heading/paragraph, Markdown/HTML node, and TXT line/character DTOs. Main looks up citation position from an owned persisted assistant message and Renderer cannot supply document/version/chunk/path scope.
- Verified safe historical serialization retains document/version/coordinates but omits evidence/chunk IDs, snippets/support excerpts, block/request IDs, filenames, paths, URLs, and hidden chunks.
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

## Fix Round 1: grounded citation boundary review

### Implementation

- Removed `evidenceId` from durable `KnowledgeCitationReference`, persisted `knowledge_answer` blocks, Renderer source identity, preview ownership, and history. `KnowledgeSearchResult.evidenceId` remains transient only in the current Main run and provider tool exchange. Local retrieval no longer copies a chunk row ID into the durable citation.
- Changed PDF citation/preview semantics from misleading character offsets to PDF.js text-item coordinates (`itemStart`/`itemEnd`) throughout shared contracts, Main lookup/context, tests, and the `文本项` UI label.
- Reworked preview resolution to query the immutable source block by owned document/version, require exactly one structural-coordinate match, and return unavailable on mismatch, recycle, or purge. Renderer still sends only the owned persisted message position.
- Added a bounded deterministic support check in Main over only the cited current-turn snippets. It accepts normalized direct support or a conservative high-overlap CJK paraphrase, requires all claim numbers to occur in evidence, rejects polarity/negation mismatch, and requires material Latin tokens to occur. Unsupported claims consume the existing single repair, then strict mode refuses. Snippets/support excerpts never enter a ChatBlock.
- Changed workflow-to-KB admission to evaluate the latest status per immutable workflow identity. A completed changed-input read-only retry supersedes its earlier failed attempt; an unresolved or terminal failure for any other workflow still blocks knowledge.
- Kept `awaiting_approval` chat work associated with its conversation until terminal. Conversation deletion, explicit cancel, authentication identity change, and shutdown cancel/drain the retained run; terminal events and successful cancellation release it without leaving a waiting promise.
- Wrapped provider-consent lookup failure, rechecked terminal/cancel state after the await, and prevented a late lookup from replacing cancelled status.
- Made the controlled citation preview an accessible modal: focus enters it, Escape closes it, focus returns to the invoking source, and `role="dialog"`/`aria-modal="true"` are present. Renderer/Main source deduplication now uses the same collision-free durable JSON identity.

### Exact RED evidence

- `pnpm test packages/shared/src/contracts.test.ts apps/desktop/electron/main/chat/conversation-context.test.ts apps/desktop/electron/main/knowledge/local-retriever.test.ts --reporter=dot` -> 3 failed / 113 passed. Failures showed durable citations still required `evidenceId`, PDF still required `startOffset`/`endOffset`, history rejected the safe shape, and local retrieval persisted the chunk row ID.
- `pnpm test apps/desktop/electron/main/agent/agent-orchestrator.test.ts -t 'routes a KB-only|changed-input read-only retry succeeds|conservative paraphrase|contradictory material claim|consent lookup fails|consent lookup resolves late' --reporter=dot` -> 5 failed / 1 passed / 206 skipped. The positive paraphrase was the one baseline pass; durable output, retry routing, valid-ID contradiction, visible consent failure, and late-cancel behavior all failed.
- `pnpm test apps/desktop/electron/main/application.test.ts -t 'awaiting knowledge-consent' --reporter=dot` -> 1 failed / 154 skipped after allowing the background `finally` to run; conversation deletion observed zero Agent cancellations. The combined owned-preview command separately produced 1 failed / 1 passed / 153 skipped because the durable PDF citation shape was rejected.
- `pnpm test apps/desktop/tests/components/chat.test.ts -t 'controlled source preview|moves focus into the citation modal' --reporter=dot` -> 2 failed / 159 skipped: PDF rendered undefined character offsets and the dialog lacked modal/focus behavior.
- Self-review collision regression: `pnpm test apps/desktop/tests/components/chat.test.ts -t 'identifier text contains delimiters' --reporter=dot` -> 1 failed / 161 skipped because two distinct durable references collapsed to one Renderer source.
- First post-slice `pnpm typecheck` -> four errors in the new Renderer citation-key union branch. First post-slice `pnpm lint` -> five `no-undef` errors / 459 warnings for DOM globals in the same component. Both were corrected narrowly and rerun.

### GREEN and verification

- Durable contracts/context/local retrieval focused rerun -> 116 passed.
- Support/routing/consent Agent focus -> 6 passed / 206 skipped; the added numeric-mismatch repair is also covered by the full Agent suite.
- Pending-consent deletion plus owned durable preview focus -> 2 passed / 153 skipped.
- Renderer preview/accessibility focus -> 2 passed / 159 skipped; delimiter collision RED then GREEN -> 1 passed / 161 skipped; full Renderer chat suite -> 162 passed.
- `pnpm test apps/desktop/electron/main/agent/agent-orchestrator.test.ts apps/desktop/electron/main/agent/workflow-tool-loop.test.ts apps/desktop/electron/main/chat/conversation-context.test.ts apps/desktop/electron/main/knowledge/knowledge-service.test.ts apps/desktop/electron/main/knowledge/local-retriever.test.ts apps/desktop/electron/main/knowledge/cloud-retriever.test.ts apps/desktop/electron/main/knowledge/cloudbase-knowledge-client.test.ts packages/shared/src/contracts.test.ts apps/desktop/tests/components/chat.test.ts --reporter=dot` -> 9 files / 551 passed.
- Full `application.test.ts` -> 154 passed / exactly 1 preserved failure: `bills real context-summary streams through the Application-supplied provider snapshot` still returns the unrelated `CONTEXT_LIMIT_EXCEEDED` baseline.
- IPC + Preload suites -> 48 passed. `pnpm typecheck` passed all four typed workspace projects. `pnpm lint` exited 0 with 0 errors / 459 existing warnings. `pnpm build` passed all package and Electron targets.
- Final combined Agent/Workflow/context/knowledge/IPC/Preload/shared/Renderer rerun on the hardened tree -> 11 files / 600 passed.
- `pnpm --filter @autoforge/desktop smoke:knowledge-ui` rebuilt and crossed the real Electron Renderer/Preload/IPC/Main/parser/persistence boundary, ending with `{ "ok": true }` and persisted/restored strict selection.

### External gates and self-review

- No real provider, CloudBase, TokenHub, PostgreSQL, entitlement, beta, cloud, or kill-switch gate was accessed or enabled. Provider synthesis/support/repair uses deterministic doubles; the Electron smoke is local only.
- Re-read the production/test diff against both Critical, all three Important, and both Minor findings. Identity/system/workflow/browser/tool-unavailable policy assembly, 5/3/10/8 budgets, workflow-first visibility, single repair, provider-scoped consent, immutable snapshots, cloud kill switches, privacy logging, and the unrelated context-limit baseline remain intact.
- `progress.md` is controller-owned and remains dirty but excluded from staging. No migration was added because this Task 8 citation shape is unreleased branch-local data; fresh/local feature databases are the only current consumers.

### Remaining concerns

- The conservative support proof intentionally produces false negatives for abstractive paraphrases, especially non-extractive English claims. This is fail-closed by controller ruling; no second provider adjudicator or persisted support excerpt was introduced.
- The single unrelated Application context-summary baseline failure and external release gates remain unchanged.
