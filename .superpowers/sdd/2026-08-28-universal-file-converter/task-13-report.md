# Task 13 report — signed converter packs and real-engine fixtures

## Outcome and scope

- Worktree: `/Users/liangshan/Downloads/workspace/workspace_qisi/auto-forge/.worktrees/universal-file-converter`
- Base: `2d6d8972b700678e347479ce7f73bc90c2ff7f10`
- Task 13 and Important-finding fix rounds 1–2 are implemented. Task 14 was not started.
- Production remains fail-closed: `downloadsEnabled=false`, `indexUrl=null`, `rootPublicKeyFile=null`.
- Task 12 remains reader-first: deploy the v1-safe/v2 Cloud SQL and handler before Desktop v2 writers, then prove PostgreSQL locking, RLS, purge, receipts, and cross-device convergence.

## TDD evidence

Original Task 13 RED evidence began at **11 failed, 2 passed, 11 skipped**. The real-engine matrix then progressed from **11 failed**, to **7 failed**, to **1 failed** before reaching GREEN; focused catalog REDs covered LibreOffice ZIP data descriptors and MPEG-2/2.5 Layer III probing.

Fix round 1 added acceptance/tooling/build-config tests before implementation:

- strengthened real matrix against the old fixtures: **2 failed, 9 passed**; the WAV and MP4 metadata-sentinel preconditions were genuinely absent;
- positive packaging allowlist: **1 failed, 2 skipped**;
- tooling, packaged-boundary, locale, hardlink/swap, production inventory, and runtime role checks: **20 failed, 36 passed** across 56 tests.

Fix round 2 again began with tests against the fix-round-1 implementation:

- catalog, adapter, runtime-role, native-package, and tooling coverage: **6 failed, 121 passed**; failures proved missing `ic11`–`ic14` probing, permissive ICO fields, incomplete active-extension classification, absent Windows-native structure selection, DER-key acceptance, and Resources-only package walking;
- the first signed real-engine rerun reached **10 passed, 1 failed** because the production WebM probe rejected FFmpeg's valid eight-byte TrackUID; the focused fixture was then hardened to reproduce that exact EBML width;
- an outside-package symlink regression was independently RED at **1 failed, 17 skipped** before standard Electron bundle links were constrained to in-package targets.

Final GREEN evidence:

- strengthened signed real-engine matrix: **11/11 passed**;
- absent fixture root: **1 suite / 11 tests explicitly skipped** with the external-gate message;
- invalid signed root plus sentinel-only `PATH`: failed in `verifyConverterPackIndex` with `index_invalid`, **11 tests skipped**, and the fallback sentinel remained absent;
- Task 4/5 adjacency plus tooling/build configuration: **11 files / 198 tests passed**;
- final signed-index runtime verifier: **35/35 passed**;
- final fix-round-2 catalog/adapter/runtime/tooling/native gate: **5 files / 127 tests passed**; this includes Win32 drive/UNC containment, source-mode independence, the reviewed active-content extension table, full-package traversal, DER private-key detection, and structural Win32 x64 native verification without simulated execution;
- scoped ESLint passed; `pnpm build` passed;
- full `pnpm typecheck` remains blocked only by two unrelated baselines: `cloud-user-data-sync-main.ts` lacks `capturePageScreenshot`, and `browser-visual-evidence-resolver.ts` lacks provider-stream `purpose`;
- `pnpm dist:dir` passed, including Electron 43.1.1 native ABI loading and the actual packaged converter boundary verifier;
- actual Darwin arm64 `app.asar` and the complete `.app` root were inspected, and exact canonical metadata byte comparisons passed;
- `git diff --check` passed.

## Exact local acceptance matrix

The opt-in suite loads Task 4's Ed25519-signed test index, resolves only exact installed-tree lease paths, and runs Task 5's real adapters/process runner. It asserts content, not extensions or mere existence:

- transparent 40x20 PNG to default ICO, favicon ICO, and ICNS; every ICO directory entry validates colorCount/reserved/planes/bitCount, offsets, bounds, and embedded dimensions; all ten scale-specific ICNS chunks retain type/logical-size/pixel-size/scale metadata and extract to distinct transparent PNG outputs;
- animated two-frame WebP to two-frame GIF, two-frame H.264 MP4, and first-frame PNG;
- DOCX/XLSX/PPTX/CSV to readable one-page PDF; CSV to structurally valid XLSX;
- three-page PDF to three PNGs and three JPEGs with decoded dimensions and page metadata;
- WAV to MP3/WAV/M4A/AAC/FLAC/Ogg Vorbis/Opus with canonical `ffprobe` format names, one exact audio stream/codec, and stripped metadata;
- MP4 to MP4/WebM/MOV/GIF/MP3 with stable magic where defined, canonical format name, exact ordered stream types/codecs, dimensions, 12 decoded frames where video remains, and no retained chapter or sentinel metadata. WebM acceptance parses EBML and requires the exact `webm` DocType; a Matroska DocType is a negative fixture even with compatible streams.

