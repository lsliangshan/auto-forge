# SDD ledger — plan: docs/superpowers/plans/2026-08-26-personal-knowledge-base.md

## Baseline

- Branch start: `ee598fc`
- Planning commit: `bf4583c`
- `pnpm typecheck`: pass after workspace packages were built.
- `pnpm test`: 2774 pass, 1 pre-existing failure in the real context-summary billing test (`CONTEXT_LIMIT_EXCEEDED` instead of completion); targeted rerun reproduces it.

## Pre-flight consistency scan

| Task(s) | Producer → consumer or internal check | Finding |
|---|---|---|
| 1 | Shared DTO/schema → Preload/IPC/Main and later UI/Agent tasks | Consistent: Main-owned scope excludes paths, user ids, SQL, topK and index ids. |
| 2 | Encrypted DB/key/schema → Tasks 4, 6, 9 | Consistent: fail-closed gate and sensitive metadata isolation are explicit. |
| 3 | Parser/object protocol → Task 4 import lifecycle | Consistent: supported formats and one-time-key boundary match the spec. |
| 4 | Local service/retriever → Tasks 5 and 8 | Consistent: ready-only publication, 1/1 entitlement and short-query behavior are explicit. |
| 5 | Conversation selection → Task 8 immutable routing snapshot | Consistent: new conversations select none; Main persists and authorizes selection. |
| 6 | Cloud schema/client/sync → Tasks 7 and 9 | Consistent: JWT+RLS, generation publication and durable sync provide required seams. |
| 7 | Cloud retrieval/evidence → Task 8 knowledge tool | Consistent: consent, fixed 1024D embeddings and keyword-only degradation are explicit. |
| 8 | Agent evidence/citations → Task 5 chat UI and Task 9 kill switch | Consistent: priority/budgets and current-turn evidence validation match the spec. |
| 9 | Entitlement/kill switch → Tasks 4–8 feature availability | Consistent: Main remains authoritative and local export/delete remain available. |
| 10 | All production tasks → release verification | Consistent: unverified external/platform gates remain disabled. |
| 1 + 5 | `chatSendInputSchema`, DesktopAPI and persisted conversation preferences | Shared interface: Task 1 defines input/DTO shape; Task 5 supplies persistence and UI. No conflict. |
| 1 + 8 | citation/event union and Agent output | Shared interface: Task 1 defines strict citation references; Task 8 produces and renders them. No conflict. |
| 2 + 4 | schema/key lifecycle and local service transactions | Shared interface: Task 4 consumes Task 2's DB without putting sensitive fields in the app DB. No conflict. |
| 3 + 4 | parser results and atomic version publication | Shared interface: Task 3 returns structural blocks; Task 4 alone publishes ready generations. No conflict. |
| 4 + 5 | knowledge service IPC and Renderer store | Shared interface: Task 5 consumes only Task 1/4 DTOs. No conflict. |
| 4 + 8 | local retrieval and Main knowledge tool | Shared interface: Task 8 passes only query/rewrite; Task 4 resolves scope/snapshot. No conflict. |
| 6 + 7 | cloud generations and vector/index generation | Shared interface: Task 7 builds shadow generations through Task 6's durable publication model. No conflict. |
| 6 + 9 | cloud lifecycle and expiry/purge | Shared interface: Task 9 applies policy through Task 6 state transitions. No conflict. |
| 7 + 8 | hybrid results and evidence citations | Shared interface: retrieval returns immutable evidence ids/coordinates; Agent cannot forge them. No conflict. |
| 8 + 10 | grounding behavior and evaluation harness | Shared interface: Task 10 measures Task 8 acceptance gates. No conflict. |

No pre-flight ruling was required.

## Execution

