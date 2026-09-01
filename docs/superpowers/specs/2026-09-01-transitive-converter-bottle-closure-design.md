# Transitive Converter Bottle Closure Design

## Status and scope

This design amends `2026-09-01-full-development-converter-release-design.md`
after real cold-cache acceptance proved that the three Homebrew engine bottles
are not self-contained. It covers the complete, reproducible dependency closure
for the existing `image-icon`, `document`, `pdf`, and `media` converter packs on
`darwin-arm64` and `darwin-x64`.

It does not add formats, a fifth shared pack, Windows support, host `PATH`
fallback, or converter binaries to the packaged desktop application.

## Problem statement

The schema-version-1 source lock authenticates only the top-level `ffmpeg`,
`libvips`, and `poppler` bottles. Their Mach-O files contain relocatable load
commands such as:

```text
@@HOMEBREW_CELLAR@@/vips/8.18.6/lib/libvips.42.dylib
@@HOMEBREW_PREFIX@@/opt/glib/lib/libglib-2.0.0.dylib
```

Expanding those paths against `/opt/homebrew` or `/usr/local` would silently
copy unpinned host files and would make clean development machines fail. The
current union of Homebrew dependencies declared by the three formulae contains
approximately 106 formulae. Some engines also load modules and data at runtime
that are not reachable through Mach-O load commands.

The source lock therefore cannot be repaired by recognizing two placeholder
strings. The release needs an authenticated download universe and an exact,
target-specific runtime closure.

## Accepted product behavior

- The desktop `.app` remains independent of converter engines.
- A cold development preparation may download up to 1.8 GB and use up to 10 GB
  of temporary disk space.
- The persistent converter cache is limited to 5 GB.
- The active and immediately previous release are retained; older immutable
  releases are eligible for pruning.
- Each of the four packs is independently installable and contains every
  non-system runtime dependency it needs, even when that duplicates libraries
  across packs.
- A representative single-architecture converter release is expected to be
  approximately 0.7–1.3 GB compressed and 1.5–3 GB installed. Acceptance must
  replace these estimates with measured values.

## Lock artifacts

### Source lock schema version 2

`apps/desktop/converter-packs/sources.lock.json` becomes the small root of
trust. Its canonical JSON shape is:

```ts
type SourceLockV2 = {
  schemaVersion: 2
  homebrewCoreRevision: string
  homebrewCaskRevision: string
  targets: ['darwin-arm64', 'darwin-x64']
  engines: Array<{
    name: 'ffmpeg' | 'libreoffice' | 'libvips' | 'poppler'
    version: string
    license: string
    rootFormula: string | null
    acquisitions: Record<Target, DownloadCoordinate>
  }>
  formulae: Array<{
    name: string
    version: string
    revision: number
    license: string
    acquisitions: Record<Target, BottleCoordinate | null>
    licenses: LicenseAsset[]
  }>
  closureLocks: Record<Target, {
    path: string
    sha256: string
    bytes: number
  }>
}
```

`DownloadCoordinate` and `BottleCoordinate` contain exact HTTPS URL, lowercase
SHA-256, compressed byte length, archive kind, and target Cellar coordinate.
Every formula and array is sorted by UTF-8 bytes. Formula names are unique.
Dependencies referenced by a closure lock must exist in this formula catalog.

The LibreOffice engine keeps its locked DMG coordinate and has
`rootFormula: null`. The other engines name their root formula. Full upstream
source archives are no longer downloaded solely to find one license file.
For a formula-backed engine, each engine acquisition must be byte-for-byte
equal to the same target coordinate in its root formula catalog entry. This
deliberate duplication preserves the existing engine-facing acquisition
interface while making disagreement fail schema validation.

### License assets

A license asset is one of two exact variants:

```ts
type LicenseAsset =
  | {
      kind: 'bottle-entry'
      target: Target
      path: string
      sha256: string
      bytes: number
      destination: string
    }
  | {
      kind: 'download'
      url: string
      sha256: string
      bytes: number
      destination: string
    }
```

Bottle entries are preferred. When a bottle lacks the required license or
notice, the lock records a direct upstream license file instead of an entire
source archive. A formula used by a pack must contribute at least one verified
license asset to that pack.

### Target closure locks

Large exact inventories live in:

```text
apps/desktop/converter-packs/closures/darwin-arm64.lock.json
apps/desktop/converter-packs/closures/darwin-x64.lock.json
```

The source lock authenticates each closure lock by relative path, byte length,
and SHA-256. A closure lock contains:

```ts
type TargetClosureLock = {
  schemaVersion: 1
  target: Target
  formulae: Array<{
    name: string
    version: string
    dependencies: string[]
  }>
  families: Record<PackFamily, {
    files: Array<{
      formula: string
      sourcePath: string
      destination: string
      sha256: string
      bytes: number
      executable: boolean
      role: 'executable' | 'code' | 'data'
    }>
    rewrites: Array<{
      destination: string
      dependency: string
      replacement: string
    }>
    licenses: Array<{
      formula: string
      source: string
      destination: string
      sha256: string
      bytes: number
    }>
  }>
  measurements: {
    downloadBytes: number
    compressedPackBytes: Record<PackFamily, number>
    installedReleaseBytes: number
  }
}
```

The file inventory includes the Mach-O dependency closure and explicit runtime
modules or data needed by capability probes. It contains no globs. Destination
paths are portable, canonical, and unique case-insensitively. Libraries are
namespaced by formula, for example `lib/glib/libglib-2.0.0.dylib`, so unrelated
formulae cannot collide on a basename.

## Lock maintenance

Lock generation is an explicit maintainer workflow, never a development-startup
operation. It runs against exact Homebrew/core and Homebrew/cask revisions and
performs these phases:

1. Resolve the declared runtime dependency candidates for both targets.
2. Record every candidate bottle URL, SHA-256, byte length, version, revision,
   Cellar coordinate, SPDX license expression, and license assets.
3. Download and hash the candidates in a disposable maintenance workspace.
4. Extract them into a synthetic bottle universe.
5. Inspect Mach-O dependencies and engine-specific runtime modules.
6. Prune formulae that are not reachable from any family.
7. Produce exact per-family file, rewrite, runtime-data, and license inventories.
8. Build and probe the four packs for each target.
9. Write canonical source and closure locks only after both targets pass.

Generated lock changes are code-reviewed. Development preparation only
validates and consumes committed locks; it never invokes `brew`, GitHub APIs,
formula Ruby, or a host package manager.

## Acquisition and resumable cache

All network reads use URLs and sizes committed in `sources.lock.json`.
Acquisition uses at most three concurrent requests.

Each incomplete download has a private data file and canonical metadata that
binds it to the expected URL, SHA-256, byte length, and current partial length.
On retry:

- a matching partial file is requested with `Range`;
- `206 Content-Range` must start at the exact partial length;
- `200` causes a safe restart from byte zero;
- malformed range responses discard the partial file;
- the completed file is hashed in full before atomic publication.

The first failure aborts sibling requests, waits for all request handlers to
settle, removes invalid partial metadata, and returns one controlled error. A
failed CLI cannot remain alive because of forgotten download sockets.

Content-addressed complete blobs are shared across families and releases. A
SHA mismatch never overwrites an existing blob.

Normal development acquisition reads only the current host target. The 5 GB
cache budget does not require retaining bottles for both architectures on one
developer machine; dual-target downloads occur only in the isolated maintainer
workflow.

## Synthetic bottle universe

Verified bottles are extracted beneath a private workspace into canonical
coordinates:

```text
universe/Cellar/<formula>/<version>/...
```

The implementation exposes an immutable lookup object rather than creating or
following host-style `opt` symlinks:

```ts
type BottleUniverse = {
  target: Target
  cellar(formula: string, version: string): string
  opt(formula: string): string
  contains(path: string): boolean
}
```

The universe accepts only formulae and versions in the selected closure lock.
All selected files are regular, canonical, non-symbolic paths inside the
private universe and match their closure-lock bytes and SHA-256.

## Mach-O and runtime closure

The closure resolver accepts the bottle universe explicitly. It expands:

- `@@HOMEBREW_CELLAR@@/<formula>/<version>/...` through `cellar()`;
- `@@HOMEBREW_PREFIX@@/opt/<formula>/...` through `opt()`;
- `@loader_path`, `@executable_path`, and `@rpath` within the selected universe;
- `/usr/lib/...` and `/System/Library/...` as system dependencies.

No other absolute dependency is accepted. In particular, it never probes
`/opt/homebrew`, `/usr/local`, or `PATH`.

The runtime planner compares discovered Mach-O nodes with the exact closure
lock. Missing, additional, differently hashed, differently sized, or
differently addressed files fail closed. Explicit runtime modules and data are
also copied only from the closure-lock inventory.

Every non-system dependency is rewritten to a pack-local `@loader_path` path.
Library identities use a namespaced value such as
`@rpath/autoforge/<formula>/<basename>`. Post-relocation inspection rejects all
remaining Homebrew placeholders, host absolute paths, and undeclared modules.

