# Universal File Converter Workflow Design

## Status

Approved in chat on 2026-08-28. This document specifies the design only. It
does not authorize or contain the implementation.

The product name is **万象转换**. The example project directory is
`examples/universal-file-converter`, and its workflow ID is
`file.convert.universal`.

## Goal

Add a real local file-conversion workflow that can accept files from chat or
the developer debug page, convert common image, icon, document, PDF, audio,
and video formats, and return managed results without exposing local paths or
arbitrary process execution to workflow code.

Conversion bytes stay on the local device. Network access is used only to
download the versioned, signed converter packs selected by the current app
release. A later app release may select a newer signed pack catalog. The first
release does not add an independent remote pack-update channel. The original
file is never overwritten.

## Success Criteria

- The workflow is discoverable and buildable through the existing local
  workflow project path.
- Chat accepts one to five attachments and a target format, runs the workflow,
  shows progress, and exposes completed outputs through save and reveal
  actions.
- The developer debug page provides a native file picker for the same workflow
  input and shows the same job states and result actions.
- A clear local-conversion request never sends attachment bytes, paths,
  database IDs, or execution-scoped handles to a model provider.
- Workflow code receives only attachment indexes and a narrow conversion
  capability. It cannot read arbitrary files, choose executable paths, or pass
  arbitrary command-line arguments.
- An installed converter pack works offline after its first verified download.
- Every supported route has a real fixture conversion on each supported
  platform or is excluded from the platform's published catalog.
- Cancellation, timeout, restart, and late process completion cannot replace a
  terminal `cancelled`, `failed`, or `interrupted` state.
- Failed or interrupted jobs leave no visible partial output and never modify
  the source file.

## Supported Platforms

The first release supports:

- macOS on Apple Silicon;
- macOS on Intel;
- Windows on x64.

Linux support and Linux packaging are outside this design.

## Scope

This design covers:

- the `examples/universal-file-converter` workflow project;
- a dedicated `file.convert` workflow capability;
- execution-scoped attachment bindings;
- conversion jobs and managed workflow artifacts;
- signed on-demand converter-pack installation;
- chat and developer-page presentation;
- cancellation, timeout, restart recovery, and cleanup;
- local privacy and security controls;
- macOS and Windows packaging and release gates.

This design does not add:

- PDF-to-Word, PDF-to-Excel, or PDF-to-PowerPoint reconstruction;
- raster-to-SVG tracing;
- OCR;
- archive creation or extraction;
- CUR or ANI cursor conversion;
- Xcode asset catalogs, Android resource trees, or project-directory output;
- arbitrary FFmpeg, LibreOffice, or image-engine parameters;
- cloud conversion or upload of source/output bytes;
- Linux support.

## Existing Boundaries

The current workflow SDK exposes only `browser` and `logger`. The shared
capability enum names filesystem and artifact capabilities, but the Worker
request schema and guest context implement only browser requests. A workflow
cannot currently read or write a local file.

Chat attachments already enter an application-owned media store and are
referenced by opaque asset IDs. The Main process enforces ownership and stable
file reads. Chat currently allows at most five attachments with per-kind and
per-request byte limits. Those limits remain authoritative for conversion.

Workflow execution is isolated in a child Worker and validates manifest
permissions, runtime requests, input, output, source identity, cancellation,
and timeouts. The new capability must extend this boundary rather than bypass
it with Node filesystem or process access.

## Chosen Architecture

Use a host-owned conversion service behind a narrow workflow capability.
Workflow code states the attachment index and desired result. Main owns source
resolution, engine selection, executable selection, arguments, temporary
files, limits, job state, and output registration.

Two alternatives were rejected:

1. Generic filesystem and process capabilities were rejected because they
   would expose paths and create command-injection and arbitrary-execution
   boundaries.
2. Bundling all converters as workflow JavaScript or WebAssembly was rejected
   because Office and media support would be incomplete, bundles would be
   large, and memory behavior would be difficult to bound.

## Components

### ConversionCatalog

`ConversionCatalog` is the single source of truth for supported routes. Each
route declares:

