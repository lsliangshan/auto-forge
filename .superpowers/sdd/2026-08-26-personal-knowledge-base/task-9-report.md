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

## Fix Round 2/5: independent enrollment and entitlement CAS

### Review findings resolved

- Moved prior-enrollment state out of the entitlement-cache directory into the existing Main-owned application `appSettings` repository. The key contains only a domain-separated owner SHA-256. The independent marker commits before the encrypted record; marker-present plus missing/corrupt/decrypt-invalid record denies. A valid record with a missing marker restores only the marker while retaining its `maxIssuedAt`/`maxObservedAt`; an invalid record cannot reset history. Deleting both legacy cache-directory files while the independent marker survives now denies replay after restart. Never-enrolled owners still bootstrap independently.
- Added a per-owner monotonic authorization revision to `KnowledgeEntitlementAuthority`. A new signed envelope, kill/revoke/fail-closed transition, or changed full authorization advances the token. Async refresh compares token plus the complete state, and a final synchronous CAS closes the microtask gap before every next cloud side effect or returned admission/result.
- Reworked the deployable signer to consume the exact production RPC row `{tier,status,betaEnabled,cloudEnabled,killSwitchEnabled,version,validUntil}`. Runtime UID remains the only owner source; frozen deployment config owns key id, clock, and TTL. Member `active/offline_grace` with a future `validUntil` maps to signed active; free/expired maps to expired; unavailable maps to revoked; null terminal time uses trusted issuance for free/unavailable. Inconsistent rows and client-selected fields fail closed. Both checked-in migrations already emitted this exact contract, so no migration rewrite was needed.
- Aligned server canonical timestamps with Main's four-digit-year grammar. Extended-year `Date#toISOString()` values are rejected before signing.
- Applied the same authorization token across cloud availability, legacy server admission, direct/captured cloud search, cloud snapshot capture, consent reads, and consent mutations. Each remote await is followed by signed-token validation, server additional-denial validation where applicable, another signed refresh, and final synchronous CAS before another remote call or return. Signed kill/revoke discards late results; server kill still prevents synced-cache fallback. An already-captured local-only immutable Agent turn remains usable.
- Split Renderer `canPurge` from `canRecycle`. Recycled documents and bases remain reachable for confirmed strict purge while recycle stays disabled. A delayed document purge updates only the original base cache and does not clear or replace a newer selected base/document.

### Exact RED/GREEN evidence

- Independent enrollment and authority token: RED 6 failed / 25 passed; GREEN 31/31. Literal cases cover marker-before-record failure, one encrypted directory record with no sibling marker, deletion of both old directory files, corrupt/missing enrolled record, valid-record marker restoration without max-history loss, restart, owner isolation, and active-to-kill token invalidation.
- Actual RPC signer and timestamp grammar: RED 3 failed / 3 passed; GREEN 6/6. The handler's runtime-owner/exact-row forwarding boundary was already correct and remained GREEN 4 passed / 40 skipped; the missing behavior was the signer accepting that row.
- Final signer contract self-review added literal member `expired`/`unavailable` rows permitted by the real database schema: RED 1 failed / 5 passed because terminal member rows were rejected; GREEN 6/6. Their original entitlement flags remain signed, but the signed expired/revoked status denies capability. A member-expired row without an actual terminal timestamp and a free row carrying paid flags remain inconsistent and fail closed.
- First TOCTOU slice: RED 4 failed / 52 skipped. It reproduced stale cloud availability, new Agent admission after signed kill during the legacy await, returned granted consent after kill, and starting remote search after kill during snapshot capture. The corrected setup produced assertion failures rather than fixture errors.
- Self-review synchronous CAS slice: RED 1 failed / 56 skipped because a queued owner revision could advance after async validation but before caller continuation. GREEN focused result: 7 passed / 50 skipped, including the pre-existing local-only captured-turn positive and legacy server-kill synced-cache regression.
- Recycled purge and Renderer race: RED 2 failed / 45 skipped; GREEN focused 2/2 and full Renderer 47/47.
- First broad Electron rerun exposed one Task 9 regression plus the known baseline: 390 passed / 2 failed. The regression was a brittle Application test fixed to locate the consent mutation by action after the new post-check calls; focused rerun passed 1/1. No production gate was weakened.

### Final verification

