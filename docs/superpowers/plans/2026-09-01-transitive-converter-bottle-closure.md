# Transitive Converter Bottle Closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the three-top-level-bottle development input with an authenticated, resumable, target-specific Homebrew dependency universe that produces four self-contained converter packs without reading host Homebrew files.

**Architecture:** Canonical source-lock schema version 2 authenticates two large target closure locks and every downloadable blob. A resumable content-addressed downloader materializes a private synthetic Cellar; staging consumes exact per-family inventories, expands Homebrew placeholders only through that universe, verifies every selected byte, and rewrites all non-system Mach-O dependencies into each self-contained pack. Local preparation adds disk preflight and active-plus-previous retention while preserving the existing signed pack index and runtime contracts.

**Tech Stack:** Node.js 24 ESM, TypeScript 6, Vitest 4, macOS `otool`/`lipo`/`install_name_tool`/`codesign`, deterministic canonical JSON, restricted runtime-pack USTAR, bounded bottle gzip/PAX tar reading, Ed25519, GitHub Actions macOS arm64/x64 runners.

**Spec:** `docs/superpowers/specs/2026-09-01-transitive-converter-bottle-closure-design.md`

## Global Constraints

- Supported targets remain exactly `darwin-arm64` and `darwin-x64`.
- Pack families remain exactly `image-icon`, `document`, `pdf`, and `media`; no shared fifth pack is added.
- The desktop application never embeds converter engines and runtime applications continue to consume signed pack index schema version 1.
- Development and production preparation never invoke Homebrew, query a live formula API, search `PATH`, or read `/opt/homebrew` or `/usr/local` for runtime bytes.
- Every network artifact has one committed canonical HTTPS URL, lowercase SHA-256, and positive byte length.
- The current host target alone is downloaded during ordinary development; dual-target acquisition is maintainer-only.
- Download concurrency is exactly three, full-file SHA-256 is checked after resume, and one failed transfer aborts and awaits all sibling transfers.
- Each final pack is independently installable and includes every non-system library, runtime asset, and license it needs.
- Any remaining Homebrew placeholder, undeclared file, host absolute dependency, symlink, path escape, size mismatch, or hash mismatch fails closed.
- Preparation requires at least 10 GiB free before network access, limits complete compressed blobs to 5 GiB, and retains the active plus one previous verified release.
- A build, closure, license, probe, integrity, or smoke failure never replaces the previous active marker.
- CLI errors remain fixed and path-free; tests may use injected diagnostics.
- Preserve unrelated worktree changes. Every behavior change follows RED, GREEN, REFACTOR.

---

### Task 1: Validate schema-v2 source and target closure locks

**Files:**
- Create: `apps/desktop/scripts/converter-packs/closure-lock.mjs`
- Create: `apps/desktop/tests/integration/converter-pack-closure-lock.test.ts`
- Modify: `apps/desktop/scripts/converter-packs/source-lock.mjs`
- Modify: `apps/desktop/tests/integration/converter-pack-source-lock.test.ts`

**Interfaces:**
- Produce: `loadConverterClosureLock({ sourceLockPath, target }) -> Promise<{ sourceLock, closureLock, target }>`.
- Produce: `validateTargetClosureLock(value, target) -> TargetClosureLock` for generated-lock tests.
- Preserve: `loadConverterSourceLock({ path, target })`, now requiring source-lock schema version 2 and returning selected engine, formula, license, and authenticated closure-lock coordinates.
- Consume later: all acquisition, universe, fingerprint, staging, and maintainer tasks use these immutable validated records.

- [ ] **Step 1: Replace the schema-v1 fixture with a literal minimal schema-v2 fixture**

  Build two canonical closure fixtures, hash their exact bytes, and reference
  them from a source lock. The smallest valid graph contains root formulae
  `ffmpeg`, `vips`, and `poppler`, a shared `glib`, and the LibreOffice DMG.
  Assert the selected result contains exact positive `bytes`, exact Cellar
  coordinates, formula dependency arrays, license assets, and one authenticated
  closure lock for the requested target.