- canonical source and target format names;
- accepted content signatures and container probes;
- result MIME type and extension;
- required converter pack and engine adapter;
- fixed preset names;
- input, output, page, pixel, and timeout limits;
- whether one input may produce multiple output artifacts;
- whether animation or audio streams are retained;
- the metadata-retention policy.

The Renderer, workflow schema, Agent tool projection, capability validation,
and conversion service derive their choices from this catalog. They must not
maintain independent format lists.

### ConverterPackManager

`ConverterPackManager` installs and resolves converter packs. It accepts only
catalog entries signed by a root public key embedded in the application.

The first release has four independently downloadable packs:

- `image-icon`: a libvips-based image helper plus the AutoForge ICO/ICNS
  container codec;
- `document`: a headless LibreOffice distribution and locked configuration;
- `pdf`: a Poppler-backed PDF raster helper plus the isolated Chromium
  document-to-PDF adapter;
- `media`: an FFmpeg build with the exact encoders and muxers required by this
  specification.

The implementation must enumerate the actual formats/codecs from the packaged
helpers during pack production and compare them with the release catalog. A
build cannot advertise a route that its packaged binary does not provide.

The application ships the signature root and an app-version-compatible pack
index as release inputs. Production URLs and signing keys are not invented by
the repository. A release remains blocked until release engineering provides
the signed index, hosted pack artifacts, license notices, and platform signing
evidence. Development and automated tests use a separate test root key and
local fixture source; production builds must reject that key.

### ConversionService

`ConversionService` validates and durably submits a job. It:

1. resolves the attachment index from the current execution context;
2. verifies user ownership and immutable source identity;
3. detects the source format from bytes and container structure;
4. rejects an extension/content conflict;
5. resolves an exact catalog route and converter-pack version;
6. persists a job before returning to the workflow;
7. schedules the job under concurrency limits;
8. runs the fixed adapter without a shell;
9. validates every result and atomically commits it;
10. emits sanitized progress and terminal events.

### ConversionJobRunner

Long conversions are asynchronous so a video job is not constrained by the
existing five-minute workflow timeout. The workflow submits durable jobs and
finishes after they are accepted. `ConversionJobRunner` continues in Main and
updates the result card or developer panel.

At most two conversion jobs run at once. LibreOffice jobs are serialized, and
video jobs are serialized. Image, icon, PDF, and audio work may occupy the
second slot. These limits are product constants, not workflow-configurable
settings.

### WorkflowArtifactService

`WorkflowArtifactService` owns developer inputs and all conversion outputs. A
local-only artifact record contains:

- owner user ID;
- execution ID and conversion job ID;
- role (`input` or `output`);
- sanitized original/display name;
- detected format and MIME type;
- byte size and SHA-256;
- application-relative storage path;
- lifecycle state and timestamps.

Absolute paths never enter shared contracts, message blocks, Renderer state,
logs, workflow output, or sync payloads. Artifact records and bytes are local
only and are excluded from CloudBase sync. A synced conversation may retain a
payload-free terminal summary, but another device must show that the local
result is unavailable rather than inventing a download.

Chat inputs remain authoritative media assets; the execution attachment vault
binds them to indexes without copying their bytes. Developer inputs are copied
into the artifact staging area before execution so later path replacement
cannot change the submitted content. Conversion outputs are workflow artifacts
for both entry points.

### Universal Converter Workflow

`examples/universal-file-converter/src/index.ts` is intentionally thin. It:

- validates that one to five attachment indexes were supplied;
- validates the target format and preset;
- submits one conversion job per attachment in deterministic order;
- reports accepted or rejected items without exposing job, asset, user, or path
  IDs;
- leaves all format probing and security decisions to Main.

The example includes source, `workflow.json`, built `dist/index.js`, and a
matching code hash, following the existing example-project convention.

## Format Matrix

Canonical format values are lowercase.

### Static Images

`png`, `jpeg`, `webp`, `avif`, `tiff`, and `bmp` may be converted among one
another. The image adapter preserves orientation and an applicable ICC color
profile, removes location metadata and unnecessary author metadata, and
rejects truncated or structurally invalid input.

