# Task 4 Report: Local knowledge lifecycle, retrieval, and IPC

## Status

Implemented the login-scoped local knowledge service and verified it on the current macOS arm64 host. The service remains fail-closed on unverified platforms, and cloud access remains disabled. The implementation commit uses the required subject `feat(knowledge): manage and search local libraries`.

## Implementation

- Added a per-owner `KnowledgeService` with lazy `我的知识库` creation, create/list/version operations, Main-owned import and export dialogs, replacement, recycle, permanent purge, conversation selection, bounded retrieval, entitlement enforcement, and explicit shutdown.
- Enforced the default non-member limit of one non-recycled local library and one non-recycled file in Main. An injected member entitlement is honored only while active or in offline grace; expired and unavailable memberships use the free limits. No payment or cloud-access claim was added.
- Added encrypted-database-only `source_objects`, `knowledge_metadata`, `conversation_selections`, and `conversation_selection_bases`. Source metadata stores an opaque UUID `.afobj` name, encrypted file-key wrap, size, hash, and display filename; it never stores the original source path.
- Added a separate random 32-byte object master key in the same atomic, durable, safeStorage-wrapped key-record format as the database key. An HMAC check stored inside the encrypted database detects missing or substituted object keys. The object key is loaded only for an operation, cleared in `finally`, and intentionally survives database-key rotation.
- Import snapshots and encrypts the selected file before parsing. Version/block/chunk rows become visible together in one publication transaction. A replacement keeps its prior active version and prior display filename searchable until publication; parser failure records a failed staging version and restores the prior ready document state.
- Retrieval takes only a Main-owned conversation selection plus query. One Unicode code point returns `ask_for_detail`; two use bounded selected-scope `instr`; three or more use a safely quoted literal trigram `MATCH`. All paths use the fixed Main-side limit of eight and join only active libraries and active ready versions.
- Export writes an atomic ZIP with `manifest.json` and decrypted version originals. The manifest includes version metadata and content hashes but excludes source/local paths, managed object names, wrapped keys, vectors, secrets, and URLs.
- Recycle removes a base from selections and records a 30-day tombstone. Permanent purge deletes the graph and file-key wraps, removes managed object files, runs `VACUUM` to rebuild the encrypted database, and rotates the database key without claiming physical overwrite.
- Extended strict shared, preload, and IPC contracts for the lifecycle operations. Renderer requests accept only names/resource IDs, conversation IDs, and query text; they do not accept paths, user IDs, SQL, `topK`, index IDs, or entitlement claims. Every IPC owner still comes from Main authentication.
- Application composition now derives conversation ownership from the existing application repository, closes knowledge state before login/logout identity changes, calls parser `terminateAll()` before knowledge database teardown, and closes knowledge before the application database. The production parser factory resolves emitted parser HTML and preload assets relative to `import.meta.url`; it contains no development path.

## TDD evidence

- Initial service RED: focused Electron tests failed to resolve `knowledge-service.js` and `local-retriever.js` before those modules existed.
- Import/replacement RED/GREEN: tests exposed fixture publication ordering, globally reused parser block IDs, and premature filename publication. Production now namespaces block IDs by version and updates the active version, filename, MIME type, chunks, and job state in one publication transaction.
- Entitlement RED/GREEN: an expired member initially bypassed the free limit; the final membership predicate admits only active and offline-grace members.
- Lifecycle RED/GREEN: closing during an in-flight session open initially leaked the parser/session. Shutdown now drains opening, terminates the parser, waits tracked mutations, closes the encrypted database, and permits a fresh owner scope.
- Object-key RED/GREEN: the tests reopen imported objects and selections, then prove missing and substituted object-key records fail closed. The purge test rotates the database key and then exports/decrypts the retained object's original bytes, proving the independent object key and wraps survive DB-key rotation.
- Export RED/GREEN: ZIP generation initially exposed a signed external-attribute encoding bug; the final archive uses unsigned fields and passes manifest/original-content checks.
- Application RED/GREEN: the real boundary test caught a shutdown-promise reset bug. The final application test exercises auth, real app and encrypted repositories, the real object envelope and TXT parser, mocked native dialogs, search/export, parser-before-DB logout ordering, and cross-user selection denial.

