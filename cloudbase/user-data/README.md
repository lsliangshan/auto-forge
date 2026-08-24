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
