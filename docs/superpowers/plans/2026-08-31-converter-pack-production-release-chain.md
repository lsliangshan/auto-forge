# Converter Pack Production Release Chain Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a credential-safe macOS arm64/x64 production pipeline that produces, signs, verifies, publishes, and packages all four AutoForge converter packs.

**Architecture:** A provider-neutral release-tool module turns a canonical source lock and normalized engine roots into the existing staging/index interface. Native helpers preserve the current runtime command contracts, while GitHub Actions supplies architecture runners and protected credentials. The checked-in Desktop bootstrap remains fail-closed; only an explicit release packaging path enables the signed CDN index.

**Tech Stack:** Node.js 24 ESM, C/C++ with Apple Clang, libvips, Poppler, FFmpeg, LibreOffice, Ed25519, deterministic USTAR, macOS codesign/notarytool, GitHub Actions, Tencent COS/CDN.

**Spec:** `docs/superpowers/specs/2026-08-31-converter-pack-production-release-chain-design.md`

## Global Constraints

- Production inventory is exactly four pack families for `darwin-arm64` and `darwin-x64`.
- Existing index schema version 1 and Ed25519 signature contract remain unchanged.
- No runtime or build step may search host `PATH` for a converter engine.
- The checked-in bootstrap stays `downloadsEnabled:false` and contains no key or URL.
- Private keys and cloud/Apple credentials never enter repository files or generated release artifacts.
- Windows and automatic credential provisioning are out of scope.
- Every implementation change follows RED, GREEN, REFACTOR and preserves unrelated user changes.

---

### Task 1: Canonical source lock module

**Files:**
- Create: `apps/desktop/converter-packs/sources.lock.json`
- Create: `apps/desktop/scripts/converter-packs/source-lock.mjs`
- Create: `apps/desktop/tests/integration/converter-pack-source-lock.test.ts`
- Modify: `apps/desktop/package.json`

**Interfaces:**
- Consumes: canonical JSON bytes and a target string `darwin-arm64 | darwin-x64`.
- Produces: `loadConverterSourceLock({ path, target }) -> { target, engines }`, where every engine has exact version, license, source archive and target acquisition metadata.

- [x] **Step 1: Write the failing source-lock tests**

  Add tests that load a minimal canonical fixture, assert the literal selected
  target record, and reject non-canonical JSON, duplicate engines, missing
  source SHA-256, HTTP URLs, unsupported targets and unknown keys. The mutation
  caught is accepting an input that cannot uniquely reproduce or audit a pack.

- [x] **Step 2: Run the focused test and verify RED**

  Run:
  `pnpm --filter @autoforge/desktop exec vitest run --config vitest.config.ts tests/integration/converter-pack-source-lock.test.ts`

  Expected: FAIL because `source-lock.mjs` does not exist.

- [x] **Step 3: Implement the minimal validator and checked-in lock**

  Implement strict exact-key validation, canonical-byte comparison, URL and
  SHA-256 checks, target selection, unique engine names and safe absolute input
  paths. Record libvips, Poppler, FFmpeg and LibreOffice with explicit licenses,
  source archives and per-target acquisitions. Add a package script
  `converter-packs:verify-sources` that loads both production targets.

- [x] **Step 4: Verify GREEN and the existing pack tooling suite**

  Run the focused test, both target validations, and
  `tests/integration/converter-pack-tooling.test.ts`.

- [x] **Step 5: Commit**

  Commit message: `build: lock converter pack sources`

### Task 2: Verified acquisition and immutable caching

**Files:**
- Create: `apps/desktop/scripts/converter-packs/acquire-sources.mjs`
- Create: `apps/desktop/tests/integration/converter-pack-acquisition.test.ts`
- Modify: `apps/desktop/package.json`

**Interfaces:**
- Consumes: the Task 1 target record, an absolute cache directory and injected `fetch` for tests.
- Produces: immutable source and runtime archive files keyed by SHA-256. Extraction is owned by Task 4 after Homebrew revision selection or read-only DMG mounting.

- [x] **Step 1: Write failing acquisition tests**

  Exercise real response streams. Prove byte caps, exact hashes, HTTPS redirect
  termination, anonymous GHCR bearer authentication, cache revalidation and
  no-follow output creation. The mutation caught is trusting upstream bytes
  before their identity is proven.

- [x] **Step 2: Run the focused test and verify RED**

  Expected: module-not-found failure for `acquire-sources.mjs`.

