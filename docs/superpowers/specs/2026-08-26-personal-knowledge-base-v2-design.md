# AutoForge v2 Personal Knowledge Base Design

**Date:** 2026-08-26

**Status:** Approved; Task 4 cloud-catalog and consent-revocation expansion approved 2026-08-28

**Base:** `origin/v2@a2bd28dd4da10aec6aa68113484ba480991fc672`

**Scope:** Personal knowledge bases only. Enterprise, team, sharing, and ACL are deferred.

## 1. Outcome and routing

AutoForge users can create personal knowledge bases, import supported local documents into encrypted local storage, optionally synchronize them through CloudBase when entitled, select zero or more bases per conversation, and receive answers with verifiable citations.

Electron Main owns the routing order:

1. execute an eligible workflow;
2. after no workflow applies, an eligible workflow completes, or a composite request continues, search the current conversation's captured knowledge snapshot;
3. ask the current chat model to synthesize the final answer.

Retrieval supplies evidence; it never independently generates the final answer. Exact workflow-only requests keep the existing rule that browser continuation tools are not model-visible. Composite and later messages retain the current browser continuation behavior. Workflow permission, execution, and cancellation errors remain visible and cannot be hidden by fallback.

## 2. Clean-room v2 implementation rule

This branch is a new implementation from current v2. It must not merge, rebase, or bulk cherry-pick `codex/personal-knowledge-base`.

Only these historical points may be inspected with `git show` or a narrow per-file diff:

- `43cb4f6`: local Tasks 1–5 design, tests, and algorithms;
- `04bf6d7`: first CloudBase sync repair, known to remain unsafe around cancellation.

Any production code inspired by those commits is rewritten against current v2 and starts with a failing current-branch test. The old branch's test counts and platform claims are not evidence for this branch.

## 3. User-visible behavior

### 3.1 Knowledge workspace

Add `/knowledge` between Chat and Workflows. The page has three stable regions:

- left: personal knowledge-base list and creation controls;
- center: logical files, import/replace controls, and local/cloud processing state;
- right: selected file metadata, immutable versions, synchronization details, and sanitized errors.

Persistent import happens only on this page. Chat attachments never enter a knowledge base automatically. Supported files are text-layer PDF, DOCX, UTF-8 TXT, Markdown, and HTML. OCR, scanned PDFs, encrypted PDFs, PPTX, XLSX, file watching, and URL ingestion are excluded.

Only a published `ready` version is searchable. UI states distinguish local processing, upload, cloud parsing, indexing, ready, failed, paused, read-only, deleted, and keyword-only.

### 3.2 Conversation selection

New conversations select no knowledge bases. Each conversation stores zero or more selected base IDs plus `mixed | strict` mode in the existing versioned conversation metadata.

- `mixed`: knowledge-backed claims are identified, and any model-general material is explicitly labeled.
- `strict`: material claims require current-turn evidence; insufficient evidence produces a bounded refusal.

At request admission, Main captures owner, conversation revision, selected bases, immutable document versions, and index generations. Later imports, deletes, remote pulls, or index switches cannot alter the in-flight scope.

### 3.3 Citations

Citation coordinates are format-specific:

- PDF: page and best-effort position;
- DOCX: heading path and paragraph identity;
- TXT: line and character range;
- Markdown/HTML: sanitized structural path.

History stores only immutable document/version/coordinate references. It never stores local paths, hidden chunks, query text, keys, or permanent/signed URLs. Purged or inaccessible sources render `source unavailable`.

## 4. Current v2 integration boundaries

### 4.1 Identity, stores, and lifecycle

The feature reuses the current CloudBase authentication, UID, per-user store binding, device identity, and account lifecycle. It does not create another authentication layer, session cache, conversation outbox, or device registry.

`Application` remains the owner of admission. Knowledge services bind only after the authenticated user-data store is admitted. Binding tokens contain the UID and an owner generation. Logout, account switch, discard, and shutdown invalidate the generation before awaiting remote or parser work, cancel/drain jobs, close encrypted connections, clear key material, and reject late callbacks.

