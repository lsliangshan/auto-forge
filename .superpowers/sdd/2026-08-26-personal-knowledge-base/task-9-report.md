# Task 9 Report: Membership lifecycle, signed entitlement, and kill switch

## Outcome

- Added a strict Main-owned Ed25519 entitlement envelope. Canonical signed bytes bind the user, exact sorted `knowledge_base_beta`/`knowledge_base_cloud` entitlements, `issuedAt`, snapshot expiry, membership expiry/status, `keyId`, and kill switch. The production trusted-key allowlist is intentionally empty.
- Added an encrypted owner-scoped SafeStorage cache containing only the last verified signed envelope plus per-user maximum observed clock and issued time. Every use and restart verifies the signature again. Rollback, future issue, removed/untrusted keys, different same-issued-at envelopes, and first-use stale snapshots fail closed.
- Limited offline grace to 72 hours after snapshot expiry for an envelope that was previously cached while active and whose membership horizon is still active. Signed expired/revoked state is expired immediately; signed kill switch never becomes grace and disables beta, cloud, and new Agent knowledge admission.
- Preserved the authoritative non-member local mode: at most one local knowledge base and one active logical file, while production-empty trust disables beta, cloud, and new Agent knowledge tools. Existing atomic replacement semantics remain intact.
- Added durable per-user downgrade lifecycle state. At expiry, all local content becomes encrypted read-only and non-searchable until the user atomically retains exactly one ready, non-recycled, local-only file in one base. Selection is idempotent, survives restart, clears if the retained item is recycled/purged, restores content after renewal, and requires a new choice on a later expiry.
- Serialized selection against import/replace/recycle/purge. The selection transaction cancels every active import authority, sets the exact retained base/file access state, then aborts and drains all late snapshot/parser jobs before returning. Recycled, purged, cloud-synced/non-local, non-ready, and cross-scope documents cannot be selected.
- Persisted exact lifecycle boundaries: `[expiry, +30d)` download/convert window, `[+30d, +60d)` recycle window, and `>= +60d` purge eligibility. Local cached export, recycle, purge, and immediate deletion remain available throughout. No claim is made that logical purge erases physical SSD remnants or third-party backups.
- Closed all cloud surfaces on a signed/server kill switch: cloud search, captured cloud-snapshot search, embedding-consent reads/mutations, and new Agent knowledge tool admission. An already-captured authorized local-only immutable snapshot can finish; it performs no new provider/cloud disclosure. Local management/export/delete remains visible and enabled.
- Wired the downgrade choice through Application/KnowledgeService, authenticated IPC, strict shared schemas, Preload, Pinia, and UI. Renderer state remains advisory; Main revalidates owner, entitlement, membership epoch, base, file, version, locality, and current lifecycle.
- Added a minimal deployable server envelope adapter that accepts only an injected `signCanonical(bytes, deploymentKeyId)` private KMS signer. The authenticated `get_entitlement` handler has a fail-closed injection seam, while the production entry deliberately provides no signer because no approved KMS signer, public key, TokenHub credential, or pre-production CloudBase exists.

## Exact RED evidence

- Verifier first slice:
  - `pnpm --filter @autoforge/desktop exec vitest run electron/main/knowledge/entitlement-verifier.test.ts --config vitest.node.config.ts --reporter=dot`
  - RED: suite failed to load because `entitlement-verifier.js` did not exist.
  - SafeStorage cache follow-up RED: 1 failed / 11 passed because `SafeStorageKnowledgeEntitlementCache` did not exist.
- Shared lifecycle/IPC schema RED: shared contracts reported 1 failed / 80 passed because lifecycle fields and the downgrade selection request were rejected.
- Production trust RED: focused Application test failed because production still returned the legacy unsigned four-field entitlement instead of the fail-closed local-only state.
- Agent kill-switch RED: focused KnowledgeService test failed because a new snapshot remained selected after the switch.
- Downgrade lifecycle RED: focused KnowledgeService test failed because expired content remained ready/searchable instead of becoming read-only.
- IPC/Preload/shared boundary RED: 3 failed / 126 passed because the request schema, bridge function, and authenticated handler did not exist.
- Renderer downgrade RED: 1 failed / 38 skipped because no retained-file guidance/action existed.
- Restart/deletion RED: recycling the retained file left its base ready/searchable instead of clearing the durable selection.
- Late import race RED:
  - `pnpm --filter @autoforge/desktop exec vitest run electron/main/knowledge/knowledge-service.test.ts --config vitest.node.config.ts -t "atomically cancels and drains late imports" --reporter=dot`
  - RED: 1 failed / 41 skipped; `abortedBeforeSelectionReturned` was `false`.