- [x] **Step 3: Implement bounded download and immutable caching**

  Reuse stable-file and safe-entry primitives from `pack-tooling-lib.mjs`.
  Downloads write to exclusive temporary files, verify SHA-256 before rename,
  and never overwrite a mismatched cache entry. The module acquires both exact
  source and runtime archives and returns only verified local identities.

- [x] **Step 4: Verify GREEN and mutation cases**

  Run the focused test with download/cache hash mismatches, size overflow,
  insecure URL, HTTP error and GHCR challenge cases, then rerun Task 1 tests.

- [x] **Step 5: Commit**

  Commit message: `build: acquire verified converter sources`

### Task 3: Native image and PDF helper contracts

**Files:**
- Create: `apps/desktop/converter-packs/native/image-converter/main.c`
- Create: `apps/desktop/converter-packs/native/image-converter/icon-container.c`
- Create: `apps/desktop/converter-packs/native/image-converter/icon-container.h`
- Create: `apps/desktop/converter-packs/native/pdf-raster/main.c`
- Create: `apps/desktop/converter-packs/native/common/arguments.c`
- Create: `apps/desktop/converter-packs/native/common/arguments.h`
- Create: `apps/desktop/converter-packs/native/common/process.c`
- Create: `apps/desktop/converter-packs/native/common/process.h`
- Create: `apps/desktop/converter-packs/native/tests/helper-contract-harness.c`
- Create: `apps/desktop/converter-packs/native/tests/fake-engine.c`
- Create: `apps/desktop/scripts/converter-packs/build-native-helpers.mjs`
- Create: `apps/desktop/tests/integration/converter-pack-native-helpers.test.ts`
- Modify: `apps/desktop/scripts/verify-converter-packs.mjs`
- Modify: `apps/desktop/scripts/converter-packs/pack-tooling-lib.mjs`
- Modify: `apps/desktop/tests/integration/converter-pack-tooling.test.ts`

**Interfaces:**
- Image helper preserves the adapter commands `convert`, `create-icon`, and `extract-icon`.
- PDF helper preserves `raster --format <png|jpeg> --pages all --page-number-width 3 --output-pattern <path> -- <input>`.
- Pack executable validation additionally permits the exact sibling `vips` and
  Poppler raster executables required by the helpers.

- [x] **Step 1: Write failing parser and container tests**

  Compile the common argument and icon-container code without libvips. Assert
  literal ICO/ICNS headers, lengths, ordered representations, malformed length
  rejection, unknown/duplicate option rejection and `--` positional handling.
  Add a tooling test proving any undeclared executable still fails.

- [x] **Step 2: Run tests and verify RED**

  Expected: compilation/module failure because helper sources are absent.

- [x] **Step 3: Implement strict parsers and icon containers**

  Use bounded integer arithmetic and explicit big/little-endian reads/writes.
  Do not invoke a shell. Keep the parser interface limited to parsed command
  structs consumed by each helper.

- [x] **Step 4: Implement libvips image operations and Poppler delegation**

  The image helper delegates fixed argument vectors to a signed sibling `vips`,
  loads only the requested first frame unless extracting all signed
  representations, uses contain-plus-transparent-padding for icons, and
  emits PNG-backed ICO/ICNS entries. The PDF helper resolves a signed sibling
  executable relative to its own real path, spawns it with a fixed argument
  vector, and normalizes outputs only after a zero exit status.

- [ ] **Step 5: Run real helper smoke tests on the current architecture**

  Build against acquired libvips/Poppler roots, then convert a JPEG to PNG,
  create/extract ICO and ICNS, and raster a generated three-page PDF. Inspect
  magic bytes, dimensions and exact zero-padded output names.

- [x] **Step 6: Commit**

  Commit message: `feat: add native converter pack helpers`

### Task 4: Relocatable pack staging and capability gate

**Files:**
- Create: `apps/desktop/scripts/converter-packs/macho-closure.mjs`
- Create: `apps/desktop/scripts/converter-packs/stage-production-packs.mjs`
- Create: `apps/desktop/tests/integration/converter-pack-staging.test.ts`
- Create: `apps/desktop/converter-packs/README.md`
- Modify: `apps/desktop/package.json`

**Interfaces:**
- Consumes: exact target record, acquired engine roots, helper build root, version, sequence and HTTPS archive base URL.
- Produces: the normalized `release-input/` tree consumed unchanged by existing `build-index.mjs`.