The knowledge database and object directory are separate per-user encrypted stores because current v2 user-data SQLite cannot contain plaintext knowledge names, filenames, blocks, chunks, queries, or FTS data.

### 4.2 Conversation sync

Knowledge selection extends the existing conversation preference payload and the current `conversation.preferences` revision/outbox/CAS path. It must converge through `UserDataSyncEngine` and CloudBase user-data contracts. No separate local-only conversation-selection table is allowed.

A local manual update and a late remote update use the existing conversation revision rules. Renderer reads authoritative state after conflict or pull; an owner generation prevents an earlier user's response from repopulating the Pinia store.

### 4.3 Agent and context

The current leading system policy, `WORKFLOW_AGENT_POLICY`, tool-capable model checks, `workflowLaunchOnlyRequest`, browser continuation rules, `leadingMessages`, context budgeting/compression, Provider snapshot, and usage attribution remain intact.

`knowledge_search` is a Main-owned evidence tool. The model supplies only a bounded `query` or `rewrite`. Main supplies owner, base scope, entitlement, consent, `topK`, and index snapshot. Per turn: workflow calls <= 5, knowledge searches <= 3, Agent decisions <= 10, and at most eight evidence items total across all current-turn knowledge searches. The immutable current-turn evidence registry, Provider payload, citations, and persisted citation references all use that same total cap; a later search may replace or add to the registry only while the total remains at most eight.

Evidence is wrapped as untrusted content and cannot change system policy, tool permissions, or routing. Context summaries may retain citation coordinates but must exclude hidden chunks, local paths, and signed URLs.

## 5. Trusted IPC contract

Renderer is untrusted. Shared Zod schemas, Preload, IPC, and Main reject unknown keys and never accept caller-provided:

- `userId` or owner scope;
- local/database/object paths;
- SQL, FTS expression, `topK`, or index/generation ID;
- entitlement truth or Provider consent truth.

Main may accept opaque knowledge-base/document IDs only where the authenticated owner and conversation snapshot independently authorize them. Availability separately reports local encryption, parser, CloudBase, embedding, entitlement, beta, and cloud gates.

## 6. Local encrypted storage

Pin `better-sqlite3-multiple-ciphers@13.0.3` only after an Electron 43 packaging/runtime probe passes. Current macOS arm64 must be verified. macOS x64 and Windows x64 remain fail-closed until separately verified.

Each UID receives a random database key protected by Electron `safeStorage`. Active/pending wrapped-key slots make rekey crash-safe. `PRAGMA temp_store=MEMORY` and FTS5/trigram support are probed before sensitive work. There is no plaintext fallback.

The encrypted schema contains bases, logical files, immutable versions, blocks, chunks, external-content trigram FTS, durable jobs, sync cursors, conflicts, tombstones, and cleanup records. AEAD source objects use random per-file keys wrapped by a domain-separated master object key.

Tests scan database, WAL, journal, temp, and crash-recovery artifacts for a sentinel and cover correct/wrong keys, checkpoint, rollback, pending-key recovery, and rekey.

## 7. Restricted parsing

Parsing runs in a sandboxed Electron utility/renderer process or equivalently proven isolated process with no Node integration and no network. It receives an encrypted snapshot and one-time file key, not the master key, credentials, or unrestricted filesystem access.

Use PDF.js, Mammoth, fatal `TextDecoder`, unified/remark, and parse5 with script/external-resource removal. Enforce file, expanded ZIP, page, text, block, memory, wall-time, and response-size limits. Cancellation and shutdown kill the worker and remove temporary material. Errors distinguish encrypted PDF, scanned PDF, malformed, limit exceeded, cancelled, timed out, and unsupported.

## 8. Local service and retrieval

The service supports create, list, import, atomic replace, immutable versions, recycle, restore, purge, and export. Import acknowledgement returns within one second and processing continues through a durable job. Publication uses generation/token CAS; a failed job never replaces the prior ready generation.

