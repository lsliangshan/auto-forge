# Task 1 report — Contracts, feature gate, and persistence seams

## Implemented

- Added strict shared DTOs/schemas for knowledge bases, documents, versions, selection, Main-only local-search input, bounded evidence, source-specific citations, entitlement, provider consent, and fail-closed feature availability.
- Added fixed `knowledge:*` IPC request/response contracts, a narrow `DesktopAPI.knowledge` bridge, authenticated IPC handlers, and a Main runtime fail-closed availability seam.
- Added Main-only `KnowledgePersistence`/`KnowledgeOwner` types for subsequent encrypted-store work; no storage, import, retrieval implementation, or UI was added.
- Commit: `feat(knowledge): define trusted IPC contracts`.

## TDD evidence

- RED: `pnpm --filter @autoforge/shared exec vitest run src/contracts.test.ts` — workspace config resolved desktop tests from `packages/shared/apps/desktop`, so the command failed before test discovery.
- RED: `pnpm test -- packages/shared/src/contracts.test.ts apps/desktop/electron/preload/bridge.test.ts apps/desktop/electron/main/ipc/register-ipc.test.ts` — 4 new shared-contract, 1 preload, and 1 IPC test failed because the knowledge contract did not exist; the recorded unrelated application baseline also failed.
- GREEN: `pnpm --filter @autoforge/shared build && pnpm --filter @autoforge/shared typecheck && pnpm --filter @autoforge/desktop typecheck && pnpm test packages/shared/src/contracts.test.ts apps/desktop/electron/preload/bridge.test.ts apps/desktop/electron/main/ipc/register-ipc.test.ts && git diff --check` — shared build/typecheck and desktop typecheck passed; 3 test files and 118 tests passed; whitespace check passed.
- Post-commit verification repeated the shared build/typecheck, desktop typecheck, and same 118 targeted tests; all passed. `git show --check HEAD` reported no whitespace errors.
- Full-suite check: `pnpm test` reached the documented unrelated `application.test.ts` failure, `bills real context-summary streams through the Application-supplied provider snapshot` (`CONTEXT_LIMIT_EXCEEDED`); no new knowledge-suite failure was reported before that baseline stop.

## Files changed

- `packages/shared/src/desktop-api.ts`, `packages/shared/src/events.ts`, `packages/shared/src/contracts.test.ts`
- `apps/desktop/electron/preload/bridge.ts`, `apps/desktop/electron/preload/bridge.test.ts`
- `apps/desktop/electron/main/ipc/register-ipc.ts`, `apps/desktop/electron/main/ipc/register-ipc.test.ts`
- `apps/desktop/electron/main/application.ts` (required to assemble the new handler seam fail-closed)
- `apps/desktop/electron/main/knowledge/knowledge-types.ts`

## Self-review / concerns

- Reviewed request schemas: they reject extra fields and never accept paths, user IDs, SQL, caller-selected `topK`, or index IDs. Feature availability exposes only enum reasons, not native exception details.
- The selection maximum of 32 is a DTO safety bound; the specified retrieval limit is enforced separately at eight evidence results. Actual encrypted persistence, entitlement validation, consent persistence, and selection ownership checks intentionally remain later tasks.

## Fix round 1

- Changed the knowledge IPC service seam so every knowledge operation receives a `KnowledgeOwner` derived solely from `auth.requireSession()`; renderer-provided IDs remain resource identifiers and cannot select an owner.
- Split feature availability into independently fail-closed `local` and `cloud` scopes. `kill_switch_enabled` is valid only in the cloud scope, allowing local management/export/delete/authorized retrieval to remain available.
- Covering tests: `packages/shared/src/contracts.test.ts`, `apps/desktop/electron/main/ipc/register-ipc.test.ts`, and `apps/desktop/electron/preload/bridge.test.ts`.
- RED: `pnpm test packages/shared/src/contracts.test.ts apps/desktop/electron/preload/bridge.test.ts apps/desktop/electron/main/ipc/register-ipc.test.ts` — 3 failures (the new scoped-availability contract and two owner-propagation assertions).
- GREEN: `pnpm --filter @autoforge/shared build && pnpm test packages/shared/src/contracts.test.ts apps/desktop/electron/preload/bridge.test.ts apps/desktop/electron/main/ipc/register-ipc.test.ts` — 3 files, 120 tests passed.
- Typecheck: `pnpm --filter @autoforge/shared typecheck && pnpm --filter @autoforge/desktop typecheck` — both passed; `git diff --check` passed.