- Kill-switch/lifecycle UI RED:
  - `pnpm --filter @autoforge/desktop exec vitest run tests/components/knowledge.test.ts -t "cached cloud export|membership lifecycle boundary" --reporter=dot`
  - RED: 4 failed / 39 skipped; the signed kill-switch notice, local cloud-cache actions, and three lifecycle messages were absent.
- Server adapter RED:
  - `node --test cloudbase/knowledge/function/entitlement-envelope.test.js`
  - RED: `MODULE_NOT_FOUND` for `entitlement-envelope.js`.
- First broad KnowledgeService run exposed 6 failures / 66 passes: a missing `createBase` entitlement binding, a list/open/close await race introduced by lifecycle reconciliation, and an old consent test that still expected an unsigned cloud grant. Each root cause was fixed without weakening production trust.
- First typecheck reported four Task 9 errors (readonly fixture payload and narrowed lifecycle); first quiet lint reported eight Node-global errors in the new CommonJS adapter test. Both were corrected narrowly.
- Offline/replay hardening RED:
  - focused verifier run reported 2 failed / 16 skipped because a never-cached stale envelope entered grace and a different valid envelope with the same `issuedAt` extended membership.
- Durable restart RED: service focus returned `requiresSelection: true` after a retained selection was restored; Renderer focus called `getEntitlement` once instead of reconciling again after Main opened the catalog.
- Captured cloud disclosure RED: focused synced-selection test made a second remote search after kill switch (`searchPublished` calls 2 instead of 1).
- All-cloud-operation REDs: signed kill switch initially allowed `setEmbeddingConsent('revoked')` and then `getConsent()` still returned the remote granted state. Both now fail closed without remote calls.
- Server tool-catalog RED: focused local snapshot test returned `selected: true` after the authoritative server kill switch changed to enabled. New Agent admission now consults that server state as an additional denial, while an already-captured local-only snapshot can still finish offline.

## GREEN and verification

- Entitlement verifier/cache full suite: 18 passed, including literal valid, expired, revoked, wrong-user, wrong-key-id, wrong-public-key, tampered, future-issued, exact skew, exact grace, exact 30/60-day, stale-first-use, replay/equivocation, rollback, and owner-cache fixtures.
- Late import selection focus: 1 passed / 41 skipped. The parser signal is aborted before selection returns, the active authority is gone, the task is drained, and the late document remains failed/read-only.
- Downgrade focus: idempotent selection, recycle/purge invalidation, cloud-synced rejection, renewal, later expiry, and restart recovery all passed.
- Main combined Electron-ABI run:

  `node scripts/run-vitest-electron.mjs run electron/main/knowledge electron/main/application.test.ts electron/main/ipc/register-ipc.test.ts electron/preload --config vitest.node.config.ts --reporter=dot`

  Result: 16 files, 365 passed / exactly 1 failed. The only failure is the required unrelated Application baseline `bills real context-summary streams through the Application-supplied provider snapshot`; its emitted block and failed status both contain `CONTEXT_LIMIT_EXCEEDED`.
- Renderer knowledge suite: 1 file / 44 passed.
- Shared contracts: 1 file / 81 passed.
- Server canonical/KMS adapter: 3 passed.
- `pnpm typecheck`: all four typed workspace projects passed.
- `pnpm lint --quiet`: exit 0, no errors.
- `pnpm build`: shared/workflow packages plus Electron Main, Preload, Renderer, parser worker, and workflow worker passed.
- `pnpm --filter @autoforge/desktop smoke:knowledge-ui`: real Electron Renderer -> Preload -> IPC -> Main -> parser -> encrypted persistence smoke passed with `{"ok":true}` and visible import acknowledgement, ready document, selector, persisted strict selection, and restored selection.

## Files changed

