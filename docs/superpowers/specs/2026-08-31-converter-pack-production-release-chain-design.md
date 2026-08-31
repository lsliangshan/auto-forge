# Converter Pack Production Release Chain Design

**Date:** 2026-08-31
**Status:** Approved in conversation

## Goal

Close the production release gate for AutoForge converter packs on macOS arm64
and x64. A release must build or acquire pinned converter engines, stage all
four pack families, verify their real capabilities and legal notices, sign the
canonical eight-coordinate index, publish immutable artifacts, and produce
packaging metadata that enables the Desktop runtime without weakening its
fail-closed defaults.

## Scope

The release chain owns:

- pinned upstream provenance for libvips, Poppler, FFmpeg and LibreOffice;
- the native `autoforge-image-converter` and `autoforge-pdf-raster` helpers;
- relocation, staging and capability inspection of each macOS pack;
- code-signing and notarization gates for downloaded executables;
- deterministic pack archives, canonical index generation and Ed25519 signing;
- immutable COS/CDN publication and post-publication read-back verification;
- production bootstrap generation and packaged-app verification;
- GitHub Actions orchestration for macOS arm64 and x64.

The release chain does not create Apple, GitHub, Tencent Cloud or DNS accounts,
does not mint a production signing root automatically, and does not publish
without explicit protected-environment credentials. Windows remains outside
the first-release matrix.

## Existing Contracts That Remain Authoritative

- Pack families are exactly `image-icon`, `document`, `pdf`, and `media`.
- Production coordinates are those four families for `darwin-arm64` and
  `darwin-x64`.
- Pack archives remain restricted deterministic USTAR files produced by
  `build-index.mjs`.
- The canonical index remains schema version 1 and is signed with Ed25519.
- Desktop fetches `index.json` and sibling `index.sig` over HTTPS and verifies
  every archive and expanded entry before installation.
- The checked-in `resources/converter-packs/bootstrap.json` remains disabled.
  Only release packaging may consume generated enabled metadata.
- Runtime adapters continue to invoke fixed absolute executable paths with
  fixed arguments and never search host `PATH`.

## Architecture

### 1. Source lock and build inputs

`apps/desktop/converter-packs/sources.lock.json` is canonical JSON. It records
the upstream version, license expression, source URL and SHA-256 for every
redistributed engine. Binary acquisition records additionally identify the
per-target archive URL and SHA-256. Homebrew bottles are accepted only as
pinned, hash-verified build inputs; LibreOffice uses its per-architecture
upstream DMG. The release also retains the exact source archives needed to
satisfy source-availability obligations.

A source-lock module exposes one small interface: validate the whole lock and
return the exact target record. An acquisition module then performs bounded
HTTPS downloads, the anonymous GHCR bearer challenge, hash verification and
immutable caching. It does not extract upstream archives.

### 2. Native helpers

The image helper is a native command-line program linked to the staged libvips
closure. It implements only the existing `convert`, `create-icon`, and
`extract-icon` commands. ICO and ICNS containers are assembled and parsed by
the helper; pixel decoding, resize and encoding remain behind libvips.

The PDF helper is a native command-line program that validates the existing
`raster` command and delegates only to the pack-owned Poppler raster executable
through an absolute sibling path. The Poppler child is declared and signed as
an allowed pack executable. Output names are normalized to the adapter's
zero-padded contract before the helper exits successfully.

Both helpers reject unknown flags, duplicate flags, missing values, paths
outside the supplied input/output contract, and unsupported formats. Neither
uses a shell.

### 3. Staging and relocation

Each architecture job emits one normalized staging root:

```text
release-input/
  release.json
  packs/
    <family>-<platform>-<arch>/
      pack.json
      payload/
```

