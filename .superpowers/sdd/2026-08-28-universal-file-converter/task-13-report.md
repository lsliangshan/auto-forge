# Task 13 report — signed converter packs and real-engine fixtures

## Outcome and scope

- Worktree: `/Users/liangshan/Downloads/workspace/workspace_qisi/auto-forge/.worktrees/universal-file-converter`
- Base: `2d6d8972b700678e347479ce7f73bc90c2ff7f10`
- Task 13 and Important-finding fix rounds 1–4 are implemented. Task 14 was not started.
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

Fix round 3 again began with tests against the fix-round-2 implementation:

- focused catalog, adapter, repository, native, cross-platform-root, and ASAR tooling coverage: **16 failed, 95 passed**; failures proved duplicate EBML DocTypes were accepted, ICNS slot identity was dropped, malformed DIBs were accepted, Windows root helpers were absent, native directories/FIFOs could satisfy existence checks, and unindexed ASAR prefix/trailer bytes were ignored;
- the local Application snapshot boundary was then exercised independently after the strict shared view schema was rebuilt.

Fix round 4 began with tests against the fix-round-3 implementation:

- native and ASAR tooling coverage produced **6 genuine failures**: a configured `AutoForge` directory plus executable `00-decoy` passed, non-executable `AutoForge` passed, the verifier was not bound to the configured product name, and zero slack, nonzero alignment padding, and DER-key header slack were accepted;
- the positive package test also opens the actual electron-builder ASAR as a raw file, proves it exceeds 100 MiB, and verifies its production Pickle/header layout rather than relying only on synthetic fixtures.

Final GREEN evidence:

- strengthened signed real-engine matrix: **11/11 passed**;
- absent fixture root: **1 suite / 11 tests explicitly skipped** with the external-gate message;
- invalid signed root plus sentinel-only `PATH`: failed in `verifyConverterPackIndex` with `index_invalid`, **11 tests skipped**, and the fallback sentinel remained absent;
- Task 4/5 adjacency plus tooling/build configuration: **11 files / 198 tests passed**;
- final signed-index runtime verifier: **35/35 passed**;
- final fix-round-2 catalog/adapter/runtime/tooling/native gate: **5 files / 127 tests passed**; this includes Win32 drive/UNC containment, source-mode independence, the reviewed active-content extension table, full-package traversal, DER private-key detection, and structural Win32 x64 native verification without simulated execution;
- final fix-round-3 Task 4/5 adjacency, catalog/adapter/artifact persistence, tooling, native and build-config gate: **16 files / 249 tests passed**;
- final fix-round-4 native, ASAR tooling and build-config gate: **3 files / 41 tests passed**;
- shared artifact-view contract: **12/12 passed**; the focused Application snapshot persisted and projected all ten scale-specific ICNS identities, including distinct `ic11` and `icp5` records at the same 32×32 pixel size;
- the full Application suite passed **192/194**; its two repeatable unrelated baselines are the legacy-import cleanup `ENOTEMPTY` race and context-summary fixture `CONTEXT_LIMIT_EXCEEDED`. The new ICNS snapshot test passes independently;
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
- MP4 to MP4/WebM/MOV/GIF/MP3 with stable magic where defined, canonical format name, exact ordered stream types/codecs, dimensions, 12 decoded frames where video remains, and no retained chapter or sentinel metadata. WebM acceptance parses EBML and requires exactly one `webm` DocType; zero, duplicate, mixed duplicate, and Matroska-for-WebM cases reject.

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
- The ASAR parser validates both Pickle size records, the declared JSON string length and closing terminator, minimal four-byte alignment, zero-only padding, and the exact derived content offset before reading entry bytes. Oversized zero slack, nonzero padding, DER-key header slack, and unindexed DER prefix/trailer bytes reject. The freshly built 353,880,101-byte electron-builder ASAR passes this exact parser.
- Native packaging requires `app.asar`, `better_sqlite3.node`, and the selected app executable to be non-symlink regular files; directory and FIFO substitutes fail. Darwin resolves only the `AutoForge` product executable declared by electron-builder, requires executable mode, and never falls back to a decoy directory entry. POSIX hosts inspect POSIX paths, while native Win32 validation accepts canonical drive/UNC roots and rejects drive-relative, root-without-volume, and device paths without pretending to execute Windows binaries locally.
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
a3a02d0f609bc60065060975f20418c0ea210ac54f847b9261a969836c978a46  apps/desktop/electron/main/application.test.ts
43a2eb036326d04b6dd343f820a76a5d1fab3f2028e9d598ad4988fd03f89322  apps/desktop/electron/main/conversion/adapters/image-icon.ts
b248feef4e89a989883cb774ee22bbb023cda4d20d42e8f0945bd4a098bef0bc  apps/desktop/electron/main/conversion/adapters/image-icon.test.ts
fac9bc8babb60aa0bb5814beeb75c7309f0fa5065b6442510408833df16a0a90  apps/desktop/electron/main/conversion/conversion-catalog.ts
026fecf264203f09f75d5744c49786267f14636d80350ca62bc014bb384112a7  apps/desktop/electron/main/conversion/conversion-catalog.test.ts
3aade14f8b59a38e709c337144eb3e9763b5e3bf75cc812ccc04ed997bb25527  apps/desktop/electron/main/conversion/converter-pack-manager.test.ts
a9fb3bc481dcd32998bad8a897711df490d05bf851c2c56ed17f93b3eb1fa214  apps/desktop/electron/main/conversion/converter-pack-types.ts
fc3bffe1aad5c0e956fa61d087ad7f2fe092dcdf26cff303a087bf5391377565  apps/desktop/electron/main/conversion/converter-pack-verifier.test.ts
4744eb73f0e97af979c0c26c4d74b0590b470a6835a2b6d65f9b8fd7c067c1a0  apps/desktop/electron/main/conversion/converter-pack-verifier.ts
26d5f8f7270d09aed8e6a76cde163fb311c9674b155e3ec6f0a13effce08bbfb  apps/desktop/electron/main/database/conversion-repositories.test.ts
9a79af7193c98f575d0b09194bef022eba41b86adbb7acca500fd27ad215ffee  apps/desktop/electron/main/database/repositories.ts
af2d38108924f34e9fcb9b6baf5487a447dedbd7be747ca5f5f51b088201797c  apps/desktop/electron/main/database/native-packaging.test.ts
7f09ce5c8f6b28707985bf113a8728b5c3b419c149ed3eefcd6c6aac4b7db292  apps/desktop/electron/main/database/native-package-paths.test.ts
58a244d069217058001e205ea563010de154f897d9c87572627854046e9362a0  apps/desktop/resources/converter-packs/bootstrap.json
c72112dcfc676041ff7201f72dde3bbf8b38027eb1fb86acc26b952d810275ac  apps/desktop/resources/converter-packs/index.schema.json
fd839c3bd921aa50f55484532dec72fd8eb3688510f8246f6d887ff16be9e65d  apps/desktop/scripts/converter-packs/build-index.mjs
b498e529400adb98ccb3121c62815f235dc06ac8769480473e169aa74f4ae010  apps/desktop/scripts/converter-packs/create-test-pack.mjs
276af8db85e594a7174d2e7d1c567ae944a0d953c3afb2f0b0c4a84fce7837f6  apps/desktop/scripts/converter-packs/pack-tooling-lib.mjs
b86723e1883fbc49bb4ac0debdde905098301684dc03e03743c8719f984c0e96  apps/desktop/scripts/converter-packs/sign-index.mjs
1bc2da6349c3a3a4498ed7ec6c7a1a12d29aa3f2d178eeacda1b5f17a8daf95c  apps/desktop/scripts/native-package-paths.mjs
70f0af998e7ce8b28ca3c1e7423d3b08eb99ab2960b5e0d81c8290055881a96b  apps/desktop/scripts/verify-converter-packs.mjs
c12c6407c0c6d254270e2f8c5fb18a6ab1afa2801e486ef83ba901618c1e5b3e  apps/desktop/scripts/verify-packaged-native.mjs
9f65bab2cbece6e3e936b9d5b2331b854924b404cfc698a902840c505f3e09af  apps/desktop/src/components/conversion/ConversionBlock.vue
0515af3233416feb9b0d8131746e8825851f797c21fd63d8952feea3201bed5e  apps/desktop/tests/fixtures/conversion/README.md
0b26a2cd951fdaa2cb805d5efcfcba7e45ae36f3348a5bff1f54de3def83f1e0  apps/desktop/tests/integration/conversion-engines.test.ts
d72b8445063ffbbc228b35cf01c3f83e5c7c501422c564d0f2eacb02462831d5  apps/desktop/tests/integration/converter-pack-test-root.test.ts
25c8479f793a7e334b2bf2a441a2b97df226350a6c86f8b64dad0f6c7e4a8dae  apps/desktop/tests/integration/converter-pack-test-root.ts
afa27bdfccb2ca9c27b7d0966ac2e0f7f87320d60500d836a71fd439a237fee8  apps/desktop/tests/integration/converter-pack-tooling.test.ts
9033659e47d86de1a2d9bb4b1c5a159b1e00b3d0815cdaeb3d6601fa41090716  packages/shared/src/conversion.test.ts
22baeda793cfc5c7821014a541efd45bfc522af5e7641e0bf2d5f0e9bd3c9eeb  packages/shared/src/desktop-api.ts
```

## External release gates

Local signed-fixture GREEN does not authorize production distribution. Release remains blocked until release engineering supplies and independently verifies:

1. the production Ed25519 root public key and approved rotation/recovery procedure;
2. the production HTTPS CDN and pinned signed canonical index;
3. all four signed pack families for macOS arm64, macOS x64, and Windows x64;
4. complete redistributable third-party licenses, notices, source offers, and provenance for every engine/dependency;
5. real conversion-matrix runs on all three targets, platform signing, macOS notarization, packaged-content, privacy, update, and rollback acceptance.

If any item is absent, the production root stays unpinned and converter pack downloading stays disabled.