- Entitlement verifier + KnowledgeService: 87/87 before the final synchronous-CAS addition; the final combined Electron runner includes the added case.
- Electron Main/Application/IPC/Preload: 16 files, 392 passed / exactly 1 failed (393 total). The sole failure remains the unrelated context-summary billing baseline; its emitted error block and failed status both contain exactly `CONTEXT_LIMIT_EXCEEDED`.
- Renderer knowledge: 47/47. Shared contracts + CloudBase handler: 125/125 (81 + 44). Server signer: 6/6.
- `pnpm typecheck`: all four typed workspace projects passed after the final CAS change.
- `pnpm lint --quiet`: exit 0. `pnpm typecheck`: all four typed workspace projects passed. `pnpm --filter @autoforge/desktop smoke:knowledge-ui` rebuilt Main, Preload, Renderer, parser/workflow workers and passed the real Electron Renderer -> Preload -> IPC -> Main -> parser -> encrypted-persistence path with `{"ok":true}`. Final `git diff --check` and staged-diff verification passed before commit.

### External gates unchanged

- No real CloudBase, PostgreSQL, object storage, TokenHub, provider, KMS, or production key was accessed or modified.
- Production build-time trusted keys remain empty; the Cloud Function entry still supplies no signer. Beta, cloud, and new Agent knowledge admission remain closed while authoritative free local 1-base/1-file management remains usable.
- The existing migrations were inspected only; no live migration or external mutation ran. Pre-production must prove the RPC row, KMS signer, key rotation/revocation, owner isolation, and clock behavior before enablement.
- Cloud download/convert remains explicitly unavailable pending the owner-scoped pre-production client and release gate. Logical purge still makes no physical SSD, snapshot, log, or third-party backup erasure claim.

### Self-review

- Rechecked marker crash ordering, deletion/corruption/restart recovery, owner-key privacy, token advancement on signed and sticky fail-closed state, server row exactness, four-digit timestamp grammar, every `this.options.cloud` await, synced-cache denial, local-only immutable snapshot completion, and recycled purge reachability.
- Additional issues found were the async-validation microtask gap and rejection of real-schema member terminal rows; each received a literal RED and narrow fix before final verification.
- Round 2 final assessment before external gates: Critical 0, Important 0, Minor 0.

## Fix Round 3/5: monotonic authority and signed free state

### Review findings resolved

- Replaced the independent boolean enrollment marker with a versioned owner-hash-bound appSettings watermark containing only `maxIssuedAt`, `maxObservedAt`, and the SHA-256 of the exact canonical accepted envelope. The watermark commits before encryption/cache replacement. A failed encryption or cache write therefore safe-locks against the older record. Restart rejects lower issued/clock values, same-issued equivocation, a restored whole old ciphertext, corrupt owner binding, and corrupt schema without storing raw entitlement payload outside safeStorage. Legacy boolean or safely missing markers migrate only from a valid decrypted owner-bound record; owners remain isolated.
- Added canonical signed `tier` to the pre-deployment v1 grammar in Main and server. The real default database row signs as free/active with empty entitlements and `membershipExpiresAt === issuedAt`; Main verifies it to writable local-only 1-base/1-logical-file authority with no membership lifecycle. Free rows cannot carry beta/cloud entitlements or member-only statuses. Member active/offline-grace and member expired/revoked retain exact membership horizons and 30/60-day lifecycle behavior.
- Reordered every cloud/tool authorization sequence so the local asynchronous refresh completes first and the final await is the legacy server snapshot. The next remote operation or return follows only synchronous full server-state/version validation plus local revision CAS. Post-remote validation follows the same local-refresh -> final-server -> synchronous-CAS order. A changed server version discards consent/search results and prevents synced-cache fallback even when all grant booleans still look active.
- Made delayed base purge publication selection-aware. It always removes the purged base/cache, but clears or replaces selection only if that base is still selected after the await; a newer base/document selection remains intact.

### Exact RED/GREEN evidence