Under the locked Homebrew revisions, staging installs the verified bottles;
LibreOffice is mounted from its verified DMG read-only. Homebrew bottles may
contain their normal Cellar symlinks, so the staging module dereferences inputs
while copying and then rejects every symlink or multiply-linked file in its
output. It copies only the transitive Mach-O dependency closure needed by
declared executables, rewrites Homebrew absolute install names to
`@loader_path`-relative paths, copies required data directories and license
files, and rejects unresolved non-system dependencies. LibreOffice retains its
internal application layout under the pack's `program/` seam.

Every staged executable is inspected with `file`, `lipo`, `otool`, and its own
capability command. Advertised catalog routes are compared with the observed
formats/codecs. The module fails rather than silently producing a partial pack.

### 4. Signing and notarization

Mach-O files are signed inside-out with hardened runtime and a Developer ID
Application identity supplied by the protected release environment. The chain
validates signatures with `codesign --verify --strict --deep` and submits the
signed payload bundle to Apple's notary service. A release cannot advance
without accepted notarization and Gatekeeper assessment evidence for both
architectures.

The Ed25519 private key is materialized with mode `0600` only inside the
protected index-signing job, used by the existing signer, and removed by the
ephemeral runner. The repository contains only the corresponding public key.

### 5. Publication

Archives and release-specific metadata are uploaded to immutable COS object
keys first. The publisher reads every object back and compares SHA-256 and
length. Only after all objects pass does it replace the stable `index.json`
and `index.sig`. Because Desktop verifies sequence numbers and signatures, a
failed or interrupted publication leaves the last complete release usable.

The publisher accepts credentials only from environment variables or a
short-lived token provider. It never writes credentials into the release tree,
logs, index or bootstrap.

### 6. Desktop release metadata

A bootstrap generator accepts an HTTPS stable index URL and an Ed25519 public
key, emits canonical `bootstrap.json` plus `root-public-key.pem`, and refuses
the checked-in fail-closed resource directory as its output. Release packaging
uses that generated directory through an explicit production builder config.
Normal development and unsigned packaging continue to include the disabled
bootstrap and no root key.

### 7. CI orchestration

GitHub Actions uses native macOS runners for arm64 and Intel x64. Architecture
jobs validate source hashes, build helpers, stage packs, run real conversion
fixtures, sign/notarize, and upload workflow artifacts. A protected production
job downloads both artifacts, proves the exact eight-coordinate inventory,
builds and signs the index, publishes to COS/CDN, performs HTTPS read-back, and
emits provenance/SBOM artifacts.

Pull requests run source-lock, helper, staging and release-tool tests without
production credentials. Manual production dispatch requires an explicit
sequence and version and cannot fall back to test keys or fixture URLs.

## Failure Model

- Missing source, hash mismatch or a redirect terminating without HTTPS: stop
  before installation or mounting.
- Unsupported engine capability: stop before staging.
- Unresolved or wrong-architecture Mach-O dependency: stop before signing.
- Missing license/source evidence: stop before index generation.
- Missing Apple or Ed25519 credentials: stop before publication.
- Any upload/read-back mismatch: do not update stable metadata.
- Invalid production bootstrap or absent public key: packaged Desktop remains
  fail-closed with `CONVERSION_COMPONENT_UNAVAILABLE`.

## Verification

Acceptance requires:

1. source-lock parser and downloader tests with real bytes and malicious layout
   fixtures;
2. helper argument/container tests plus real image and multipage PDF runs;
3. staging tests for dependency closure, relocation, architecture and licenses;
4. existing pack build/sign/verify suites in production mode with eight packs;
5. publication tests against a filesystem-backed object-store adapter proving
   immutable-first ordering and rollback behavior;
6. production bootstrap and packaged-app tests proving enabled releases include
   only the production public key while ordinary builds remain disabled;
7. GitHub workflow validation and a credential-free dry run;
8. release-environment runs on both macOS architectures followed by real
   JPG-to-PNG, DOCX-to-PDF, PDF-to-PNG and MP4-to-WebM smoke tests.