The WAV input has unique title/artist/comment sentinels. The MP4 input has unique title/artist/comment, video/audio handler names, and a chapter title; the chapter's MP4 data track is also asserted as an input precondition. Every output proves that all `AUTOFORGE_*` values and chapters were removed.

## Fixture provenance and licenses

The ignored local bundle is `.test-artifacts/converter-packs-fix1`; it is outside production `out/**` and is not committed or packaged. Inputs are self-created shapes, text, tables, slides, tones, and color frames under CC0 1.0. No user content or third-party corpus is present. Generators recorded in `fixtures/PROVENANCE.md` are Pillow 12.3.0, python-docx 1.2.0, openpyxl 3.1.5, python-pptx 1.0.2, ReportLab, and FFmpeg 7.1.1. The WAV/MP4 sentinel variants were remuxed locally with the signed FFmpeg 7.1.1 fixture engine.

The local Darwin arm64 engines are ImageMagick 7.1.1-47, LibreOfficeDev 26.8.0.0.alpha0, Poppler 25.06.0, and FFmpeg/FFprobe 7.1.1. Their signed trees contain the corresponding ImageMagick notice, LibreOffice MPL 2.0 legal notice, Poppler GPL v2 notice, and FFmpeg license notice. These local wrappers are neither redistributable production packs nor cross-platform acceptance.

## Pack supply-chain and packaging proof

- `--mode production` is the default for build, sign, and verify. It requires exactly 12 unique coordinates: four pack families times Darwin arm64, Darwin x64, and Windows x64. No extras or duplicates are accepted. Fixture subsets require explicit `--mode test`.
- Staging uses an explicit file inventory with signed `executable`, `code`, `license`, or `data` roles. Executable identity must match the exact family/platform allowlist. `.exe`, `.com`, `.cmd`, `.bat`, `.ps1`, `.scr`, `.msi`, `.dll`, `.hta`, `.vbs`, `.vbe`, `.js`, `.jse`, `.wsf`, `.wsh`, `.cpl`, `.lnk`, `.reg`, `.url`, native/script/library extensions, shebang, MZ, ELF, and Mach-O signatures are classified; unclassified or disguised code fails.
- All release inputs are canonical absolute paths. Release/pack JSON, payloads, licenses, executables, private/public keys, indexes, signatures, archives, ASAR, and pinned packaged metadata are opened with no-follow handles, require `nlink=1`, and verify `dev`, `ino`, and `size` before/after reads. Hardlink and path-swap attacks are covered.
- All sorting that affects signed bytes uses UTF-8 `Buffer.compare`; `en_US.UTF-8` and `tr_TR.UTF-8` builds produce byte-identical indexes and archives.
- Darwin sources require 0755 only for executables and 0644 otherwise. Windows source modes are not interpreted as Unix executable truth; the signed role and extension inventory remains mandatory. Windows drive-relative/rooted/device paths fail, canonical drive and UNC roots use `path.win32` containment, and the native/package verifiers select Darwin arm64/x64 or Win32 x64 structure. Cross-platform checks are explicitly structural; no Windows or Darwin x64 execution was fabricated.
- The private key is supplied only by explicit absolute path, must be Ed25519 with restrictive Unix permissions, is never copied or logged, and repeated signing of identical canonical bytes is deterministic.
- electron-builder now uses a positive `out` allowlist plus source-map and test/e2e/stale exclusions. Only exact canonical `bootstrap.json` and `index.schema.json` are packaged; the optional future root public key is absent while the kill switch is off.
- The package verifier reads every ASAR payload and walks the complete physical application root. It rejects converter engines/packs, archives, signatures, private/trust material, and test/e2e/stale paths wherever placed. Regular files require no-follow, `nlink=1`, and stable identity; standard Electron framework symlinks are not traversed and must resolve inside the package root. Bounded small-file scans reject PEM/OpenSSH text and parseable DER PKCS8/PKCS1/SEC1 private keys regardless of filename.
- Actual `dist:dir` evidence: Darwin arm64 `app.asar` had **23,161 entries**; required main/preload/renderer/worker/package files were present; forbidden path/content scans were empty; packaged bootstrap/schema matched the pinned canonical bytes exactly. Developer ID signing completed; notarization was explicitly skipped because notarize options were unavailable.