## Final verification

- Shared contracts and preload: 2 files, 93 tests passed.
- Electron knowledge and IPC suites: 9 files, 88 tests passed.
- Focused real Application boundary: 1 test passed (147 unrelated tests skipped).
- Repository typecheck: passed for shared, workflow schema/SDK, and desktop Node/Renderer projects.
- Targeted ESLint over every changed source and test file: passed with no findings.
- Desktop production build: passed and emitted the packaged parser HTML, parser preload, and Main references to their relative packaged locations.
- `git diff --check`: passed.
- Full repository suite: 103 files and 2,845 tests passed; one pre-existing unrelated test failed at `application.test.ts:3765`, `bills real context-summary streams through the Application-supplied provider snapshot`, because it received `CONTEXT_LIMIT_EXCEEDED`. The failure was not hidden or changed.

## Self-review and release gates

- Existing application-database migrations and repositories were not extended. The real Application test scans application-database artifacts and finds none of the imported filename, chunk text, or search query.
- Cross-user access fails before a second owner's database can replace the active scope; conversation selection also requires ownership from the Main application repository and validates every selected base in the owner's encrypted database.
- Import and export chooser paths remain Main-local. Only opaque managed relative object names are persisted, and those are validated before filesystem resolution.
- The separate object master key never enters IPC, parser messages, Renderer state, logs, exports, or the existing application database. The parser receives only a one-time unwrapped file key and encrypted object path.
- macOS x64 and Windows x64 remain unverified and fail closed. The local feature is enabled only on verified darwin/arm64 with available safeStorage and a configured parser runtime.
- Signed paid entitlements and cloud access intentionally remain later work. The default is local-only free policy; cloud availability retains the kill switch.
- `VACUUM` provides a logical encrypted database rebuild and key rotation provides new database encryption material; neither is represented as physical media erasure.

## Fix round 1: durable concurrency and recovery

### Implementation and self-review

- Split the approved responsibilities so `KnowledgeService` no longer duplicates background job or purge transaction logic: `KnowledgeImportRuntime` owns job claim/reconciliation/CAS publication/cancellation, `KnowledgePurgeService` owns the durable purge state machine, and `KnowledgeAdmissionGate` owns auth epochs.
- Added encrypted-only `local_import_jobs`, `document_import_heads`, and `purge_operations`. Import authority tokens are random opaque values; a newer generation cancels the previous generation, and every publication transaction checks job status, generation, job ID, and authority token before making a version ready.
- Import now returns after the encrypted snapshot, source row, and pending job are durable. Session open reconciles stale running jobs, resumes authoritative pending jobs, marks missing snapshots failed, removes only strictly validated unreferenced managed objects, and does not parse an already-completed job twice.
- Recycle and purge cancel authoritative jobs before aborting/draining parser work. A prepared purge journal blocks later replacements/imports in the same entity scope, closing the gap while parser cleanup is awaited.
- Purge validates every managed object name before graph deletion and persists monotonic `prepared -> graph_deleted -> objects_unlinked -> vacuumed` states. Retry after reopen tolerates an already-unlinked file, reruns `VACUUM` only from its durable state, completes database-key rotation, and clears the journal last. Base purge removes all tombstones scoped to the base.
- Auth transitions increment admission epoch before queueing, then hold exclusive admission across knowledge close and the underlying restore/register/login/logout mutation. Knowledge IPC derives its owner inside the same admitted operation and rejects a stale epoch after completion. Failed auth transitions release admission without reopening the old knowledge session.
- Availability now probes the real encrypted database/FTS/object-key/parser boundaries and closes the probe parser/database without creating a knowledge base. Export rejects more than 256 versions or 128 MiB of encrypted originals before aggregate materialization. Production parser creation verifies emitted worker/preload files and contains no development path.

### RED commands and captured output