- [x] **Step 1: Write failing Mach-O closure and staging tests**

  Inject literal `otool` output and a command runner. Prove transitive closure,
  system-library exclusion, basename collision rejection, architecture mismatch
  rejection, unresolved Homebrew path rejection, required data/license copying
  and exactly four staged families for one target.

- [x] **Step 2: Run tests and verify RED**

  Expected: module-not-found failure for the staging modules.

- [x] **Step 3: Implement dependency closure and relocation plan**

  Return a data plan before mutating files. Copy regular files through stable
  handles, rewrite install names to `@loader_path`-relative paths, then rescan
  every Mach-O and fail if a non-system absolute dependency remains.

- [x] **Step 4: Implement pack staging and capability probes**

  Build canonical `pack.json` files with explicit `executable`, `code`, `data`
  and `license` roles. Probe libvips formats, FFmpeg encoders/muxers, Poppler
  utilities and LibreOffice conversion before declaring the pack complete.

- [x] **Step 5: Verify current-architecture staging through existing production builder**

  Combine two copies of controlled fixture staging only inside the test to
  exercise the exact eight-coordinate production validator. Run build, sign
  with a generated test-only key passed explicitly in `--mode test` where
  applicable, and verify archives and entry hashes.

- [x] **Step 6: Commit**

  Commit message: `build: stage relocatable converter packs`

### Task 5: Code-signing, notarization and compliance evidence

**Files:**
- Create: `apps/desktop/scripts/converter-packs/sign-pack-payload.mjs`
- Create: `apps/desktop/scripts/converter-packs/verify-release-evidence.mjs`
- Create: `apps/desktop/tests/integration/converter-pack-release-evidence.test.ts`
- Modify: `apps/desktop/package.json`

**Interfaces:**
- Consumes: a staged target root and credential paths supplied outside that root.
- Produces: signed payload bytes plus canonical provenance, SBOM, license and notarization evidence; returns no secret material.

- [x] **Step 1: Write failing evidence tests**

  Use injected command results to reject unsigned Mach-O, wrong team identity,
  missing hardened runtime, unaccepted notarization, absent source offers,
  incomplete licenses and architecture mismatch. Prove evidence serialization
  contains no environment values or private-key markers.

- [x] **Step 2: Run tests and verify RED**

  Expected: missing module failure.

- [x] **Step 3: Implement inside-out signing and evidence verification**

  Enumerate Mach-O files from the staged manifest, sign libraries before
  executables, verify strict signatures, submit a deterministic ZIP wrapper to
  `notarytool`, and record only request ID/status/team ID/tool versions and
  artifact hashes.

- [x] **Step 4: Verify credential-free fail-closed behavior**

  Run without signing variables and assert a stable nonzero exit before index
  generation; run tests with injected accepted evidence and verify GREEN.

- [x] **Step 5: Commit**

  Commit message: `build: gate converter pack release evidence`

### Task 6: Immutable publication module

**Files:**
- Create: `apps/desktop/scripts/converter-packs/publish-release.mjs`
- Create: `apps/desktop/tests/integration/converter-pack-publication.test.ts`
- Modify: `apps/desktop/package.json`

**Interfaces:**
- Consumes: verified release output, HTTPS public base URL, sequence and an object-store adapter.
- Produces: immutable release objects followed by stable `index.json` and `index.sig`; read-back verification result.

- [ ] **Step 1: Write failing filesystem-adapter publication tests**

  Exercise real files. Assert archives and sequence metadata exist and hash-match
  before stable metadata changes; a simulated read-back mismatch must leave the
  previous stable pair byte-for-byte unchanged. Reject unknown files, private
  keys, mutable archive destinations and non-HTTPS public URLs.

- [ ] **Step 2: Run tests and verify RED**

  Expected: missing publisher module failure.

- [ ] **Step 3: Implement release planning and filesystem adapter**

  Generate explicit object keys and content metadata, write immutable objects
  with create-only semantics, read them back, and update the stable pair through
  a generation directory plus final promotion.

- [ ] **Step 4: Implement COS command adapter**

  Invoke one explicitly configured absolute `coscli` executable without a shell.
  Pass bucket/region/token through environment, redact command errors, use
  create-only archive keys, download every uploaded object for SHA-256
  verification, and promote stable metadata only after all checks pass.

- [ ] **Step 5: Verify GREEN and interrupted publication recovery**

  Run filesystem publication twice, inject a failure between index and signature
  staging, then prove the old stable pair remains valid and the retry succeeds.

