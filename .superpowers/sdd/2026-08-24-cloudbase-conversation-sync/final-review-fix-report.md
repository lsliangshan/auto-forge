# Final review fix report

Date: 2026-08-25

Fix-wave base: `3b59c090ed355cfc7150de9c565e27f43c41cc5b`

Verified code HEAD: `5fa8aa8ba816062091ea9eb548296710c04a3d91`

Commit message: `fix: converge cloud conversation metadata replay`

## Outcome

All three final-review findings were implemented in one surgical fix wave:

1. Same-hash receipt replay now maps only a stored `applied` result to `duplicate`; stored `conflict` and `rejected` results retain their original status and error code.
2. Conversation generation preferences now use a strict `conversation.preferences` mutation in the existing per-conversation revision domain, with atomic local projection/outbox enqueue, CloudBase optimistic concurrency, pull hydration, and payload-free purge compaction.
3. Initial and paginated conversation pages now reconcile live conversation events that arrived after each request began; removals still invalidate stale work, and identity reset clears all overlay coordination.

## Files changed

- `packages/shared/src/desktop-api.ts`
  - Added the strict generation-preference mutation/pull/compacted contracts.
  - Changed mutation results to a discriminated success/failure union.
- `packages/shared/src/contracts.test.ts`
  - Added strict mutation, pull, compaction, and result-shape coverage.
- `cloudbase/migrations/20260824090000_user_data_foundation.sql`
- `cloudbase/user-data/migrations/0001_user_data_foundation.sql`
  - Added the preference kind, strict SQL validation and optimistic update branch, failure-preserving receipt replay, and purge compaction.
  - The two SQL files remain byte-identical.
- `cloudbase/user-data/function/user-data-handler.js`
  - Added strict preference validation and status-dependent mutation-result parsing.
- `tests/cloudbase/user-data-handler.test.ts`
- `tests/cloudbase/user-data-migration.test.ts`
  - Added handler and SQL regression coverage for all new behavior.
- `apps/desktop/electron/main/database/user-data-repositories.ts`
  - Added atomic optimistic preference writes, outbox/revision accounting, strict remote projection, receipt acknowledgement, and compacted receipt handling.
- `apps/desktop/electron/main/database/user-data-client.test.ts`
  - Added offline persistence/replay acknowledgement and clean second-device convergence coverage.
- `apps/desktop/electron/main/application.ts`
- `apps/desktop/electron/main/application.test.ts`
  - Queued a sync flush after preference mutation and verified the real service path records the mutation.
- `apps/desktop/src/stores/chat.ts`
  - Added request-versioned conversation event overlays, reset cleanup, and selected-preference rehydration after converged metadata changes.
- `apps/desktop/tests/components/chat.test.ts`
  - Added initial-page, pagination, removal, reset, and selected-preference convergence races.
- `apps/desktop/tests/e2e/cloud-user-data-sync-fixture.ts`
  - Aligned fixture replay semantics and preference mutation projection with the shared contract.

## Design choices

### Receipt replay and result shape

- `applied` and `duplicate` are successful wire results and require `revision`; they cannot carry `errorCode`.
- `conflict` and `rejected` are failures and require `errorCode`; they cannot carry `revision`.
- The SQL same-hash branch returns `duplicate` only when the stored status is `applied`. Otherwise it returns the stored status, `result_revision`, and `error_code` verbatim through `jsonb_strip_nulls`.
- Request-hash identity is unchanged. The request hash is still computed before any stale receipt is compacted, and purge never rewrites it.

### Conversation generation preferences

- The mutation is `conversation.preferences` with only `preferences` and `metadataUpdatedAt`; no owner/user identifier crosses the client contract.
- It shares the conversation advisory lock and revision chain. A successful mutation requires `resultRevision = baseRevision + 1`.
- The local preference projection and outbox insert occur in one SQLite transaction. Repeated offline changes naturally chain from the optimistic conversation revision.
- CloudBase validates exact nested objects and scalar types before updating `app_conversations.generation_preferences` and `metadata_updated_at`.
- Pull applies the full strict payload. Purge and post-purge missing-conversation conflicts retain only a `compacted: true` anchor with no preference business payload.
- A selected Renderer conversation rehydrates preferences when a newer converged conversation metadata timestamp arrives, including replacing an older in-flight hydration.

### Conversation page/event ordering

- Every initial or paginated request captures the current live-event version.
- A per-conversation latest-event overlay is applied after the page merge only for events newer than that request, so newer live updates win and off-page updates remain visible.
- Removal continues to advance the data generation and invalidate all old page/hydration requests; a removal overlay also prevents an otherwise accepted older response from reintroducing the row.
- `resetLocalData()` clears both the event version and overlays, so no prior identity state can affect the next identity.

## TDD evidence

### Finding 1 RED

Command:

```text
pnpm exec vitest run packages/shared/src/contracts.test.ts tests/cloudbase/user-data-handler.test.ts tests/cloudbase/user-data-migration.test.ts
```

Expected failure: exit 1; 3 files failed, 3 tests failed, 122 passed of 125.

- Shared schema accepted revisionless success and revision-bearing failures.
- Function RPC parser accepted `{ status: 'applied' }` without a revision.
- SQL still contained the unconditional same-hash `'status', 'duplicate'` branch.

Focused GREEN after the minimal result-contract/SQL/parser fix: 3 files passed, 125 tests passed.

### Finding 2 RED

Contract/CloudBase command:

```text
pnpm exec vitest run packages/shared/src/contracts.test.ts tests/cloudbase/user-data-handler.test.ts tests/cloudbase/user-data-migration.test.ts
```

Expected failure: exit 1; 3 files failed, 4 tests failed, 123 passed of 127.