- Task 1: started from `bf4583c`; implementer `/root/task1_contracts`.
- Task 1: review at `b6cd8c4` found owner/session propagation missing and kill-switch availability too coarse; fix round 1 started.
- Task 1: fix round 1/5 (2 addressed, 0 open; commit `f6a54eb`).
- Task 1: complete (commits `bf4583c..f6a54eb`, review clean).
- Task 2: started from `f6a54eb`; implementer `/root/task2_encrypted_store`.
- Task 2: review at `5324000` found one Critical (key-slot writes not crash-durable) and three Important findings (error-path handle leaks, blocked version lifecycle, missing cross-entity scope constraints); fix round 1 started.
- Task 2: fix round 1/5 (4 addressed, 0 open; commit `ff14995`).
- Task 2: minor (deferred): simultaneous key-record sync and handle-close failures may report the close error; operation still fails closed before rekey.
- Task 2: minor (deferred): dual-key AggregateError path is code-covered but lacks a dedicated injected assertion.
- Task 2: complete (commits `f6a54eb..ff14995`, review clean with 2 deferred minors).
- Task 3: started from `ff14995`; implementer `/root/task3_parsing`.
- Task 3: Ruling: implement the restricted parser as a dedicated hidden sandboxed Electron Renderer process, not a Node child — Node 24 permission flags cannot deny sockets, while a sandboxed no-Node Renderer with a dedicated session, CSP `connect-src 'none'`, Main `webRequest` denial, and transferable encrypted bytes provides a cross-platform enforceable boundary and still satisfies “restricted child process”; cost if wrong: additional Renderer build entry/lifecycle complexity and possible large-buffer IPC overhead.
- Task 3: review at `b14343a` found two Critical findings (shutdown can miss starting work; decompression budget is not hard) plus key/buffer cleanup, exception-safe teardown, response aggregate bounds, Markdown inline HTML, and boundary-test gaps; fix round 1 started.
- Task 3: fix round 1/5 (7 addressed, 4 open — synchronous Brotli allocation precedes accounting; response metadata lacks aggregate bound; Markdown quoted/cross-block active HTML leaks; empty-password encrypted PDF not detected; commit `f928393`).
- Task 3: fix round 2/5 (3 addressed, 1 open — incomplete safe HTML tag can hide a following dangerous opener; commit `a89e115`).
- Task 3: fix round 3/5 (1 addressed, 0 open; commit `0a7db76`).
- Task 3: complete (commits `ff14995..0a7db76`, review clean).
- Task 4: started from `0a7db76`; implementer `/root/task4_local_service`.
- Task 4: Ruling: lifecycle IPC contracts absent from Task 1 may be added surgically in Task 4 because lifecycle+IPC is an explicit Task 4 output and Task 5 depends on it; requests remain Main-scoped and path-free — cost if wrong: a wider Task 4 diff across shared/preload/IPC files.
- Task 4: Ruling: until signed entitlement verification is implemented in Task 9, the injected default entitlement is non-member local-only (one KB/one active file) and cloud stays disabled — cost if wrong: paid-member local multi-KB cannot be exercised until Task 9.
- Task 4: Ruling: extend the encrypted DB with opaque managed-object metadata and conversation selections, and add a separate durable safeStorage-wrapped 32-byte object master key that survives DB-key rotation — import/export/reopen otherwise cannot work and deriving wraps from the rotating DB key would invalidate retained objects; cost if wrong: another local key lifecycle and sidecar record must be maintained and migrated.
- Task 4: review at `74b7786` found three Critical findings (import/lifecycle publication races, non-resumable purge, auth-transition admission race) and two Important findings (no durable background import recovery, base purge leaves document tombstones); fix round 1 started.
- Task 4: Ruling: fix with encrypted `local_import_jobs`, authoritative generation heads, monotonic `purge_operations`, short per-owner mutation serialization, token/generation publication CAS, and an Application/IPC exclusive auth epoch gate spanning owner derivation through operation completion — these are the minimum durable seams that close all three races; cost if wrong: additional state-machine and recovery complexity in Task 4.
- Task 4: fix round 1/5 (auth admission, base tombstones and much of background import/purge addressed; 4 open — pre-snapshot authority race, superseded parser drain gap, purge journals not auto-reconciled/jobs retained, snapshot directory entry not fsync-durable; commit `7f41a9d`).
- Task 4: fix round 2/5 (4 addressed, 1 open — CAS-rejected snapshot cleanup can swallow unlink/dir-sync failure and leave an unjournaled managed object; commit `3665737`).
- Task 4: fix round 3/5 (1 addressed, 0 open; commit `89f4b5b`).
- Task 4: complete (commits `0a7db76..89f4b5b`, review clean).
- Task 5: started from `89f4b5b`; implementer `/root/task5_ui`.
- Task 5: review found owner-state leakage/stale publication, entitlement/scope gaps, unbounded overlapping polling, optimistic preference drift, ambiguous read-only/failed semantics, missing recycle confirmation/accessibility state, and a DTO-only smoke; fix wave implemented with owner epochs/request versions, bounded single-flight polling, Renderer+Main gates, authoritative preference recovery, usable published/read-only semantics, and a reproducible real encrypted Electron smoke.
- Task 5: fix-wave verification passed Renderer 366/366, Main knowledge/Application review slice 11/11, typecheck, targeted lint, production build, and `pnpm smoke:knowledge-ui`; report and commit handoff complete.
- Task 5: rereview at `1dd147d` found route-unmount publication races, missing free 1/1 advisory gates, read-only/searchability drift, optimistic fallback after double failure, and child-owned timeout cleanup; fix round 2/5 started.
- Task 5: fix round 2/5 addressed all rereview findings with an authoritative `searchable` DTO, route request invalidation, free quota gates, per-conversation confirmed snapshots, and parent-owned process-group/temp-root cleanup. Verification passed shared 76/76, Renderer 374/374, Main review slice 17/17, focused KnowledgeService/runner 34/34, typecheck, lint, production build, and the real repo smoke.
- Task 5: rereview at `18c530c` found divergent Main selection eligibility, a checked-disabled stale-choice trap, and deleted/local-processing status drift; fix round 3/5 started.
- Task 5: fix round 3/5 reused one active-plus-published-ready predicate for catalog/selection reads/writes, kept checked stale choices removable, and corrected deleted-document/local-processing labels. Verification passed focused KnowledgeService 33/33, focused knowledge Renderer 35/35, full Renderer 379/379, typecheck, targeted lint, production build, and real Electron smoke; full Desktop Node remained at the recorded baseline of 2,366 pass plus the unrelated context-summary billing failure.
- Task 5: rereview at `4bae011` found the real KnowledgeService parser probe still inherited an OS temp root outside the parent-owned smoke cleanup boundary; fix round 4/5 started.
- Task 5: fix round 4/5 validates the runner-owned root and overwrites smoke-child `TMPDIR`/`TMP`/`TEMP`, with a real-service hard-timeout regression proving probe-file containment, descendant termination, and root removal. Verification passed runner 3/3, workspace typecheck, targeted lint, diff check, production build, and the real Electron smoke. The exact prior stale probe root was moved recoverably to `/Users/liangshan/.Trash/autoforge-knowledge-probe-jXq1CV-task5-round4`.
- Task 5: complete (commits `89f4b5b..43cb4f6`, final rereview clean).
- Task 6: started from `43cb4f6`; implementer `/root/task6_cloud_sync`.
- Task 6: Ruling: Electron Main reaches personal-knowledge cloud operations only through the authenticated CloudBase SDK function boundary; the Cloud Function derives the owner solely from trusted runtime context and keeps the PostgreSQL service credential server-side — this satisfies the user-JWT-only client boundary while allowing state transitions to remain server-owned; cost if wrong: a future direct user-JWT PG Storage data plane would require an additional narrowly scoped port and live RLS validation.
- Task 6: Ruling: because no `tcb`, PostgreSQL client, CloudBase integration variables, or approved sandbox environment is configured, ship matching migration/rollback/function artifacts while retaining the existing `kill_switch_enabled` desktop gate and do not touch the real `autoforge-d1gkhyfb419ba8455` environment — cost if wrong: cloud sync remains intentionally unavailable until migration, private storage, RLS, lease/CAS, rollback, and cross-owner integration tests pass in pre-production.
- Task 6: implementation ready for task review: encrypted durable offline queue, cursor/full-resync boundary, conflict preservation, bounded transient retry, lease/CAS, staging publication, cancellation/orphan cleanup, pause, and verified conversion are covered; canonical Electron Main verification is 2,382 passing plus the recorded unrelated context-summary billing failure.
- Task 6: review at `ad629bd` found a page-global cursor that could skip the 1,001st change, incomplete retention/job/conversion/upload lifecycles, missing per-base synchronization serialization, incomplete composite ownership constraints, an overloaded local conflict kind, and an overbroad sequence grant; fix round 1/5 started.
- Task 6: Ruling: consumable uploads use a private server-side PG Storage adapter that returns a short-lived signed PG Storage authorization while persisting and consuming the database ticket; Electron receives neither COS credentials nor permanent object URLs — cost if wrong: the three deployment-owned PG Storage adapter endpoints must be mapped to the final CloudBase Storage API without changing the authenticated Function or Main envelopes.
- Task 6: fix round 1/5 addresses all review findings with page-last cursors/`hasMore`, durable retention floors and snapshots, terminal third leases and a transient allowlist, per-base epoch serialization, crash-safe conversion journals, verified one-time uploads/private-byte cleanup, composite owner FKs, orthogonal conflict kinds, and narrow identity-sequence grants. Focused verification passed CloudBase 18/18 and Main knowledge 116/116; canonical Electron Main is 2,394 passing plus the same recorded unrelated context-summary billing failure.
- Task 6: fix round 2/5 closed the known in-flight cancel race by atomically invalidating the leased mutation's per-base epoch; RED proved a late remote mutation could otherwise proceed into pull, and GREEN passed sync 19/19 plus Main knowledge 116/116 (commit `cc112f9`).
- Task 6: full rereview at `cc112f9` found four Important findings: non-idempotent replay of conflict receipts, orphan cleanup racing upload verification, incomplete same-document composite ownership constraints, and resumed synchronization reporting synced while an unexpired invalidated lease remains; fix round 3 started.
- Task 6: minor (deferred): a permanent pull/full-resync/application exception can leave the durable mode reporting `syncing`; final whole-branch review must triage whether this remains non-blocking.
- Task 6: fix round 3/5 (4 addressed, 1 open — durable orphan-cleanup request ids can exceed the 128-character API/SQL limit for valid long storage references; commit `b2011b4`).
- Task 6: fix round 4/5 (0 addressed, 1 open — pre-fix durable orphan rows retain legacy overlong request ids because `INSERT OR IGNORE` does not backfill them; commit `e818adc`).
- Task 6: fix round 5/5 (1 addressed, 0 open — exact legacy cleanup identities migrate durably to fixed private v1 ids while unrelated states fail closed; commit `7634b07`).
- Task 6: complete (commits `43cb4f6..7634b07`, full review plus scoped rereviews clean with 1 deferred minor and Critical/Important zero).
- Task 7: started from `7634b07`.
- Task 7: Ruling: without an approved CloudBase pre-production environment or TokenHub integration credential, implement repository-deployable Function/Main contracts with injected deterministic test adapters, keep cloud and beta gates fail-closed, and record live embedding/vector/RLS behavior as an external release gate — cost if wrong: deployment adapter mapping and live generation/index validation may require a later compatibility fix before enabling cloud retrieval.
- Task 7: implementation at `78a2a93`; focused verification passed Function/shared/RBAC 116/116, Main/IPC/Preload 175/175, and UI 36/36.
- Task 7: review at `78a2a93` found two Critical findings (hybrid retrieval/embedding-consent mutation unreachable from the production Main/IPC path; consent revocation can race post-snapshot TokenHub sends) and one Important finding (owner-global retrieval mode mislabels per-base state); fix round 1 started.
- Task 7: fix round 1/5 (2 addressed, 1 open — production reachability and per-base mode fixed; revocation can still hang on a stranded no-expiry send lease after Function termination or release-RPC failure; commit `6a4b4c7`).
- Task 7: Ruling: use durable `admitted -> sending -> released|expired` send leases with a 10-second admission deadline, non-extendable 30-second sending deadline, and 20-second TokenHub timeout; revocation advances the epoch/closes admission, expires unsent leases immediately, waits only already-sending leases to their fixed deadlines, then deletes vectors; terminal rows are retained seven days — this gives a bounded no-late-send repository contract while keeping live abort/timing behavior behind the disabled pre-production gate; cost if wrong: slow TokenHub calls may degrade to keyword-only or the internal deadlines may need adjustment before cloud enablement.
- Task 7: fix round 2/5 (0 addressed, 1 open — completion can release expired/admitted or missing leases and Function treats `expired` as confirmed safe completion, allowing late provider success to proceed; commit `01ac96a`).
- Task 7: fix round 3/5 (1 addressed, 0 open — only exact current unexpired `sending` may release; provider success after expiry/revocation is discarded; commit `2d3f796`).
- Task 7: complete (commits `0cd9c6b..2d3f796`, task review plus scoped rereviews clean and Critical/Important zero).
- Task 8: started from `2d3f796`.