- Independent watermark/cache: RED 6 failed / 28 passed (34 total). Missing cases were watermark-before-cache crash order, normal/migration watermark persistence, whole old ciphertext rollback, same-issued equivocation, and corrupt watermark denial. GREEN verifier/cache full suite: 35/35 after the signed grammar update.
- Signed free grammar: server RED 3 failed / 3 passed; Signer -> Verifier RED 1 failed / 34 skipped; Signer -> Verifier -> KnowledgeService RED 1 failed / 57 skipped because the default free row became expired lifecycle state. GREEN: signer 6/6, verifier/cache 35/35, and the end-to-end service focus 1 passed / 62 skipped.
- Server-final ordering/version: RED 5 failed / 58 skipped. Cloud availability and local-only new Agent admission survived a server kill/version flip during local refresh; consent read/mutation accepted a new server version; rejected remote search disclosed synced cached evidence after version advance. GREEN focused: 5 passed / 58 skipped.
- Delayed base purge: RED 1 failed / 47 skipped because the newer selected document was cleared. GREEN focused: 1 passed / 47 skipped; full Renderer knowledge 48/48.
- Final stale-kill self-review: RED 1 failed / 35 skipped because a signed member kill snapshot one millisecond past `snapshotExpiresAt` still returned active and could preserve paid local write/search authority indefinitely. GREEN focused: 1 passed / 35 skipped. A signed kill remains active only through its exact snapshot boundary, is never offline-graced, and stale verification fails closed with `snapshot_expired`.

### Verification

- Verifier + KnowledgeService: 99/99.
- Electron Main/Application/IPC/Preload: 16 files, 403 passed / exactly 1 failed (404 total). The sole failure is the unrelated context-summary billing baseline; its emitted error block and final failed status both contain exactly `CONTEXT_LIMIT_EXCEEDED`.
- Renderer knowledge: 48/48. Shared contracts + CloudBase handler: 125/125 (81 + 44). Server signer: 6/6.
- `pnpm typecheck`: all four typed workspace projects passed. `pnpm lint --quiet`: exit 0.
- `pnpm build`: shared/workflow packages, Electron Main, Preload, Renderer, parser worker, and workflow worker passed.
- `pnpm --filter @autoforge/desktop smoke:knowledge-ui`: real Electron Renderer -> Preload -> IPC -> Main -> parser -> encrypted persistence and restart restore passed with `{"ok":true}`; import acknowledgement, ready document, strict selector persistence, and restored selection were visible.

### External gates unchanged

- No real CloudBase, PostgreSQL, object storage, TokenHub, provider, KMS, or production key was accessed or modified.
- Production build-time trusted keys remain empty and the Cloud Function entry still has no signer. Beta, cloud, and new Agent knowledge admission remain closed; authoritative free local 1-base/1-file management remains usable.
- Pre-production must prove the real RPC row, KMS signature/key rotation, server-version transitions, owner isolation, rollback recovery, RLS, and cloud object lifecycle before enablement. Logical purge still makes no physical SSD, snapshot, log, or third-party backup erasure claim.

### Self-review

- Rechecked watermark crash order, whole-ciphertext rollback, same-issued hash binding, legacy migration, corrupt owner isolation, free/member canonical grammar, fixed literal signatures, local quota reconciliation, member terminal windows, and every server/cloud await.
- Moved synced cached fallback computation before final post-remote authorization and returns only its already-computed result after the final server/CAS segment; no synced evidence is loaded after that validation.
- Found and fixed one preserved Round 1 issue during final self-review: `killSwitchEnabled` had incorrectly bypassed snapshot expiry for member local authority. Literal boundary coverage now proves exact-expiry denial without granting offline grace.
- Round 3 assessment before prohibited external gates: Critical 0, Important 0, Minor 0.

## Fix Round 4/5: signed equivocation fails closed

### Finding resolved

- A schema-valid, signature-valid envelope with the same `issuedAt` as the cached envelope or independent maximum watermark is now compared byte-for-byte by canonical payload and signature. Any non-identical value is signed equivocation, not an ordinary rollback: the owner enters sticky process-lifetime fail-closed state before any cache write, the authorization revision advances, and cached member authority cannot be reused.
- Literal revoked, kill-switch, canonical free, and different membership-horizon envelopes exercise the same-issued branch. Each returns authoritative free local quota with beta/cloud/new knowledge-tool admission denied, invalidates the captured member authorization, leaves the cache/write boundary unchanged, and refuses identical, strictly newer, or older recovery attempts in the same process. Restart or an explicit future recovery design is required; no implicit unstick path was added.
- Exact canonical replay remains idempotent and retains the same authorization revision. Failure remains isolated per owner; an unaffected second owner continues with active signed member authority.

### Exact RED/GREEN evidence

