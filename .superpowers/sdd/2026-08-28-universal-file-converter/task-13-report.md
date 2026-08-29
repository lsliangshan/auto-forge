# Task 13 report — signed converter packs and real-engine fixtures

## Outcome and scope

- Worktree: `/Users/liangshan/Downloads/workspace/workspace_qisi/auto-forge/.worktrees/universal-file-converter`
- Base: `2d6d8972b700678e347479ce7f73bc90c2ff7f10`
- Task 13 and Important-finding fix round 1 are implemented. Task 14 was not started.
- Production remains fail-closed: `downloadsEnabled=false`, `indexUrl=null`, `rootPublicKeyFile=null`.
- Task 12 remains reader-first: deploy the v1-safe/v2 Cloud SQL and handler before Desktop v2 writers, then prove PostgreSQL locking, RLS, purge, receipts, and cross-device convergence.

## TDD evidence

Original Task 13 RED evidence began at **11 failed, 2 passed, 11 skipped**. The real-engine matrix then progressed from **11 failed**, to **7 failed**, to **1 failed** before reaching GREEN; focused catalog REDs covered LibreOffice ZIP data descriptors and MPEG-2/2.5 Layer III probing.

Fix round 1 added acceptance/tooling/build-config tests before implementation:

- strengthened real matrix against the old fixtures: **2 failed, 9 passed**; the WAV and MP4 metadata-sentinel preconditions were genuinely absent;
- positive packaging allowlist: **1 failed, 2 skipped**;
- tooling, packaged-boundary, locale, hardlink/swap, production inventory, and runtime role checks: **20 failed, 36 passed** across 56 tests.

Final GREEN evidence:

- strengthened signed real-engine matrix: **11/11 passed**;
- absent fixture root: **1 suite / 11 tests explicitly skipped** with the external-gate message;
- invalid signed root plus sentinel-only `PATH`: failed in `verifyConverterPackIndex` with `index_invalid`, **11 tests skipped**, and the fallback sentinel remained absent;
- Task 4/5 adjacency plus tooling/build configuration: **9 files / 133 tests passed**;
- final signed-index runtime verifier: **35/35 passed**;
- final runtime/tooling/build-configuration gate: **56/56 passed**; this includes hardlink coverage for release metadata, pack manifests, executable payloads, and licenses, plus the complete launchable/code extension table;
- scoped ESLint passed; `pnpm build` passed;
- full `pnpm typecheck` remains blocked only by two unrelated baselines: `cloud-user-data-sync-main.ts` lacks `capturePageScreenshot`, and `browser-visual-evidence-resolver.ts` lacks provider-stream `purpose`;
- `pnpm dist:dir` passed, including Electron 43.1.1 native ABI loading and the actual packaged converter boundary verifier;
- actual Darwin arm64 `app.asar` and Resources were inspected, and exact canonical metadata byte comparisons passed;
- `git diff --check` passed.

## Exact local acceptance matrix

The opt-in suite loads Task 4's Ed25519-signed test index, resolves only exact installed-tree lease paths, and runs Task 5's real adapters/process runner. It asserts content, not extensions or mere existence:

- transparent 40x20 PNG to default ICO, favicon ICO, and ICNS; every ICO directory entry and ICNS chunk is bounds-checked, dimension-checked, structurally probed, and extracted to transparent PNG;
- animated two-frame WebP to two-frame GIF, two-frame H.264 MP4, and first-frame PNG;
- DOCX/XLSX/PPTX/CSV to readable one-page PDF; CSV to structurally valid XLSX;
- three-page PDF to three PNGs and three JPEGs with decoded dimensions and page metadata;
- WAV to MP3/WAV/M4A/AAC/FLAC/Ogg Vorbis/Opus with canonical `ffprobe` format names, one exact audio stream/codec, and stripped metadata;
- MP4 to MP4/WebM/MOV/GIF/MP3 with stable magic where defined, canonical format name, exact ordered stream types/codecs, dimensions, 12 decoded frames where video remains, and no retained chapter or sentinel metadata.

The WAV input has unique title/artist/comment sentinels. The MP4 input has unique title/artist/comment, video/audio handler names, and a chapter title; the chapter's MP4 data track is also asserted as an input precondition. Every output proves that all `AUTOFORGE_*` values and chapters were removed.

## Fixture provenance and licenses