`svg` is input-only. It may produce `png`, `jpeg`, `webp`, or `pdf`. Raster
images cannot produce SVG.

### Animated Images

Animated `gif` and animated `webp` may convert to each other or to `mp4`.
Conversion to a static image selects the first frame and marks that fact in the
public result metadata. Animation is never silently discarded.

### Icons

`ico` and `icns` are accepted as input and output. `png`, `jpeg`, `webp`,
`avif`, and `svg` may produce either icon format.

ICO output contains 16, 24, 32, 48, 64, 128, and 256 pixel representations.
The `favicon` preset uses 16, 32, and 48 pixel representations in the same ICO
container. The `app-icon` preset uses the complete target-specific size set;
for ICO and ICNS, `default` resolves to `app-icon`. ICNS output contains the
representations needed for 16, 32, 64, 128, 256, 512, and 1024 pixel display
sizes, including Retina representations.

Non-square source images are scaled proportionally, centered, and padded to a
square transparent canvas. They are never cropped. A target that cannot retain
alpha uses the user-selected background, or white when no background is
provided.

ICO or ICNS conversion to a normal image exports every distinct embedded
representation as a grouped result. Duplicate representations with identical
dimensions and hashes are emitted once.

### Documents

The following formats may produce PDF:

- `doc`, `docx`, `xls`, `xlsx`, `ppt`, `pptx`;
- `odt`, `ods`, `odp`, `rtf`, `csv`;
- `html`, `markdown`, `txt`.

CSV may also produce XLSX. Office and OpenDocument conversions use the locked
headless LibreOffice adapter. HTML, Markdown, and text use an isolated local
document renderer backed by Electron's PDF printing capability. The renderer
has no network access; external URLs and active content are not loaded.

The design does not support PDF-to-Office reconstruction or arbitrary Office-
to-Office conversion.

### PDF

PDF may produce PNG or JPEG. Each page becomes one output named
`<stem>-page-001.<ext>`. A PDF may contain at most 100 pages. A larger document
is rejected; it is not silently truncated.

### Audio

`mp3`, `wav`, `m4a`, `aac`, `flac`, `ogg`, and `opus` may be converted among
one another using fixed codec and quality templates from `ConversionCatalog`.

### Video

Accepted input containers are `mp4`, `mov`, `mkv`, `webm`, and `avi`.
Supported video targets are:

- MP4 using H.264 video and AAC audio;
- WebM using VP9 video and Opus audio;
- MOV using H.264 video and AAC audio;
- GIF with no audio stream.

A video may also produce any supported audio target. Video conversion retains
the source dimensions and frame rate unless the fixed target template requires
a compatible value. Workflows cannot choose codecs, filters, protocols,
devices, or raw FFmpeg arguments.

## Limits

The existing media limits remain authoritative:

- at most 5 attachments;
- image input: 20 MiB per file;
- audio input: 50 MiB per file;
- video input: 200 MiB per file;
- other file input: 100 MiB per file;
- total input per request: 250 MiB;
- output: 500 MiB in aggregate per conversion job; each artifact is necessarily
  bounded by the same aggregate cap.

Additional limits are:

- PDF: 100 pages;
- image/icon decode: 100 megapixels per frame;
- image/icon multi-page or multi-frame decode: 500 megapixels total;
- task timeout: 2 minutes for image/icon, 5 minutes for document/PDF,
  10 minutes for audio, and 30 minutes for video;
- converter stdout and stderr capture: 64 KiB each before truncation;
- all displayed engine diagnostics: 2 KiB after sanitization.

The source file is revalidated immediately before adapter start. Output count,
type, dimensions, duration, size, and content signature are revalidated before
commit. A route that exceeds a limit fails without a partial visible result.

## Contracts

### Capability

Add `file.convert` to the shared capability enum and add a dedicated scope:

```ts
interface FileConvertScope {
  formats: ConversionTargetFormat[]
}
```

Manifest validation requires a non-empty unique format list, all values known
to `ConversionCatalog`, and no extra properties. The runtime request carries
the attachment index, target format, and preset. Main verifies that the target
format is covered by the declared permission.

