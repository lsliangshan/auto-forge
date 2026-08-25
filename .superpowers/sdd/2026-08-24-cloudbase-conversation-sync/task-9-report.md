# Task 9 report: whole-branch ownership and convergence seams

## Result

Task 9 closes all seven cumulative-review seams without changing the trusted-UID boundary or weakening the Task 8 Electron acceptance path. The implementation advances dependent optimistic revisions, makes execution ownership Main-owned, makes pending-work logout explicit and typed, rejects mismatched duplicate message IDs, preserves legacy import identity history, adds a service-role-only tombstone purge boundary, and derives the 24-hour warning from durable outbox state.

No CloudBase or PostgreSQL artifact was deployed, no credential was accessed, and no branch was pushed or merged. Commit message: `fix: close cloud sync cross-seam gaps`. The final SHA is returned in the task handoff.

## Seam-by-seam implementation

1. **Dependent offline revisions.** Optimistic conversation create now projects revision 1, and rename, tombstone/restore, message append, and asset-backed message append project `baseRevision + 1`. A create → rename → multiple-message offline queue therefore emits the same dependent bases the server expects. Existing mutation receipt/pull reconciliation continues to converge idempotently.
2. **Execution ownership.** Global migration `0014_execution_owner.sql` adds a nullable legacy owner column, an owner index, and a trigger that rejects every new unowned execution. `ExecutionService` supplies only the Main-authenticated UID. Repository, application, detail, step, log, event, decision, and cancel paths authorize against that stored owner. Preserved legacy-null rows are exposed to no authenticated user. Renderer execution state resets whenever the authenticated UID changes or logs out.
3. **Logout lifecycle.** The shared logout contract now returns either `logged_out` or typed `pending_sync` with the bounded pending count. Ordinary logout performs a bounded drain and refuses while work remains. The Renderer displays an explicit discard confirmation; only `{ discardPending: true }` abandons the queue. Successful normal logout or confirmed discard closes the cache, completes authentication logout, and deletes the exact SQLite file and sidecars. If authentication logout fails, the old session and cache are rebound rather than deleted.
4. **Message duplicate identity.** Both SQL migration copies take an owner/message-ID advisory transaction lock, then compare conversation ID, role, blocks, execution ID, and creation timestamp before any target-conversation/revision processing. Byte-identical retries return `duplicate`; any immutable mismatch returns `INVALID_INPUT` without a receipt, event, row, or revision change, including concurrent device calls and payloads naming a nonexistent conversation or stale base.
5. **Legacy identity history.** User-cache migration `0006_legacy_import_identity_history.sql` replaces the singleton row with a composite-key history over canonical selection/consent identity, retaining the former singleton on upgrade. Identity selection uses insert-if-absent followed by exact-key lookup, so A → B → A reuses A's original root/batch and entity IDs.
6. **Thirty-day purge.** `autoforge_purge_expired_conversation_tombstones()` is a fixed-search-path `SECURITY DEFINER` boundary that removes only conversations deleted more than 30 days ago, nulls restrictive usage references, removes related mutation history, and relies on owned cascades for dependent messages/model runs. Invocation is revoked from public/direct user roles and granted only to `service_role`. The runbook documents an explicit deployment-neutral daily scheduler step and count-only monitoring.
7. **Durable warning.** Conversation summaries and sync status derive `syncWarningSince`/`warningSince` from the durable minimum `created_at` among pending or failed outbox rows. The warning appears at exactly 24 hours, survives restart, offers targeted retry in the existing sync UI, and clears when the durable queue recovers. Existing outbox/status caps remain 10,000.

## Changed paths

- Main/database/sync/IPC/execution: `apps/desktop/electron/main/{application.*,database/{database.test.ts,repositories.ts,schema.ts,user-data-client.*,user-data-repositories.ts},ipc/register-ipc.*,sync/user-data-sync-engine.*,workflows/execution-service.ts}`.
- Global and per-UID migrations: `apps/desktop/resources/migrations/0014_execution_owner.sql` and `apps/desktop/resources/user-cache-migrations/0006_legacy_import_identity_history.sql`.
- Renderer/preload/shared boundaries: `apps/desktop/electron/preload/bridge.ts`, `apps/desktop/src/{components/AppRail.vue,components/ContextSidebar.vue,stores/auth.ts}`, `packages/shared/src/{contracts.test.ts,desktop-api.ts,events.ts}`.
- SQL and operator docs: both user-data foundation SQL copies, its rollback, `cloudbase/user-data/README.md`, and `docs/runbooks/cloudbase-user-data-foundation.md`.
- Acceptance/fixture regression coverage: Desktop component tests, local cloud-sync fixtures/tests, and the existing Task 8 local E2E Main entry points.

## TDD evidence

