# Full Development Converter Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `pnpm dev` prepare, cache, verify, and use all four converter pack families so every conversion direction already declared by the catalog is available during macOS development.

**Architecture:** A new development orchestrator reuses the pinned production acquisition, helper-build, staging, probe, index, and signing modules. It publishes immutable fingerprinted development releases behind an atomic active marker; Electron resolves that marker and runs the existing production adapters against the development-only trust root.

**Tech Stack:** Node.js 24 ESM, TypeScript 6, Vitest 4, Electron 43, C with Apple Clang, libvips, LibreOffice, Poppler, FFmpeg, Ed25519, deterministic USTAR.

**Spec:** `docs/superpowers/specs/2026-09-01-full-development-converter-release-design.md`

## Global Constraints

- Supported development targets are exactly `darwin-arm64` and `darwin-x64`.
- Pack families remain exactly `image-icon`, `document`, `pdf`, and `media`.
- Existing index schema version 1, fixed executable inventories, restricted USTAR format, and Ed25519 verification remain unchanged.
- Downloads use only canonical `sources.lock.json` HTTPS URLs and locked SHA-256 values.
- Converter engines are never searched from host `PATH`; subprocesses receive fixed executable paths and argument arrays.
- Development signing material must remain rejected by production mode and packaged applications must always select the production runtime factory.
- A partial or failed preparation must not replace the active development release.
- No new conversion source formats, target formats, workflow permissions, or Windows support are added.
- Preserve unrelated worktree changes. Do not stage or commit pre-existing changes that cannot be separated safely.
- Every behavior change follows RED, GREEN, REFACTOR.

---

### Task 1: Fingerprinted development cache and atomic active marker

**Files:**
- Create: `apps/desktop/scripts/converter-packs/local-development-release-cache.mjs`
- Create: `apps/desktop/tests/integration/local-development-release-cache.test.ts`

**Interfaces:**
- Consumes: `fingerprintDevelopmentRelease({ target, inputs })`, where `target` is `darwin-arm64 | darwin-x64` and `inputs` is a sorted array of `{ path, bytes }`.
- Produces: a lowercase 64-character SHA-256 fingerprint.
- Consumes: `developmentReleasePaths(cacheRoot, fingerprint)`.
- Produces: canonical lexical paths for `sources`, `releases/<fingerprint>`, `active-release.json`, and private sibling temporary roots.
- Consumes: `readActiveDevelopmentRelease({ cacheRoot })` and `activateDevelopmentRelease({ cacheRoot, fingerprint })`.
- Produces: a canonical absolute active release directory, selected through an atomically replaced canonical marker.

- [ ] **Step 1: Write the failing cache tests**

  Add literal tests proving:

  ```ts
  expect(fingerprintDevelopmentRelease({
    target: 'darwin-arm64',
    inputs: [
      { path: 'a', bytes: Buffer.from('one') },
      { path: 'b', bytes: Buffer.from('two') },
    ],
  })).toBe('ff854d97f63725260c0c5cc96dde6006aa48f8db5912303ec6532bc0d6a355af')
  ```

  Also prove input order cannot change the result after canonical sorting, target
  and byte changes do change it, unsafe/duplicate paths are rejected, a marker
  cannot escape `releases/`, a missing release is rejected, and a failed marker
  write leaves the old marker readable. Inject file operations only for the
  final rename-failure case; all other tests use real temporary directories.

- [ ] **Step 2: Run the focused test and verify RED**

  Run:
  `pnpm --filter @autoforge/desktop exec vitest run --config vitest.config.ts tests/integration/local-development-release-cache.test.ts`

  Expected: FAIL because `local-development-release-cache.mjs` does not exist.

- [ ] **Step 3: Implement deterministic fingerprint framing and marker validation**

  Use an unambiguous length-prefixed hash input:

  ```js
  hash.update('autoforge-development-converter-release-v1\0')
  hash.update(`${target}\0`)
  for (const input of sortedInputs) {
    hash.update(`${Buffer.byteLength(input.path)}\0${input.path}\0${input.bytes.byteLength}\0`)
    hash.update(input.bytes)
  }
  ```

  The marker schema is exactly:
  `{"fingerprint":"<64 lowercase hex>","schemaVersion":1}\n`.
  Write it to an exclusive sibling temporary file, `sync()` it, rename it over
  `active-release.json`, then sync the cache directory. Reject symlinks,
  non-canonical roots, unknown marker keys, and release paths outside
  `releases/`.

