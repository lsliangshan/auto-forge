# Membership control plane

This directory owns the production membership control plane. The first consumer is the personal
knowledge base. Free accounts receive one local knowledge base and one non-purged document; Pro
accounts receive twenty knowledge bases and five hundred non-purged documents. Both plans cap one
file at 64 MiB.

## Security and authority

- `membership_accounts` is the current state. `membership_events` is immutable audit history.
- Only the Cloud Function service role may execute the membership RPC functions.
- The caller identity is taken from the CloudBase authenticated context, never from request data.
- Main requires confirmed `manage_memberships`; an authorized super admin may manage their own
  membership, and every mutation remains versioned and audited in PostgreSQL.
- Every Free and Pro snapshot is Ed25519 signed. The private key belongs only in a CloudBase
  Secret/KMS-backed function environment variable. It must never enter Git, PostgreSQL, an Electron
  bundle, a command line, a log, the clipboard, or a temporary file.
- The Electron bundle contains only the public verification key. Rotate with a new key id, ship the
  public key first, then switch the signer, and retire the prior verifier only after the 72-hour
  offline grace window plus the supported-client upgrade window.

Required function environment variables:

- `AUTOFORGE_PG_RPC_BASE_URL`
- `AUTOFORGE_PG_SERVICE_KEY`
- `AUTOFORGE_MEMBERSHIP_SIGNING_KEY_ID`
- `AUTOFORGE_MEMBERSHIP_SIGNING_PRIVATE_KEY`

## Production dark launch gate

Target: `autoforge-d1gkhyfb419ba8455`, region `ap-shanghai`.

Do not perform a production write until the operator has shown and recorded all of the following:

1. The exact environment id and region from an authenticated read-only CLI command.
2. The SHA-256 of `migrations/0001_membership_control_plane.sql`, byte-identical to the root
   timestamped migration.
3. A completed PostgreSQL manual backup id and timestamp from the Tencent Cloud PostgreSQL backup
   console.
4. One ordinary-user canary id (record only a non-reversible fingerprint in the rollout log) and
   confirmation that the operator can log into that account in Electron.
5. Confirmation that personal-knowledge cloud execution remains fail-closed during the rollout.
6. A Secret/KMS path that injects the Ed25519 private key without exposing it through files, command
   arguments, standard output, shell history, or repository configuration.

The repository root contains unrelated pending migrations. Never run a root-wide `tcb migration up`
for this launch. Copy only `migrations/0001_membership_control_plane.sql` to an empty `mktemp -d`
workspace, run a dry-run there, verify its hash again, and then apply that single migration.

### 2026-08-30 approved no-backup exception

The operator explicitly authorized this dark launch to continue without the backup required above.
This is a one-rollout exception, not a change to the production gate. The shared production database
had no confirmed manual backup or PITR boundary, so recovery remains limited to the additive rollback
described below and compensating membership mutations.

- Environment `autoforge-d1gkhyfb419ba8455`, region `ap-shanghai`.
- Migration SHA-256 `b3510a984a170fba22c78b331f3c6f1fd37b130b0569fe4f01419d1bbac0ad8b`;
  CloudBase task `task-c1627200` submitted only the five already-applied migrations plus the one
  membership migration, and the service executed only the latter. Seven unrelated root migrations
  were not submitted.
- `autoforge-membership` was deployed Active on Node.js 18.15 with key id
  `membership-2026-08`. The Ed25519 private key was generated in process memory and injected through
  child-process environment expansion; it was not printed or written to disk.
- Canary fingerprint `3f289aeb40e1` and administrator fingerprint `98ad26b8c62a` use the first 12
  hexadecimal characters of SHA-256 over the exact string user id. No raw user id is recorded here.
- The single canary completed Free v0 -> Pro v1 -> extended Pro v2 -> revoked v3 -> corrected Free
  v4. The revoke assertion initially expected Pro limits even though revoked memberships correctly
  project Free limits; its fail-safe compensation performed the final correction. Read-only RPC and
  rendered Electron verification then confirmed Free `1 / 1`, 64 MiB, and exactly four immutable
  audit events in reverse order: `correct`, `revoke`, `extend`, `grant`.
- Personal-knowledge cloud execution remained fail-closed throughout the rollout.

Use `scripts/run-production-canary.mjs --verify` for a read-only repeat of the final membership and
audit assertions. `--apply` creates a new four-event canary cycle and must not be used as a probe.

## Super-admin self-management patch

`migrations/0002_allow_super_admin_self_membership.sql` is mirrored at
`../migrations/20260830010000_allow_super_admin_self_membership.sql`. Apply only this incremental
migration to an existing membership control plane after the normal environment and backup gates;
do not reapply or edit the already-recorded `0001` migration. The patch changes only the mutation
function: confirmed super admins keep the same authorization, optimistic-version, idempotency, and
audit requirements when the target user is themselves.

The patch was applied to `autoforge-d1gkhyfb419ba8455` in `ap-shanghai` on 2026-08-30 after the
operator confirmed the production write and backup gate. The mirrored migration SHA-256 was
`f05bb099a33de360e2ee19e801090a68169df8edfda5f9a55bc297d14801cf77`; CloudBase task
`task-03599955` succeeded and applied only the one pending migration. A follow-up dry-run reported
no pending migrations. A state-preserving self-mutation probe for the sole super admin, fingerprint
`98ad26b8c62a`, passed authorization and stopped at the deliberately impossible expected version
with `MEMBERSHIP_CONFLICT`, confirming that the obsolete self-mutation rejection was no longer
active without changing membership state or audit history.

## Canary sequence

1. Apply only the membership migration and verify Free plan defaults through the service-role RPC.
2. Deploy `function/` as `autoforge-membership`, preserving the existing PostgreSQL secret inputs and
   injecting the membership signing secret through Secret/KMS.
3. Invoke `getCurrent` for the canary and verify a valid signed Free snapshot.
4. In the rendered Electron app, verify Free usage and the `1 / 1` knowledge limits.
5. From a different super-admin account, grant the canary Pro for a bounded term and verify `20 / 500`.
6. Extend the term, then revoke it, verifying each immutable audit event and immediate online
   downgrade to Free/read-only retention selection.
7. Correct the canary to Free, verify export and delete remain available, and leave all other users
   untouched.

Stop immediately on an owner mismatch, signature failure, audit gap, version conflict, unexpected
user count, or any knowledge cloud job. Do not broaden the canary automatically.

## Rollback

The rollback SQL revokes and removes callable membership functions but deliberately retains plan,
account, request, and audit tables. Disable or remove the `autoforge-membership` function first, then
apply `migrations/0001_membership_control_plane.rollback.sql`. Existing Electron clients fail closed:
an online refresh becomes unavailable, while an already verified cached snapshot can remain usable
only within its signed offline grace interval. Data cleanup is a separate, explicitly approved task.