## Deferred Minors (per ruling)

The following seven Minor findings remain deliberately deferred and were not folded into this fix round:

1. exact PDF output enumeration;
2. hashed fixture provenance manifest;
3. missing-root gate text under the default reporter;
4. exactly two USTAR terminators rather than the current minimum-two rule;
5. preflight/stream archive verification;
6. WAV duration assertion.
7. Windows TAR executable entries retain the portable 0755 archive convention; no Windows execution evidence is inferred from that mode.

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
ca41057645ba32cdaa8975d5618562168c0acf394ff1d86373b5cf6230510270  apps/desktop/electron/main/conversion/conversion-catalog.ts
05e2a8b59823e069dafb7b7a4da870710bb32a9985c7ffb385c4348d384afc31  apps/desktop/electron/main/conversion/conversion-catalog.test.ts
9b8df438860b5f75e8300a7d52950623fc9b24126204181c32f2af66c5b5b09a  apps/desktop/electron/main/conversion/adapters/image-icon.test.ts
3aade14f8b59a38e709c337144eb3e9763b5e3bf75cc812ccc04ed997bb25527  apps/desktop/electron/main/conversion/converter-pack-manager.test.ts
a9fb3bc481dcd32998bad8a897711df490d05bf851c2c56ed17f93b3eb1fa214  apps/desktop/electron/main/conversion/converter-pack-types.ts
fc3bffe1aad5c0e956fa61d087ad7f2fe092dcdf26cff303a087bf5391377565  apps/desktop/electron/main/conversion/converter-pack-verifier.test.ts
4744eb73f0e97af979c0c26c4d74b0590b470a6835a2b6d65f9b8fd7c067c1a0  apps/desktop/electron/main/conversion/converter-pack-verifier.ts
c09dd1a2654699db718d83c64e81fb16111f336cee331fdc64702884af193972  apps/desktop/electron/main/database/native-packaging.test.ts
58a244d069217058001e205ea563010de154f897d9c87572627854046e9362a0  apps/desktop/resources/converter-packs/bootstrap.json
c72112dcfc676041ff7201f72dde3bbf8b38027eb1fb86acc26b952d810275ac  apps/desktop/resources/converter-packs/index.schema.json
fd839c3bd921aa50f55484532dec72fd8eb3688510f8246f6d887ff16be9e65d  apps/desktop/scripts/converter-packs/build-index.mjs
b498e529400adb98ccb3121c62815f235dc06ac8769480473e169aa74f4ae010  apps/desktop/scripts/converter-packs/create-test-pack.mjs
276af8db85e594a7174d2e7d1c567ae944a0d953c3afb2f0b0c4a84fce7837f6  apps/desktop/scripts/converter-packs/pack-tooling-lib.mjs
b86723e1883fbc49bb4ac0debdde905098301684dc03e03743c8719f984c0e96  apps/desktop/scripts/converter-packs/sign-index.mjs
e7fa72e88c3656925ee137c865454f28e86efe251f087291fd1e14af7f36f926  apps/desktop/scripts/verify-converter-packs.mjs
a54e7c2a7073102ca560360422831882798cf3f76126a3c3ea784ec08b4d903a  apps/desktop/scripts/verify-packaged-native.mjs
0515af3233416feb9b0d8131746e8825851f797c21fd63d8952feea3201bed5e  apps/desktop/tests/fixtures/conversion/README.md
3797ed6ea919cc4b51362af04df139d46554c37317e4eee8f2fdd56a98ce5816  apps/desktop/tests/integration/conversion-engines.test.ts
923bd23a465fedd051929922b3f3be59dd4401f15e73f681eafb4b7c83944138  apps/desktop/tests/integration/converter-pack-tooling.test.ts
```

## External release gates

Local signed-fixture GREEN does not authorize production distribution. Release remains blocked until release engineering supplies and independently verifies:

1. the production Ed25519 root public key and approved rotation/recovery procedure;
2. the production HTTPS CDN and pinned signed canonical index;
3. all four signed pack families for macOS arm64, macOS x64, and Windows x64;
4. complete redistributable third-party licenses, notices, source offers, and provenance for every engine/dependency;
5. real conversion-matrix runs on all three targets, platform signing, macOS notarization, packaged-content, privacy, update, and rollback acceptance.

If any item is absent, the production root stays unpinned and converter pack downloading stays disabled.
