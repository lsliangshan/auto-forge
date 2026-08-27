# Task 2 report: encrypted per-user database and object storage

## Outcome

Implemented the v2 local knowledge trust foundation without wiring parser/service/UI work and without changing CloudBase. The store uses hashed per-UID roots, safeStorage-wrapped owner-bound database active/pending slots plus a stable object-wrapping slot, `better-sqlite3-multiple-ciphers@13.0.3`, schema v1, `temp_store=MEMORY`, FTS5 trigram, WAL, and an AEAD object store. There is no plaintext SQLite fallback. Runtime availability is enabled only for the exercised `darwin/arm64` target; `darwin/x64`, `win32/x64`, and other targets return unavailable.

## RED/GREEN evidence

All Vitest commands below used the repository Electron runner, which executes the pinned Electron runtime with `ELECTRON_RUN_AS_NODE=1`.

1. Owner-bound key slots
   - Break named: secure storage absence or a copied record could create/load an unbound key; active/pending transitions could lose durability.
   - RED command: `pnpm --filter @autoforge/desktop exec node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts electron/main/knowledge/key-store.test.ts`
   - RED output: exit 1; suite failed with `Cannot find module './key-store.js'`; 0 tests ran.
   - GREEN output after the minimum implementation: exit 0; 1 file and 3 tests passed.

2. Versioned schema and trigram index
   - Break named: a keyed database could open without a stable v1 graph, synchronized external-content FTS index, or cross-base graph protection.
   - RED command: `pnpm --filter @autoforge/desktop exec node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts electron/main/knowledge/knowledge-schema.test.ts`
   - RED output: exit 1; suite failed with `Cannot find module './knowledge-schema.js'`; 0 tests ran.
   - GREEN output: exit 0; 1 file and 3 tests passed.

3. Encrypted database, WAL, and crash rekey
   - Break named: correct/wrong/no-key behavior, memory-only temp storage, encrypted WAL artifacts, transaction rollback, checkpointing, unsupported targets, or active/pending crash recovery could fail open.
   - RED command: `pnpm --filter @autoforge/desktop exec node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts electron/main/knowledge/encrypted-database.test.ts`
   - Initial RED output: exit 1; suite failed with `Cannot find module './encrypted-database.js'`; 0 tests ran.
   - First implementation output: exit 1; 5 tests failed because the native capability probe returned `native-capability-unavailable`.
   - Root cause evidence: SQLite3MultipleCiphers rejects `key(Buffer)` for `:memory:` with `SQLITE_ERROR`, while the same Electron 43 binding succeeds for an ephemeral real file, including keying, memory temp storage, and trigram FTS. The probe was corrected to exercise an ephemeral encrypted file and remove it in `finally`.
   - GREEN output: exit 0; 1 file and 5 tests passed. The later owner-bound object integration expanded this file to 6 passing tests.

4. AEAD object storage
   - Break named: plaintext/recovery artifacts, reused IDs or file keys, wrong-owner reads, tampering, object renaming, and traversal could bypass authentication.
   - RED command: `pnpm --filter @autoforge/desktop exec node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts electron/main/knowledge/encrypted-object-store.test.ts`
   - RED output: exit 1; suite failed with `Cannot find module './encrypted-object-store.js'`; 0 tests ran.
   - GREEN output: exit 0; 1 file and 3 tests passed.

5. Factory-owned object lifecycle and safeStorage migration
   - Break named: `KnowledgeStoreFactory.open(ownerId)` exposed no owner-bound object store, database key rotation could strand existing objects, and `shouldReEncrypt` could leave old wrapped slots behind.
   - Factory RED output: exit 1; 1 of 6 database tests failed with `Cannot read properties of undefined (reading 'put')`.
   - Rewrap RED output: exit 1; 1 of 4 key-store tests failed with `expected 2 to be 4` encryption calls.
   - GREEN behavior: the record now carries an independent random object master key, factory close zeroes/closes it, database rotation leaves existing objects readable, and active/pending/object slots are atomically rewrapped when requested.

6. Native preparation coexistence
   - Break named: preparation could validate only the existing user-data `better-sqlite3` path while an incompatible cipher binding passed unnoticed.
   - RED command: `pnpm --filter @autoforge/desktop exec node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts tests/integration/prepare-native-electron.test.ts`
   - RED output: exit 1; 3 of 7 tests failed because the probe omitted `CipherDatabase`, the second package path, and `better-sqlite3-multiple-ciphers` from `onlyModules`.
   - GREEN output: exit 0; 1 file and 7 tests passed. The old `better-sqlite3` path remains present and is probed/rebuilt alongside, not replaced by, the cipher module.

## Final verification

- Focused Electron suite:
  - Command: `pnpm --filter @autoforge/desktop exec node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts electron/main/knowledge/key-store.test.ts electron/main/knowledge/encrypted-database.test.ts electron/main/knowledge/knowledge-schema.test.ts electron/main/knowledge/encrypted-object-store.test.ts tests/integration/prepare-native-electron.test.ts`
  - Result: exit 0; 5 files, 23 tests passed; Electron-runtime assertion confirmed major version 43.
- Native preparation:
  - Command: `pnpm --filter @autoforge/desktop prepare:native-electron`
  - Result: exit 0; `Database native modules are already compatible with Electron 43.1.1`.