- Shared push and compacted-pull unions had no `conversation.preferences` discriminator.
- The function rejected the new strict mutation.
- The SQL kind/branch/purge assertions found no preference mutation support.

Desktop persistence command:

```text
pnpm --filter @autoforge/desktop exec node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts electron/main/database/user-data-client.test.ts electron/main/application.test.ts
```

Expected failure: exit 1; 2 files failed, 2 tests failed, 219 passed of 221.

- Local preference update left the conversation at revision 1 instead of 2.
- The application service recorded no preference outbox mutation.

Renderer convergence command:

```text
pnpm --filter @autoforge/desktop exec node scripts/run-vitest-electron.mjs run --config vitest.config.ts tests/components/chat.test.ts
```

Expected failure: exit 1; 1 test failed, 163 passed of 164. A selected second-device conversation did not rehydrate preferences after the converged metadata event and made only one hydration call instead of two.

Focused GREEN:

- Shared/CloudBase suite: 3 files passed, 127 tests passed.
- Initial desktop persistence/application suite: 2 files passed, 221 tests passed.
- Final Renderer suite: 1 file passed, 164 tests passed.

### Finding 3 RED

Command:

```text
pnpm --filter @autoforge/desktop exec node scripts/run-vitest-electron.mjs run --config vitest.config.ts tests/components/chat.test.ts
```

Expected failure: exit 1; 2 tests failed, 161 passed of 163.

- An older initial page dropped a newer live off-page conversation.
- An older paginated row overwrote the newer live projection for the same conversation.

Focused GREEN after the request-versioned overlay fix: 1 file passed, 163 tests passed. The later preference convergence regression increased the final suite to 164 passing tests.

## Final focused verification

```text
pnpm exec vitest run packages/shared/src/contracts.test.ts tests/cloudbase/user-data-handler.test.ts tests/cloudbase/user-data-migration.test.ts
```

Result: 3 files passed, 127 tests passed.

```text
pnpm --filter @autoforge/shared build
```

Result: passed (`tsc -p tsconfig.json`). This rebuild ran before final desktop tests.

```text
pnpm --filter @autoforge/desktop exec node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts electron/main/database/user-data-client.test.ts electron/main/cloud/cloudbase-user-data-port.test.ts electron/main/sync/user-data-sync-engine.test.ts electron/main/application.test.ts
```

Result: 4 files passed, 280 tests passed.

```text
pnpm --filter @autoforge/desktop exec node scripts/run-vitest-electron.mjs run --config vitest.config.ts tests/components/chat.test.ts
```

Result: 1 file passed, 164 tests passed.

```text
pnpm --filter @autoforge/shared typecheck && pnpm --filter @autoforge/desktop typecheck
```

Result: passed (`tsc --noEmit`, desktop Node `tsc --noEmit`, and Renderer `vue-tsc --noEmit`). An earlier typecheck correctly exposed three callers of the stricter result union; those were narrowed and the fixture replay semantics were corrected before this final pass.

```text
cmp -s cloudbase/migrations/20260824090000_user_data_foundation.sql cloudbase/user-data/migrations/0001_user_data_foundation.sql
git diff --check
```

Result: SQL copies are byte-identical and the diff has no whitespace errors.

## Invariant audit

- UID ownership remains derived from the authenticated context/store binding; no owner identifiers were added to mutation payloads or Renderer events.
- Mutation and pull parsing remains strict at shared, function, and local projection boundaries.
- Idempotency remains request-hash based; changed-content ID reuse remains rejected.
- Conversation create/rename/preferences/message/delete/restore continue to share one monotonically ordered revision chain.
- Purge compaction retains cursor/idempotency anchors but no title, message blocks, or generation-preference business payload.
- Renderer reset clears subscriptions, data generation, requests, and the new conversation overlay coordination.

## Concerns / deferred verification

- The implementer pass did not deploy, access credentials, push, merge, create a PR, run Playwright, or run the final root full-gate matrix. The controller subsequently ran the complete local gate matrix recorded below.
- No live PostgreSQL service was available in this fix wave. SQL execution semantics were checked through focused migration assertions, strict function tests, byte identity, and downstream repository tests; the controller should include the normal PostgreSQL/integration gate if available.

## Controller-run final gate matrix

Run on 2026-08-25 after the independent whole-branch scoped re-review approved all three fixes:

- `pnpm test` — exit 0; 102 test files and 2,899 tests passed.
- `pnpm typecheck` — exit 0 across all four participating workspace projects.
- `pnpm build` — exit 0 for shared/workflow packages, Electron Main/Preload/Renderer, workflow worker, and Cloud sync E2E bundle. Rollup emitted only the existing third-party `@vueuse/core` pure-annotation warnings.
- `pnpm exec playwright test apps/desktop/tests/e2e/cloud-user-data-sync.spec.ts` — exit 0; all 9 serial scenarios passed, including the new lost-response-after-purge case.
- Focused ESLint over every added/modified TypeScript, TSX, Vue, and JavaScript path in `44cf8ce..5fa8aa8` — exit 0 with 0 errors and 25 existing Vue formatting warnings.
- `cmp cloudbase/migrations/20260824090000_user_data_foundation.sql cloudbase/user-data/migrations/0001_user_data_foundation.sql` — exit 0; byte-identical.
- `git diff --check 44cf8ce..5fa8aa8` and `git diff --check` — exit 0.
- `git status --porcelain=v1 -uall` — empty before this report-only update.

The remaining staging-only gap is unchanged: no live PostgreSQL/CloudBase deployment, grant check, purge/restore race, or cross-UID RPC test was performed, and no credentials were accessed.