- [ ] **Step 2: Add literal rejection cases before implementation**

  Cover unknown keys; schema v1; noncanonical JSON; closure byte/hash mismatch;
  unsorted or duplicate formulae; root engine coordinate disagreement; unknown,
  duplicate, or cyclic dependencies; target mismatch; null root formula on a
  bottle engine; non-null LibreOffice root formula; invalid HTTPS/SHA/bytes;
  unsafe license destination; duplicate case-folded destination; undeclared
  formula in a family file; unsafe `sourcePath`; duplicate family file; invalid
  rewrite; incomplete four-family record; and measurement sums inconsistent
  with the unique referenced download coordinates or non-positive measured
  pack/release byte counts.

- [ ] **Step 3: Run the focused tests and verify RED**

  Run:

  ```bash
  pnpm --filter @autoforge/desktop exec node scripts/run-vitest-electron.mjs run \
    --config vitest.node.config.ts \
    tests/integration/converter-pack-source-lock.test.ts \
    tests/integration/converter-pack-closure-lock.test.ts
  ```

  Expected: FAIL because schema version 2 and `closure-lock.mjs` are absent.

- [ ] **Step 4: Implement exact canonical validators**

  Use `readStableRegularFile`, `canonicalBytes`, `compareUtf8`, and exact-key
  checks. Cap source lock at 8 MiB and each closure lock at 64 MiB. Resolve each
  closure path relative to the canonical source-lock directory, reject
  symlinks, verify committed byte length and SHA-256 before JSON parsing, and
  return frozen plain records. Detect formula cycles with a three-state DFS:

  ```js
  function visit(name) {
    if (state.get(name) === 'visiting') fail('Converter formula dependency graph contains a cycle.')
    if (state.get(name) === 'done') return
    state.set(name, 'visiting')
    for (const dependency of formulae.get(name).dependencies) visit(dependency)
    state.set(name, 'done')
  }
  ```

- [ ] **Step 5: Run both focused files twice and verify GREEN**

  Expected: all schema and graph tests pass twice; `git diff --check` emits no
  output.

- [ ] **Step 6: Commit the isolated schema task**

  Commit: `build: validate transitive converter closure locks`

---

### Task 2: Add resumable, bounded, cancellable acquisition

**Files:**
- Modify: `apps/desktop/scripts/converter-packs/acquire-sources.mjs`
- Modify: `apps/desktop/tests/integration/converter-pack-acquisition.test.ts`

**Interfaces:**
- Change: `acquireVerifiedArchive({ archive, cacheRoot, fetchImpl, signal? })`, where `archive` is exactly `{ url, sha256, bytes }`.
- Produce: `acquireLockedArtifacts({ selected, cacheRoot, fetchImpl?, concurrency? }) -> Promise<{ blobs, networkBytes }>`.
- Cache layout: `<sha256>.archive`, `.<sha256>.partial`, and `.<sha256>.partial.json`; metadata bytes are canonical JSON bound to URL/SHA/total/partial length.
- Consume later: universe and license downloads receive a map keyed by SHA-256; preparation metrics receive `networkBytes`.

- [ ] **Step 1: Write failing resume and cancellation tests**

  Add deterministic streaming fixtures proving:

  - a valid `206` with `Content-Range: bytes 4-9/10` resumes a four-byte partial;
  - a `200` response restarts at zero and truncates the old partial;
  - malformed, shifted, oversized, or total-mismatched ranges discard partials;
  - completed bytes are re-read and hashed in full before publication;
  - stale metadata, URL/SHA/size disagreement, symlinks, and completed-size
    disagreement fail closed;
  - three requests run concurrently and the fourth waits;
  - the first failure aborts two active siblings, no queued request starts,
    every reader settles, and no unbound temporary file remains;
  - GHCR bearer authentication applies the same AbortSignal and Range headers.

- [ ] **Step 2: Verify RED with the acquisition test**

  Run the Electron Node test command for
  `tests/integration/converter-pack-acquisition.test.ts`. Expected: the current
  downloader rejects Range responses and starts unbounded `Promise.all` work.

