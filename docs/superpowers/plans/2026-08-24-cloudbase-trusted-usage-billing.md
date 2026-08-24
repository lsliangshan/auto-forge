# CloudBase Trusted Usage Billing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Execute platform-funded OpenRouter requests in a trusted CloudBase Run service, persist resumable run events and an immutable per-user usage ledger, enforce zero-default budgets, and clearly separate confirmed platform cost from BYOK estimates.

**Architecture:** Electron submits idempotent platform run commands through the CloudBase API gateway and consumes persisted SSE events by cursor. A CloudBase Run API/worker validates the CloudBase access token, leases queued PostgreSQL runs, streams OpenRouter server-side, persists normalized events before delivery, and records actual usage/cost plus append-only adjustments. Desktop BYOK paths remain local and synchronize only self-reported estimates.

**Tech Stack:** Node.js 22, TypeScript 6, CloudBase Run, `@cloudbase/node-sdk@3.18.3` for access-token validation, PostgreSQL RPC, OpenRouter SSE, `eventsource-parser@3.1.0`, Zod 4, Electron 43, Vue 3, Vitest 4, Playwright.

**Spec:** `docs/superpowers/specs/2026-08-24-cloudbase-user-data-persistence-design.md`

## Global Constraints

- Platform OpenRouter keys exist only in CloudBase Run environment configuration; existing local BYOK keys are never uploaded.
- CloudBase HTTP authentication is enabled for the gateway. The service also validates the Bearer access token and derives UID; it never accepts a client owner ID.
- Platform calls are disabled by default: a new user's monthly limit is exactly zero until an audited entitlement grants budget.
- Every conversation has at most one active run and every account has at most three concurrent platform runs.
- A run is acknowledged only after its command, user message, lease eligibility, and budget reservation are committed.
- SSE disconnect does not cancel work. Explicit cancellation sets server state and aborts the Provider request when observed.
- Persist normalized run events before exposing their cursor; the client resumes with `run_id + after_cursor`.
- Actual Provider cost is immutable. Reconciliation differences append adjustment events instead of editing the original event.
- `provider_cost`, `charged_amount`, and `estimated_cost` remain distinct. First-version `charged_amount` is always null.
- Decimal money is never converted through binary floating point or SQLite/PostgreSQL floating types.
- Logs exclude prompts, responses, raw Provider bodies, credentials, signed URLs, and authentication headers.
- CloudBase current official access path requires `Authorization: Bearer <access token>` and supports SSE; token-to-UID validation follows `https://docs.cloudbase.net/faq/knowledge/cloudrun-authentication-integration`.
- Do not stage or modify unrelated pre-existing workspace changes.

---

### Task 1: Define trusted run, ledger, budget, and administrator contracts

**Files:**
- Create: `packages/shared/src/decimal.ts`
- Create: `packages/shared/src/decimal.test.ts`
- Modify: `packages/shared/src/index.ts`
- Modify: `packages/shared/src/desktop-api.ts`
- Modify: `packages/shared/src/errors.ts`
- Modify: `packages/shared/src/contracts.test.ts`
- Modify: `apps/desktop/electron/main/billing/decimal-usd.ts`

**Interfaces:**
- Produces exact `normalizeDecimal`/`addDecimals`, platform run requests/status/events, cost classification, budget summaries, usage pages, adjustment requests, and admin aggregate contracts.
- Consumes existing model, modality, chat block, token usage, and cursor schemas.

- [ ] **Step 1: Write failing decimal and contract tests**

```ts
expect(normalizeDecimal('001.2300')).toBe('1.23')
expect(addDecimals(['0.1', '0.2', '1e-7'])).toBe('0.3000001')
expect(platformRunCreateSchema.safeParse({
  operationId: 'op_1', conversationId: 'conv_1', model: 'openai/gpt-5', userId: 'forged',
}).success).toBe(false)
expect(usageCostSchema.parse({
  status: 'reported', providerCost: { amount: '0.0012', currency: 'USD' },
  chargedAmount: null,
})).toMatchObject({ status: 'reported' })
expect(budgetSummarySchema.parse({ monthlyLimit: '0', reserved: '0', spent: '0', currency: 'USD' }))
  .toMatchObject({ monthlyLimit: '0' })
```

