# Production converter packs

The checked-in schema-v2 `sources.lock.json` and the authenticated
`closures/darwin-arm64.lock.json` and `closures/darwin-x64.lock.json` are one
indivisible authority for redistributed libvips, Poppler, FFmpeg, and
LibreOffice inputs. Production jobs verify that authority, acquire the exact
selected target closure, and materialize it once before creating a staging
plan. Cache keys authenticate all three files.

The current checked-in production source lock is still schema v1 and has no
authenticated closure coordinates. Consequently, the safe no-argument
`converter-packs:verify-sources` command intentionally fails until replacement
schema-v2 locks have passed manual review and all three files are committed
together. Suppressing that failure or hand-editing placeholder coordinates is
not an acceptable migration.

## Lock maintenance and resource budgets

Only `.github/workflows/converter-pack-lock.yml` may call
`converter-packs:capture-lock-target` or `converter-packs:generate-lock`. A
maintainer dispatch pins the exact Homebrew core and cask revisions, captures
both architectures, and emits the three candidate locks as one artifact.
Before committing them, manual review must confirm the provenance revisions,
both capture and probe hashes, canonical ordering, exact URLs, byte counts,
SHA-256 values, licenses, and the complete target closures. Check, release, and
development workflows only consume reviewed locks; they never generate them.

Cold preparation enforces a 1.8 GB download ceiling and a 10 GiB free-space
requirement before acquisition. Safe pruning enforces a 5 GiB blob-cache limit
and retains the active release plus one previous release. An ordinary
preparation, including production staging and `pnpm dev`, never reads host
Homebrew metadata or uses Homebrew-installed formula bytes. Homebrew resolution
is isolated to the maintainer lock workflow.

`converter-packs:stage` accepts one canonical JSON plan through `--plan`. The
plan contains these exact top-level fields:

- `target`: `darwin-arm64` or `darwin-x64`;
- `output`: a new absolute `release-input` directory;
- `version`, `sequence`, `generatedAt`, and an HTTPS `archiveBaseUrl`;
- `families`: exactly `image-icon`, `document`, `pdf`, and `media`.

Each family declares the exact executable sources and destinations enforced by
the pack validator, plus an explicit list of regular-file data and license
assets. Paths in this local plan are build inputs only; they are never written
to the signed index. Every redistributed dependency license must be listed.

Staging recursively inspects each Mach-O entrypoint with absolute Apple tool
paths, excludes only `/usr/lib` and `/System/Library`, rejects architecture and
basename collisions, copies the complete closure, rewrites it to
`@loader_path`, and rescans the result. It then starts every executable and
checks the image/media capability sets used by the runtime adapters. Because
`install_name_tool` invalidates Apple Silicon signatures, staging applies an
explicit temporary ad-hoc signature inside-out before these probes. The
protected release step must replace it with the required Developer ID identity
and rejects ad-hoc signatures as final evidence. A failed probe removes the
newly-created staging directory.

Typical protected-job order:

1. `converter-packs:verify-sources`
2. `converter-packs:acquire`
3. `converter-packs:build-native`
4. `converter-packs:prepare-staging` to extract the verified bottles, select
   source-license notices, and generate the canonical staging plan
5. `converter-packs:stage --plan <absolute-plan-path>`
6. sign/notarize the staged payloads before building and publishing the index

The document pack deliberately does not expand the LibreOffice application
bundle into the pack protocol. The locked application contains far more files
and expanded bytes than the bounded archive contract permits. Instead the
pack carries the hash-verified DMG as one data entry and a signed native
`program/soffice` launcher. The launcher mounts that pack-local image read-only
at a unique private mount point, forwards the fixed adapter arguments to the
contained `soffice`, and always detaches it before returning.

The COS publisher invokes one absolute COSCLI binary with `cp`,
`--forbid-overwrite` for immutable objects, and a private external
`--config-path`. COSCLI's official contract is config-file based, so protected
CI must materialize that file outside the release tree with mode `0600`, use a
short-lived token, and remove it in an always-run cleanup step. The adapter
disables COSCLI logs, redacts command failures, downloads every object for hash
verification, and promotes stable metadata only after immutable read-back.

The repository bootstrap remains disabled. Development packaging must not use
production plans, signing identities, cloud credentials, or private keys.