- [ ] **Step 3: Implement the single-artifact resume state machine**

  Open partial and metadata with no-follow/exclusive semantics. Validate the
  existing partial using canonical metadata and `lstat`; request the missing
  range; handle only the specified `200`/`206` cases; sync data and metadata;
  close readers and file handles in `finally`; then stream the complete partial
  through SHA-256 before linking it into the immutable cache key.

- [ ] **Step 4: Implement the three-worker acquisition scheduler**

  Sort unique artifacts by SHA-256, reject conflicting identities for one SHA,
  and run exactly three workers over a shared cursor. One private
  `AbortController` combines the optional caller signal with internal failure.
  On first error, abort and `await Promise.allSettled(workers)` before throwing
  the original controlled error. Deduplicate artifacts shared by formulae,
  engines, and license assets.

- [ ] **Step 5: Run acquisition and source-lock tests twice**

  Expected: all tests pass without dangling timers, sockets, readers, partial
  metadata, or `.downloading` files.

- [ ] **Step 6: Commit the acquisition task**

  Commit: `build: resume transitive converter downloads`

---

### Task 3: Materialize a verified synthetic bottle universe

**Files:**
- Create: `apps/desktop/scripts/converter-packs/bottle-archive.mjs`
- Create: `apps/desktop/scripts/converter-packs/bottle-universe.mjs`
- Create: `apps/desktop/tests/integration/converter-pack-bottle-universe.test.ts`

**Interfaces:**
- Produce: `materializeBottleUniverse({ target, closureLock, formulae, blobs, outputRoot }) -> Promise<BottleUniverse>`.
- `BottleUniverse` exposes frozen `cellar(formula, version)`, `opt(formula)`, `resolveLockedFile(formula, sourcePath)`, and `contains(path)` methods.
- Add: `readVerifiedBottleEntries({ archive, expectedBytes, expectedSha256 })`, a bounded gzip/tar reader that understands USTAR and the exact POSIX PAX records emitted by locked Homebrew bottles.
- Add: `extractVerifiedBottle({ archive, coordinate, selectedEntries, destination })`, a private-root extractor that materializes only closure-declared regular bytes and safe internal links.
- Consume later: closure planning and staging never construct host Homebrew paths themselves.

- [ ] **Step 1: Write failing synthetic-bottle tests**

  Build restricted tar fixtures with `formula/version/bin/tool`,
  `formula/version/lib/libtool.dylib`, and license files. Assert exact canonical
  `universe/Cellar/<formula>/<version>` coordinates, immutable formula lookup,
  and reuse of one extracted formula by two families. Include real-shape PAX
  `path`/`linkpath` records and gzip framing. Reject malformed PAX lengths,
  global PAX headers, archive traversal, hard links, special files,
  absolute links, escaping links, link cycles,
  case-fold collisions, undeclared formula/version, duplicate archive entries,
  output symlinks, file hash/size disagreement, extra selected file, and a
  lookup outside the private universe.

- [ ] **Step 2: Verify RED**

  Run the new universe test. Expected: `bottle-archive.mjs` and
  `bottle-universe.mjs` are missing.

- [ ] **Step 3: Implement a bottle-only gzip/PAX tar reader without weakening pack archives**

  Keep runtime pack USTAR code untouched and regular-file-only. The bottle
  reader uses Node zlib with a 4 GiB decompressed cap, parses 512-byte tar
  records, validates checksums, and accepts only regular files, directories,
  internal symbolic links, and local PAX headers containing bounded UTF-8
  `path`/`linkpath`/`size` records; all global PAX headers are rejected. A link
  is materialized only when its normalized target names a closure-declared
  regular entry in the same formula/version root. Materialize selected links
  as copied verified bytes, never filesystem symlinks. Remove the private
  extraction root on any error and publish only after every selected entry
  matches bytes, SHA-256, mode, and role.

- [ ] **Step 4: Implement `BottleUniverse` as a deep module**

  Canonicalize and no-follow the output root once. Store exact formula/version
  maps privately. `opt(formula)` returns the formula's canonical version root,
  not an `opt` symlink. `resolveLockedFile` accepts only a file tuple committed
  in the selected target closure and returns a canonical regular path beneath
  the universe.