```text
$ node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts electron/main/knowledge/knowledge-service.test.ts -t 'acknowledges|cancels and drains|authoritative generations|recovers a durable'
FAIL acknowledges a durable encrypted import before parsing completes
  expected the acknowledgement to match { status: 'parsing', versionCount: 1 }; received undefined before parse completion
FAIL cancels and drains a parsing import before recycling/purge
  expected AbortSignal.aborted to be true before lifecycle completion; received false
FAIL uses authoritative generations so two replacements completing out of order keep the newest result
  older completion replaced the newest active version
FAIL recovers a durable interrupted import once
  reopened import remained failed instead of becoming ready
```

```text
$ node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts electron/main/knowledge/knowledge-service.test.ts -t 'resumes a durable purge|validates every managed object|removes every document and base tombstone'
FAIL resumes a durable purge after unlink/vacuum/rekey failure
  injected failures were not observed and retry lost the already-deleted target
FAIL validates every managed object name before committing purge graph deletion
  tampered relative name committed graph deletion
FAIL removes every document and base tombstone scoped to a purged knowledge base
  expected 0 scoped tombstones; received 2
```

```text
$ node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts electron/main/application.test.ts -t 'knowledge owner derivation|reopens admission safely'
FAIL holds knowledge owner derivation through completion and rejects stale-epoch IPC during logout
FAIL reopens admission safely after a failed auth transition
  knowledgeAdmission was undefined before the admission gate was composed
```

```text
$ node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts electron/main/knowledge/knowledge-service.test.ts -t 'maps real encrypted-storage|rejects an export'
FAIL maps real encrypted-storage, FTS, and parser probe failures
  parser probe was not called and parser failure still reported local.available=true
FAIL rejects an export whose encrypted version aggregate exceeds the fixed Main memory bound
  oversized export resolved instead of rejecting
```

The final journal-admission gap was reproduced after the seam split with the exact command/output below:

```text
$ node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts electron/main/knowledge/knowledge-service.test.ts -t 'cancels and drains a parsing import before purge'
FAIL |desktop-node| electron/main/knowledge/knowledge-service.test.ts > KnowledgeService lifecycle > cancels and drains a parsing import before purge removes its graph and object
AssertionError: promise resolved "{ …(7) }" instead of rejecting
Test Files  1 failed (1)
Tests  1 failed | 19 skipped (20)
```

### GREEN commands and output

```text
$ node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts electron/main/knowledge/knowledge-service.test.ts -t 'cancels and drains a parsing import before purge'
Test Files  1 passed (1)
Tests  1 passed | 19 skipped (20)
```

```text
$ node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts electron/main/knowledge/knowledge-service.test.ts -t 'resumes a durable purge|cancels and drains a parsing import before purge|removes every document and base tombstone|validates every managed object name'
Test Files  1 passed (1)
Tests  6 passed | 14 skipped (20)
```

```text
$ node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts electron/main/knowledge electron/main/ipc/register-ipc.test.ts
Test Files  9 passed (9)
Tests  102 passed (102)
```

```text
$ node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts electron/main/application.test.ts -t 'owns path-free knowledge|holds knowledge owner derivation|reopens admission safely'
Test Files  1 passed (1)
Tests  3 passed | 147 skipped (150)
```

```text
$ pnpm typecheck
Scope: 4 of 5 workspace projects
packages/shared typecheck: Done
packages/workflow-sdk typecheck: Done
packages/workflow-schema typecheck: Done
apps/desktop typecheck: Done
```

```text
$ pnpm exec eslint <all 13 changed Task 4 source/test files>
(no output; exit 0)
$ git diff --check
(no output; exit 0)
```

```text
$ pnpm build
packages/shared build: Done
packages/workflow-sdk build: Done
packages/workflow-schema build: Done
out/preload/parser.cjs  0.51 kB
out/renderer/electron/main/knowledge/parser-worker.html  0.46 kB
CJS Build success
```

```text
$ pnpm test
Test Files  1 failed | 103 passed (104)
Tests  1 failed | 2861 passed (2862)
```

The sole full-suite failure is the same unrelated pre-existing Application context-summary billing case at `application.test.ts:3865`: it receives `CONTEXT_LIMIT_EXCEEDED` instead of a completed stream. All Task 4 focused and integration boundaries are green.
