# Task 5 Report: Knowledge management UI and conversation preferences

## Status

Implemented the `/knowledge` workspace and per-conversation knowledge preferences. Navigation is now exactly Chat, Knowledge Base, Workflows, Developer, Executions, optional User Management, Settings. The implementation uses the existing path-free `DesktopAPI.knowledge` namespace and does not add persistent knowledge import to chat attachments.

## Implementation

- Added a shared Pinia knowledge Store for feature availability, entitlement/consent state, bases, documents, immutable versions, path-free create/import/replace/recycle/export operations, durable processing acknowledgements, and 1.5-second refreshes only while processing state exists.
- Added the real three-pane `/knowledge` workspace using the existing Workbench layout: `ContextSidebar` owns base create/select/actions, `KnowledgeView` owns files/import/status/replacement/errors, and `InspectorPanel` owns selected metadata/version/processing/sync/error inspection. All three consume one Store rather than duplicating page state.
- Added fail-closed local/cloud write gating. The UI distinguishes only-local, syncing, synced, keyword retrieval, unavailable, read-only, expired, failed, paused, and deleted/missing states.
- Added `KnowledgeSelector` directly above the `ChatComposer` tools. It supports zero-or-more bases plus mixed (default) or strict mode, loads and saves each conversation through Main, serializes rapid saves, isolates selector errors from the primary chat error channel, and initializes every new conversation with no bases selected.
- Added exact navigation order checks for ordinary and user-management-capable sessions, real route/view/Store/composer tests, and a reusable Electron smoke entry.

## TDD evidence

- Navigation RED received `['聊天', '工作流', '开发', '执行记录', '设置']` before `/knowledge` existed.
- Knowledge suite RED failed to resolve `src/stores/knowledge` before the Store and three-pane implementation existed.
- Multi-base polling RED left the first base at `parsing`; per-base load versions now let every processing base refresh independently.
- Scoped-write RED showed cloud import enabled while cloud availability was false; `canWrite` now derives from the selected base kind and Main-provided availability/entitlement.
- Renderer regression caught selector failures overwriting a model-list error and two bridge rejections. Knowledge errors now remain local to the selector/knowledge Store.

## Final verification

- Renderer: `vitest run --config vitest.config.ts` — 10 files, 353 tests passed.
- Real Application knowledge boundary: 1 passed, 149 skipped; covers actual encrypted import, strict conversation selection persistence, search/export, logout ordering, and cross-owner denial.
- Desktop typecheck: Node and Renderer projects passed.
- Targeted ESLint over every changed source/test/smoke file with `--quiet`: passed.
- Desktop production build: passed and emitted Main, actual preload, Renderer, parser worker, and workflow worker artifacts.
- `git diff --check`: passed.

## Real Electron smoke

The smoke launches the built production Renderer with the built `out/preload/index.cjs`; it does not inject `window.autoForge`. `registerDesktopIpc` validates requests/responses in Main. The visible UI navigates to `/knowledge`, renders `我的知识库` and `可见知识.md`, clicks the file, and renders `版本 2` in the inspector. Captured Main calls were `getFeatureAvailability`, `getEntitlement`, `getConsent`, `listBases`, `listDocuments:kb_smoke`, and `listVersions:document_smoke`; the process exited 0.

## Concerns and gates

- Cloud sync and hybrid vector retrieval remain later tasks; the current cloud kill switch remains visible and fail-closed while local keyword retrieval stays usable.
- The Electron UI smoke uses deterministic Main knowledge DTOs to isolate Renderer/Preload/IPC/visible-state behavior; the separate real Application test covers the actual encrypted KnowledgeService lifecycle.
- No full-repository suite was requested for this UI task. Renderer, the focused real Application boundary, typecheck, lint, build, and Electron smoke all passed.