- Entitlement verification/cache: `apps/desktop/electron/main/knowledge/entitlement-verifier.ts` and test.
- Durable lifecycle and retrieval enforcement: knowledge schema, types, `knowledge-service.ts`, `local-retriever.ts`, import runtime, and tests.
- Production assembly and authenticated boundary: `application.ts`, IPC, Preload, shared contracts, and adjacent tests.
- Renderer: knowledge store, knowledge view, and component tests.
- Server contract: `cloudbase/knowledge/function/entitlement-envelope.js`, its Node test, and the CloudBase knowledge release-gate README.
- Evidence: this report. Controller-owned `progress.md` remains dirty, untouched by this agent, and excluded from staging.

## External gates

- No real CloudBase, PostgreSQL, PG Storage, TokenHub, provider, KMS, or production key was accessed or modified.
- No approved production Ed25519 public key or private KMS signer exists. Production trusted keys remain `{}`; beta, cloud, and new Agent knowledge admission therefore remain closed while local non-member management stays usable.
- The server signing adapter is wired only as an injected, fail-closed authenticated handler seam; the production Cloud Function entry provides no signer. Pre-production must supply an audited KMS signer, embed the matching build-time public-key allowlist, exercise rotation/revocation/clock behavior, and prove signed fetch/cache behavior before enabling any gate.
- Remote download/convert, scheduled recycle, remote purge eligibility, physical object deletion, PostgreSQL/RLS, and third-party backup retention require an isolated pre-production environment. This task persists and enforces the exact local state/window contract but does not claim those external operations ran.
- Logical purge does not claim forensic erasure from SSD wear-leveling, snapshots, logs outside the defined payload-free contract, or third-party backups.

## Self-review

- Re-read the full Task 9 production/test diff against signed-envelope ownership, offline grace, clock rollback/replay, no runtime key acceptance, local free quota, atomic downgrade selection, restart recovery, 30/60-day boundaries, kill-switch cloud closure, immutable local snapshot completion, Renderer advisory state, and Task 8 routing/privacy/budget preservation.
- Hardened four Important issues found during self-review: first-use stale grace and same-issued-at equivocation; late parser publication during selection; post-switch use of an already-captured cloud snapshot/consent surface; and server kill-switch removal of new local knowledge-tool admission.
- Verified production-empty trust never accepts the legacy unsigned CloudBase entitlement as a grant. The existing unsigned server response is consulted only as an additional denial while an injected/signed Main state already authorizes cloud use.
- Kept Task 8 workflow/browser policies, immutable version scope, provider disclosure contract, and 5/3/10/8 budgets unchanged.
- No Critical or Important issue remains in the Task 9 scope. The unrelated `CONTEXT_LIMIT_EXCEEDED` baseline and prohibited external release gates remain explicitly open concerns.

## Fix Round 1/5: entitlement lifecycle hardening

### Review findings resolved

- Serialized fetch/verify/commit with a per-user authority tail. Different owners still proceed independently, but a slow older active refresh can no longer overwrite or re-enable a newer revoked/kill state. Verification, cache, and clock failures become sticky for that owner for the process lifetime.
- Added a separate owner-enrollment watermark. The marker is durably written before the first encrypted record, so a crash can leave only the safer marker-without-record state. Once enrolled, missing, corrupt, undecryptable, or schema-invalid cache state fails closed and cannot bootstrap from a replayed older active envelope. Owner markers and failure state do not bleed across users.
- Reconciled unverifiable/free authority against retained paid data. A never-member installation retains the normal one-local-base/one-active-file mode; retained data above that quota instead becomes read-only/non-searchable, clears conversation scope, and requires an exact ready, non-recycled, local-only selection. The selection persists over restart and direct search/replace cannot bypass it.
- Made every legacy unsigned server field additional-denial only: member tier, active/offline-grace status, beta enabled, cloud enabled where applicable, and kill disabled are all required. An unsigned response never grants capability.
- Removed synced-cache disclosure after kill. Captured or direct synced/cloud scope never falls back to cached `allVersionIds`; only versions captured from bases that were local-only may complete. Every remote await is followed by a current gate check, including rejection fallback and snapshot capture.
- Hardened the signer boundary. Runtime auth supplies the owner, a strict database record supplies membership/status/flags, and frozen deployment configuration supplies key id, TTL, and time. Caller-shaped payloads, owners, flags, key ids, and timestamps are rejected. No configured signer means fail closed.
- Enforced terminal chronology: active membership expires strictly after issue, while expired/revoked membership terminates no later than issue. The 30-day download/convert and 60-day purge-eligibility boundaries anchor to that signed terminal timestamp, including early revocation.
- Added confirmed immediate document and base purge actions through Store -> Preload -> IPC -> Main, using the existing strict purge requests. Kill switch does not hide local management/export/delete/purge. Cloud download/convert is explicitly unavailable pending the external pre-production gate; the UI no longer promises an unassembled production operation.
- Canonical grammar now rejects surrounding user-id whitespace and requires a canonical base64url signature that decodes and round-trips exactly to 64 bytes. `createBase` now uses one serialized authoritative entitlement decision, so expiry during an earlier await cannot commit a base.

