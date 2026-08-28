# CloudBase personal knowledge rollout runbook

## Boundary

These artifacts target CloudBase environment `autoforge-d1gkhyfb419ba8455` in
`ap-shanghai`. This document is an operator runbook only. Repository builds,
tests, commits, and pushes must not apply migrations, deploy functions, create
Storage objects, or change feature flags.

Keep the cloud knowledge kill switch closed until every staging gate below has
recorded reviewer-approved evidence. Never record credentials, raw UIDs, source
content, local paths, object URLs, upload headers, or service-role diagnostics.

## Required artifact record

Before any authorized staging work, record:

- application commit and reviewer;
- SHA-256 checksums for both byte-identical forward migrations, the rollback,
  and the function directory;
- PostgreSQL, CloudBase Function, and PG Storage runtime versions;
- environment, operator, rollback owner, and observation window.

Stop if the two forward migrations are not byte-identical.

## Staging gates

1. Apply `0001_personal_knowledge.sql` and then the additive
   `0002_personal_knowledge_workers.sql` in an isolated staging database. Prove every knowledge
   table has forced RLS, direct client roles have no table or RPC grants, all
   owner/base/document/object joins use their composite owner keys, and the
   entitlement row defaults to `kill_switch_enabled = true`.
2. Deploy the reviewed CommonJS `autoforge-knowledge` function with
   `AUTOFORGE_PG_RPC_BASE_URL`, `AUTOFORGE_PG_STORAGE_BASE_URL`, the exact HTTPS
   `AUTOFORGE_PG_STORAGE_UPLOAD_URL_PREFIX`, and `AUTOFORGE_PG_SERVICE_KEY`
   supplied only by the server-side secret manager.
   Confirm the deployed checksum and the one-MiB response ceiling.
   Separately package `cloudbase/knowledge` from its root `index.js` and root
   `package.json`, deploy it as the scheduled `autoforge-knowledge-worker`, and
   inject the PostgreSQL RPC/Storage service credentials plus TokenHub endpoint
   and key only from the server-side secret manager. Its private Storage adapter
   additionally requires `POST /objects/read` with an exact byte-size/SHA-256
   response contract. Preserve `worker/parser-process.js`, `worker/parser-child.js`,
   and the version-aligned parser dependencies in `worker/package.json`; run a
   package-resolution smoke with the release Node runtime before deployment.
   Do not set `AUTOFORGE_KNOWLEDGE_MUTATION_PERMIT_PORT_VERSION=db-job-v1`
   until both private services implement the reviewed `mutation-permit-port.js`
   contract: PG Storage must validate `storage_delete` immediately before each
   object delete and return the validation receipt header; TokenHub must validate
   `tokenhub_embedding` immediately before each send and return
   `mutationPermitValidated: true`. Both validations call
   `autoforge_knowledge_validate_job_mutation_permit` with the same opaque
   worker/job/lease capability. Without both handlers the scheduled worker is
   intentionally unstartable.
   Never expose worker RPCs or worker credentials to Electron.
3. With anonymous, Alice, and Bob staging identities, probe every action.
   Anonymous and forged-owner events must fail; cross-owner reads, upload
   tickets, publications, jobs, cleanup, and deletion must expose and mutate
   zero rows.
4. Verify a ticket is single-use, expires after fifteen minutes, and is bound to
   the exact owner, base, object, byte size, SHA-256, and MIME type. Verify only
   private HTTPS PUT authorizations are returned and no permanent URL or
   service credential reaches Electron.
