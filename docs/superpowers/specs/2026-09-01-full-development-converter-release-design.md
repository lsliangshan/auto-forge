# Full Development Converter Release Design

**Date:** 2026-09-01
**Status:** Approved in conversation

## Goal

Make macOS development builds support every conversion direction already
declared by the AutoForge conversion catalog. A clean `pnpm dev` must prepare
all four converter pack families from pinned upstream artifacts, while later
starts reuse a verified cache. This work does not add new source or target
formats.

## Scope

The change owns:

- preparation of development releases for `darwin-arm64` and `darwin-x64`;
- verified acquisition and caching of the four engines in
  `converter-packs/sources.lock.json`;
- reuse of the existing native-helper, staging, capability-probe, index and
  signature contracts;
- activation of the `image-icon`, `document`, `pdf`, and `media` adapters in
  the development runtime;
- precise, safe conversion errors returned by the universal converter
  workflow;
- automated tests and real headless conversion smoke tests.

The change does not add Windows development support, new conversion formats,
new workflow permissions, production credentials, or a fallback to converter
executables discovered on the host `PATH`.

## Existing Contracts That Remain Authoritative

- Pack families remain exactly `image-icon`, `document`, `pdf`, and `media`.
- The source lock remains the authority for engine versions, source URLs,
  runtime acquisition URLs, licenses, and SHA-256 values.
- Pack index schema version 1, deterministic restricted USTAR archives, Ed25519
  signatures, fixed executable inventories, and runtime lease verification do
  not change.
- Runtime adapters invoke only fixed absolute executable paths declared by a
  verified pack.
- The checked-in production bootstrap remains fail-closed. Development signing
  material must never become a production trust root.
- The conversion catalog remains the authority for supported directions.

## Architecture

### 1. Development release preparation

A development-release orchestrator replaces the current image-only preparation
script. On a cache miss it performs the following stages for the current target:

1. load and validate `sources.lock.json`;
2. acquire the pinned source and runtime archives through the existing bounded,
   hash-verifying acquisition module;
3. build the current-architecture native helpers;
4. prepare and stage all four pack families through the existing production
   staging modules;
5. run the existing family capability probes;
6. build the deterministic pack index in test mode;
7. sign the index with the development-only Ed25519 key;
8. materialize and verify installed pack coordinates for all four families.

The orchestrator coordinates existing modules rather than duplicating their
download, extraction, relocation, probe, archive, or verification logic.
Production signing, notarization, publication, and bootstrap generation are not
part of development preparation.

### 2. Immutable cache and active release

Development cache state is divided into:

```text
node_modules/.cache/autoforge-converter-packs/
  sources/<sha256>.archive
  releases/<fingerprint>/
    index.json
    index.sig
    root-public-key.pem
    installed/...
  active-release.json
```

The release fingerprint includes the canonical source lock, target platform and
architecture, native-helper sources, and every preparation module whose output
affects a pack. A matching release is reused only after its index, signature,
installed entries, executable inventories, and all four coordinates have been
verified.

Preparation occurs in a private sibling temporary directory. Only a completely
verified release is renamed into its immutable fingerprint directory. The
canonical `active-release.json` marker is then replaced atomically. The marker
contains only the selected fingerprint. `dev.mjs` resolves the marker to a
canonical absolute release directory and supplies that value through
`AUTOFORGE_DEV_CONVERTER_RELEASE_ROOT`.

An incomplete preparation never changes the active marker. Old derived releases
may be removed before Electron starts, but verified source archives remain
content-addressed. A corrupted derived release is rebuilt. A cached upstream
archive whose bytes do not match its locked hash causes an actionable failure;
it is never trusted or silently overwritten.

### 3. Development runtime

The local development runtime continues loading a signed, canonical release and
using `ConverterPackManager`. Its adapter list becomes the same four-family
mapping used by the production conversion runtime:

- image and icon routes use `image-icon`;
- office-document routes use `document`;
- PDF raster routes use `pdf`;
- audio and video routes use `media`.

The image-only `sips` adapter and release are removed from the default
development path. There is no partial fallback: if any required family cannot
be prepared or verified, `pnpm dev` exits before Electron starts.

### 4. Data flow

```text
sources.lock.json
  -> verified immutable source cache
  -> helper build + four-family staging + capability probes
  -> deterministic development index + development signature
  -> verified immutable release directory
  -> atomic active-release marker
  -> AUTOFORGE_DEV_CONVERTER_RELEASE_ROOT
  -> local runtime / ConverterPackManager
  -> fixed adapter and pack executable
```

User files enter only after application startup through the existing managed
conversion-artifact service. They are not inputs to release preparation or
cache fingerprinting.

## Failure Handling

The preparation command reports which boundary failed: source download, hash
verification, native toolchain, staging, capability probing, signing, cache
verification, or active-marker resolution. It does not log private keys,
environment credentials, user paths, or user-file contents.

`pnpm dev` stops on preparation failure and retains the previous active release
marker for diagnosis or rollback. It does not start with a stale release while
claiming the new preparation succeeded.

The universal converter workflow preserves known `CONVERSION_*` error codes
using canonical safe messages. Unknown thrown values still collapse to
`CONVERSION_COMPONENT_UNAVAILABLE`; raw exception messages never cross the
workflow boundary.

## Security

- Downloads use only the HTTPS URLs declared by the canonical source lock and
  must match the locked SHA-256 before use.
- Converter engines are never discovered from `PATH`.
- All build and runtime subprocesses use fixed executable paths and argument
  arrays without a shell.
- Development signing material is fixed test-only material and is accepted only
  by a development runtime explicitly selected while `app.isPackaged` is false.
- Installed pack entries remain regular, non-symbolic, hash-verified files
  within the managed release root.
- A packaged application continues selecting the production factory regardless
  of development environment variables.

## Verification

Automated tests must prove:

1. a cold cache produces an index and installed coordinates for all four pack
   families;
2. an unchanged fingerprint reuses the verified release without downloading or
   rebuilding;
3. source-lock, helper-source, target, or preparation-module changes produce a
   different fingerprint;
4. partial preparation cannot replace the active marker;
5. derived-cache corruption rebuilds, while locked-archive hash mismatch fails
   closed;
6. the development runtime selects `document` for DOC/DOCX and CSV routes,
   `pdf` for PDF raster routes, `image-icon` for image/icon routes, and `media`
   for audio/video routes;
7. packaged applications never select the development release;
8. known conversion failures retain their safe error codes and unknown errors
   are redacted.

Current-architecture headless smoke tests must exercise representative real
conversions:

- DOC and DOCX to PDF;
- CSV to XLSX;
- PDF to PNG and JPEG;
- image transcoding, image to PDF, ICO, and ICNS;
- audio transcoding, video transcoding, and video audio extraction.

Smoke tests verify magic bytes, probed format, output count, and any ordered
multi-output naming contract. The catalog route suite remains responsible for
covering every declared direction; the real-engine suite uses representative
fixtures per family rather than duplicating every format pair.

## Acceptance Criteria

- A clean macOS development checkout can run one preparation command through
  `pnpm dev` and obtain all four verified pack families without installing
  converter engines manually.
- A second unchanged invocation performs no engine download or pack rebuild.
- Every currently declared catalog direction reaches the correct development
  adapter and pack.
- Representative real conversions for all four families pass headlessly.
- Existing production release, bootstrap, runtime, workflow, and conversion
  tests remain green.