- [ ] **Step 4: Run the focused test and verify GREEN**

  Run the Step 2 command twice. Expected: PASS both times with no leaked
  temporary marker files.

- [ ] **Step 5: Commit the isolated task if safe**

  Stage only the two Task 1 files and commit:
  `build: add development converter release cache`

---

### Task 2: Build a signed installed development release from staged packs

**Files:**
- Create: `apps/desktop/scripts/converter-packs/build-local-development-release.mjs`
- Create: `apps/desktop/tests/integration/local-development-release-builder.test.ts`
- Modify: `apps/desktop/scripts/converter-packs/pack-tooling-lib.mjs`
- Modify: `apps/desktop/tests/integration/converter-pack-tooling.test.ts`

**Interfaces:**
- Add `writeRestrictedUstarEntries({ archive, descriptor, destination })` to `pack-tooling-lib.mjs`; it verifies the existing restricted archive contract while writing regular entries beneath one new canonical destination.
- Add `buildLocalDevelopmentRelease({ stagingRoot, outputRoot, privateKeyPath, publicKeyPath }) -> Promise<void>`.
- Add `verifyLocalDevelopmentReleaseIntegrity({ releaseRoot, platform, arch }) -> Promise<void>`; it verifies the exact release layout, index signature, four current-target descriptors, and every installed entry hash/mode without executing an engine.
- The output layout is exactly `index.json`, `index.sig`, `root-public-key.pem`, and `installed/`.

- [ ] **Step 1: Write the failing restricted-extraction tests**

  Extend the tooling tests with one valid two-entry archive and literal output
  bytes/modes. Add rejection cases for traversal, duplicate portable names,
  symlinks, undeclared entries, hash mismatch, non-empty destination, and
  partial output after a malformed second entry. The production change caught
  is materializing bytes that were not authenticated by the descriptor.

- [ ] **Step 2: Verify the restricted-extraction test is RED**

  Run:
  `pnpm --filter @autoforge/desktop exec vitest run --config vitest.config.ts tests/integration/converter-pack-tooling.test.ts`

  Expected: FAIL because `writeRestrictedUstarEntries` is not exported.

- [ ] **Step 3: Implement extraction inside the existing verifier**

  Share header parsing with `verifyRestrictedUstar`; open every destination with
  `wx`, mode `0755` for executable entries and `0644` otherwise, never follow a
  symbolic ancestor, and remove the private destination root on any failure.
  Do not invoke `/usr/bin/tar` for pack installation.

- [ ] **Step 4: Write the failing four-family release-builder test**

  Build a real normalized staging fixture containing the exact executable
  inventories:

  ```ts
  const executables = {
    'image-icon': ['bin/autoforge-image-converter', 'bin/vips'],
    document: ['program/soffice'],
    pdf: ['bin/autoforge-pdf-raster', 'bin/pdfinfo', 'bin/pdftocairo'],
    media: ['bin/ffmpeg', 'bin/ffprobe'],
  }
  ```

  Use minimal executable fixture bytes already accepted by test-mode pack
  tooling, a generated Ed25519 private key with mode `0600`, and its public key.
  Assert that the output index contains four descriptors, every archive is
  installed under `installed/<family>/<version>/darwin-arm64`, the signature
  verifies, and archives are not retained in the final runtime release.

- [ ] **Step 5: Verify the release-builder test is RED**

  Run:
  `pnpm --filter @autoforge/desktop exec vitest run --config vitest.config.ts tests/integration/local-development-release-builder.test.ts`

  Expected: FAIL because `build-local-development-release.mjs` does not exist.

- [ ] **Step 6: Implement the minimal release builder**

  Call `buildConverterPackIndex({ mode: 'test' })`, then
  `signConverterPackIndex({ mode: 'test' })`. Verify the supplied public key is
  exactly the public half of the signing key. For each descriptor, read the
  deterministic archive named by `archiveFilename(descriptor)` and call
  `writeRestrictedUstarEntries` into the exact installed coordinate. Copy only
  canonical `index.json`, `index.sig`, and `root-public-key.pem` into the final
  output. Build under a private temporary root and rename only after all four
  families exist.

  Implement `verifyLocalDevelopmentReleaseIntegrity` with `validateIndex`,
  `createPublicKey`, `verify`, stable file reads, and the descriptor entry
  hashes. Reject extra top-level files, extra installed coordinates, symlinks,
  executable mode mismatches, absent families, and wrong platform/architecture.