- [ ] **Step 5: Run both focused tests twice and commit**

  Expected: GREEN twice; runtime pack USTAR tests remain unchanged. Commit:
  `build: materialize verified converter bottle universe`.

---

### Task 4: Resolve exact pack-local Mach-O and runtime closures

**Files:**
- Modify: `apps/desktop/scripts/converter-packs/macho-closure.mjs`
- Modify: `apps/desktop/scripts/converter-packs/stage-production-packs.mjs`
- Modify: `apps/desktop/tests/integration/converter-pack-staging.test.ts`

**Interfaces:**
- Change: `planMachOClosure({ entrypoints, architecture, inspect, universe, expectedFiles, expectedRewrites })`.
- Produce: an exact plan whose files and rewrites equal the selected family closure lock.
- Change: `stageProductionPacks(request, dependencies?)` consumes a staging plan
  containing `sourceLockPath`, `universeRoot`, `helpersRoot`, and
  `engineAssetsRoot`. The source lock authenticates the target closure. Bottle
  files remain confined to `BottleUniverse`; non-bottle inputs resolve only
  through target-bound helper and engine-asset manifests, never arbitrary host
  source paths.
- Preserve: fixed executable destinations and adapter capability probes.

- [ ] **Step 1: Add failing placeholder and exact-inventory tests**

  Use synthetic formulae `vips`, `glib`, and `libpng`. Prove exact expansion of:

  ```text
  @@HOMEBREW_CELLAR@@/vips/8.18.6/lib/libvips.42.dylib
  @@HOMEBREW_PREFIX@@/opt/glib/lib/libglib-2.0.0.dylib
  @loader_path/../lib/liblocal.dylib
  @rpath/libpng16.16.dylib
  ```

  Reject unknown formula/version, host `/opt/homebrew` and `/usr/local` paths,
  undeclared discovered nodes, declared-but-unreached files, hash changes,
  unexpected rewrites, missing rewrites, placeholder text after relocation,
  basename collisions, symlinked universe entries, and runtime data not listed
  in the closure lock.

- [ ] **Step 2: Verify RED**

  Run `converter-pack-staging.test.ts`. Expected: `@@HOMEBREW_*@@` is unresolved
  and the planner accepts only a discovered basename-based closure.

- [ ] **Step 3: Implement universe-bound placeholder resolution**

  Parse both placeholders with anchored regexes, extract exact formula/version,
  and delegate to `BottleUniverse`. Preserve system-prefix handling. No branch
  may call `existingRegular` on an arbitrary absolute path; all non-system
  candidates must first be authorized by the expected family file inventory.

- [ ] **Step 4: Namespace library destinations and compare exact plans**

  Use `lib/<formula>/<basename>` destinations and
  `@rpath/autoforge/<formula>/<basename>` identities. Compare UTF-8-sorted
  discovered tuples to committed files and rewrites before copying. Copy
  explicit data/modules from the same exact inventory. After relocation,
  rescan every Mach-O and reject any non-system dependency not beginning with
  pack-local `@loader_path/` or the file's exact pack-local identity.

- [ ] **Step 5: Run staging, native-helper, and four adapter tests**

  Expected: all existing command contracts and capability probes pass; no test
  supplies a host Homebrew path.

- [ ] **Step 6: Commit the closure task**

  Commit: `build: stage exact self-contained converter closures`

---

### Task 5: Generate and review real dual-target locks

**Files:**
- Create: `apps/desktop/scripts/converter-packs/capture-homebrew-target.mjs`
- Create: `apps/desktop/scripts/converter-packs/generate-transitive-source-lock.mjs`
- Create: `apps/desktop/scripts/converter-packs/durable-lock-publication.mjs`
- Create: `apps/desktop/converter-packs/lock-candidates.json`
- Modify: `apps/desktop/scripts/converter-packs/bottle-archive.mjs`
- Modify: `apps/desktop/scripts/converter-packs/macho-closure.mjs`
- Modify: `apps/desktop/scripts/converter-packs/source-lock.mjs`
- Create: `apps/desktop/tests/integration/converter-pack-lock-generation.test.ts`
- Create: `.github/workflows/converter-pack-lock.yml`
- Modify: `apps/desktop/package.json`
- Replace: `apps/desktop/converter-packs/sources.lock.json`
- Create: `apps/desktop/converter-packs/closures/darwin-arm64.lock.json`
- Create: `apps/desktop/converter-packs/closures/darwin-x64.lock.json`