`file.convert` is a sensitive-read capability with managed local output. It
cannot be persisted as a blanket file grant. Chat approval binds one decision
to the exact workflow fingerprint, execution, attachment snapshot, and target
format. Developer file selection is the corresponding one-run authorization.

### Workflow SDK

The SDK adds:

```ts
interface ConverterCapability {
  submit(input: {
    attachmentIndex: number
    targetFormat: ConversionTargetFormat
    preset?: 'default' | 'favicon' | 'app-icon'
    background?: string
  }): Promise<{
    accepted: true
    sourceName: string
    targetFormat: ConversionTargetFormat
  }>
}

interface WorkflowContext {
  browser: BrowserCapability
  converter: ConverterCapability
  logger: LoggerCapability
}
```

The returned value contains no internal ID. Main binds jobs to the execution
out of band. The guest bridge validates JSON before it crosses the Worker
boundary, and the Execution Service validates it again against the manifest
permission and current execution attachment vault.

### Workflow Input

The example input schema contains:

```ts
interface UniversalConverterInput {
  attachmentIndexes: number[]
  targetFormat: ConversionTargetFormat
  preset?: 'default' | 'favicon' | 'app-icon'
  background?: string
}
```

The `attachmentIndexes` JSON Schema property has an AutoForge extension keyword
that asks the developer debug form to render a native file picker. The schema
validator explicitly registers that keyword. The Agent tool projection strips
all `x-autoforge-*` UI annotations and retains the numeric index schema.

The background value accepts only `#RRGGBB` or `#RRGGBBAA` and is used only for
targets without alpha. Main ignores it for other routes.

### Workflow Output

The workflow output is provider-safe:

```ts
type ConversionPublicErrorCode =
  | 'UNSUPPORTED_CONVERSION'
  | 'INPUT_FORMAT_MISMATCH'
  | 'INPUT_UNAVAILABLE'
  | 'INPUT_LIMIT_EXCEEDED'

interface UniversalConverterOutput {
  accepted: true
  items: Array<{
    sourceName: string
    targetFormat: ConversionTargetFormat
    status: 'queued' | 'rejected'
    errorCode?: ConversionPublicErrorCode
  }>
}
```

Job IDs and artifact IDs remain in Main-owned card bindings. They do not enter
model evidence or conversation context.

### Job and Artifact IPC

Renderer IPC exposes purpose-built operations only:

- list conversion jobs for an owned execution or batch;
- cancel or retry one owned job;
- subscribe to sanitized conversion events;
- save a copy of an owned completed artifact;
- reveal an owned completed artifact;
- delete an owned completed artifact;
- inspect installed pack status and initiate/cancel a required download.

Every handler derives the current user from Main authentication and verifies
ownership. No handler accepts or returns an absolute path or executable name.

## Chat Flow

1. The user attaches files and requests a target format.
2. Before provider projection, Main identifies a possible local-conversion
   request from the explicit conversion verb, target format, or workflow name.
   This guard controls byte redaction only; it does not authorize or force
   execution.
3. The Agent receives sanitized attachment metadata and stable ordinal indexes,
   never attachment bytes. If intent or target is ambiguous, it asks a question.
4. The workflow tool call supplies indexes and a target format.
5. Main resolves indexes, validates the route, and shows one exact approval:
   for example, “读取这 2 个附件并创建 PDF 结果”.
6. After approval, the workflow submits jobs and returns accepted summaries.
7. A Main-owned conversion card observes durable job events. It displays pack
   download, queue, conversion, verification, and terminal states.
8. Completed artifacts expose save and reveal actions. Multi-page and multi-
   representation outputs appear as a collapsible result group.

An explicit conversion request must remain on the local workflow path even if
a selected provider supports PDF or Office file input. If local routing cannot
proceed, the application reports the local failure; it does not fall back to
uploading the file.

## Developer Flow

The debug form renders the attachment field as a file picker and the target
format as a catalog-derived select. Main imports selected files to local
artifact staging and mints ordinal bindings before starting the workflow.

