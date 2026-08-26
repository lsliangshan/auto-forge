# Personal Knowledge Base Design

**Date:** 2026-08-26
**Status:** Approved for implementation
**Scope:** Personal knowledge bases only; enterprise/team knowledge bases are explicitly deferred.

## 1. Product outcome

AutoForge users can create personal knowledge bases, import local documents, optionally synchronize them to CloudBase, and let chat answers use those documents as cited evidence. The answer router is authoritative in Electron Main and applies this priority:

1. invoke an eligible workflow;
2. search the knowledge bases selected for the conversation when eligible;
3. ask the configured AI model for the final response.

Knowledge retrieval is an evidence tool, not a second answer generator. A final LLM synthesis is still required unless the user denied provider disclosure, in which case the app shows retrieval results without sending snippets to the provider.

## 2. Scope and rollout

### Included

- Named personal knowledge bases and a lazily-created “我的知识库”.
- Snapshot import for text-layer PDF, DOCX, UTF-8 TXT, Markdown, and HTML.
- Encrypted local persistence and Chinese keyword retrieval.
- Optional CloudBase synchronization, parsing, indexing, and hybrid retrieval.
- Chat knowledge-base selection, strict/mixed modes, grounded citations, and source preview.
- Membership entitlements, downgrade handling, export, recycle bin, purge, diagnostics, and a cloud kill switch.

### Deferred

- Enterprise/team knowledge bases and sharing.
- OCR and scanned-PDF recognition.
- PPTX/XLSX, folder watching/import, external-resource fetching, and public links.
- Disaster-grade backup guarantees and payment/checkout implementation.

The work is delivered in four independently gated phases: local foundation, CloudBase sync, Agent/citations, then membership/rollout. A phase may remain disabled until its security and packaging gate passes.

## 3. User-visible behavior

### 3.1 Knowledge page

Add `/knowledge` between Chat and Workflows in the main navigation. Its layout has:

- left: knowledge-base list and create/select controls;
- center: files, import action, and copy/upload/parse/index/ready/fail/pause/delete states;
- right: selected-file metadata, immutable versions, sync/index state, processing location, and actionable errors.

Only a published `ready` version is searchable. Persistent imports happen only on this page; chat attachments never silently become knowledge files.

### 3.2 Chat selection

The composer shows a knowledge selector beside output type/model. Selection is zero or more knowledge bases and is persisted per conversation. A new conversation selects none.

Modes:

- `mixed` (default): retrieved evidence may be combined with general model knowledge, but the answer labels that separation.
- `strict`: every material claim must be supported by current-turn evidence; if evidence is insufficient, the assistant refuses to invent an answer.

The current request captures an immutable selection/index snapshot. Imports, deletes, or index switches during the turn do not change it.

### 3.3 Preview and citations

- PDF citations include page and best-effort position in an in-app controlled preview.
- DOCX citations use heading path and paragraph identity; the UI never invents page numbers.
- Markdown/HTML use sanitized structural preview.
- TXT uses line/character coordinates.

Each knowledge-supported material statement gets a nearby citation. The answer also ends with a compact sources summary. Historical messages store immutable document/version/coordinate references, never permanent signed URLs, local paths, or hidden full chunks. Deleted or purged sources render as unavailable.

## 4. Entitlements and lifecycle

Knowledge bases are an APP membership benefit, not separately metered billing.

- Non-member: at most one local knowledge base containing one active logical file. Replacing the sole file is atomic.
- Paid member: multiple local knowledge bases and CloudBase sync.
- Beta access additionally requires `knowledge_base_beta` while the beta gate is enabled.
- Cloud access requires `knowledge_base_cloud`.

Main validates a signed entitlement snapshot containing user, entitlements, issued time, expiry, and key id with a built-in public key. Renderer state is advisory only. Offline grace is 72 hours.

After membership expiry:

1. user selects one local knowledge base/file to remain active;
2. other local data remains encrypted, read-only, exportable, and deletable, but not searchable;
3. cloud operations and cloud search stop;
4. cloud content is downloadable/exportable/convertible to local-only for 30 days;
5. it then enters a 30-day recycle period before purge.

Fair-use storage, queue, rate, and concurrency limits are public and benchmarked before beta. They are safety limits, not overage charges.

## 5. Local trust boundary

### 5.1 Storage

