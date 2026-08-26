# Task 8 report: milestone-one acceptance and deployment gates

## Result

Task 8 adds a local-only real Electron acceptance path for CloudBase conversation synchronization and an operator rollout runbook. The suite launches the production Renderer, Preload, IPC registration, application runtime, strict `CloudBaseUserDataPort`, sync engine, and per-UID SQLite cache against a deterministic loopback service double.

The test path does not deploy CloudBase or PostgreSQL, contact production, use a real credential, or issue a paid Provider request. Test controls exist only on the test Main process global and do not add production diagnostic IPC.

Commit message: `test: verify cloud conversation sync milestone`. The final SHA is returned in the task handoff.

## TDD and defect evidence

Initial RED evidence:

- `pnpm build && pnpm exec playwright test apps/desktop/tests/e2e/cloud-user-data-sync.spec.ts` built successfully, then exited 1 with `Error: No tests found` because root `playwright.config.ts` matched only `browser-continuation.spec.ts`.
- After the authorized additive `testMatch` change, `pnpm exec playwright test --list` exited 1 because the not-yet-created local fixture module could not be resolved. This was the effective acceptance RED before fixture wiring.
- The first legacy-import fixture emitted a non-canonical full confirmation receipt and the strict pull parser rejected the page. Correcting it to the reduced `legacy.import` receipt exposed that the then-current SQL did not make imported rows pullable.
- Task 8 stopped without a production workaround. The independently reviewed Task 7 fix `b31d2bb` added deterministic row receipts and awaited ordinary pull.
- Migrating the pre-existing full-suite fixtures from sealed global legacy repositories to the real per-UID boundary produced 79 `CONFLICT` failures. That work then exposed the stale global execution-to-global-chat-run foreign key. Task 8 stopped again; independently approved Task 8A commit `a95c721` removed that cross-database FK.
- With Task 8A present, the migrated six-file slice initially had six remaining setup-shape failures: five context-usage cases lacked their real parent chat run and one media case lacked required owner/provider seed fields. The fixture-only corrections preserved every behavioral and failure assertion.

Final GREEN evidence:

- Migrated six-file regression slice: 6 files and 131 tests passed.
- Playwright discovery: 40 tests across the existing browser-continuation file and the new cloud-sync file, proving the additive config retains the prior suite.
- Cloud conversation acceptance: 8/8 passed after the exact production build.
- Review follow-up fixture contract tests: 2/2 passed. Their RED run proved that the previous double incorrectly treated changed mutation content and changed import-batch content as duplicates.
- The legacy-import acceptance now selects the imported conversation in each real Renderer and visibly asserts all 99 transcript articles plus representative first, middle, and last message text. It performs no Main-side repository count.
- The BYOK acceptance now reads a test-Main diagnostic backed by the injected Provider network transport. Every attempted Provider fetch increments the counter before the fail-closed error; the visible usage-summary path leaves the counter at zero.

## Canonical local-double parity

The local import implementation mirrors `autoforge_import_legacy_batch` at `a95c721`:

- Import row IDs use the same domain-separated forms: `legacy-conversation:` plus MD5 of `batchId:conversation:entityId`, and `legacy-message:` plus MD5 of `batchId:message:entityId`.
- Every newly inserted `conversation.create` receipt precedes all imported message receipts and has base/result revisions `0/1`.
- Imported messages retain input order. Each `message.append` uses the conversation's current revision as its base and increments it exactly once.
- The final event is the strict reduced `legacy.import` receipt with only `batchId` and `includeUnowned` in its payload.
- Mutation receipts retain a canonical request hash. An identical retry returns `duplicate`, while changed content under the same mutation ID returns `rejected/INVALID_INPUT` without changing rows, events, or revisions.
- Import receipts retain a canonical hash over the same identity fields used by SQL. An identical batch returns `duplicate` before row processing, while changed content under the same batch ID returns `rejected/SYNC_CONFLICT`; neither path adds an event or revision.
- The legacy scenario imports one conversation plus 99 messages. Its 101 import events are observed through ordinary `100 + 1` cursor pages; the current profile and a fresh second profile each hydrate all 99 messages without direct cache injection.

## E2E scenario map