- [ ] **Step 2: Run shared tests and verify RED**

Run: `pnpm exec vitest run packages/shared/src/decimal.test.ts packages/shared/src/contracts.test.ts`

Expected: missing decimal module and run/ledger contracts.

- [ ] **Step 3: Move exact decimal behavior into shared and implement schemas**

Move the existing strict decimal-string parser without weakening validation. Keep `apps/desktop/electron/main/billing/decimal-usd.ts` as a compatibility re-export so existing imports remain stable during migration.

Define run events as a strict discriminated union:

```ts
type PlatformRunEvent =
  | { cursor: string; type: 'status'; status: 'queued' | 'running' | 'cancelling' | 'completed' | 'failed' | 'cancelled' }
  | { cursor: string; type: 'text_delta'; text: string }
  | { cursor: string; type: 'usage'; inputTokens?: number; outputTokens?: number; cost: UsageCost }
  | { cursor: string; type: 'error'; code: AppErrorCode }
  | { cursor: string; type: 'done' }
```

Add `PLATFORM_BUDGET_REQUIRED`, `PLATFORM_BUDGET_EXCEEDED`, `PLATFORM_RUN_CONFLICT`, `PLATFORM_GATEWAY_UNAVAILABLE`, `RUN_NOT_FOUND`, and `RUN_ALREADY_TERMINAL`. Extend business capability with `manage_model_budgets`; super-admin authorization may include both capabilities.

- [ ] **Step 4: Run shared tests, typecheck, and existing decimal regression tests**

Run: `pnpm exec vitest run packages/shared/src/decimal.test.ts packages/shared/src/contracts.test.ts`

Run: `pnpm --filter @autoforge/shared typecheck`

Run:

```bash
pnpm --filter @autoforge/desktop exec node scripts/run-vitest-electron.mjs run \
  --config vitest.node.config.ts electron/main/billing/decimal-usd.test.ts
```

Expected: all pass.

- [ ] **Step 5: Commit shared ledger contracts**

```bash
git add packages/shared/src/decimal.ts packages/shared/src/decimal.test.ts packages/shared/src/index.ts packages/shared/src/desktop-api.ts packages/shared/src/errors.ts packages/shared/src/contracts.test.ts apps/desktop/electron/main/billing/decimal-usd.ts
git commit -m "feat: define trusted platform usage contracts"
```

---

### Task 2: Add platform runs, budgets, immutable ledger, adjustments, and rollups

**Files:**
- Create: `cloudbase/migrations/20260824110000_trusted_usage_billing.sql`
- Create: `cloudbase/user-data/migrations/0003_trusted_usage_billing.sql`
- Create: `cloudbase/user-data/migrations/0003_trusted_usage_billing.rollback.sql`
- Create: `tests/cloudbase/trusted-usage-migration.test.ts`

**Interfaces:**
- Produces `app_model_entitlements`, `app_model_run_events`, expanded `app_model_runs`, `app_usage_adjustments`, `app_daily_usage_rollups`, and administrator audit rows.
- Produces transactional RPCs for create/lease/append-event/finish/cancel, budget reserve/settle, usage report/adjust, rollups, and admin queries.
- Consumes existing conversations, messages, usage events, user roles, and caller UID.

- [ ] **Step 1: Write failing migration tests**

Assert owner FKs use `bigint`, budget defaults to zero, money uses `numeric` or validated text without floating types, run events are ordered, one active run is enforced, and service-role-only grants remain intact:

```ts
expect(sql).toContain('monthly_limit numeric NOT NULL DEFAULT 0')
expect(sql).toContain('CHECK (monthly_limit >= 0)')
expect(sql).toContain('UNIQUE (run_id, sequence)')
expect(sql).toContain('app_active_run_per_conversation')
expect(sql).not.toMatch(/\b(real|double precision|money)\b/i)
```