The ignored local bundle is `.test-artifacts/converter-packs-fix1`; it is outside production `out/**` and is not committed or packaged. Inputs are self-created shapes, text, tables, slides, tones, and color frames under CC0 1.0. No user content or third-party corpus is present. Generators recorded in `fixtures/PROVENANCE.md` are Pillow 12.3.0, python-docx 1.2.0, openpyxl 3.1.5, python-pptx 1.0.2, ReportLab, and FFmpeg 7.1.1. The WAV/MP4 sentinel variants were remuxed locally with the signed FFmpeg 7.1.1 fixture engine.

The local Darwin arm64 engines are ImageMagick 7.1.1-47, LibreOfficeDev 26.8.0.0.alpha0, Poppler 25.06.0, and FFmpeg/FFprobe 7.1.1. Their signed trees contain the corresponding ImageMagick notice, LibreOffice MPL 2.0 legal notice, Poppler GPL v2 notice, and FFmpeg license notice. These local wrappers are neither redistributable production packs nor cross-platform acceptance.

## Pack supply-chain and packaging proof

- `--mode production` is the default for build, sign, and verify. It requires exactly 12 unique coordinates: four pack families times Darwin arm64, Darwin x64, and Windows x64. No extras or duplicates are accepted. Fixture subsets require explicit `--mode test`.
- Staging uses an explicit file inventory with signed `executable`, `code`, `license`, or `data` roles. Executable identity must match the exact family/platform allowlist. `.exe`, `.com`, `.cmd`, `.bat`, `.ps1`, `.scr`, `.msi`, `.dll`, native/script/library extensions, shebang, MZ, ELF, and Mach-O signatures are classified; unclassified or disguised code fails.
- All release inputs are canonical absolute paths. Release/pack JSON, payloads, licenses, executables, private/public keys, indexes, signatures, archives, ASAR, and pinned packaged metadata are opened with no-follow handles, require `nlink=1`, and verify `dev`, `ino`, and `size` before/after reads. Hardlink and path-swap attacks are covered.
- All sorting that affects signed bytes uses UTF-8 `Buffer.compare`; `en_US.UTF-8` and `tr_TR.UTF-8` builds produce byte-identical indexes and archives.
- Darwin sources require 0755 only for executables and 0644 otherwise; Windows pack sources and deterministic archive metadata are 0644 for non-Darwin execution semantics. Windows drive-relative/rooted/device paths fail, while canonical drive and UNC forms are recognized by the platform-aware validator. No Windows or Darwin x64 execution was fabricated.
- The private key is supplied only by explicit absolute path, must be Ed25519 with restrictive Unix permissions, is never copied or logged, and repeated signing of identical canonical bytes is deterministic.
- electron-builder now uses a positive `out` allowlist plus source-map and test/e2e/stale exclusions. Only exact canonical `bootstrap.json` and `index.schema.json` are packaged; the optional future root public key is absent while the kill switch is off.
- The ASAR verifier reads every packed file payload and physical Resources recursively. It rejects converter engines, archives, signatures, private/trust material, test/e2e/stale paths, symlinks/hardlinks, and PEM/OpenSSH private-key content regardless of filename.
- Actual `dist:dir` evidence: Darwin arm64 `app.asar` had **23,161 entries**; required main/preload/renderer/worker/package files were present; forbidden path/content scans were empty; packaged bootstrap/schema matched the pinned canonical bytes exactly. Developer ID signing completed; notarization was explicitly skipped because notarize options were unavailable.

## Deferred Minors (per ruling)

The following six Minor findings remain deliberately deferred and were not folded into this fix round:

1. exact PDF output enumeration;
2. hashed fixture provenance manifest;
3. missing-root gate text under the default reporter;
4. exactly two USTAR terminators rather than the current minimum-two rule;
5. preflight/stream archive verification;
6. WAV duration assertion.

## Deterministic local test release SHA-256

```text
9cd253b66faa6bc83a5242c0ec5d57e1ea1d4088eb151922381f3bf460e8324a  index.json
502de3a17c4206a33be882d83886e6d6d248d10359770153858cfd16e30b720c  index.sig
0f0dbca9793b164bfd76ee972e7b96ba7d388e1c4e0189a2cc894f26e1de4485  document-1.0.0-darwin-arm64.tar
327c125458e31778b44bfa21c087bde559af95d4dcfe36a0a6958351545ac3c9  image-icon-1.0.0-darwin-arm64.tar
e6ffa64913531323512654b9df062f1d97db3963d22bdb35c9328356001bd687  media-1.0.0-darwin-arm64.tar
11d8a29faf1401300eb72614eb16f6c68150c6b77e5c08f8b152f0a0eb96a43b  pdf-1.0.0-darwin-arm64.tar
```