| Scenario | Real boundary and visible evidence |
| --- | --- |
| Alice/Bob, one profile | Switches authenticated users through Main, reloads Renderer, and proves each sidebar contains only its owner's named conversation. |
| Alice, two profiles | Uses two disposable Electron `userData` roots and shows the first profile's named conversation in both Renderers. |
| Cursor pagination | Seeds 55 remote conversations, shows 50, clicks the visible load-more control, then shows all 55. |
| Offline replay | Creates while the local service is offline, shows `等待同步`, restores service, and shows `同步完成`. |
| Duplicate idempotency | Returns an ambiguous post-apply failure, observes a duplicate retry, shows one synchronized conversation, and proves no duplicate row. |
| Tombstone propagation | Deletes on profile one, observes the remote tombstone, performs an ordinary pull on profile two, and removes the visible title. |
| Explicit legacy import | Shows both cloud-sync and unowned-history confirmations, imports 100 rows across 101 events, selects the imported conversation in each Renderer, and visibly shows 99 message articles plus representative transcript text in both profiles. |
| BYOK classification | Shows estimated and unavailable BYOK costs and an unavailable confirmed-platform amount; the injected Provider transport's real attempt counter remains zero. |

All app profiles use `mkdtemp` roots and explicit per-profile cleanup. The fixture binds only to `127.0.0.1`, derives owner from test Main authentication, and never accepts a Renderer-supplied UID.

## Documentation and rollout boundary

- `cloudbase/user-data/README.md` retains the Task 3 authentication, service-role, secret-storage, response-size, and deployment-neutral statements. It now distinguishes repository artifacts, local Electron acceptance, explicit operator deployment, and staging-only runtime validation.
- `docs/runbooks/cloudbase-user-data-foundation.md` uses the required gate order: apply schema; deploy function; verify unauthenticated/cross-owner denial; enable shadow write; compare counts and deterministic hashes; enable internal import; enable remote read; run dual-device real Electron acceptance; widen feature flag.
- Rollback disables remote write/import and remote read, returns clients to local behavior, preserves queued local changes and accepted remote rows, and forbids destructive table operations.
- The runbook includes owner isolation, idempotency, tombstone, cursor, import, usage-classification, monitoring, and multi-role sign-off criteria without secrets or automatic deployment commands.

## Exact verification

| Command | Outcome |
| --- | --- |
| `pnpm exec vitest run packages/shared/src/contracts.test.ts tests/cloudbase/user-data-migration.test.ts tests/cloudbase/user-data-handler.test.ts` | Exit 0; 3 files, 116 tests passed. |
| `pnpm test` | Exit 0 after review corrections; 102 files, 2,845 tests passed. |
| `pnpm typecheck` | Exit 0; shared, workflow SDK, workflow schema, and Desktop typechecks passed. |
| `pnpm lint` | Exit 1 under the controller-approved baseline exception: 5 errors and 302 warnings. The errors are four `no-useless-assignment` reports in unchanged `apps/desktop/electron/main/agent/browser-continuation-tool-executor.ts` at lines 561, 585, 744, and 765, plus one `prefer-const` report in unchanged `apps/desktop/electron/main/browser/electron-browser-workspace.test.ts` at line 1185. `git diff --quiet a95c721 --` over both files exited 0; Task 8 did not modify them and the controller directed that they not be fixed here. |
| `pnpm build` | Exit 0; all packages, production Electron bundles, workflow worker, and local E2E Main built. |
| `pnpm exec playwright test apps/desktop/tests/e2e/cloud-user-data-sync.spec.ts` | Exit 0; all 8 serial scenarios passed. |
| `git diff --check` | Exit 0. |

Additional verification: `node apps/desktop/scripts/run-vitest-electron.mjs run apps/desktop/electron/e2e/cloud-user-data-sync-fixture.test.ts` passed 2/2 after its intentional RED run failed 2/2; the focused per-UID fixture migration suite passed 131/131; `pnpm exec playwright test --list` listed 40 tests in 2 files; and focused ESLint over all four review-changed TypeScript files exited 0. Full lint was rerun after the review correction and returned only the same documented 5-error baseline with 302 warnings.

## Task 8A relationship

The Task 8A boundary report's 92-test Agent/ExecutionService count was obtained with Task 8's per-UID fixture migration present in the working tree. Commit `a95c721` deliberately contains only the reviewed production boundary fix and its own focused regression; this Task 8 commit supplies the fixture migration needed to reproduce that broader integration count. The corrected relationship note in `task-8-execution-boundary-report.md` is included with this task.

## Remaining staging-only gaps

- No CloudBase function or PostgreSQL migration was deployed by this task.
- The actual supported PostgreSQL runtime, service-role RPC grants, CloudBase authentication context, unauthenticated/cross-owner denial, and data-preserving rollback still require staging execution.
- Counts and deterministic hashes must be compared inside staging's trusted boundary before remote reads are enabled.
- The local two-profile run is real Electron against a deterministic double; the runbook still requires dual-device staging acceptance before widening the feature flag.
- `confirmedPlatformCost` remains unavailable until a separately trusted platform billing source supplies it. BYOK estimates never populate or masquerade as that field.
- Media object bytes remain local and are outside this milestone.