- [ ] **Step 2: Run migration test and verify RED**

Run: `pnpm exec vitest run tests/cloudbase/trusted-usage-migration.test.ts`

Expected: migration files are absent.

- [ ] **Step 3: Implement transactional run and money state machines**

`autoforge_create_platform_run` must, in one transaction:

1. Resolve caller UID from the trusted gateway argument.
2. Verify conversation owner and absence of an active run.
3. Check device/protocol and a positive platform entitlement.
4. Lock the monthly entitlement row.
5. Reject when `spent + reserved + requested_reservation > monthly_limit`.
6. Insert or return the same operation ID, persist the user message, create queued run, reserve budget, and append the initial status event.

Run events use a monotonically increasing sequence and maximum serialized payload of 64 KiB. Provider usage events record `credential_owner='platform'`, `billable=true`, `provider_cost_amount`, `provider_cost_currency`, nullable charged amount, Token, purpose, model, Provider generation ID, occurred/received time, and immutable request identity.

Settlement locks the run and entitlement, releases reservation, increments actual spend once, inserts the original usage event, and appends terminal events. Adjustment RPCs insert signed deltas and audit operator/reason; they do not update the original row.

- [ ] **Step 4: Run migration tests and compare copies**

Run: `pnpm exec vitest run tests/cloudbase/trusted-usage-migration.test.ts`

Run: `cmp cloudbase/migrations/20260824110000_trusted_usage_billing.sql cloudbase/user-data/migrations/0003_trusted_usage_billing.sql`

Expected: pass and `cmp` exits 0.

- [ ] **Step 5: Commit the trusted billing schema**

```bash
git add cloudbase/migrations/20260824110000_trusted_usage_billing.sql cloudbase/user-data/migrations/0003_trusted_usage_billing.sql cloudbase/user-data/migrations/0003_trusted_usage_billing.rollback.sql tests/cloudbase/trusted-usage-migration.test.ts
git commit -m "feat: add trusted platform usage ledger"
```

---

### Task 3: Scaffold the authenticated CloudBase Run API

**Files:**
- Create: `apps/model-gateway/package.json`
- Create: `apps/model-gateway/tsconfig.json`
- Create: `apps/model-gateway/Dockerfile`
- Create: `apps/model-gateway/src/config.ts`
- Create: `apps/model-gateway/src/auth.ts`
- Create: `apps/model-gateway/src/rpc.ts`
- Create: `apps/model-gateway/src/server.ts`
- Create: `apps/model-gateway/src/server.test.ts`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Produces authenticated endpoints `POST /v1/runs`, `GET /v1/runs/:id`, `GET /v1/runs/:id/events`, and `POST /v1/runs/:id/cancel`.
- Consumes `@cloudbase/node-sdk@3.18.3` access-token validation and PostgreSQL service RPCs.

- [ ] **Step 1: Write failing HTTP boundary tests**

Use an in-process server with injected auth/RPC ports. Prove missing/invalid Bearer returns 401, forged body UID is rejected, valid token-derived UID reaches RPC, responses contain safe codes, and SSE honors `after` cursor without echoing authentication headers.

- [ ] **Step 2: Run gateway tests and verify RED**

Run: `pnpm --filter @autoforge/model-gateway test`

Expected: workspace package does not exist.

- [ ] **Step 3: Implement config, token validation, and routes**

Use strict environment parsing for:

```ts
interface GatewayConfig {
  port: number
  cloudBaseEnvId: string
  postgresRpcBaseUrl: string
  postgresServiceKey: string
  openRouterApiKey: string
  openRouterBaseUrl: 'https://openrouter.ai/api/v1'
}
```

`auth.ts` requires `Authorization: Bearer <token>`, calls `tcbApp.auth().getUserInfoByAccessToken(token)`, validates a non-empty UID, and returns only `{ uid }`. It never decodes an unverified JWT to authorize. Configure CloudBase Run HTTP authentication as an external deployment requirement and keep server validation as defense in depth.