- [ ] **Step 7: Run focused tests and verify GREEN**

  Run the Step 2 and Step 5 commands. Expected: PASS.

- [ ] **Step 8: Commit the isolated task if safe**

  Commit message: `build: assemble signed development converter release`

---

### Task 3: Orchestrate cold preparation and verified cache reuse

**Files:**
- Create: `apps/desktop/scripts/converter-packs/prepare-local-development-release.mjs`
- Create: `apps/desktop/tests/integration/local-development-release-preparation.test.ts`
- Delete after behavior migration: `apps/desktop/scripts/converter-packs/create-local-development-image-release.mjs`

**Interfaces:**
- Export `developmentFingerprintInputs(desktopRoot) -> Promise<Array<{ path, bytes }>>` using an explicit allowlist of the source lock, native helper tree, and preparation modules.
- Export `prepareLocalDevelopmentRelease(request, dependencies?) -> Promise<{ fingerprint, releaseRoot, reused }>`.
- `request` is exactly `{ desktopRoot, cacheRoot, platform, arch, compiler }`.
- Injectable dependencies expose `buildHelpers`, `preparePlan`, `stagePacks`, `buildRelease`, `verifyRelease`, and `activateRelease` so standard tests never access the network or real engines.

- [ ] **Step 1: Write failing orchestration tests**

  With real cache directories and injected stage functions, prove:

  - a cold cache calls every stage once in order and activates only after verification;
  - a verified matching release returns `reused: true` and calls no build stage;
  - source-lock, helper-source, target, and preparation-module byte changes alter the fingerprint;
  - a build/probe/sign/verify failure retains the literal previous marker;
  - a corrupted derived release is removed and rebuilt before activation;
  - unsupported platforms and non-canonical cache roots fail before downloads;
  - dependency callbacks receive only absolute paths under their designated temporary or cache roots.

- [ ] **Step 2: Run the focused test and verify RED**

  Run:
  `pnpm --filter @autoforge/desktop exec vitest run --config vitest.config.ts tests/integration/local-development-release-preparation.test.ts`

  Expected: FAIL because the preparation module does not exist.

- [ ] **Step 3: Implement the fingerprint input allowlist**

  Include canonical bytes from:

  ```text
  converter-packs/sources.lock.json
  converter-packs/native/**
  scripts/converter-packs/source-lock.mjs
  scripts/converter-packs/acquire-sources.mjs
  scripts/converter-packs/build-native-helpers.mjs
  scripts/converter-packs/prepare-production-staging.mjs
  scripts/converter-packs/macho-closure.mjs
  scripts/converter-packs/stage-production-packs.mjs
  scripts/converter-packs/build-index.mjs
  scripts/converter-packs/sign-index.mjs
  scripts/converter-packs/pack-tooling-lib.mjs
  scripts/converter-packs/build-local-development-release.mjs
  ```

  Sort portable relative paths by UTF-8 bytes and reject symlinks or files
  outside the desktop root.

- [ ] **Step 4: Implement the cold preparation pipeline**

  Use version `0.0.0-dev+<first 12 fingerprint hex>`, sequence `1`, target
  `darwin-<arch>`, and archive base
  `https://local-development.invalid/converter-packs/<fingerprint>`.
  Create private work, helper, staging, plan, signing-key, and release roots.
  Call the existing modules in the approved order. Materialize the fixed
  development Ed25519 private key only inside the private workspace with mode
  `0600`, remove the workspace in `finally`, verify all four installed leases,
  then activate the marker.

- [ ] **Step 5: Implement warm-cache verification**

  Before reuse, call `verifyLocalDevelopmentReleaseIntegrity` from Task 2. A
  failed derived verification removes only
  `releases/<fingerprint>` and runs the cold path. Do not remove or overwrite a
  content-addressed source archive whose hash check failed.

- [ ] **Step 6: Run focused and existing release-tool tests**

  Run:

  ```bash
  pnpm --filter @autoforge/desktop exec vitest run --config vitest.config.ts \
    tests/integration/local-development-release-preparation.test.ts \
    tests/integration/converter-pack-acquisition.test.ts \
    tests/integration/converter-pack-staging.test.ts \
    tests/integration/converter-pack-tooling.test.ts
  ```

  Expected: PASS with no network calls in the local-development tests.