Every logged-in user has a separate encrypted knowledge database. The existing application database may store only opaque references and health flags—never knowledge-base names, filenames, chunks, or search terms.

Use `better-sqlite3-multiple-ciphers@13.0.3` only after a packaging POC passes on macOS arm64/x64 and Windows x64. If the encrypted driver, FTS5, safe storage, or packaging gate fails on a platform, knowledge bases fail closed there; plaintext fallback is forbidden.

Connection requirements:

- random 32-byte database key;
- Electron `safeStorage` wraps keys in Main;
- HKDF domain separation for database, object wrapping, and ancillary keys;
- `PRAGMA temp_store=MEMORY` set and verified before sensitive work;
- active/pending wrapped-key slots for crash-safe rekey;
- key and sensitive buffers cleared best-effort after use;
- logout closes connections, terminates parsers, and clears keys/caches.

Source snapshots are AEAD-encrypted objects. Each file has a random file key wrapped by the user master key. Metadata, versions, blocks, FTS structures, jobs, cursors, and conflicts live in the encrypted database.

The POC must demonstrate that sentinel plaintext is absent from the database, WAL, journal, and temp paths, and that correct-key, wrong-key, crash-recovery, checkpoint, and two-slot rekey behavior are correct.

### 5.2 Parsing

Parsing runs in a restricted child process. It receives only an encrypted object and a one-time file key, never the master key, provider credentials, CloudBase secrets, or unrestricted network access. It decrypts in memory and enforces decompression, page, text, time, and memory budgets.

Parsers:

- PDF.js with scripting disabled for text-layer PDFs;
- Mammoth for DOCX, followed by sanitization;
- `TextDecoder` with fatal UTF-8 handling for TXT;
- unified/remark for Markdown;
- parse5 plus sanitization for HTML, with external resources disabled.

Parser output is versioned structural blocks with stable coordinates and normalized plain text. Unsupported/encrypted/scanned documents produce explicit errors.

### 5.3 Local retrieval

Use external-content FTS5 over chunks:

```sql
CREATE VIRTUAL TABLE kb_chunks_fts USING fts5(
  body,
  content='kb_chunks',
  content_rowid='rowid',
  tokenize='trigram',
  detail=full
);
```

Writes to content and index are one transaction. Queries of three or more Unicode characters use safely constructed literal `MATCH`; two-character queries use bounded `instr` inside selected knowledge bases; one-character queries ask for more detail. Local result count is capped by Main.

## 6. CloudBase architecture

Cloud mode uses environment `autoforge-d1gkhyfb419ba8455` in `ap-shanghai`. Electron Main authenticates with the user's CloudBase session JWT and uses PG Storage/SQL under RLS. Service-role credentials and direct COS bypass are forbidden in the client.

Cloud schema owns knowledge bases, encrypted/raw objects, documents, immutable versions, parser runs, blocks/chunks, index generations, jobs/leases, sync change sequence/tombstones, conflicts, and entitlements. Cloud Functions own state transitions; RLS is defense in depth.

Synchronization rules:

- local-only content remains authoritative on device;
- synced content is canonical in CloudBase with a local cache;
- enabling sync stages the whole knowledge base and atomically publishes only after upload, parse, and index succeed;
- the prior ready generation remains usable during staging or failure;
- offline mutations queue with a base version and remain locally usable;
- incremental sync uses a monotonic sequence and 90-day tombstones; stale cursors trigger full resync;
- content conflicts preserve both versions; delete-vs-update asks the user; low-risk metadata uses last-write-wins;
- pause sync and convert to local-only are separate operations;
- conversion downloads and verifies everything before cloud deletion.

Persistent jobs use leases/tokens/expiry/CAS and idempotent state transitions. Only transient failures retry, at most three times. Cancellation and orphan cleanup are required.

## 7. Embeddings and cloud retrieval

Synced document parsing is canonical in CloudBase. Embeddings use TokenHub `kinfra-text-embedding-0.6b`, 1024 dimensions, processed in Guangzhou. Raw files, canonical text/chunks, and vectors persist in Shanghai.

TokenHub disclosure/consent is separate from the chat provider consent. Revocation immediately stops new sends, deletes vectors, and leaves keyword-only cloud retrieval. Re-consent triggers re-indexing.

Cloud retrieval combines Chinese keyword and vector candidates using reciprocal-rank fusion. No external reranker is used in v1. Exact cosine is allowed for small candidate sets; HNSW is enabled only after benchmarks.