Use Node's built-in HTTP server to keep the service small. `POST /v1/runs` validates the strict shared schema then calls `autoforge_create_platform_run`. SSE sends only persisted event rows returned by owner-scoped RPC and uses `id: <opaque cursor>`; keepalive comments contain no data.

- [ ] **Step 4: Run gateway tests, typecheck, and container build**

Run: `pnpm --filter @autoforge/model-gateway test`

Run: `pnpm --filter @autoforge/model-gateway typecheck`

Run: `docker build -f apps/model-gateway/Dockerfile apps/model-gateway`

Expected: tests/typecheck pass and image build exits 0 without embedding environment values.

- [ ] **Step 5: Commit the gateway API shell**

```bash
git add apps/model-gateway pnpm-lock.yaml
git commit -m "feat: add authenticated model gateway API"
```

---

### Task 4: Implement leased OpenRouter workers and resumable events

**Files:**
- Create: `apps/model-gateway/src/openrouter.ts`
- Create: `apps/model-gateway/src/openrouter.test.ts`
- Create: `apps/model-gateway/src/run-worker.ts`
- Create: `apps/model-gateway/src/run-worker.test.ts`
- Modify: `apps/model-gateway/src/server.ts`

**Interfaces:**
- Produces an OpenRouter streaming port and a database-leased worker loop.
- Consumes `autoforge_lease_platform_runs`, append-event, cancellation-status, finish, and fail RPCs.

- [ ] **Step 1: Write failing provider and worker tests**

Cover normalized text deltas, tool events required by existing Agent protocol, usage/cost, malformed SSE, Provider errors, lease expiry/recovery, two workers racing, disconnect without cancel, explicit cancel, and restart resumption. Assert every emitted cursor exists in RPC storage before it is visible to the SSE reader.

- [ ] **Step 2: Run gateway worker tests and verify RED**

Run:

```bash
pnpm --filter @autoforge/model-gateway exec vitest run \
  src/openrouter.test.ts src/run-worker.test.ts
```

Expected: modules are missing.

- [ ] **Step 3: Implement provider streaming and persistent worker leases**

OpenRouter requests use the server key, `stream_options.include_usage=true`, and `user: autoforge:<uid>`. Never accept a Provider endpoint or key from the run row. Parse SSE with `eventsource-parser`, normalize events, and buffer text to at most 8 KiB or 100 ms before persisting an event. Persist first, then notify connected SSE readers.

The worker polls queued/expired-lease runs, claims one with a 30-second lease, renews every 10 seconds, and uses an AbortController. It checks `cancel_requested_at` between upstream events. Process termination leaves the run recoverable after lease expiry; the same operation identity prevents a second Provider request once generation identity or a terminal usage report exists.

- [ ] **Step 4: Run worker tests and gateway typecheck**

Run the Step 2 command again.

Run: `pnpm --filter @autoforge/model-gateway typecheck`

Expected: pass.

- [ ] **Step 5: Commit the platform run worker**

```bash
git add apps/model-gateway/src/openrouter.ts apps/model-gateway/src/openrouter.test.ts apps/model-gateway/src/run-worker.ts apps/model-gateway/src/run-worker.test.ts apps/model-gateway/src/server.ts
git commit -m "feat: execute resumable platform model runs"
```

---

### Task 5: Settle actual cost, reconcile unknown usage, and build rollups

**Files:**
- Create: `apps/model-gateway/src/usage-ledger.ts`
- Create: `apps/model-gateway/src/usage-ledger.test.ts`
- Create: `apps/model-gateway/src/reconciler.ts`
- Create: `apps/model-gateway/src/reconciler.test.ts`
- Create: `apps/model-gateway/src/rollup-worker.ts`
- Create: `apps/model-gateway/src/rollup-worker.test.ts`
- Modify: `apps/model-gateway/src/run-worker.ts`

**Interfaces:**
- Produces exact platform cost settlement, bounded generation reconciliation, append-only adjustments, and account-timezone daily rollups.
- Consumes normalized OpenRouter usage/cost and trusted run identity.

