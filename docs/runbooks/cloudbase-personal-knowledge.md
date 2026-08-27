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

1. Apply the migration in an isolated staging database. Prove every knowledge
   table has forced RLS, direct client roles have no table or RPC grants, all
   owner/base/document/object joins use their composite owner keys, and the
   entitlement row defaults to `kill_switch_enabled = true`.
2. Deploy the reviewed CommonJS `autoforge-knowledge` function with
   `AUTOFORGE_PG_RPC_BASE_URL`, `AUTOFORGE_PG_STORAGE_BASE_URL`, the exact HTTPS
   `AUTOFORGE_PG_STORAGE_UPLOAD_URL_PREFIX`, and `AUTOFORGE_PG_SERVICE_KEY`
   supplied only by the server-side secret manager.
   Confirm the deployed checksum and the one-MiB response ceiling.
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
6. Verify pull pages stay within both 512 rows and 768 KiB, use the page-last
   sequence, and make progress while `hasMore` is true. Verify a zero or
   retention-floor cursor receives one transactionally materialized,
   owner-scoped snapshot through bounded stable pages,
   and the 90-day cleanup advances the durable floor before pruning changes.
7. Verify job claim and completion CAS with token and expiry. Only
   `TRANSIENT_FAILURE` may retry, at most three attempts; the third expired
   lease becomes terminal `failed`.
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
3. Withdraw the function, then apply
   `cloudbase/knowledge/migrations/0001_personal_knowledge.rollback.sql`
   through the approved database process.
4. The rollback revokes the service-role function/table surface and drops
   externally callable RPC functions. It deliberately retains all tables,
   accepted rows, forced RLS policies, composite relationships, and immutable
   lifecycle guards.
5. Confirm zero knowledge traffic and retain authorized operator access for
   reconciliation. Do not drop, truncate, or delete accepted data.