Every embedding/index generation records model and configuration. A probe detects drift. Drift queues new writes, builds a shadow index, switches atomically, and retains the previous generation for seven days. During provider outage or model deprecation, the last published index stays live; unpublished versions are not searchable and the system may degrade to keyword-only.

## 8. Agent routing and grounding

Main owns routing, tool catalogs, scopes, and budgets.

### 8.1 Priority

- An exact explicit request to “运行/打开/查询 + unique workflow”, or an exact activation match, forces workflow execution.
- Main resolves workflows first. It does not expose knowledge search until no workflow applies, the workflow completes, or the workflow explicitly allows a knowledge continuation.
- Composite requests may execute a workflow and then search knowledge.
- Workflow permission, execution, and cancellation errors remain visible and are never masked by a model fallback.

### 8.2 Budgets

- workflow invocations: at most 5 per turn;
- knowledge searches: at most 3 per turn;
- total Agent decisions: at most 10 per turn;
- knowledge search returns at most 8 evidence items.

The first release enables this path only for text output with a tool-capable model. Other output types pause workflow/knowledge tools.

### 8.3 Knowledge tool contract

The model may provide only a query/rewrite. Main fixes user identity, conversation selection, knowledge-base scope, entitlement, `topK`, and immutable index snapshot. The model cannot submit arbitrary knowledge-base ids, filesystem paths, SQL, or user ids.

Documents and tool output are untrusted evidence. They cannot change system policy, tools, permissions, or scope. The tool stage emits status cards rather than premature assistant prose; the final answer streams only after tool and citation validation.

Before snippets are sent to a chat provider, the user grants first-use consent per provider. Switching provider requires new consent. Only the minimum selected snippets are sent. Denial returns search results without LLM synthesis.

Main validates every citation id against current-turn evidence and attempts one citation repair. In strict mode, unresolved unsupported material fails closed. In mixed mode, unsupported general knowledge must be labeled as such.

## 9. Deletion, export, and recovery

- Recycle period: 30 days, with immediate purge available.
- Export: ZIP containing originals, `manifest.json`, metadata, and version list; no vectors, local paths, secrets, or permanent URLs.
- Local purge: delete wrapped file key, encrypted object, document/version/block/chunk/FTS rows; rebuild a fresh encrypted database excluding deleted data and rotate the DB key. The UI does not promise SSD byte overwrite.
- Cloud purge: remove storage objects, versions, text, chunks, vectors, jobs, caches, and access. The UI does not claim third-party physical backups disappear immediately.
- Corrupt synced data may be re-downloaded. Local-only recovery depends on user export, and the UI says so.

## 10. Observability and privacy

Normal diagnostics contain metrics, state transitions, timing, sizes, and error codes—not raw queries, chunks, document text, filenames, local paths, provider payloads, or signed URLs.

Before beta, privacy disclosure identifies CloudBase Shanghai, TokenHub Guangzhou, the selected chat provider, data purpose, retention, export/deletion behavior, membership expiry, and degraded modes.

A server kill switch removes cloud operations and the cloud/knowledge tool catalog. Local management, export, delete, and already-authorized local retrieval remain available.

## 11. Acceptance gates

Security and correctness:

- zero cross-user knowledge leakage in authorization tests;
- no plaintext sentinel leakage across encrypted persistence artifacts;
- Recall@8 at least 90% on the approved evaluation set;
- citation support, grounded-answer rate, and correct no-evidence behavior each at least 95%;
- valid supported-document processing succeeds at least 99%.

Performance under the benchmark profile:

- local FTS over 10,000 chunks: p95 at most 300 ms;
- cloud retrieval excluding final LLM: p95 at most 2 s;
- import acknowledgement: at most 1 s;
- 100-page text PDF reaches ready at p95 within 2 minutes under normal load.

Release sequence is beta entitlement, internal telemetry review, then gradual rollout. Technical safety limits are fixed only after benchmark evidence and are displayed to users.

## 12. Baseline exception

Before implementation, the repository had one stable unrelated failing test:

`electron/main/application.test.ts > createApplicationRuntime > bills real context-summary streams through the Application-supplied provider snapshot`

It returns `CONTEXT_LIMIT_EXCEEDED` where the test expects completion. This feature must not worsen or hide that failure. All newly introduced suites and targeted regression suites must pass; final verification reports the baseline exception separately.