- [ ] **Step 1: Write failing ledger tests**

Cover zero cost, exact decimals, reported cost, missing cost with generation lookup, three failed reconciliations, duplicate terminal events, cancellation after Provider billing, budget release, all-purpose classification, and timezone boundaries. Prove prompt/title/context/tool/media purposes remain separate and no cross-currency sum occurs without a stored rate snapshot.

- [ ] **Step 2: Run ledger tests and verify RED**

```bash
pnpm --filter @autoforge/model-gateway exec vitest run \
  src/usage-ledger.test.ts src/reconciler.test.ts src/rollup-worker.test.ts
```

Expected: ledger modules are absent.

- [ ] **Step 3: Implement immutable settlement and bounded reconciliation**

Normalize Provider decimals through `@autoforge/shared`. On the first usage cost, call settle RPC with `status='reported'`, USD original currency, nullable charged amount, and received time from the server clock. Missing cost with generation ID enters pending reconciliation; query only the fixed OpenRouter generation endpoint, with the platform key that created the run, at most three times.

If a later Provider amount differs, append an adjustment containing exact delta, reason `provider_reconciliation`, original event ID, operator `system`, and audit timestamp. Rollups are rebuildable projections grouped by owner-local calendar day, Provider, model, purpose, credential owner, billable, cost status, and currency.

- [ ] **Step 4: Run ledger tests and gateway typecheck**

Run the Step 2 command again.

Run: `pnpm --filter @autoforge/model-gateway typecheck`

Expected: pass.

- [ ] **Step 5: Commit trusted settlement**

```bash
git add apps/model-gateway/src/usage-ledger.ts apps/model-gateway/src/usage-ledger.test.ts apps/model-gateway/src/reconciler.ts apps/model-gateway/src/reconciler.test.ts apps/model-gateway/src/rollup-worker.ts apps/model-gateway/src/rollup-worker.test.ts apps/model-gateway/src/run-worker.ts
git commit -m "feat: settle trusted provider usage"
```

---

### Task 6: Route platform credentials through the gateway in Electron

**Files:**
- Create: `apps/desktop/electron/main/chat/platform-gateway-client.ts`
- Create: `apps/desktop/electron/main/chat/platform-gateway-client.test.ts`
- Modify: `apps/desktop/electron/main/chat/multimodal-router.ts`
- Modify: `apps/desktop/electron/main/chat/multimodal-router.test.ts`
- Modify: `apps/desktop/electron/main/agent/agent-orchestrator.ts`
- Modify: `apps/desktop/electron/main/agent/agent-orchestrator.test.ts`
- Modify: `apps/desktop/electron/main/application.ts`
- Modify: `apps/desktop/electron/main/application.test.ts`

**Interfaces:**
- Produces a `PlatformGatewayClient` compatible with the orchestrator's normalized event port.
- Consumes CloudBase access token internally, credential-owner route metadata, and platform run/event contracts.

- [ ] **Step 1: Write failing routing and recovery tests**

Prove `credentialOwner='platform'` never resolves a local secret, BYOK never calls the gateway, the operation ID survives retry, SSE resumes after cursor, duplicate create returns the same run, gateway 401 refreshes CloudBase session once, and same-conversation conflict occurs before a second user message.

- [ ] **Step 2: Run focused Desktop tests and verify RED**

```bash
pnpm --filter @autoforge/desktop exec node scripts/run-vitest-electron.mjs run \
  --config vitest.node.config.ts \
  electron/main/chat/platform-gateway-client.test.ts \
  electron/main/chat/multimodal-router.test.ts \
  electron/main/agent/agent-orchestrator.test.ts \
  electron/main/application.test.ts
```

Expected: no platform route/client exists.

- [ ] **Step 3: Implement credential-owner routing and resumable client**