5. Verify immutable staging generations: a failed parser/index job leaves the
   prior published generation active; publication requires both the expected
   prior generation and a ready candidate.
   For every upload, verify the credentialed scheduler launches a fresh parser
   child whose environment contains no RPC, Storage, TokenHub, proxy, service-role,
   or provider credential and whose network APIs are denied. Exercise the exact
   parser ceilings before or during accumulation: 64 MiB input, 32 MiB expanded
   DOCX and 100x compression ratio, 1000 PDF pages, 16 MiB text, 10000 blocks or
   chunks, 768 KiB result, 832 KiB response frame, and 128 MiB V8 old-space.
   Treat the parent's 192 MiB RSS sampler only as a post-allocation kill guard,
   never as a kernel memory limit; require cgroup, rlimit, or an equivalent hard
   boundary in the release runtime. Cancellation, timeout, child crash,
   malformed/duplicate/late frames, and parser dependency failure must kill and
   close that request's process, zero its source bytes, fail closed, and never
   complete a different lease. Confirm the scheduler's 120-second parser deadline
   remains below its 600-second lease.
6. Verify pull pages stay within both 512 rows and 768 KiB, use the page-last
   sequence, and make progress while `hasMore` is true. Verify a zero or
   retention-floor cursor receives one transactionally materialized,
   owner-scoped snapshot through bounded stable pages,
   and the 90-day cleanup advances the durable floor before pruning changes.
7. Verify job claim, bounded embedding yield, and completion CAS with token and expiry. Claim
   must create the opaque mutation permit and deadline with PostgreSQL's clock;
   worker SQL, PG Storage, and TokenHub must reject a stale or mismatched capability
   using only the stored DB deadline and lease, even when the worker wall clock is
   skewed both ahead and behind. Exercise acknowledged abort and an ignored-abort
   transport: the former must quiesce inside the reserve; the latter must terminate
   the current scheduled execution containment with no later side effect. Only
   `TRANSIENT_FAILURE` may retry, at most three attempts; the third expired
   lease becomes terminal `failed`. A successful two-chunk embedding slice must
   persist its vectors, yield the exact live lease back to `queued`, and preserve
   the accumulated transient-failure count rather than consuming a retry.
8. Verify purge order by instrumenting PG Storage and PostgreSQL: private bytes
   must be deleted before metadata cleanup is acknowledged. A failed Storage
   deletion must leave the durable cleanup/deletion job incomplete. The worker
   must call `autoforge_knowledge_prepare_base_purge`, delete the exact returned
   set, and only then call `autoforge_knowledge_complete_base_purge`; neither RPC
   may be reachable from Electron.
9. Run two release-equivalent Electron profiles. Hold a remote mutation,
   cancel the base locally, let the mutation commit and become pull-visible,
   and prove that cancelled run applies no local mutation, snapshot, or cursor.
   Also cover pause, account switch, offline replay, conflicts, and restart of a
   partially completed local-only conversion.
10. Compare owner-scoped counts and deterministic hashes, then obtain product,
    security, database, CloudBase, Storage, desktop, and rollback-owner signoff.
    Only the approved control plane may open the kill switch.

## Monitoring

Monitor aggregate rates only: authorization denial, response rejection,
upload-ticket conflict, job lease expiry, retry, publication conflict,
cursor-stale snapshot, no-progress rejection, deletion backlog, and local/cloud
hash mismatch. Any cross-owner exposure, credential disclosure, skipped page,
publication regression, or metadata-before-Storage purge is an immediate stop.

## Data-preserving rollback

1. Close the cloud kill switch and stop cloud writes, reads, uploads, workers,
   and retention cleanup.
2. Preserve desktop outboxes and conversion journals.
3. Stop the scheduled worker, withdraw both functions, then apply
   `cloudbase/knowledge/migrations/0002_personal_knowledge_workers.rollback.sql`
   followed by `cloudbase/knowledge/migrations/0001_personal_knowledge.rollback.sql`
   through the approved database process.
4. The rollback revokes the service-role function/table surface and drops
   externally callable RPC functions. It deliberately retains all tables,
   accepted rows, forced RLS policies, composite relationships, and immutable
   lifecycle guards.
5. Confirm zero knowledge traffic and retain authorized operator access for
   reconciliation. Do not drop, truncate, or delete accepted data.
