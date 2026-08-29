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

The index must contain all four pack families for the running platform and
architecture. The preinstalled trees must exactly match the signed entry
hashes and modes. `image-icon` declares `bin/autoforge-image-converter`,
`document` declares `program/soffice`, `pdf` declares
`bin/autoforge-pdf-raster` plus `bin/pdfinfo`, and `media` declares `bin/ffmpeg`
plus `bin/ffprobe`. Tests execute only these lease-resolved absolute paths;
they never search or fall back to system `PATH`. An invalid or unsigned bundle
fails before any converter process starts.

The minimal inputs are self-created deterministic shapes, text, tables,
slides, tones, and color frames. `fixtures/PROVENANCE.md` must identify how
they were generated, the exact local engine versions, and their licenses.
They contain no third-party document or media corpus. Generated fixture
bundles and private test keys belong under repository-root `.test-artifacts/`,
which is outside production `out/**` and is not committed or packaged.

This suite checks content, not filenames: magic bytes, icon representations,
transparent square padding, dimensions, PDF pages, animation frames, stream
codecs, containers, duration, and first-frame metadata.

Passing with a test root is local evidence only. Production release remains
blocked until release engineering supplies the production root public key,
HTTPS CDN, a signed compatible index and all four signed pack families for
macOS arm64, macOS x64, and Windows x64, complete third-party license/source
notices, and real runs plus signing/notarization evidence on every platform.
The download kill switch stays off when any one of those inputs is absent.

The Task 12 Cloud dependency is unchanged: deploy the v1-safe/v2 Cloud
SQL/handler reader-first, then prove PostgreSQL locking, RLS, purge, receipt,
and cross-device convergence before enabling Desktop v2 writers.