## Implementation files and SHA-256

```text
09a3c99d26d3acbfdfeba85d2d73ca67ef80b5178ff1fc0c611ef0fb32df5e19  .gitignore
4a7c8e762acc1b86872a4deab21f0b416f40d4efd9b37053e2d3db3dcf40a150  apps/desktop/electron-builder.yml
698711e1c25c851eb58a6e3e1360a9c9e215d5c2cff3996cd46ac1d8877778a2  apps/desktop/package.json
77d08033f83b10d2813941bab4da65ee2f72954cc1e04b5e8aefe7a3629e3a2b  apps/desktop/electron/main/build-config.test.ts
95e2e53f059fe863ca804b02d3445e8be2b10dd9173c92437e0fab8b55ba8872  apps/desktop/electron/main/conversion/conversion-catalog.ts
6032b63155dc57f345d7c5d439584fb2d7b4f86085c66a5af472ec4c8ba00271  apps/desktop/electron/main/conversion/conversion-catalog.test.ts
3aade14f8b59a38e709c337144eb3e9763b5e3bf75cc812ccc04ed997bb25527  apps/desktop/electron/main/conversion/converter-pack-manager.test.ts
a9fb3bc481dcd32998bad8a897711df490d05bf851c2c56ed17f93b3eb1fa214  apps/desktop/electron/main/conversion/converter-pack-types.ts
b205c3006195b01f951d73e366c41b4b68068bcac9a7a1633794a75ac6d63669  apps/desktop/electron/main/conversion/converter-pack-verifier.test.ts
86790bbbe7e67c42fbfd3bb020ff99bcd53dc7e6515dbd772a3b8cc925626e89  apps/desktop/electron/main/conversion/converter-pack-verifier.ts
58a244d069217058001e205ea563010de154f897d9c87572627854046e9362a0  apps/desktop/resources/converter-packs/bootstrap.json
c72112dcfc676041ff7201f72dde3bbf8b38027eb1fb86acc26b952d810275ac  apps/desktop/resources/converter-packs/index.schema.json
fd839c3bd921aa50f55484532dec72fd8eb3688510f8246f6d887ff16be9e65d  apps/desktop/scripts/converter-packs/build-index.mjs
b498e529400adb98ccb3121c62815f235dc06ac8769480473e169aa74f4ae010  apps/desktop/scripts/converter-packs/create-test-pack.mjs
63f57799d05fa0b9275f695347e1490246495f6a16a9abf72a87c96c8f4a909f  apps/desktop/scripts/converter-packs/pack-tooling-lib.mjs
b86723e1883fbc49bb4ac0debdde905098301684dc03e03743c8719f984c0e96  apps/desktop/scripts/converter-packs/sign-index.mjs
ba161ce5343de3cb2f533c73777330cc9c4dac2ba90a63315783a8e8b38e05d0  apps/desktop/scripts/verify-converter-packs.mjs
0515af3233416feb9b0d8131746e8825851f797c21fd63d8952feea3201bed5e  apps/desktop/tests/fixtures/conversion/README.md
b8f80ed072ca8aefa35ac581e9e0bb22346606733710841760776ffe4ab04633  apps/desktop/tests/integration/conversion-engines.test.ts
62cf13dd1863a8f02301a1059747180c5fef9e80805b34457697d9a961574a8d  apps/desktop/tests/integration/converter-pack-tooling.test.ts
```

## External release gates

Local signed-fixture GREEN does not authorize production distribution. Release remains blocked until release engineering supplies and independently verifies:

1. the production Ed25519 root public key and approved rotation/recovery procedure;
2. the production HTTPS CDN and pinned signed canonical index;
3. all four signed pack families for macOS arm64, macOS x64, and Windows x64;
4. complete redistributable third-party licenses, notices, source offers, and provenance for every engine/dependency;
5. real conversion-matrix runs on all three targets, platform signing, macOS notarization, packaged-content, privacy, update, and rollback acceptance.

If any item is absent, the production root stays unpinned and converter pack downloading stays disabled.