### Exact RED/GREEN evidence

- Verifier/cache initial review slice: RED 9 failed / 18 passed; GREEN 28 passed. It covers same-owner active-versus-kill ordering, different-owner concurrency, sticky write/clock failures, canonical user/signature grammar, terminal chronology, deletion/corruption/replay, restart, and owner isolation.
- Enrollment crash ordering: RED 1 failed / 27 skipped; GREEN in the 28-test verifier/cache suite. The injected marker-to-record failure leaves the marker present and missing record fail-closed after restart.
- Sticky rollback recovery: RED 1 failed / 27 skipped; GREEN in the 28-test verifier/cache suite.
- KnowledgeService lifecycle/denial/race review slice: RED 9 failed / 42 skipped; GREEN 9 passed. It covers retained-paid fail-closed selection, never-member 1/1 usability, restart enforcement, direct replacement/search, unsigned server denial matrix, synced-cache kill scope, and the `createBase` expiry race.
- First broad KnowledgeService rerun exposed one idempotent-selection regression (1 failed / 78 passed); the exact-match idempotency rule was corrected and the focused rerun passed 2/2.
- Final remote-await self-review slice first reproduced cached synced search after a kill, then reproduced a captured synced snapshot returning selected after the switch. Each behavior was literal RED in sequence; the final test passed 1/1 with 51 skipped.
- Server signer adapter: RED 0/4 because the hardened factory was absent; GREEN 4/4. Authenticated handler injection: RED 0/2; GREEN 2/2, with the full handler suite 42/42.
- Renderer reachability/truth slice: RED 2 failed / 43 skipped; GREEN 2/2. The full Renderer knowledge suite passed 45/45.

### Final verification

- Electron Main/Application/IPC/Preload combined runner: 16 files, 384 passed / exactly 1 failed (385 total). The sole failure is the pre-existing Application context-summary billing baseline; both the emitted block and failed status contain exactly `CONTEXT_LIMIT_EXCEEDED`.
- Renderer knowledge: 45/45. Shared contracts: 81/81. CloudBase knowledge handler: 42/42. Server signer: 4/4.
- `pnpm typecheck`: all four workspace projects passed.
- `pnpm lint --quiet`: exit 0.
- `pnpm build`: Main, Preload, Renderer, workers, shared, and workflow packages passed.
- `pnpm --filter @autoforge/desktop smoke:knowledge-ui`: real Electron Renderer -> Preload -> IPC -> Main -> parser -> encrypted persistence passed with `{"ok":true}`, visible import acknowledgement, ready document, selector, persisted strict selection, and restart restore.
- Diff self-review found and fixed the two additional remote-await gate variants above. Final Task 9 Fix Round 1 assessment: Critical 0, Important 0, Minor 0.

### External gates unchanged

- No real CloudBase, PostgreSQL, object storage, TokenHub, provider, KMS, or production key was accessed or modified.
- Production build-time trusted keys remain empty; beta, cloud, and new Agent knowledge admission remain closed. The free local 1-base/1-file management surface remains authoritative and usable.
- The authenticated signer seam has no production signer. Remote conversion/download remains explicitly unavailable until an owner-scoped pre-production cloud client, approved KMS signer/public key, and release-gate evidence exist.
- Logical purge does not claim physical SSD, snapshot, log, or third-party backup erasure.