**Interfaces:**
- Produce: `captureHomebrewTarget({ target, brew, repositoryRevision, coreRevision, caskRevision, roots, output, run }) -> Promise<void>` for an isolated correct-architecture maintainer runner; its canonical integrity-checked capture contains the fully probed target closure.
- Produce: `generateTransitiveSourceLock({ arm64Capture, x64Capture, provenanceManifest, outputRoot }) -> Promise<void>`; merge never executes a foreign-architecture binary and accepts only captures bound by the protected current-run manifest.
- Package commands: `converter-packs:capture-lock-target` and `converter-packs:generate-lock`.
- Development and production preparation consume only the generated canonical files; these commands never run from `predev`.

- [ ] **Step 1: Write failing generator tests with synthetic command output**

  Capture fixtures must prove exact brew path, exact tap revision, target/host
  match, dependency discovery from roots, formula JSON validation, bottle URL/
  SHA/size capture, license expression capture, deterministic sorting, and one
  downloaded blob per SHA. Reject unpinned tap revisions, non-HTTPS URLs,
  missing bottles, unexpected target tags, inconsistent versions, duplicate
  formulae, command output above 64 MiB, and any formula not reachable from a
  root.

- [ ] **Step 2: Verify RED**

  Run `converter-pack-lock-generation.test.ts`. Expected: both maintainer
  modules are absent.

- [ ] **Step 3: Implement target capture and target-local closure generation**

  Require absolute `brew`, verify `process.platform === 'darwin'` and target
  architecture, run `brew tap-info --json=v1 homebrew/core`, and require the
  exact requested lowercase 40-hex revisions for both `homebrew/core` and
  `homebrew/cask`. Obtain the dependency union and formula JSON
  with fixed argument arrays and a fixed maintainer environment. Fetch each
  selected bottle into a private workspace, compute byte length and SHA-256,
  and fail when they differ from Homebrew metadata. On that same target runner,
  materialize the universe, derive exact Mach-O and declared runtime-asset
  closures, build and probe all four target packs, and include the integrity-checked
  closure plus measurements in one canonical capture fragment. The fixed
  runtime-asset policy permits only known formula-relative roots required by
  libvips loaders/configuration and is expanded to exact files in the capture;
  it never writes a glob to the closure lock. Do not edit repository locks in
  this step.

- [ ] **Step 4: Implement dual-target merge and closure generation**

  Validate both already-probed capture fragments against a current-run manifest
  binding repository SHA, both tap revisions, target, and capture digest. Merge
  only equal formula/version/license identities; dependency edges remain target
  local in closure locks. Recompute capture hashes and all graph,
  file, rewrite, license, and measurement invariants without executing either
  architecture. Write both closure files, then write source lock last after
  hashing them. Refuse to overwrite existing outputs unless every existing file
  exactly equals newly generated canonical bytes. Publish each file through a
  same-directory private temp, fsync/chmod/verification, and hardlink
  no-replace; publish the source lock last and recover bounded interrupted temps.

- [ ] **Step 5: Add the protected maintainer workflow**

  Use one `macos-15` arm64 capture job and one `macos-15-intel` x64 capture job,
  each with contents-read permissions, pinned actions, one-day artifacts, no
  production secrets, and explicit core and cask revision inputs. Each capture
  job validates strict lowercase 40-hex input before any tap Git operation,
  checks out both exact revisions in isolated taps, and lets capture revalidate
  both HEADs. A merge job binds the two artifacts to the current run, runs the
  generator and uploads the three generated lock files for human review; it
  never commits or publishes automatically.