- Focused same-issued review RED: 5 failed / 3 passed / 34 skipped. The four signed equivocation variants and owner-isolation case all incorrectly returned the cached member state with beta/cloud/tool enabled.
- Focused GREEN: 7 passed / 34 skipped. This includes four equivocation variants, owner isolation, identical replay idempotency, and the existing independent cache-watermark equivocation case.
- Verifier + KnowledgeService: 104/104.
- Electron Main/Application/IPC/Preload: 16 files, 408 passed / exactly 1 failed (409 total). The sole failure remains the unrelated context-summary billing baseline; its emitted block and final failed status both contain exactly `CONTEXT_LIMIT_EXCEEDED`.
- `pnpm typecheck`: all four typed workspace projects passed. `pnpm lint --quiet`: exit 0.
- `pnpm --filter @autoforge/desktop smoke:knowledge-ui`: rebuilt Main, Preload, Renderer and workers, then passed the real Electron Renderer -> Preload -> IPC -> Main -> parser -> encrypted persistence/restart path with `{"ok":true}`.

### External gates and self-review

- No real CloudBase, PostgreSQL, object storage, TokenHub, provider, KMS, or production key was accessed or modified. Production trusted keys and Cloud Function signer remain absent, so beta/cloud/new Agent knowledge admission remain closed.
- Rechecked the acceptance order: equivocation detection occurs only after strict schema and signature verification, before offline-grace acceptance and before the cache write. Malformed/untrusted/offline input preserves the existing verified-cache fallback; exact replay remains idempotent; strictly newer ordinary authority remains accepted unless that owner has already entered the deliberately sticky error state.
- Round 4 assessment before prohibited external gates: Critical 0, Important 0, Minor 0.

## Fix Round 5/5: authenticate equivocation before temporal denial

### Finding resolved

- Split `KnowledgeEntitlementVerifier` into module-private authenticated-candidate construction and current-time evaluation while preserving the public `verify()` contract as their composition. Static authentication covers strict schema/canonical grammar, exact owner, build-time trusted key, Ed25519 signature, canonical payload bytes, exact signature, SHA-256 envelope identity, and structural tier/time ordering. It deliberately does not apply future-issued, snapshot-expiry, offline-grace, or membership-current-time policy.
- `KnowledgeEntitlementAuthority` now authenticates both cached and fetched envelopes before any current-time evaluation or cache fallback. A same-issued non-identical authenticated candidate therefore reaches equivocation comparison even when a signed kill snapshot is one millisecond stale or a signed free snapshot's shorter grace is already invalid. Equivocation becomes sticky owner-local fail-closed, advances the authorization revision, and performs zero additional cache/watermark writes.
- Only after authenticated identities do not conflict does the authority evaluate both candidates at one captured current time. Invalid schema/owner/key/signature input never becomes authenticated equivocation and retains normal verified-cache fallback. An exact identical replay after the boundary is authenticated and compared idempotently, then receives the existing temporal denial or offline-grace behavior.

### Exact RED/GREEN evidence

- Focused RED after all literal cases were present: 3 failed / 1 passed / 41 skipped. Stale signed kill and grace-invalid signed free incorrectly returned cached member offline-grace with beta/cloud/tool enabled; the identical expired replay returned before fetching/authenticating its second signed identity. The invalid-signature same-issued case already passed as the required non-poisoning control.
- Focused GREEN: 4/4 with 41 skipped. Full verifier: 45/45. Verifier + KnowledgeService: 108/108.
- Electron Main/Application/IPC/Preload: 16 files, 412 passed / exactly 1 failed (413 total). The sole failure remains the unrelated context-summary billing baseline; its emitted block and final failed status both contain exactly `CONTEXT_LIMIT_EXCEEDED`.
- `pnpm typecheck`: all four typed workspace projects passed. `pnpm lint --quiet`: exit 0.
- `pnpm build`: shared/workflow packages, Electron Main, Preload, Renderer, parser worker, and workflow worker passed.
- `pnpm --filter @autoforge/desktop smoke:knowledge-ui`: rebuilt Main, Preload, Renderer and workers, then passed the real Electron Renderer -> Preload -> IPC -> Main -> parser -> encrypted persistence/restart path with `{"ok":true}`.

### External gates and final self-review

- No real CloudBase, PostgreSQL, object storage, TokenHub, provider, KMS, or production key was accessed or modified. Production trusted keys and Cloud Function signer remain absent; beta/cloud/new Agent knowledge admission stay closed.
- Rechecked that unauthenticated input never leaves Main or participates in identity comparison; only the module-private authenticated candidate reaches authority logic. Canonical payload/signature/hash all agree for exact replay, while any authenticated same-issued difference fails before cache mutation. Existing restart-required sticky recovery policy is unchanged.
- Round 5 final assessment before prohibited external gates: Critical 0, Important 0, Minor 0.
