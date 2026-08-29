# Task 13 report — signed converter packs and real-engine fixtures

## Outcome and scope

- Worktree: `/Users/liangshan/Downloads/workspace/workspace_qisi/auto-forge/.worktrees/universal-file-converter`
- Base: `2d6d8972b700678e347479ce7f73bc90c2ff7f10`
- Task 13 local implementation is complete. Task 14 was not started.
- The production converter download bootstrap remains fail-closed: `downloadsEnabled` is `false`, and both `indexUrl` and `rootPublicKeyFile` are `null`.
- Task 12's release order is unchanged: deploy the v1-safe/v2 Cloud SQL and handler reader-first, then prove PostgreSQL locking, RLS, purge, receipt, and cross-device convergence before enabling Desktop v2 writers.

## TDD evidence

The first acceptance/tooling/build-config run was intentionally RED: **11 failed, 2 passed, 11 skipped**. Missing scripts and bootstrap resources failed, while the real-engine matrix stated an explicit external gate when `AUTOFORGE_TEST_CONVERTER_PACK_ROOT` was absent. With a signed local bundle, real-matrix checkpoints progressed from **11 failed**, to **7 failed**, to **1 failed**. The final failure was real LibreOffice XLSX output using ZIP data descriptors; its focused catalog regression was captured at **1 failed / 51 skipped** before the smallest structural-parser fix.

Further adversarial RED checkpoints were recorded before each corresponding fix:

- Real 16 kHz FFmpeg MP3 output: **1 failed / 10 skipped**; focused MPEG-2 Layer III regression: **1 failed, 1 passed / 51 skipped**.
- Signed archive/entry limit validation: **1 failed / 11 skipped**.
- Symlinked parent path rejection: **1 failed / 11 skipped**.
- HTTPS archive URL containing a control character: **1 failed / 11 skipped**.

Final GREEN evidence:

- Task 3/4/5 adjacency, build configuration, tooling, and real engines: **12 files, 207/207 tests passed**.
- Signed real-engine matrix alone: **11/11 passed**.
- Missing `AUTOFORGE_TEST_CONVERTER_PACK_ROOT`: **1 suite and 11 tests explicitly skipped** with the external-gate contract.
- Invalid Ed25519 signature with a sentinel-only `PATH`: suite failed in `verifyConverterPackIndex` before converter acquisition; **11 tests skipped and `PATH_FALLBACK=absent`**.
- Tooling/build configuration alone: **15/15 passed** before the final combined run; current script syntax checks pass.
- Scoped strict TypeScript and scoped ESLint pass. Full desktop typecheck still reports only the two recorded unrelated baselines: `cloud-user-data-sync-main.ts` lacks `capturePageScreenshot`, and `browser-visual-evidence-resolver.ts` lacks provider-stream `purpose`.
- `pnpm build` passed. `pnpm --filter @autoforge/desktop dist:dir` passed, including native Electron ABI verification and converter package-boundary verification.
- `git diff --check` passed.

## Exact local acceptance matrix

The opt-in integration suite uses Task 4's signed-index and installed-tree verification, obtains only absolute lease executables, and executes them with Task 5's fixed adapters and real process runner. It verifies content rather than extensions:

- transparent 40x20 PNG to default ICO, favicon ICO, and ICNS; then every ICO/ICNS representation back to PNG with exact sizes and transparent corner pixels;
- two-frame animated WebP to two-frame GIF, two-frame H.264 MP4, and one first-frame PNG with truthful metadata;
- self-created DOCX, XLSX, PPTX, and CSV to readable one-page PDFs; CSV to structurally valid XLSX;
- three-page PDF to three PNGs and three JPEGs with page metadata and decoded dimensions;
- WAV to MP3, WAV, M4A, AAC, FLAC, Ogg Vorbis, and Opus with exact containers/codecs and stripped title/artist/comment metadata;
- MP4 to H.264/AAC MP4, VP9/Opus WebM, H.264/AAC MOV, 12-frame GIF, and audio-only MP3, including stream, frame, dimension, duration, and metadata assertions.

The real outputs exposed two compatibility gaps now covered by focused catalog tests: LibreOffice ZIP data descriptors are accepted only with matching central/local flags, CRC, sizes, and contiguous records; MPEG-1, MPEG-2, and MPEG-2.5 Layer III frame parameters are validated with version-correct bitrate, sample-rate, and frame-length tables.

## Fixture provenance and licenses

The ignored local bundle lives under `.test-artifacts/converter-packs`, outside production `out/**`. Its source shapes, text, tables, slides, tones, and color frames are self-created and dedicated under CC0 1.0; no user content or third-party corpus is present. Fixture generators were Pillow 12.3.0, python-docx 1.2.0, openpyxl 3.1.5, python-pptx 1.0.2, ReportLab, and FFmpeg 7.1.1.

The signed local Darwin arm64 fixture packs exercise explicitly pinned absolute installations, never system `PATH`: ImageMagick 7.1.1-47, LibreOfficeDev 26.8.0.0.alpha0, Poppler 25.06.0, and FFmpeg/FFprobe 7.1.1. Their signed trees contain the corresponding ImageMagick license, LibreOffice MPL 2.0 legal notice, Poppler GPL v2 notice, and FFmpeg license notice. The local wrapper packs depend on these recorded installations and are not redistributable production packs or cross-platform acceptance evidence.

## Pack supply-chain and packaging proof