- [ ] **Step 6: Generate the real schema-v2 files**

  Run both capture jobs at the already approved Homebrew revisions, download
  every candidate in the isolated maintainer workspace, generate both target
  closures, and inspect the diff. Record exact formula counts and measurement
  totals in the task report. The checked-in files must pass Task 1 validators
  for both targets without network access.

- [ ] **Step 7: Run lock, workflow, staging, and generation tests twice**

  Also run `converter-packs:verify-workflows` and both explicit target source
  verification commands. Expected: GREEN and no live Homebrew/API call from
  verification.

- [ ] **Step 8: Commit generated locks and maintainer workflow**

  Commit: `build: lock complete converter bottle dependency graph`

---

### Task 6: Add disk preflight, cache accounting, and safe retention

**Files:**
- Create: `apps/desktop/scripts/converter-packs/development-cache-budget.mjs`
- Create: `apps/desktop/tests/integration/development-cache-budget.test.ts`
- Modify: `apps/desktop/scripts/converter-packs/local-development-release-cache.mjs`
- Modify: `apps/desktop/tests/integration/local-development-release-cache.test.ts`

**Interfaces:**
- Produce: `preflightDevelopmentCache({ cacheRoot, requiredDownloadBytes, freeBytes }) -> Promise<void>`.
- Produce: `pruneDevelopmentCache({ cacheRoot, activeFingerprint, keepPrevious: 1, maximumBlobBytes: 5 * GiB }) -> Promise<{ removedReleases, removedBlobs }>`.
- Produce: immutable cache metadata at `release-metadata/<fingerprint>.json`, kept outside the exact runtime release layout and bound to a canonical existing release directory.

- [ ] **Step 1: Write failing disk and retention tests**

  Prove failure below 10 GiB before acquisition, success at exactly 10 GiB,
  active-plus-newest-previous retention, referenced-blob protection, pruning of
  only unreferenced complete blobs, no pruning of partials owned by an active
  preparation lock, deterministic oldest-first pruning, failure when 5 GiB
  cannot be met safely, and rejection of symlinked/noncanonical roots,
  malformed metadata, unknown files, or a marker pointing outside releases.

- [ ] **Step 2: Verify RED**

  Run the budget and cache tests. Expected: the budget module and release
  metadata do not exist.

- [ ] **Step 3: Implement safe accounting and pruning**

  Sum `lstat` regular-file sizes using safe integers; never follow symlinks.
  Obtain free space through an injected function in tests and `statfs` in
  production. Build exact keep/remove sets before mutation. Rename each
  removable release, metadata file, or blob into a private cache trash sibling
  before recursive removal, and never target an unresolved variable, workspace
  root, active release, active partial, or retained metadata reference.

- [ ] **Step 4: Run cache/budget tests twice and commit**

  Commit: `build: bound development converter cache usage`.

---

### Task 7: Integrate schema v2, universe staging, metrics, and warm reuse

**Files:**
- Modify: `apps/desktop/scripts/converter-packs/prepare-production-staging.mjs`
- Modify: `apps/desktop/tests/integration/converter-pack-prepare-staging.test.ts`
- Modify: `apps/desktop/tests/integration/converter-pack-staging.test.ts`
- Modify: `apps/desktop/scripts/converter-packs/prepare-local-development-release.mjs`
- Modify: `apps/desktop/tests/integration/local-development-release-preparation.test.ts`
- Modify: `apps/desktop/scripts/converter-packs/build-local-development-release.mjs`
- Modify: `apps/desktop/tests/integration/local-development-release-builder.test.ts`

**Interfaces:**
- `prepareProductionStagingPlan` loads the selected closure, acquires its unique artifacts, materializes one universe, and writes a plan that references only the universe and authenticated closure.
- `prepareLocalDevelopmentRelease` fingerprints source lock, both closure locks, universe/acquisition/budget modules, and existing helper/staging/release modules.
- Cold result remains `{ fingerprint, releaseRoot, reused: false }`; warm result remains `{ fingerprint, releaseRoot, reused: true }`.
- Preparation writes canonical `release-metadata/<fingerprint>.json` only after
  release integrity succeeds. Cache pruning revalidates its fingerprint,
  selected source/closure lock hashes, referenced blobs, and canonical release
  path; the exact runtime release layout and signed pack index schema version 1
  remain unchanged.