| Seam | RED evidence | GREEN evidence |
| --- | --- | --- |
| Dependent revisions | Focused client/engine run failed because the dependent rename received projected revision 0 instead of 1. | Offline create → rename → two messages replays with sequential bases and no conflict, quarantine, loss, or duplicate rows. |
| Execution ownership | Database/application/auth tests failed because `getForUser` did not exist, cross-user rows were returned, and execution state survived UID change. | Stored-owner repository/application filtering, legacy-null exclusion, cross-user list/read/cancel denial, and Renderer reset tests pass. |
| Logout lifecycle | Main/store tests failed because logout returned no typed result, immediately cleared state, and had no explicit discard path. | Bounded wait/success, pending refusal, visible second confirmation, confirmed discard/cache deletion, and auth-failure cache preservation pass. |
| Duplicate message ID | The local double treated the second identical message ID as a new applied revision, SQL static coverage found no immutable comparisons, and the final concurrency review's focused test failed because no owner/message-ID lock preceded the lookup. | SQL/static and runtime-double tests prove serialized identical duplicate versus mismatch rejection before conversation/revision validation. |
| Legacy A-B-A | Focused repository test generated a new root for the second A instead of returning `legacy-root-1`. | Clean install, v1-v5 upgrade, and A → B → A history reuse pass. |
| Tombstone purge | Static migration test failed because the maintenance function and grants did not exist. | Static coverage proves 30-day cutoff, dependent cleanup, fixed security boundary, direct-role revoke, and service-role-only grant. |
| Durable warning | Repository/engine assertions received `undefined`, and the Renderer had no warning selector/action. | Repository, engine, shared-contract, and Renderer tests prove 24-hour derivation, restart durability, targeted retry, and recovery clear. |

The first whole-suite run after production changes was intentionally useful integration RED: 24 legacy expectations exposed the old schema version, raw unowned execution fixtures, old optimistic revision values, old ordinary-logout behavior, and mocked Agent approvals. The corrections updated only those contract/fixture assumptions; the independently exercised approval path remains Agent-owned until an execution row exists, while manual execution decisions require the stored trusted owner.

## Exact verification

| Command | Outcome |
| --- | --- |
| `pnpm exec vitest run packages/shared/src/contracts.test.ts tests/cloudbase/user-data-migration.test.ts` | Exit 0; 2 files, 95 tests passed. |
| `pnpm --filter @autoforge/desktop exec node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts electron/e2e/cloud-user-data-sync-fixture.test.ts electron/main/database/database.test.ts electron/main/database/user-data-client.test.ts electron/main/sync/user-data-sync-engine.test.ts electron/main/application.test.ts electron/main/ipc/register-ipc.test.ts` | Exit 0; 6 files, 380 tests passed. |
| `pnpm --filter @autoforge/desktop exec vitest run tests/components/auth.test.ts tests/components/workbench.test.ts` | Exit 0; 2 files, 145 tests passed. The fresh focused total is 10 files and 620 tests. |
| `cmp cloudbase/migrations/20260824090000_user_data_foundation.sql cloudbase/user-data/migrations/0001_user_data_foundation.sql` | Exit 0; canonical and deployable SQL are byte-identical. |
| `pnpm test` | Exit 0; 102 files, 2,862 tests passed. |
| `pnpm typecheck` | Exit 0; all four participating workspaces passed. |
| `pnpm build` | Exit 0; packages, production Electron bundles, workflow worker, and cloud-sync E2E Main built. |
| `pnpm exec playwright test apps/desktop/tests/e2e/cloud-user-data-sync.spec.ts` | Exit 0; all 8 serial Task 8 acceptance scenarios passed. |
| `git diff --name-only --diff-filter=ACM \| rg '\\.(ts\|vue)$' \| xargs pnpm exec eslint` | Exit 0; 0 errors and 21 warnings. Warnings are existing Vue layout/style rules in the two touched components; no unrelated lint-error file was changed. |
| `git diff --check` | Exit 0. |

Full `pnpm lint` is intentionally not part of this task's exact gates. The documented five-error baseline files remain untouched.

## Remaining staging-only gaps

- Neither SQL migration copy nor the global/user-cache migrations were applied outside disposable local test databases.
- The purge boundary has not been executed against the supported staging PostgreSQL runtime, a real `service_role`, or direct `anon`/`authenticated` roles. Grant behavior and data-preserving deletion therefore still need staging validation.
- No production or staging scheduler was configured. An operator must attach the documented daily invocation using the environment's existing trusted scheduler and alert on invocation failure; this task assumes no PostgreSQL extension.
- CloudBase authentication context, deployed RPC behavior, unauthenticated/cross-owner denial, and staging rollback remain operator gates.
- Task 8's eight scenarios still run through real Electron against the deterministic loopback double. Dual-device staging acceptance remains required before widening the feature flag.
