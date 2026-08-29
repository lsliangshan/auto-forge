# Membership control plane

This directory owns the production membership control plane. The first consumer is the personal
knowledge base. Free accounts receive one local knowledge base and one non-purged document; Pro
accounts receive twenty knowledge bases and five hundred non-purged documents. Both plans cap one
file at 64 MiB.

## Security and authority

- `membership_accounts` is the current state. `membership_events` is immutable audit history.
- Only the Cloud Function service role may execute the membership RPC functions.
- The caller identity is taken from the CloudBase authenticated context, never from request data.
- Main requires confirmed `manage_memberships`; self-mutation is rejected in Main and PostgreSQL.
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