## Four self-contained packs

The pack families remain exactly:

- `image-icon`
- `document`
- `pdf`
- `media`

Shared source blobs and extracted formula roots are reused during preparation,
but final packs do not depend on one another. Each pack contains its fixed
executable inventory, exact reachable libraries and runtime assets, and the
licenses for every contributing formula.

The existing signed index schema version 1 and installed coordinate layout stay
unchanged. Closure metadata affects pack contents, not workflow permissions or
catalog routes.

## Disk budget and retention

Before downloading, preparation sums the committed byte lengths and checks the
available filesystem capacity. It requires at least 10 GB free and refuses to
start otherwise.

The cache budget is enforced only on task-owned converter cache content:

- complete compressed blobs: maximum 5 GB;
- releases retained: active plus one most recent verified predecessor;
- private failed workspaces: always removed;
- active release and blobs referenced by retained releases: never pruned.

Pruning uses canonical manifests and exact paths. It does not recursively delete
an unresolved root, symlink, workspace root, or user-managed Homebrew cache.
If safe pruning cannot satisfy the budget, preparation fails before replacing
the active marker.

## Failure behavior

- Invalid source or closure lock: fail before network access.
- Insufficient disk: fail before downloads or marker changes.
- Interrupted download: retain only a resumable, metadata-bound partial file.
- Hash, size, archive, or license mismatch: discard the new artifact and keep
  the old active release.
- Missing formula or placeholder target: fail; never consult the host.
- Closure mismatch or undeclared runtime file: fail before pack publication.
- Probe, signature, integrity, or smoke failure: remove the new release and keep
  the literal previous marker.
- Failure after marker rename: retain the referenced release so the marker never
  points to a missing directory.

CLI errors remain fixed and path-free. Diagnostic detail is available only to
tests or explicitly injected development diagnostics.

## Verification strategy

Automated tests use small synthetic bottles and cover:

- exact schema-v2 and closure-lock validation;
- missing, duplicate, cyclic, target-mismatched, and unknown formulae;
- bottle-entry and downloaded license validation;
- resumable responses, restart-on-200, bad ranges, wrong lengths, wrong hashes,
  cancellation, and cleanup;
- `HOMEBREW_CELLAR` and `HOMEBREW_PREFIX` expansion inside the universe;
- rejection of host paths, symlinks, traversal, undeclared dylibs, runtime
  modules, and basename collisions;
- shared downloads with self-contained final packs;
- pack license completeness;
- disk preflight, active-plus-previous retention, and safe pruning;
- cold-failure marker preservation and warm-cache zero-work reuse.

Final macOS acceptance starts from an empty task-owned cache and must prove:

1. Every locked blob downloads or resumes and rehashes successfully.
2. The active signed index contains exactly four current-target descriptors.
3. No staged Mach-O contains a Homebrew placeholder or host dependency.
4. DOC/DOCX, CSV/XLSX, PDF rasterization, image/icon, audio, and video smoke
   conversions pass with the real engines.
5. A second preparation reports `reused` with zero downloads, extractions,
   helper builds, or release builds.
6. The report records exact network bytes, compressed source-cache bytes, each
   compressed pack size, installed release size, and peak temporary disk use.

The broader desktop suite and universal workflow suite are rerun. Unrelated
baseline failures remain reported separately and are not repaired in this
scope.

## Migration and compatibility

- Source-lock consumers in acquisition, production pack staging, CI, and local
  development migrate atomically to schema version 2. Runtime applications do
  not read this source lock; they continue to read signed pack index schema
  version 1.
- The development preparation command requires source-lock schema version 2
  after migration. Maintainer commands reject schema version 1 rather than
  silently completing missing dependency coordinates from the host.
- No automatic v1-to-v2 conversion occurs at startup.
- The new fingerprint includes source lock bytes, both closure lock bytes,
  acquisition/extraction modules, closure modules, and pack staging modules.
- Existing v1 development releases cannot match the new fingerprint and are
  never reused.
- Pack index schema version 1, runtime adapter contracts, and workflow catalog
  remain unchanged.

## Explicit non-goals

- Installing or invoking Homebrew during `pnpm dev`.
- Reading libraries from a host Homebrew prefix.
- Adding a shared fifth converter pack.
- Dynamically accepting newly published formula versions.
- Bundling converter engines inside the desktop application.
- Adding conversion routes or changing adapter command arguments.