For three or more Unicode characters, Main constructs a literal trigram `MATCH`. Two characters use bounded `instr` within captured selected scope. One character returns a request-for-detail result. Non-members are enforced in Main to one local base and one active logical file, with atomic replacement.

Exports contain originals, `manifest.json`, metadata, and version lists. They contain no vectors, paths, keys, queries, hidden chunks, or permanent URLs.

## 9. CloudBase synchronization

Cloud artifacts target `autoforge-d1gkhyfb419ba8455` in `ap-shanghai` through a separate `autoforge-knowledge` function and migrations. This branch does not modify the real environment.

The design reuses current user-data conventions: trusted-context UID derivation, service-role only inside functions, strict wire limits, sanitized errors, default-deny RLS/GRANT, private Storage tickets, object-key validation, mirrored canonical/deployment migrations, data-preserving rollback, and runbook gates.

Remote data includes bases, objects, documents, immutable versions, blocks/chunks, generations, jobs/leases, monotonic changes, 90-day retention floors, tombstones, conflicts, upload tickets, and entitlement projections. All owner/base/document/object relations use composite keys.

Incremental pull returns page-last sequence and `hasMore`; clients reject non-progress loops. Stale or zero cursors receive a complete snapshot. Jobs use lease token/expiry/CAS/idempotency; only transient errors retry, at most three times, and the third expired lease becomes terminal failed.

Every base sync is serialized and bound to a per-base epoch. `pause`, `cancel`, owner invalidation, and local conversion increment that epoch. The client rechecks it after every remote await and before every local write. In particular, a mutation that succeeds remotely after cancellation must not allow its later pull result to enter the cancelled run.

Converting to local-only persists an operation/request ID, downloads and verifies all content, requests cloud deletion, waits for storage bytes and metadata purge, then publishes `local_only`. Pause does not delete cloud state.

Without authorized staging CloudBase/PostgreSQL/Storage access, only artifacts and local contract tests are delivered; cloud kill switch stays off and no RLS/Storage claim is made.

### 9.1 Owner catalog and cold-start discovery

Cross-device synchronization cannot assume that a new device already knows a knowledge-base ID from local state or conversation preferences. The trusted CloudBase knowledge boundary therefore exposes an owner-scoped, stable, bounded catalog snapshot of every non-deleted personal knowledge-base ID. The function derives the owner only from trusted CloudBase context; Electron never supplies an owner ID.

Catalog pages bind one snapshot ID to an exact ordinal sequence, reject duplicates/non-progress, and expire through bounded cleanup. The client first obtains the complete catalog, then performs the existing per-base full/incremental synchronization. Only after every listed base synchronizes successfully may one local transaction prune remote-only projections absent from that completed catalog. A partial, malformed, expired, or cancelled catalog never prunes local projections.

Cold-start acceptance begins with no local knowledge base, no remote projection, and no conversation selection. Listing knowledge bases discovers the owner's catalog, materializes each base/document/version/generation projection, and leaves every cloud-only version marked as lacking a verified local object. Catalog discovery, per-base pull, and pruning are all fenced by owner generation and current cloud-sync consent.

### 9.2 Authoritative cloud-sync consent lifecycle

`privacy_consents` purpose `cloud_sync` is the only authorization for knowledge upload, publication, owner-catalog discovery, Cloud retrieval, and Cloud search. The current state is a versioned `accepted | revoked` projection keyed by owner and purpose; accepted consent and revocation are explicit sync mutations protected by optimistic revision checks. A late accepted mutation cannot overwrite a newer revocation, and a late revocation cannot cross an owner generation.

Main advances the knowledge cloud-access epoch synchronously when local acceptance or revocation commits and when a remote consent projection is applied. Revocation pauses new Cloud work before any asynchronous flush; in-flight work captured under an older consent revision fails closed before every remote await or local commit. Re-acceptance advances the revision again and opens Cloud work only for subsequently captured operations. Local management and local retrieval remain available throughout.

The Renderer receives only the authoritative current state and may request a confirmed `cloud_sync` revocation through a strict Shared/Preload/IPC contract. It cannot supply owner IDs, revisions, entitlement truth, or knowledge epochs. The user-data Cloud function derives owner identity from trusted context, serializes changes under the existing owner lock/OCC boundary, and returns the current revision through normal pull convergence.