Add explicit route metadata rather than inferring ownership from Provider name. The client sends the CloudBase access token only in the Authorization header to the fixed configured CloudBase gateway origin, uses `operationId` from the admitted request, parses only strict SSE events, persists the last cursor in the UID cache, and resumes until a terminal event.

Platform assistant/message/run persistence comes from remote pull after gateway events; do not duplicate-write authoritative rows locally. BYOK retains current local provider and safeStorage paths, then synchronizes self-reported usage through milestone one.

- [ ] **Step 4: Run focused tests and desktop typecheck**

Run the Step 2 command again.

Run: `pnpm --filter @autoforge/desktop typecheck`

Expected: pass.

- [ ] **Step 5: Commit Desktop gateway routing**

```bash
git add apps/desktop/electron/main/chat/platform-gateway-client.ts apps/desktop/electron/main/chat/platform-gateway-client.test.ts apps/desktop/electron/main/chat/multimodal-router.ts apps/desktop/electron/main/chat/multimodal-router.test.ts apps/desktop/electron/main/agent/agent-orchestrator.ts apps/desktop/electron/main/agent/agent-orchestrator.test.ts apps/desktop/electron/main/application.ts apps/desktop/electron/main/application.test.ts
git commit -m "feat: route platform runs through cloud gateway"
```

---

### Task 7: Replace local totals and add audited budget administration

**Files:**
- Modify: `cloudbase/user-roles/migrations/0001_user_roles.sql`
- Modify: `cloudbase/migrations/20260821105102_user_roles.sql`
- Modify: `cloudbase/user-roles/function/user-role-handler.js`
- Modify: `tests/cloudbase/user-role-handler.test.ts`
- Modify: `apps/desktop/electron/main/auth/cloudbase-role-service.ts`
- Modify: `apps/desktop/electron/main/user-admin/user-admin-service.ts`
- Modify: `apps/desktop/electron/main/application.ts`
- Modify: `apps/desktop/src/views/UserManagementView.vue`
- Modify: `apps/desktop/src/components/settings/BillingUsagePanel.vue`
- Modify: `apps/desktop/src/stores/settings.ts`
- Modify: `apps/desktop/tests/components/workbench.test.ts`
- Modify: `apps/desktop/tests/components/user-management.test.ts`

**Interfaces:**
- Produces `manage_model_budgets`, owner-scoped remote usage snapshots, admin aggregate/detail queries, and audited monthly limit changes.
- Consumes trusted rollups/ledger and existing role/version/capability checks.

- [ ] **Step 1: Write failing authorization and UI tests**

Prove ordinary users see only their own events, `manage_users` alone cannot change budgets, super-admin updates require request ID and expected version, prompts are absent, zero-default entitlement blocks platform use, and the settings page separates confirmed/pending/BYOK values.

- [ ] **Step 2: Run focused CloudBase and component tests and verify RED**

```bash
pnpm exec vitest run tests/cloudbase/user-role-handler.test.ts
pnpm --filter @autoforge/desktop exec node scripts/run-vitest-electron.mjs run \
  --config vitest.config.ts \
  tests/components/workbench.test.ts tests/components/user-management.test.ts
```

Expected: missing capability, budget actions, and new display groups.

- [ ] **Step 3: Implement capability, remote queries, and audited adjustments**

Extend the super-admin capability mapping to include `manage_model_budgets`. Add strict function actions `getMyUsage`, `listUserUsage`, `updateModelBudget`, and `appendUsageAdjustment`; all derive caller UID and enforce capability in PostgreSQL. Budget updates require `requestId`, target UID, currency, exact monthly limit, and expected version.

Replace `chat_runs`/local event aggregation in `settings.getTokenUsage()` with the authenticated remote snapshot. Keep the old local aggregation only behind the milestone rollback flag and never merge the two totals.

- [ ] **Step 4: Update UI and run focused tests**

Display confirmed platform cost, pending count, BYOK estimate, unavailable count, Token, background-purpose share, account timezone, original currency, normalized currency only when a rate exists, budget used/reserved/limit, and last sync time. Admin pages show per-user aggregates and anomalies without message content or key fingerprints.