- `build-index.mjs` accepts only canonical absolute, non-symlinked staging paths with exact manifests, four known pack families, three approved OS/architecture targets, exact executable allowlists, regular payload files, exact 0755/0644 modes, nonempty declared licenses, HTTPS archive URLs, safe portable names, runtime-equivalent size caps, and deterministic ordering.
- Restricted USTAR output has fixed owner, time, mode, header, padding, entry order, and terminators. A fresh four-pack rebuild and Ed25519 resign were byte-identical to the first build.
- `sign-index.mjs` requires an explicit canonical absolute private-key path, rejects symlinks and loose Unix permissions, accepts only Ed25519, signs only canonical index bytes, and neither copies nor logs the key/path.
- `verify-converter-packs.mjs` verifies canonical index bytes, detached Ed25519 signature, exact release contents, archive name/size/hash, restricted USTAR headers, entry modes/sizes/hashes, licenses, executable allowlists, and safe paths. Correctly rehashed and resigned unsafe archives still fail.
- The effective electron-builder FileMatcher contains only `bootstrap.json`, `index.schema.json`, and optional future `root-public-key.pem`. No production root is present in this build. The actual macOS package contains only the first two converter resources.
- The actual `app.asar` list contained **23,348 entries** and no converter trust material, test root, private key, pack TAR/signature, or known engine executable. A physical Resources scan also found none. Native packaged probes passed under Electron 43.1.1.
- Developer ID signing completed locally; electron-builder explicitly skipped notarization because notarize options were unavailable. This is local packaging evidence, not formal release acceptance.

## Deterministic local release SHA-256

```text
61d8dc748af3179c8f159e9343e897a52b17db7384fe8829f20f6417b09b3c06  index.json
f45f659ce83c7ab6a43451b65602e22cd0785ba26d0bb403b0c78a3e7faf574a  index.sig
0f0dbca9793b164bfd76ee972e7b96ba7d388e1c4e0189a2cc894f26e1de4485  document-1.0.0-darwin-arm64.tar
327c125458e31778b44bfa21c087bde559af95d4dcfe36a0a6958351545ac3c9  image-icon-1.0.0-darwin-arm64.tar
e6ffa64913531323512654b9df062f1d97db3963d22bdb35c9328356001bd687  media-1.0.0-darwin-arm64.tar
11d8a29faf1401300eb72614eb16f6c68150c6b77e5c08f8b152f0a0eb96a43b  pdf-1.0.0-darwin-arm64.tar
```

## Implementation files and SHA-256

```text
09a3c99d26d3acbfdfeba85d2d73ca67ef80b5178ff1fc0c611ef0fb32df5e19  .gitignore
2a588d8e3a8dc68aeb718ad1394492bbab2b3d4c60f7e478078e8c7bb20adba3  apps/desktop/electron-builder.yml
698711e1c25c851eb58a6e3e1360a9c9e215d5c2cff3996cd46ac1d8877778a2  apps/desktop/package.json
e0f9fcb828bd08e545cadee068cdf00cf058ed7cd7c9f4cbb2f2b6e4cec16a77  apps/desktop/electron/main/build-config.test.ts
95e2e53f059fe863ca804b02d3445e8be2b10dd9173c92437e0fab8b55ba8872  apps/desktop/electron/main/conversion/conversion-catalog.ts
6032b63155dc57f345d7c5d439584fb2d7b4f86085c66a5af472ec4c8ba00271  apps/desktop/electron/main/conversion/conversion-catalog.test.ts
9ec1528127fcd2d256d16996817325a1cbd23ca145656abc82fd9a3a01a049aa  apps/desktop/resources/converter-packs/bootstrap.json
a0ccd907842113889cce510900f158d3095674241bcafeb56a7a8e29f09414a2  apps/desktop/resources/converter-packs/index.schema.json
a5f55fc7861ea27fb37c2143dc2e28f12d4ab1c19314d4977a70c3e5b6d35ed5  apps/desktop/scripts/converter-packs/build-index.mjs
da8609b0d3d0fa92b9c12b96bbf4c79d1e496488b0dd8cc355fa2c11fb6669bf  apps/desktop/scripts/converter-packs/pack-tooling-lib.mjs
4acff6f030e0e95a0de44a229800b190fc34a24011ae5cc13e3db77f912d7231  apps/desktop/scripts/converter-packs/sign-index.mjs
545a06edaac977ff85f1568f3f1c6400832f598012b7db828dc60a9462821cf8  apps/desktop/scripts/verify-converter-packs.mjs
30ae2a486bede69e34a43f8b76c7444481e2ca67b2b2ddc003d2434465735631  apps/desktop/tests/fixtures/conversion/README.md
5a5fbf8de95bedc84ee66d0bede319257db765e2ebe5f3b59d1a41a10cbbcb80  apps/desktop/tests/integration/conversion-engines.test.ts
43c192e947ae1e95d9d2fc5f1daab3c2f166123aa1051427d3bd8eac5df9010a  apps/desktop/tests/integration/converter-pack-tooling.test.ts
```

## External release gates

Local signed-fixture GREEN does not authorize production distribution. Release remains blocked until release engineering provides and independently verifies all of the following:

1. the production Ed25519 root public key and an approved key-rotation/recovery procedure;
2. the production HTTPS CDN and pinned signed canonical index;
3. all four signed pack families for macOS arm64, macOS x64, and Windows x64;
4. complete redistributable third-party license, notice, source-offer, and provenance material for every shipped engine and dependency;
5. real conversion-matrix runs on all three targets, plus platform signing, macOS notarization, packaged-content, privacy, and update/rollback acceptance.

If any item is absent, the production root remains unpinned and converter pack download remains disabled.