- [ ] **Step 7: Remove the superseded image-only generator**

  Delete it only after its signed-release, canonical-path, atomic-cleanup, and
  image-to-PDF expectations are represented by the new builder/preparation
  tests. Confirm `rg -n "create-local-development-image-release" apps/desktop`
  returns no source, package-script, or test references.

- [ ] **Step 8: Commit the isolated task if safe**

  Commit message: `build: prepare complete development converter release`

---

### Task 4: Wire preparation and active release into `pnpm dev`

**Files:**
- Modify: `apps/desktop/package.json`
- Modify: `apps/desktop/scripts/dev.mjs`
- Modify: `apps/desktop/tests/integration/dev-supervisor.test.ts`
- Modify: `apps/desktop/electron/main/build-config.test.ts`

**Interfaces:**
- Replace `localDevelopmentConverterReleaseRoot(cwd)` with `resolveLocalDevelopmentConverterReleaseRoot(cwd)`.
- The resolver reads `node_modules/.cache/autoforge-converter-packs/active-release.json` and returns the canonical absolute `releases/<fingerprint>` directory.
- `predev` runs the new preparation CLI before `dev.mjs` launches Electron.

- [ ] **Step 1: Write failing supervisor and package-script tests**

  Update the supervisor harness to create a real cache marker and release
  directory. Assert the spawned environment contains that fingerprinted path.
  Add rejection tests for missing marker, malformed JSON, symlinked release,
  path escape, and non-canonical release. Update the build-config test to assert
  `predev` names `prepare-local-development-release.mjs` and never names the
  removed image-only script.

- [ ] **Step 2: Run tests and verify RED**

  Run:

  ```bash
  pnpm --filter @autoforge/desktop exec vitest run --config vitest.config.ts \
    tests/integration/dev-supervisor.test.ts electron/main/build-config.test.ts
  ```

  Expected: FAIL because the current supervisor still computes the fixed
  `.../release` directory.

- [ ] **Step 3: Implement marker resolution and package wiring**

  Resolve the active release before building the workflow runner. Keep the
  existing environment merge and process-signal behavior unchanged. Change
  `predev` to:

  ```json
  "predev": "pnpm prepare:native-electron && node scripts/converter-packs/prepare-local-development-release.mjs"
  ```

  The CLI uses the desktop root, its ignored `node_modules/.cache` directory,
  `process.platform`, `process.arch`, and fixed `/usr/bin/clang`; it prints one
  concise `prepared` or `reused` line including no sensitive path.

- [ ] **Step 4: Run tests and verify GREEN**

  Run the Step 2 command. Expected: PASS.

- [ ] **Step 5: Commit the isolated task if safe**

  Commit message: `build: activate full converter release in development`

---

### Task 5: Enable all four runtime adapters in development

**Files:**
- Modify: `apps/desktop/electron/main/conversion/production-conversion-runtime.ts`
- Modify: `apps/desktop/electron/main/conversion/local-development-conversion-runtime.ts`
- Modify: `apps/desktop/tests/integration/local-development-converter-pack.test.ts`
- Modify: `apps/desktop/electron/main/application-production-conversion.test.ts`

**Interfaces:**
- Export one immutable `CONVERSION_ADAPTERS` mapping from `production-conversion-runtime.ts` or a focused sibling module.
- Both production and local development runtimes consume the same mapping.
- The local runtime supplies only its signed index and installed root; it no longer replaces the adapter mapping with an image-only subset.

- [ ] **Step 1: Write the failing adapter-selection regression test**

  Replace the old image-only release fixture with the four-family signed fixture
  from Task 2. Resolve representative probes and assert literal leases:

  ```ts
  expect(await acquire('doc', 'pdf')).toMatchObject({ name: 'document' })
  expect(await acquire('csv', 'xlsx')).toMatchObject({ name: 'document' })
  expect(await acquire('pdf', 'png')).toMatchObject({ name: 'pdf' })
  expect(await acquire('png', 'ico')).toMatchObject({ name: 'image-icon' })
  expect(await acquire('wav', 'mp3')).toMatchObject({ name: 'media' })
  expect(await acquire('mp4', 'webm')).toMatchObject({ name: 'media' })
  ```

  Keep the packaged-app test proving a development environment variable cannot
  select the development trust root.

- [ ] **Step 2: Run the focused tests and verify RED**

  Run:

  ```bash
  pnpm --filter @autoforge/desktop exec vitest run --config vitest.config.ts \
    tests/integration/local-development-converter-pack.test.ts \
    electron/main/application-production-conversion.test.ts
  ```

  Expected: DOC/PDF/media assertions fail because the local runtime passes only
  `localDevelopmentImageAdapter`.