- [ ] **Step 6: Commit**

  Commit message: `feat: publish immutable converter pack releases`

### Task 7: Production bootstrap and packaged-app seam

**Files:**
- Create: `apps/desktop/scripts/converter-packs/create-production-bootstrap.mjs`
- Create: `apps/desktop/electron-builder.production.yml`
- Create: `apps/desktop/tests/integration/converter-pack-bootstrap.test.ts`
- Modify: `apps/desktop/electron/main/build-config.test.ts`
- Modify: `apps/desktop/scripts/verify-converter-packs.mjs`
- Modify: `apps/desktop/package.json`

**Interfaces:**
- Consumes: stable HTTPS index URL, Ed25519 public key and an exclusive output directory.
- Produces: canonical enabled bootstrap metadata used only by production builder configuration.

- [ ] **Step 1: Write failing bootstrap and build-config tests**

  Prove the generator rejects non-HTTPS URLs, private keys, non-Ed25519 keys,
  symlink output and the checked-in resource root. Assert ordinary builder
  config still packages disabled metadata while production config requires an
  explicit generated root.

- [ ] **Step 2: Run tests and verify RED**

  Expected: missing generator and production config assertions.

- [ ] **Step 3: Implement canonical bootstrap generation**

  Write only `bootstrap.json`, `index.schema.json` and
  `root-public-key.pem` into a new directory. Extend packaged verification with
  an explicit production mode that verifies enabled URL/key metadata and still
  scans the ASAR for private keys, fixtures and engines.

- [ ] **Step 4: Package and verify both modes**

  Run ordinary `dist:dir` and confirm fail-closed bootstrap. Generate a test
  release root, package with the production config and confirm the public key
  and enabled canonical bootstrap are present while no private material exists.

- [ ] **Step 5: Commit**

  Commit message: `build: enable signed converter metadata for releases`

### Task 8: GitHub Actions orchestration and final release drill

**Files:**
- Create: `.github/workflows/converter-pack-check.yml`
- Create: `.github/workflows/converter-pack-release.yml`
- Create: `apps/desktop/scripts/converter-packs/validate-workflows.mjs`
- Create: `apps/desktop/tests/integration/converter-pack-workflows.test.ts`
- Modify: `apps/desktop/tests/fixtures/conversion/README.md`
- Modify: `apps/desktop/package.json`

**Interfaces:**
- Check workflow has no production credentials and runs deterministic validation.
- Release workflow accepts explicit `version` and `sequence`, builds both native targets, then enters one protected production job for signing and publication.

- [ ] **Step 1: Write failing workflow behavior tests**

  Parse workflow YAML as data. Assert separate arm64/Intel jobs, exact target
  mapping, pinned action revisions, least-privilege permissions, protected
  `production` environment, explicit inputs, artifact handoff, no pull-request
  access to secrets, and invocation of every tested release CLI.

- [ ] **Step 2: Run tests and verify RED**

  Expected: workflows absent.

- [ ] **Step 3: Implement check and release workflows**

  Use native GitHub macOS runners, frozen pnpm install, cache keyed by the
  canonical source lock, bounded artifact retention and concurrency protection.
  Materialize secrets only in the protected job and remove temporary key/cert
  files in an always-run cleanup step.

- [ ] **Step 4: Run credential-free dry run and repository verification**

  Run workflow validator, source-lock validation, helper contract tests,
  acquisition/staging/publication/bootstrap tests, existing converter pack
  tests, Desktop typecheck, ESLint and build. Do not run a headed browser.

- [ ] **Step 5: Run final real-engine acceptance where local inputs permit**

  Point `AUTOFORGE_TEST_CONVERTER_PACK_ROOT` at the locally produced signed
  fixture root and run `conversion-engines.test.ts`. Record Apple/COS steps as
  externally blocked unless real protected credentials are present; do not
  weaken or bypass those gates.

- [ ] **Step 6: Commit**

  Commit message: `ci: publish signed converter packs`

## Plan Self-Review

- Spec coverage: source provenance, helpers, staging, signing/notarization,
  publication, bootstrap, CI, failure modes and all verification layers map to
  Tasks 1-8.
- Placeholder scan: every implementation step names concrete behavior and a
  defined neighboring interface.
- Type consistency: Task 1 target records feed Tasks 2 and 4; Task 4 produces
  the existing `build-index.mjs` input; Tasks 5-6 consume its verified output;
  Task 7 consumes the same stable URL and public key published by Task 6; Task 8
  only orchestrates these interfaces.