The Debug Panel shows the completed workflow submission plus live conversion
jobs. Closing or rebuilding the project does not cancel accepted jobs. Each job
is bound to the source workflow version, development build hash, converter
catalog version, and pack version captured at submission.

Results remain available from the execution detail until the user deletes them
or clears local data. Save and reveal use the same ownership checks as chat.

## Converter Pack Trust and Lifecycle

The embedded root uses Ed25519 signatures. A signed pack index contains:

- catalog schema version;
- app-version compatibility range;
- pack name and version;
- platform and architecture;
- archive URL, compressed size, unpacked size, and SHA-256;
- archive file allowlist and per-file hashes;
- executable relative paths;
- declared converter capabilities;
- license-notice references;
- expiry and optional revocation information.

Main validates the signature and all structural limits before trusting any URL
or size. Downloads use HTTPS through the application's trusted download layer,
write to a `.part` file, enforce the signed size, and support range resumption
only when the server identity and signed metadata remain unchanged.

Extraction rejects absolute paths, traversal, links, devices, duplicate paths,
unexpected files, and size expansion beyond the signed limit. Installation is
an atomic rename into an app-owned version directory. Pack resolution verifies
the selected executable hash again before every job.

The application retains the previous valid pack version. A new version is not
selected for already submitted jobs. Old versions are removed only after no
job references them. Revoked or expired metadata prevents new jobs but does
not delete user artifacts.

## Process Isolation

Adapters invoke an exact executable path without a shell. Arguments are built
from catalog templates and application-owned staging paths. The environment is
an allowlist and does not inherit provider credentials, user secrets, proxy
credentials, shell startup variables, or arbitrary PATH entries.

Each job receives a private working directory. Only the immutable input and
staging output are placed there. LibreOffice receives a private user profile
with macros, updates, and external links disabled. HTML/Markdown rendering
uses a sandboxed, hidden local renderer with network requests denied. FFmpeg
uses local-file protocols only and cannot accept workflow-provided protocols,
devices, filter scripts, or URLs.

Main owns the child process group. Cancellation and timeout terminate the full
group, wait for exit, and then remove staging. Process output is bounded and
sanitized before persistence.

## Job State Machine

```text
queued
  -> downloading_component
  -> converting
  -> verifying
  -> completed

queued | downloading_component | converting | verifying
  -> cancelled
  -> failed
  -> interrupted
```

Terminal states are monotonic. Each job has an epoch and compare-and-set
transition. Output commit and terminal transition occur under one job lock.
A process result, download callback, timeout, or cancellation from an older
epoch is ignored after a terminal transition.

Each capability call durably creates its accepted job before returning. The
workflow catches a public rejection for one attachment and continues with the
remaining indexes. A later rejection does not roll back an earlier accepted
job. Once submitted, jobs fail independently, and successful siblings remain
available when another sibling fails or is cancelled.

## Cancellation and Restart Recovery

- Cancelling a workflow before durable submission creates no conversion job.
- Cancelling the conversion card cancels all non-terminal jobs in that batch.
- Cancelling one row affects only that job.
- A cancelled or timed-out process is killed and reaped before staging cleanup.
- Pack downloads may resume after restart. Conversion processes do not.
- Startup marks non-terminal conversion jobs `interrupted`, removes their
  staging directories after ownership and path validation, and offers retry.
- Retry creates a new job epoch and revalidates the current source artifact.
- Committed artifacts survive a later application crash or sibling failure.

## Naming and Metadata

Normal output uses `<source-stem>.<target-extension>`. If source and target
extensions match, use `<source-stem>-converted.<target-extension>`. Page output
uses a three-digit page suffix. Icon representations use a size suffix in the
group display while remaining members of one ICO or ICNS container when the
target itself is a container.

Names are sanitized to remove control characters, path separators, URL-like
prefixes, trailing dots/spaces where relevant, and reserved Windows names.
Save-copy collision behavior belongs to the native save dialog; Main never
silently overwrites an existing destination.

The converter preserves orientation, relevant ICC profiles, dimensions,
duration, and frame rate when the route allows it. It removes GPS/EXIF location
data and unnecessary author metadata by default. Result metadata records when
only the first animation frame was selected.