## 10. Embeddings and hybrid retrieval

Embedding consent is separate from chat Provider disclosure. TokenHub processing occurs in Guangzhou with `kinfra-text-embedding-0.6b`, 1024 dimensions; source files, chunks, and vectors persist in Shanghai.

Consent revocation stops new sends immediately, deletes vectors, and retains keyword-only retrieval. Deterministic reciprocal-rank fusion combines Chinese keyword and vector candidates. Exact cosine serves small sets; HNSW requires benchmark evidence.

Model/configuration versions are recorded. Drift probes build a shadow generation, atomically switch publication, and retain the previous generation for seven days. Provider failure leaves the last published generation available; unpublished generations never search.

## 11. Provider consent, grounding, and citations

Before evidence snippets are sent to a chat Provider, Main requires first-use consent for that Provider. Switching Provider requires a new consent. Refusal displays retrieval results locally and sends no snippets.

Main validates every citation ID against current-turn evidence. One repair attempt is allowed. Strict mode fails closed if unsupported material remains. Mixed mode labels general-knowledge material. Citation previews render sanitized local content without exposing path or permanent URL.

## 12. Entitlement and degradation

Main verifies signed snapshots containing user, entitlements, `issuedAt`, `expiresAt`, and `keyId` against a built-in public key. Renderer entitlement state is display-only. Offline grace is 72 hours. Beta needs `knowledge_base_beta`; cloud needs `knowledge_base_cloud`.

After expiry, the user chooses one local base/file to remain active. Other local data stays encrypted, read-only, exportable, and deletable but not searchable. Cloud operations/search stop. Cloud content has a 30-day download/export/convert window followed by a 30-day recycle period.

The cloud kill switch removes cloud operations and the cloud knowledge tool catalog without disabling local management, export, delete, or already-consented local retrieval.

## 13. Privacy and observability

Normal logs contain safe IDs, counts, states, durations, sizes, and stable error codes only. They exclude queries, body/chunk text, filenames, local paths, Provider payloads, credentials, and signed URLs.

Before beta, disclosure covers CloudBase Shanghai, TokenHub Guangzhou, the chat Provider, purposes, retention, export/deletion, consent, membership degradation, and disabled/unverified gates.

## 14. Acceptance gates

- zero cross-user leakage;
- sentinel absent from all persisted encrypted-store artifacts;
- Recall@8 >= 90%;
- citation support, grounded answers, and correct no-evidence behavior each >= 95%;
- valid supported-document success >= 99%;
- local 10,000-chunk FTS p95 <= 300 ms;
- cloud retrieval excluding final LLM p95 <= 2 s;
- import acknowledgement <= 1 s;
- 100-page text PDF ready p95 <= 2 minutes;
- real Electron flow: login -> create -> import -> ready -> conversation select -> retrieval -> citation preview -> export -> delete -> logout/account switch.

Cloud, embedding, signed-key, cross-platform packaging, benchmark, and consent gates remain disabled until their corresponding evidence passes.

## 15. Recorded origin/v2 baseline

On the clean worktree at the base commit:

- `pnpm build`: pass;
- `pnpm lint`: fail with one error in `cloudbase/user-data/function/user-data-handler.js` plus 314 warnings;
- `pnpm typecheck` after build: fail with seven diagnostics across the Cloud user-data E2E port, browser visual usage attribution, sync-status narrowing, and CloudBase error-code narrowing;
- `pnpm test`: 3042 pass, 3 fail (renderer message `createdAt`, legacy-import temporary-directory cleanup, and context-summary billing);
- real Electron Cloud user-data Playwright smoke: first test times out waiting for the rename action, remaining serial cases do not run.

These failures are evidence, not exemptions to conceal. Knowledge-specific suites must pass. Final reporting must reproduce and separate unchanged base failures from branch regressions, and any overlap with knowledge changes must be fixed rather than waived.
