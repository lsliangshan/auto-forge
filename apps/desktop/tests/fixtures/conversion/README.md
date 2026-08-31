# Converter engine fixture contract

`conversion-engines.test.ts` is an opt-in, real-engine acceptance suite. It is
skipped unless `AUTOFORGE_TEST_CONVERTER_PACK_ROOT` names an absolute fixture
bundle with this shape:

```text
<root>/
  test-root-public-key.pem
  release/index.json
  release/index.sig
  release/<signed restricted-USTAR archives>
  installed/<pack>/<version>/<platform>-<arch>/<signed entries>
  fixtures/PROVENANCE.md
  fixtures/transparent-nonsquare.png
  fixtures/animated-two-frame.webp
  fixtures/sample.docx
  fixtures/sample.xlsx
  fixtures/sample.pptx
  fixtures/sample.csv
  fixtures/three-page.pdf
  fixtures/tone.wav
  fixtures/sample.mp4
```

The fixture index is built, signed, and verified only with explicit
`--mode test`; the production default requires the exact 8-coordinate
inventory and rejects this single-platform subset. The index must contain all
four pack families for the running platform and architecture. Every signed
entry includes an explicit `executable`, `code`, `license`, or `data` role,
and the preinstalled trees must exactly match the signed entry hashes and
target modes. `image-icon` declares `bin/autoforge-image-converter` plus
`bin/vips`,
`document` declares `program/soffice`, `pdf` declares
`bin/autoforge-pdf-raster` plus `bin/pdfinfo` and `bin/pdftocairo`, and `media` declares `bin/ffmpeg`
plus `bin/ffprobe`. Tests execute only these lease-resolved absolute paths;
they never search or fall back to system `PATH`. An invalid or unsigned bundle
fails before any converter process starts.

The minimal inputs are self-created deterministic shapes, text, tables,
slides, tones, and color frames. The WAV includes unique title, artist, and
comment sentinels. The MP4 includes unique format title/artist/comment,
video/audio handler names, and a chapter title; the matrix asserts those
preconditions and then proves that every converted output removes them and
all chapters. `fixtures/PROVENANCE.md` must identify how
they were generated, the exact local engine versions, and their licenses.
They contain no third-party document or media corpus. Generated fixture
bundles and private test keys belong under repository-root `.test-artifacts/`,
which is outside production `out/**` and is not committed or packaged.

This suite checks content, not filenames: magic bytes, every ICO/ICNS header
and embedded representation, structural probes, transparent square padding,
dimensions, PDF pages, animation frames, canonical `ffprobe` container names,
exact stream types/codecs, duration, stripped sentinels/chapters, and
first-frame metadata.

Passing with a test root is local evidence only. The first production release
matrix is macOS arm64 and macOS x64. Release engineering must supply the root
public key, HTTPS CDN/COS configuration, Apple signing/notarization credentials,
all four pack families for both targets, complete third-party license/source
notices, and accepted real-engine evidence. The document family carries the
verified LibreOffice DMG plus the signed read-only mount launcher; it does not
expand the application bundle past the pack entry and byte limits. The checked-in
download kill switch stays off when any protected release input is absent.

The Task 12 Cloud dependency is unchanged: deploy the v1-safe/v2 Cloud
SQL/handler reader-first, then prove PostgreSQL locking, RLS, purge, receipt,
and cross-device convergence before enabling Desktop v2 writers.