## Error Model

Add stable application errors for:

- unsupported source or conversion route;
- extension/content mismatch;
- component missing, download failed, signature invalid, or pack revoked;
- input unavailable or changed;
- size, page, pixel, output-count, or timeout limits;
- converter failure or invalid output;
- storage full;
- cancelled or interrupted conversion.

User-facing messages are localized and actionable. They may contain sanitized
display names and public formats, but not paths, arguments, executable names,
raw stderr, hashes, internal IDs, or user IDs. Automatic retry is limited to a
safe pack-download resume. A failed conversion requires an explicit user retry.

## Storage and Retention

Inputs imported only for an unsubmitted developer run are drafts and use the
existing draft-retention policy. Submitted job inputs remain until all
dependent jobs reach a terminal state. Completed output artifacts are not
removed by age. They remain until the user deletes them, the owning chat
conversation is deleted, or local data is cleared. Developer results have no
conversation owner and therefore remain until explicit deletion or local-data
clear.

Deletion uses quarantine-first semantics and reconciles database and disk
state on startup. It validates every application-relative path and never
follows symlinks. Clearing local data includes conversion jobs, artifacts,
staging, and downloaded packs according to the existing clear-data contract.

Startup recovery recognizes strict direct-child `results/batch-<UUID>`
directories and paired `.trash/rollback-<UUID>` plus
`.rollback-<UUID>.reserve` evidence. It retains a result batch only when its
complete leaf set maps to ready output artifacts whose owner, execution, and
completed job all agree. A batch with no durable ownership is atomically moved
out of `results` after directory identity checks. Quarantine first creates the
private `rollback-<UUID>` container exclusively, then moves the source batch to
its fixed `batch` child; an empty or non-empty competing container therefore
cannot be overwritten by directory rename. Recovery accepts both this nested
layout and the earlier direct-leaf layout. It opens and validates every
rollback leaf no-follow before changing any content, then truncates and fsyncs
only those retained handles. It leaves zero-byte tombstones and their identity
reservation until explicit local-data clear because deleting a revalidated
path would reintroduce a replacement race. Symlinks, swaps, destination
conflicts, forged rows, anonymous extra leaves, or identity mismatches create
durable owner-local conflict evidence; later bindings fail before touching
either node.

## Testing Strategy

Implementation follows test-driven development. Each behavior begins with a
test that fails for the intended reason.

### Unit Tests

- every allowed and forbidden catalog route;
- format normalization, MIME mapping, and naming;
- ICO and ICNS size sets, transparent padding, alpha fallback, and extraction;
- static selection from animated input;
- fixed adapter arguments and rejection of arbitrary parameters;
- pack signature, compatibility, expiry, revocation, size, path, and hash
  checks;
- state transitions, epochs, compare-and-set behavior, and error localization;
- metadata scrubbing and diagnostic redaction.

### Security and Race Tests

- forged extension, malformed container, decompression bomb, excessive PDF
  pages, and oversized output;
- invalid attachment index, cross-user artifact access, stale execution
  binding, and changed source;
- path traversal, symlink/hard-link substitution, archive link/device entries,
  duplicate extraction paths, and Windows reserved names;
- command, filter, protocol, and environment injection attempts;
- cancellation versus process exit, timeout versus completion, restart versus
  commit, repeated events, and late callbacks across job epochs;
- component replacement after validation and pack update while a job is live.

### Integration Tests

Use a test signing root, local fixture pack server, and deterministic fake
converters to prove:

- first-use download, resume, validation, atomic installation, and rollback;
- chat and developer attachment binding;
- durable submission and independent batch outcomes;
- output verification and atomic artifact registration;
- cancellation, restart interruption, retry, and cleanup;
- save, reveal, delete, logout, conversation deletion, and local-data clear;
- no source bytes, paths, internal IDs, or job IDs enter provider requests,
  Renderer logs, model context, or sync payloads.

### Real Engine Tests

On macOS arm64, macOS x64, and Windows x64, use licensed fixture files to cover
at least one real route for every target family:

- static image conversion;
- animated GIF/WebP conversion;
- SVG rasterization;
- ICO creation/extraction and ICNS creation/extraction;
- each Office family to PDF, CSV to XLSX, and text/HTML/Markdown to PDF;
- multipage PDF to PNG/JPEG;
- every audio target;
- MP4, WebM, MOV, GIF, and video-to-audio output.

Assertions inspect actual signatures, dimensions, frame/page counts, duration,
streams/codecs, and openability. Filename changes or HTTP success alone are not
acceptance evidence.

### UI and End-to-End Tests

- chat attachment plus explicit conversion produces an approval and a live
  card without sending file bytes to the provider;
- ambiguous target asks a question and starts no job;
- developer file picker produces the same jobs and results;
- pack download, queued, running, verifying, failed, cancelled, interrupted,
  and completed states are visible and localized;
- multi-output groups expand correctly;
- save copy and reveal operate on the real completed file;
- visual inspection covers both chat and Debug Panel layouts.

### Packaging and Release Gates

Automated packaging must inspect the produced app and prove that:

- the production signing root and compatible pack index are present;
- the test signing root and fixture URLs are absent;
- downloaded executables live outside `app.asar` in the intended app-owned
  directory;
- platform and architecture selection is exact;
- macOS components satisfy signing, hardened-runtime, quarantine, and
  notarization requirements;
- Windows components and archives satisfy code-signing requirements;
- all third-party license notices and source-offer obligations are met.

The real hosted pack artifacts, production signature, macOS notarization,
Windows signing, and CDN behavior are external release gates. Local fixtures or
unsigned development packs must never be reported as release acceptance.

## Implementation Boundaries

The implementation should remain layered:

1. shared catalog, capability, and persistence contracts;
2. pack verification and installation;
3. job and artifact lifecycle;
4. fixed engine adapters;
5. SDK and Worker bridge;
6. workflow example;
7. developer UI;
8. chat routing and presentation;
9. platform packs and release verification.

No layer may expose paths or generic process execution to the layer above it.
The implementation plan must break these into independently verifiable tasks
and keep production pack publication as an explicit external gate.

## Task 14 Implementation Evidence (2026-08-30)

The Task 14 Electron suite exercises the production Renderer, Preload, IPC,
Main, restricted Worker, signed-pack process runner, SQLite repositories, and
visible conversion card. With an explicit Task 13 test-pack root, it proves:

- the exact chat request `把图片转成 favicon ico，把文档转成 PDF` binds a PNG and
  DOCX by attachment index, presents two separately approved sanitized scopes,
  keeps paths, bytes, base64, and internal identifiers out of Provider input,
  and produces durable ICO and PDF results whose native saved copies pass
  signature/content checks;
- `file.convert.universal` / `万象转换` is discovered through the Renderer
  workflow page, Debug Panel native selection sends only indexes plus opaque
  attachment IDs, and a real MP4-to-WebM process result arriving after cancel
  cannot replace the durable cancelled state;
- the typed Main `developer.run` success response binds `executionId` to a
  `conversionCapable` boolean derived from the exact `built.manifest` used by
  that same run. The Renderer commits the pair atomically under its run token
  and never infers this execution property from its earlier build or the
  mutable editor manifest. A deterministic two-direction race holds the first
  validation while a valid `workflow.json` save flips `file.convert` before
  Main rebuilds; the card follows Main's returned snapshot in both directions.
  Once started, the live card, status, cancel, and retry controls survive
  permission removal, invalid `workflow.json`, editor switching, and
  state-preserving HMR; a new run, project/session invalidation, or store
  disposal clears the execution ID and capability together, and a stale run
  result cannot attach its capability to a newer execution;
- quitting with a conversion in flight and reopening the same local profile
  recovers the job as interrupted, while explicit retry advances its epoch and
  produces a verified durable artifact;
- an invalid signed-pack root fails visibly without consulting a PATH sentinel,
  and an absent explicit root skips with an external-gate message rather than
  falling back to host tools;