- [ ] **Step 1: Write failing end-to-end orchestration tests with synthetic bottles**

  Prove the exact cold order:

  ```text
  validate locks -> disk preflight -> acquire unique blobs -> materialize once
  -> build helpers -> prepare exact plan -> stage four packs -> build/sign
  -> integrity -> smoke -> activate -> prune
  ```

  Assert one shared formula downloads/extracts once but appears independently in
  two packs. Assert cache metadata blob references and measurements are exact.
  On every
  stage failure, previous marker bytes remain literal, private workspace is
  gone, resumable partial policy is preserved, no release metadata is
  published, and no failed release is reused.

- [ ] **Step 2: Add warm-path zero-work assertions**

  A verified active fingerprint must call only integrity verification and safe
  pruning; injected acquisition, extraction, helper, stage, build, and smoke
  functions throw if called. Assert the same fingerprint/release and unchanged
  source/release mtimes.

- [ ] **Step 3: Verify RED**

  Run preparation, staging, builder, cache, universe, and closure tests.
  Expected: current plan contains host source paths and no schema-v2 universe,
  budget, release metadata, or closure locks.

- [ ] **Step 4: Implement production staging migration**

  Remove recursive source archive extraction from the normal path. Acquire
  bottles, DMG, and direct license assets from the selected lock; materialize
  the universe; validate the exact family closure; and write a canonical plan
  containing only private canonical paths plus authenticated family inventory.
  Keep LibreOffice as the locked DMG plus native launcher.

- [ ] **Step 5: Implement local preparation migration**

  Extend the explicit fingerprint allowlist with `closures/**`,
  `closure-lock.mjs`, `bottle-archive.mjs`, `bottle-universe.mjs`, and
  `development-cache-budget.mjs`. Run disk preflight before acquisition. Write
  canonical release metadata only after integrity and smoke succeed. Activate,
  then prune. Keep activation outside the cold-build cleanup catch so a
  post-rename fsync error never deletes the marker target.

- [ ] **Step 6: Run all affected tests twice plus typecheck**

  Expected: synthetic cold/warm tests pass; existing runtime adapter tests,
  release integrity tests, and safe CLI output tests remain green.

- [ ] **Step 7: Commit integration**

  Commit: `feat: prepare self-contained transitive converter packs`

---

### Task 8: Update production workflows, documentation, and validation

**Files:**
- Modify: `.github/workflows/converter-pack-check.yml`
- Modify: `.github/workflows/converter-pack-release.yml`
- Modify: `apps/desktop/scripts/converter-packs/validate-workflows.mjs`
- Modify: `apps/desktop/tests/integration/converter-pack-workflows.test.ts`
- Modify: `apps/desktop/converter-packs/README.md`
- Modify: `apps/desktop/package.json`

**Interfaces:**
- Check and release workflow cache keys include source lock plus both closure locks.
- Production staging uses schema-v2 acquisition and exact target closure without host Homebrew bytes.
- `converter-packs:verify-sources` gains a safe no-argument mode that validates both checked-in targets; explicit `--lock --target` remains supported.

- [ ] **Step 1: Write failing workflow and package-contract tests**

  Require both closure files in cache keys, both targets in no-argument source
  verification, no `brew install/fetch/info/deps` command in check/release/dev
  paths, fixed 10 GiB preflight, and unchanged protected production signing and
  publication gates. Assert the maintainer workflow is the only workflow that
  may invoke the two new lock-maintenance package commands.

- [ ] **Step 2: Verify RED**

  Run workflow tests and the no-argument package command. Expected: cache keys
  hash only `sources.lock.json` and source verification requires arguments.

- [ ] **Step 3: Update workflows, CLI defaults, and README**

  Preserve pinned action SHAs and contents-read permissions. Document the
  source lock, target closure locks, maintainer-only generation, 1.8 GB download
  ceiling, 10 GiB free-space requirement, 5 GiB blob cache, active-plus-previous
  retention, and the rule that ordinary preparation never reads host Homebrew.