- [ ] **Step 3: Share the exact adapter inventory**

  Export/factor only the existing four entries:

  ```ts
  export const CONVERSION_ADAPTERS = Object.freeze([
    { adapter: imageIconAdapter, pack: 'image-icon' },
    { adapter: documentAdapter, pack: 'document' },
    { adapter: pdfAdapter, pack: 'pdf' },
    { adapter: mediaAdapter, pack: 'media' },
  ] as const)
  ```

  Remove the local `sips` capability filter and pass `CONVERSION_ADAPTERS`, or
  omit the adapter override so the shared default is used. Do not change route
  ownership or adapter process arguments.

- [ ] **Step 4: Run focused tests and typecheck**

  Run the Step 2 command, then
  `pnpm --filter @autoforge/desktop typecheck`.
  Expected: PASS.

- [ ] **Step 5: Commit the isolated task if safe**

  Commit message: `feat: enable all converter packs in development`

---

### Task 6: Add headless real-engine verification for the prepared release

**Files:**
- Create: `apps/desktop/scripts/converter-packs/verify-local-development-release.mjs`
- Create: `apps/desktop/tests/integration/local-development-release-verifier.test.ts`
- Modify: `apps/desktop/package.json`
- Modify: `apps/desktop/scripts/converter-packs/prepare-local-development-release.mjs`

**Interfaces:**
- Export `smokeTestLocalDevelopmentRelease({ releaseRoot, workRoot, run }) -> Promise<void>`.
- The verifier first calls `verifyLocalDevelopmentReleaseIntegrity`, resolves only descriptor-declared executable paths, generates bounded fixtures inside `workRoot`, runs the fixed pack command contracts, and validates output magic/counts.
- Add `converter-packs:verify-development` for explicit reruns against the active marker.

- [ ] **Step 1: Write the failing verifier contract tests**

  Inject a command runner and a four-family fixture release. Assert the exact
  bounded verification sequence includes:

  - LibreOffice creation of DOC and DOCX from a fixed UTF-8 text source, then DOC/DOCX to PDF;
  - CSV to XLSX;
  - PNG to JPEG, PDF, ICO, and ICNS;
  - generated PDF to PNG and JPEG;
  - FFmpeg generation of one-second WAV and MP4 fixtures, audio transcoding,
    video transcoding, and video audio extraction.

  Reject zero-byte outputs, wrong magic, wrong probed format, missing ordered
  icon representations, extra output files, subprocess failure, timeout, and a
  path escaping `workRoot`.

- [ ] **Step 2: Run the focused test and verify RED**

  Run:
  `pnpm --filter @autoforge/desktop exec vitest run --config vitest.config.ts tests/integration/local-development-release-verifier.test.ts`

  Expected: FAIL because the verifier does not exist.

- [ ] **Step 3: Implement bounded fixture generation and adapter execution**

  Call the declared pack executables with the same fixed argument contracts as
  the four adapters; this verifier is plain Node ESM and does not import
  Electron TypeScript modules. Direct `ffmpeg`/`soffice` calls are allowed only
  for generating bounded source fixtures. Use explicit document/media timeouts,
  hard caps of 64 MiB per generated source/output and 32 output files, and
  delete `workRoot` in `finally`.

- [ ] **Step 4: Gate activation on one successful cold-cache smoke run**

  Call the verifier after the release builder completes and before
  `activateDevelopmentRelease`. Warm-cache reuse verifies signatures and
  entries but does not rerun conversions. An explicit
  `converter-packs:verify-development` command always reruns the smoke suite.

- [ ] **Step 5: Run the focused test and existing engine contract tests**

  Run:

  ```bash
  pnpm --filter @autoforge/desktop exec vitest run --config vitest.config.ts \
    tests/integration/local-development-release-verifier.test.ts \
    tests/integration/converter-pack-native-helpers.test.ts \
    electron/main/conversion/adapters/document.test.ts \
    electron/main/conversion/adapters/pdf.test.ts \
    electron/main/conversion/adapters/media.test.ts \
    electron/main/conversion/adapters/image-icon.test.ts
  ```

  Expected: PASS.

- [ ] **Step 6: Commit the isolated task if safe**

  Commit message: `test: verify complete development converter release`

---

### Task 7: Preserve safe conversion error codes in the universal workflow