- real repository rows and app-owned fixture files cover narrow and wide chat,
  long unbroken names, page and icon-representation metadata, download,
  action-pending, error, deleted, remote-only, keyboard-focus, dark, and 200%
  zoom states. Main's persisted dark setting/native-theme state is asserted;
  Playwright emulates the corresponding Renderer media query for deterministic
  screenshot capture. Final computer-use visual inspection remains pending.

The page/representation screenshots remain visual fixture evidence. A later
Task 14 production-runtime closure separately proves real multi-output process
acceptance: three PDF pages and three ICNS/ICO representations cross the job
runner, per-output content and metadata verification, one atomic SQLite job and
artifact transaction, and durable artifact reads. The existing card lists all
artifacts; collapsible grouping remains presentation behavior rather than a
storage/runtime gap.

The ordinary Electron entrypoint now installs an owner-bound production
runtime factory. It reads only packaged `converter-packs/bootstrap.json` and a
packaged root key through no-follow stable handles, accepts only an HTTPS index
and sibling signature fetched under one controlled network lease with streamed
byte caps, and never consults `PATH`. The checked-in bootstrap keeps downloads
disabled and carries no key, so an unreleased build remains deterministically
unavailable. Windows also remains unavailable unless Main receives a real Job
Object process-tree port.

Before adapter planning, the runtime copies the already-owned no-follow input
handle into an exclusive private work directory, verifies size, hash, inode and
timestamps, and passes only that private path to the fixed adapter. Every plan
must declare a complete, unique output mapping directly inside that work root.
The artifact service validates every output and its page/representation
metadata before moving all leaves into one exclusive per-batch result directory
and committing job completion plus every ready artifact in one transaction.
Failure, cancellation, stale epoch, or CAS loss produces no ready subset; the
whole exact batch directory is atomically retained under the owner-local
`.trash` quarantine, including when staging cleanup fails. ICO probes retain
ordered source indexes, dimensions and payload hashes, deduplicate only equal
dimension-plus-hash entries, and persist truthful representation metadata.

The startup recovery closure was also developed against discriminatory tests.
Before wiring, the orphan-batch, rollback/CAS residue, symlink, replacement,
and destination-conflict group reported **5 failed / 1 passed**; rollback
directory identity evidence separately reported **1 failed / 27 skipped**.
The directory-rename no-clobber review then added two focused REDs: an empty
destination created after Application's pre-check reported **1 failed / 276
skipped**, and the same empty-container race in normal artifact rollback
reported **1 failed / 28 skipped**. Both paths now use the same exclusive
container plus nested payload layout.
The completed implementation covers a crash after durable batch moves but
before the SQLite CAS, normal completed multi-output ownership, forged
in-flight ownership, anonymous extra leaves, same-owner double binding,
symlink escape, source replacement, empty and non-empty quarantine conflicts,
and rollback-leaf replacement. Normal reconciliation is idempotent; a detected
conflict remains durably fail-closed until the user clears local data.

This local Darwin arm64 fixture evidence is not release acceptance. Production
signing keys and index, hosted packs and CDN behavior, all twelve production
platform/architecture pack coordinates, third-party license review, real
Darwin x64 and Windows x64 execution, code signing, hardened runtime,
notarization, quarantine behavior, production privacy review, and update or
rollback drills remain external Task 13 gates. Real CloudBase/PostgreSQL sync,
RLS, storage, and cross-device evidence remains an external Task 12 gate.

## Technical References

- libvips documents format-specific loaders/savers and bounded file/buffer
  operations: <https://libvips.github.io/pyvips/vimage.html>
- FFmpeg documents supported formats/codecs and exposes runtime `-formats` and
  `-codecs` enumeration: <https://www.ffmpeg.org/general.html>
- FFmpeg's command documentation defines local input/output conversion and the
  option model that adapters must constrain: <https://ffmpeg.org/ffmpeg.html>
- Electron documents `webContents.printToPDF()` for local HTML/text rendering:
  <https://www.electronjs.org/docs/latest/api/web-contents>
- The Document Foundation documents headless batch conversion through
  LibreOffice's `--convert-to` parameter:
  <https://wiki.documentfoundation.org/images/c/c8/LibOBasic_08_Params_Flat_A4_EN_v103.pdf>