- Task-scoped strict typecheck:
  - Command: `pnpm --filter @autoforge/desktop exec tsc --ignoreConfig --noEmit --strict --skipLibCheck --module NodeNext --moduleResolution NodeNext --target ES2023 --types node,vitest/globals electron/main/knowledge/key-store.ts electron/main/knowledge/encrypted-database.ts electron/main/knowledge/knowledge-schema.ts electron/main/knowledge/encrypted-object-store.ts electron/main/knowledge/key-store.test.ts electron/main/knowledge/encrypted-database.test.ts electron/main/knowledge/knowledge-schema.test.ts electron/main/knowledge/encrypted-object-store.test.ts`
  - Result: exit 0; no diagnostics.
- Desktop build:
  - Command: `pnpm --filter @autoforge/desktop build`
  - Result: exit 0; Main, Preload, Renderer, and workflow worker built. Rollup emitted only its existing third-party PURE-comment warnings.
- macOS arm64 package/native proof:
  - `pnpm --filter @autoforge/desktop dist:dir` rebuilt both native dependencies for Electron 43.1.1 and packaged `darwin/arm64`; its signed directory app remained available after the long signing stage.
  - `pnpm --filter @autoforge/desktop verify:packaged-native`: exit 0; existing packaged dependency probe passed under Electron 43.1.1.
  - A separate package-internal Electron probe required `better-sqlite3-multiple-ciphers` from the app archive, keyed an ephemeral database, set and read `temp_store=MEMORY`, created/dropped an FTS5 trigram table, and queried it: exit 0, `Packaged cipher SQLite verified under Electron 43.1.1 on darwin/arm64`.
  - `codesign --verify --deep --strict` returned exit 0; `file` identified the packaged cipher binding as `Mach-O 64-bit bundle arm64`.
- Dependency/version proof: runtime package inspection printed `better-sqlite3-multiple-ciphers=13.0.3`; manifest and lockfile both use the exact version; pnpm build permission is explicit.
- Diff hygiene: `git diff --check` returned exit 0. The task diff contains no CloudBase files or configuration.

## Artifact and fail-closed evidence

- The database test creates a fresh random sentinel, holds WAL autocheckpoint open, scans DB/WAL/journal/SHM/temp/recovery-shaped files while WAL exists, checkpoints with `TRUNCATE`, closes, and rescans. No sentinel bytes were found.
- The object test creates a separate random sentinel, writes the same payload twice, proves distinct IDs/ciphertexts, scans every stored/recovery file for plaintext, and verifies no temp/recovery publication remains. No sentinel bytes were found.
- Correct-key reopen succeeds. A random wrong key and a direct no-key readonly query both fail. Deleting an existing key record makes factory open fail instead of generating a replacement.
- Active-key-before-rekey recovery discards pending; pending-key-after-rekey recovery promotes pending. Object payloads survive database-key rotation because their stable safeStorage-wrapped master slot is separate.
- Object files use random 256-bit file keys, random nonces, AES-256-GCM, an HKDF-SHA-256 wrapping key separated by object ID/domain, and distinct AAD domains for wrapping and payload. Wrong owner key, byte tampering, and rename-to-another-ID all fail authentication.
- `darwin/x64` and `win32/x64` are intentionally unverified and return `unsupported-platform`; no availability claim is made for them.

## Files

- Dependency/native lifecycle: `apps/desktop/package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `apps/desktop/scripts/prepare-native-electron.mjs`, `apps/desktop/tests/integration/prepare-native-electron.test.ts`.
- Storage implementation: `apps/desktop/electron/main/knowledge/key-store.ts`, `encrypted-database.ts`, `knowledge-schema.ts`, `encrypted-object-store.ts`.
- Real-behavior tests: matching four `*.test.ts` files in the same knowledge directory.

## Two-stage self-review

1. Security/ownership review checked owner validation and hashed roots, encrypted owner binding, missing-key behavior, safeStorage migration, durable fsync/rename ordering, zeroing of temporary key buffers, absence of sensitive logging, AEAD domain separation, path validation, SQLite pragmas, and handle cleanup. This review found and corrected the invalid keyed-`:memory:` capability assumption and added a stable independently wrapped object key so database rotation cannot strand objects.
2. Requirement/diff review mapped every Task 2 checkbox to a focused test or runtime probe, confirmed the old user-data native path remains intact, verified the exact dependency pin and package ABI, confirmed unsupported targets fail closed, ran mutation checks against wrong key/owner/ID/status branches, and confirmed no CloudBase files changed.

## Concerns

- The repository-wide node typecheck remains red outside this task. Fresh command `pnpm --filter @autoforge/desktop exec tsc --noEmit -p tsconfig.node.json --pretty false` exited 2 with existing diagnostics in `electron/e2e/cloud-user-data-sync-main.ts`, `electron/main/agent/browser-visual-evidence-resolver.ts`, `electron/main/application.ts`, and `electron/main/cloud/cloudbase-user-data-port.ts`. No task-owned file appears in that output; the task-scoped strict typecheck is green.
- macOS x64 and Windows x64 were not exercised and intentionally remain fail-closed. No real CloudBase operation or deployment was performed.