Run the Step 2 commands again.

Expected: pass.

- [ ] **Step 5: Commit remote usage and budget administration**

```bash
git add cloudbase/user-roles/migrations/0001_user_roles.sql cloudbase/migrations/20260821105102_user_roles.sql cloudbase/user-roles/function/user-role-handler.js tests/cloudbase/user-role-handler.test.ts apps/desktop/electron/main/auth/cloudbase-role-service.ts apps/desktop/electron/main/user-admin/user-admin-service.ts apps/desktop/electron/main/application.ts apps/desktop/src/views/UserManagementView.vue apps/desktop/src/components/settings/BillingUsagePanel.vue apps/desktop/src/stores/settings.ts apps/desktop/tests/components/workbench.test.ts apps/desktop/tests/components/user-management.test.ts
git commit -m "feat: expose trusted usage and budgets"
```

---

### Task 8: Verify trusted billing in staging and document operations

**Files:**
- Create: `cloudbase/model-gateway/README.md`
- Create: `docs/runbooks/cloudbase-model-gateway.md`
- Create: `docs/runbooks/cloudbase-usage-reconciliation.md`
- Create: `apps/desktop/tests/e2e/platform-model-gateway.spec.ts`
- Create: `apps/model-gateway/src/redaction.test.ts`

**Interfaces:**
- Consumes all milestone-three components.
- Produces deployment, secret, budget, reconciliation, rollback, log-redaction, and real Electron acceptance evidence.

- [ ] **Step 1: Add failing security and E2E acceptance tests**

Cover invalid token, zero budget, granted budget, two-device same-conversation conflict, SSE disconnect/resume, explicit cancel with billed partial usage, duplicate operation retry, exact OpenRouter zero/nonzero cost, unknown reconciliation, adjustment, admin denial, and absence of prompt/key/token in captured logs.

- [ ] **Step 2: Run gateway security and E2E tests and verify RED**

Run: `pnpm --filter @autoforge/model-gateway exec vitest run src/redaction.test.ts`

Run: `pnpm build && pnpm exec playwright test apps/desktop/tests/e2e/platform-model-gateway.spec.ts`

Expected: missing staging gateway fixture and redaction assertions.

- [ ] **Step 3: Write exact deployment and rollback runbooks**

Document separate development/staging/production services, CloudBase HTTP authentication enabled, custom HTTPS domain, required environment variable names, service key/platform key rotation, zero-default budget bootstrap, 80%/100% alerts, global budget kill switch, worker lease alerts, pending reconciliation alerts, and log retention of 30 days. Do not include credential values.

Deployment order is schema/RPC, role capability, gateway with platform calls disabled, token/owner denial tests, one internal entitlement, live non-production OpenRouter reconciliation, Electron two-device acceptance, then gradual enablement. Rollback disables new platform runs while preserving run/ledger rows and BYOK/history access.

- [ ] **Step 4: Run complete milestone verification**

```bash
pnpm exec vitest run packages/shared/src/decimal.test.ts packages/shared/src/contracts.test.ts tests/cloudbase/trusted-usage-migration.test.ts tests/cloudbase/user-role-handler.test.ts
pnpm --filter @autoforge/model-gateway test
pnpm test
pnpm typecheck
pnpm lint
pnpm build
docker build -f apps/model-gateway/Dockerfile apps/model-gateway
pnpm exec playwright test apps/desktop/tests/e2e/platform-model-gateway.spec.ts
```

Expected: all commands exit 0; staging evidence shows token-derived UID, idempotent run recovery, immutable actual cost, zero-default budget, and visible Electron totals.

- [ ] **Step 5: Commit gateway runbooks and acceptance**

```bash
git add cloudbase/model-gateway/README.md docs/runbooks/cloudbase-model-gateway.md docs/runbooks/cloudbase-usage-reconciliation.md apps/desktop/tests/e2e/platform-model-gateway.spec.ts apps/model-gateway/src/redaction.test.ts
git commit -m "test: verify trusted platform usage milestone"
```