**Files:**
- Modify: `examples/universal-file-converter/src/index.ts`
- Modify: `examples/universal-file-converter/src/index.test.ts`
- Regenerate: `examples/universal-file-converter/dist/index.js`
- Regenerate: `examples/universal-file-converter/workflow.json`
- Regenerate: `examples/universal-file-converter/manifest.json`

**Interfaces:**
- Add a local `failedResult(error: unknown): ConverterSubmitResult` boundary.
- Known SDK conversion codes are copied into a result with canonical messages; unknown values return `CONVERSION_COMPONENT_UNAVAILABLE`.
- Never copy a thrown message, stack, path, or arbitrary error code.

- [ ] **Step 1: Write the failing safe-error tests**

  Make `ctx.converter.submit` reject separately with each SDK conversion code
  and a hostile message. Assert the result preserves the literal code but uses
  the canonical safe message. Add unknown `Error`, string, null, spoofed
  `CONVERSION_SECRET_LEAK`, and inherited-property cases; all must return the
  canonical component-unavailable result while later files still submit.

- [ ] **Step 2: Run the workflow test and verify RED**

  Run:
  `pnpm --filter @autoforge/example-universal-file-converter test`

  Expected: known-code cases fail because the current catch block collapses
  every rejection to `CONVERSION_COMPONENT_UNAVAILABLE`.

- [ ] **Step 3: Implement the minimal safe mapping**

  Define an exact frozen record for the seven SDK conversion codes and messages.
  Accept only an own string `code` property present in that record. Return a new
  object from the record; never return or spread the thrown value.

- [ ] **Step 4: Run tests, build, and verify generated hashes**

  Run:

  ```bash
  pnpm --filter @autoforge/example-universal-file-converter test
  pnpm --filter @autoforge/example-universal-file-converter typecheck
  pnpm --filter @autoforge/example-universal-file-converter build
  pnpm --filter @autoforge/desktop exec vitest run --config vitest.config.ts electron/main/workflows/registry.test.ts
  ```

  Expected: PASS and both manifest files contain the same updated `codeSha256`.

- [ ] **Step 5: Commit the isolated task if safe**

  Commit message: `fix: preserve safe converter workflow errors`

---

### Task 8: Cold-cache acceptance and regression verification

**Files:**
- Modify only if a verified defect is found: files owned by Tasks 1–7.
- Do not create persistent debug scripts or logs.

**Interfaces:**
- The acceptance signal is a real fingerprinted release selected by the same marker and environment path used by `pnpm dev`.

- [ ] **Step 1: Read the verification-before-completion skill**

  Load `superpowers:verification-before-completion` before making any success
  claim.

- [ ] **Step 2: Run focused automated suites**

  Run all Task 1–7 focused tests in one Vitest invocation where configs match,
  plus the universal workflow tests. Expected: all pass with no warnings other
  than documented external production gates.

- [ ] **Step 3: Run typecheck and converter-pack verification**

  Run:

  ```bash
  pnpm --filter @autoforge/desktop typecheck
  pnpm --filter @autoforge/desktop verify:converter-packs
  pnpm --filter @autoforge/desktop converter-packs:verify-sources
  ```

  Expected: exit status 0 for every command.

- [ ] **Step 4: Exercise a real cold cache**

  Move only the task-owned development converter cache to a temporary backup,
  run the preparation CLI, and retain the backup until acceptance completes.
  Confirm the active index has exactly four current-architecture descriptors
  and run `pnpm --filter @autoforge/desktop converter-packs:verify-development`.
  Expected: all representative headless conversions pass.

- [ ] **Step 5: Prove warm reuse**

  Run the preparation CLI again with acquisition/build probes enabled by the
  test-supported diagnostic counters. Expected: `reused`, zero downloads, zero
  helper builds, and the same fingerprinted release path.

- [ ] **Step 6: Run the broader affected test suite**

  Run:

  ```bash
  pnpm --filter @autoforge/desktop test
  pnpm --filter @autoforge/example-universal-file-converter test
  ```

  Distinguish any unrelated pre-existing failure from a failure caused by this
  change. Do not change unrelated code to make the suite green.

- [ ] **Step 7: Inspect the final diff and restore test state**

  Run `git diff --check`, verify no `[DEBUG-` instrumentation remains, restore
  or remove only the temporary cache backup created in Step 4, and confirm the
  final diff contains only requirements from the approved spec.

- [ ] **Step 8: Commit final task-owned adjustments if safe**

  Commit message: `feat: complete development file conversion support`