- [ ] **Step 4: Run workflow, source-lock, package-config, and typecheck tests**

  Expected: no-argument and explicit target verification pass offline.

- [ ] **Step 5: Commit workflow migration**

  Commit: `build: validate transitive converter release workflows`

---

### Task 9: Real cold-cache, warm-cache, and size acceptance

**Files:**
- Modify only for a verified Tasks 1–8 defect: files owned by those tasks.
- Do not create persistent debug scripts, downloaded artifacts, caches, or logs in Git.

**Interfaces:**
- Acceptance signal: the same active marker and release path consumed by `pnpm dev`, containing four signed current-target descriptors and passing the explicit real-engine verifier.
- Acceptance report records exact bytes rather than estimates.

- [ ] **Step 1: Load verification-before-completion and establish baseline**

  Record HEAD, tracked status, cache inode/mode/mtime, available disk, and the
  known unrelated baseline of ten approval-flow failures plus one knowledge
  limit failure. Run all Tasks 1–8 focused Node/Electron tests in one compatible
  invocation, the renderer suite, universal workflow tests, typecheck,
  workflow/source-lock validation, and converter-pack boundary verification.

- [ ] **Step 2: Back up only the task-owned converter cache**

  Use `mktemp -d` for a private backup parent. Resolve exactly
  `apps/desktop/node_modules/.cache/autoforge-converter-packs`, reject a symlink
  or noncanonical root, and move that one directory to the recorded backup.
  Retain it until all acceptance steps finish.

- [ ] **Step 3: Run a true empty-cache preparation**

  Execute `node scripts/converter-packs/prepare-local-development-release.mjs`
  with no mirror seeding and no host cache. Expected: `prepared <64-hex>`, exit
  zero, no lingering socket/process/partial outside the resumable policy, and
  no path-bearing CLI error.

- [ ] **Step 4: Verify the active release and real conversions**

  Check exact marker bytes; four unique descriptors for the current target;
  signed index and installed entry integrity; zero Homebrew placeholders or
  host absolute dependencies; complete formula licenses; then run
  `converter-packs:verify-development`. Expected: DOC/DOCX, CSV/XLSX, PDF,
  image/icon, audio, and video smoke conversions all pass.

- [ ] **Step 5: Prove warm reuse with zero work**

  Snapshot hashes, inode/mtime, and byte counts for all complete blobs,
  release metadata, helpers, and the active release. Run the
  exact preparation CLI again. Expected: `reused` with the same fingerprint,
  zero network bytes, and no changed snapshot outside safe pruning metadata.

- [ ] **Step 6: Measure and report exact sizes**

  Record:

  - network bytes fetched on the cold run;
  - complete compressed blob cache bytes;
  - compressed bytes for each of the four pack archives;
  - installed release bytes;
  - maximum private-workspace bytes observed during preparation;
  - formula count and license count per family.

  Fail acceptance if network exceeds 1.8 GB, free-space preflight does not
  enforce 10 GiB, complete blobs exceed 5 GiB after safe pruning, or the active
  plus previous retention invariant is violated.

- [ ] **Step 7: Run broad regression and restore user state**

  Run the full desktop and universal workflow suites. Distinguish only the
  recorded unrelated failures. Run `git diff --check`, scan for debug markers,
  inspect the full spec diff, stop task-owned processes, move the new cache to a
  recoverable location, and restore the original cache with its recorded
  metadata. Never delete the user's previous cache.

- [ ] **Step 8: Commit only verified acceptance repairs**

  If no product defect was found, create no acceptance commit. If a scoped
  defect was fixed through RED/GREEN and reviewed, commit:
  `fix: complete transitive converter cold-cache acceptance`.

---

## Final review gate

After Task 9 passes, run one fresh broad code review over the fixed range from
the pre-schema-v2 commit through HEAD. Review standards and spec compliance,
including generated lock integrity and the measured acceptance report. Resolve
all blockers through task-owned TDD loops, rerun affected verification, then use
`superpowers:finishing-a-development-branch` to choose merge, PR, or retained
worktree disposition.
