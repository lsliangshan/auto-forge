# Task 10 report: final production-path seams

## Outcome

Task 10 closes the six cumulative-review seams while preserving the Task 8 acceptance boundary and Task 9 ownership, immutable-message, identity-history, and explicit-discard guarantees.

1. **Production message revisions and replay.** The real `chatRuns.startMediaGeneration`, `chatRuns.finalizeWithMessage`, `mediaGenerationJobs.startSubmissionIntent`, `mediaGenerationJobs.complete`, and `mediaGenerationJobs.fail` atomic paths now project exactly `baseRevision + 1` onto the local conversation. Strict fake-server replay tests accept a complete offline text user/assistant/user chain and a media user/terminal-assistant chain without conflict or quarantine.
2. **Purge continuity.** The 30-day service-role-only purge now retains every opaque mutation cursor and the complete revision chain through the delete tombstone. Historical titles are replaced with `[deleted conversation]`, message blocks with `[]`, execution IDs are omitted, and the original immutable request hash is retained for duplicate-push idempotency. Conversation/content rows are still cascaded after compaction. A realistic local projection test covers checkpoints before, at, and after retained rows.
3. **Global warning and retry.** Main transports the sync engine's durable global `warningSince` on every conversation page. Renderer warning state is independent of the visible page. Global retry admits both pending/backoff and failed mutations, clears an existing retry timer, immediately pushes non-conversation work, refreshes the first page, and clears the warning after recovery.
4. **Stale OTP preservation.** Stale verification cleanup uses the typed `{ preservePending: true }` path. It ends only the authenticated session, closes the active cache, and retains the UID-scoped SQLite/media data. A later login to the same UID recovers the pending outbox; other UIDs remain isolated by the existing trusted-session binding.
5. **Bounded logout.** Logout returns typed `{ status: 'sync_timeout' }` when the active sync drain does not settle before the deadline. It leaves authentication, SQLite, media, and the active store intact so late sync completion remains safe. Confirmed discard uses the same bounded flush/drain boundary before destructive work.
6. **Per-UID media.** New media uses `data/user-media/<sha256("autoforge-user-media-v1\\0" + UID)>` with no raw UID or shared-root write. Media service/lifecycle instances bind and clear inside the serialized user-data handoff. Normal logout and confirmed discard delete only that UID root; refused, failed, timed-out, and preserve-pending logout retain it. Existing `data/media` content is neither bound nor deleted.

## Design rulings

- Purge keeps cursor rows instead of synthesizing a new anchor. Retaining the ordered, schema-valid redacted chain is the smallest design that serves devices at arbitrary old checkpoints and preserves monotonic local revision validation.
- Purge does not rewrite `request_hash`: it is minimal idempotency evidence needed for an original offline duplicate push after content compaction. The pull payload is independently redacted.
- Media scopes use a full domain-separated SHA-256 digest. Service construction and recovery occur only after the matching UID store is open; references are cleared before that store closes. The legacy shared root is deliberately untouched rather than silently assigned to whichever account logs in first.

## TDD evidence

### RED

- Real repository revision tests: 3 failures. Assistant finalization left the next user mutation at base revision `2` instead of `3`; completed/failed media terminal paths left the projected revision at `1` instead of `2`.
- Purge migration test: failed because the function deleted `app_sync_mutations`, destroying old cursor anchors.
- Global retry repository test: failed because only the failed usage row was selected; the pending/backoff conversation row remained deferred.
- Renderer warning test: initially failed because warning state was derived only from loaded conversations; after transport wiring it exposed an in-flight first-page reload race, fixed by an explicit forced refresh after retry.
- Preserve/timeout contracts: logout schema rejected `{ preservePending: true }`; stale OTP tests observed destructive discard; Main returned `pending_sync` for the preserve path; the hung-pull logout test exceeded its 250 ms guard.
- Per-UID media tests: 2 failures with `ENOENT` under the expected hashed root because production still wrote the shared `data/media` root.

### GREEN focused suites

- `pnpm --filter @autoforge/desktop exec node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts electron/main/application.test.ts electron/main/database/user-data-client.test.ts electron/main/sync/user-data-sync-engine.test.ts` — 255/255 passed.
- `pnpm exec vitest run packages/shared/src/contracts.test.ts tests/cloudbase/user-data-migration.test.ts` — 95/95 passed.
- `pnpm --filter @autoforge/desktop exec vitest run --config vitest.config.ts tests/components/auth.test.ts tests/components/workbench.test.ts` — 145/145 passed at the combined focused checkpoint; the final auth-only rerun after adding the typed timeout assertion passed 70/70.
- Targeted compacted purge behavior — 3/3 checkpoint variants passed.
- Targeted strict real-path replay — 1/1 passed; targeted global timer retry — 1/1 passed; targeted media/logout semantics — 4/4 passed.

## Required gates

- `pnpm test` — final exit 0; 102 files, 2,876 tests passed after the last test-only assertion.
- `pnpm typecheck` — exit 0 for all four workspace projects.
- `pnpm build` — exit 0; packages, Electron Main/Preload/Renderer, worker, and cloud-sync E2E Main bundle built.
- `pnpm exec playwright test apps/desktop/tests/e2e/cloud-user-data-sync.spec.ts` — exit 0; all 8 serial Task 8 scenarios passed.
- `cmp cloudbase/migrations/20260824090000_user_data_foundation.sql cloudbase/user-data/migrations/0001_user_data_foundation.sql` — exit 0.
- Focused ESLint over every changed TypeScript/Vue path plus the new media helper — exit 0 with 0 errors and 9 pre-existing `ContextSidebar.vue` formatting warnings outside changed lines.
- `git diff --check` — exit 0.

## Changed paths

- `apps/desktop/electron/main/application.ts`
- `apps/desktop/electron/main/application.test.ts`
- `apps/desktop/electron/main/media/user-media-root.ts`
- `apps/desktop/electron/main/database/user-data-repositories.ts`
- `apps/desktop/electron/main/database/user-data-client.test.ts`
- `apps/desktop/electron/main/sync/user-data-sync-engine.test.ts`
- `apps/desktop/electron/preload/bridge.ts`
- `apps/desktop/src/stores/auth.ts`
- `apps/desktop/src/stores/chat.ts`
- `apps/desktop/src/components/ContextSidebar.vue`
- `apps/desktop/tests/components/auth.test.ts`
- `apps/desktop/tests/components/workbench.test.ts`
- `packages/shared/src/desktop-api.ts`
- `packages/shared/src/contracts.test.ts`
- `cloudbase/migrations/20260824090000_user_data_foundation.sql`
- `cloudbase/user-data/migrations/0001_user_data_foundation.sql`
- `cloudbase/user-data/README.md`
- `tests/cloudbase/user-data-migration.test.ts`
- `.superpowers/sdd/2026-08-24-cloudbase-conversation-sync/task-10-report.md`

## Staging-only gaps

- No migration was executed against the supported staging PostgreSQL/CloudBase runtime. Staging must prove the service-role grant, direct `anon`/`authenticated` denial, real JSONB compaction, old cursor lookup before/at/after compacted rows, duplicate push using the retained original request hash, and cascade counts.
- No credentials were accessed and nothing was deployed. The eight-scenario Electron suite uses disposable profiles and a fake CloudBase boundary; it is not evidence of deployed identity forwarding or scheduler configuration.
- The operator must configure and monitor the documented once-daily service-role purge invocation. This repository intentionally does not install a scheduler extension or job.
