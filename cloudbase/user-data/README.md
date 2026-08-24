# AutoForge user-data CloudBase function

`function/` contains the CommonJS artifact for the `autoforge-user-data` CloudBase function. It authenticates callers only from the CloudBase function context and forwards validated owner-bound requests to the service-role PostgreSQL RPCs defined by the user-data migration.

## Runtime configuration

Configure these values as server-side environment variables for the CloudBase function:

- `AUTOFORGE_PG_RPC_BASE_URL`: the PostgreSQL REST/RPC base URL.
- `AUTOFORGE_PG_SERVICE_KEY`: the service-role credential.

Both credentials are environment-only. Do not commit them, bundle them into Electron, pass them in an event, or print them in function logs.

The PostgreSQL response boundary has a fixed 8 MiB byte ceiling. The function checks `Content-Length` when present and independently enforces the same limit while streaming the response body before JSON parsing.

## Dry-run and static verification

From the repository root:

```sh
node --check cloudbase/user-data/function/index.js
node --check cloudbase/user-data/function/user-data-handler.js
pnpm exec vitest run tests/cloudbase/user-data-handler.test.ts tests/cloudbase/user-data-migration.test.ts
```

These checks validate syntax and boundary behavior without contacting CloudBase or PostgreSQL. Committing these artifacts does not deploy the function or migration. Deployment and environment configuration remain separate, explicit operator actions.

## Repository artifacts versus deployed infrastructure

This directory contains versioned code artifacts only:

- `migrations/0001_user_data_foundation.sql` is the canonical forward schema and RPC definition.
- `migrations/0001_user_data_foundation.rollback.sql` revokes and removes the user-data RPC surface while preserving accepted data tables and rows.
- `function/` is the deployable CloudBase function source.

None of these files applies itself. Builds, tests, commits, and the local Electron acceptance suite do not modify a CloudBase environment. An authorized operator must separately apply the schema, configure server-side environment values, deploy the function, and advance each rollout gate in the [user-data foundation runbook](../../docs/runbooks/cloudbase-user-data-foundation.md).

## Local Electron acceptance

After a build, the milestone suite runs the production Renderer, Preload, IPC registration, application runtime, strict CloudBase port, and per-user SQLite cache against a loopback-only in-memory service double:

```sh
pnpm build
pnpm exec playwright test apps/desktop/tests/e2e/cloud-user-data-sync.spec.ts
```

The fixture uses disposable app profiles and fake Alice/Bob identities. It blocks Provider traffic, uses no real credential, and exposes test control only in the test Main process rather than through production diagnostic IPC. It verifies owner isolation, two-profile convergence, cursor paging, offline replay, duplicate idempotency, tombstones, explicit legacy consent/import, and BYOK cost classification.

This local suite validates application boundaries and the checked-in wire semantics. It is not evidence that PostgreSQL accepted the migration, that CloudBase authentication or service-role forwarding is configured correctly, or that a deployed environment enforces owner isolation.

## Staging-only validation

Before any production rollout, operators must execute the runbook against staging. The staging evidence must cover the actual supported PostgreSQL runtime, the deployed CloudBase function, unauthenticated and cross-owner denial, deterministic count/hash comparison, rollback controls, and a dual-device Electron run using staging accounts. Do not place live keys, tokens, UIDs, message bodies, or local paths in the evidence record.
