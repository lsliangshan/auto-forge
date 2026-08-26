# CloudBase Conversation Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make CloudBase PostgreSQL authoritative for each authenticated user's conversations, immutable messages, deletion tombstones, pagination, and BYOK self-reported usage while retaining an isolated per-user SQLite cache and outbox.

**Architecture:** Add owner-bound PostgreSQL tables and service-role RPCs behind one authenticated CloudBase function. Electron Main opens a hashed per-UID cache, records local mutations in the same SQLite transaction as optimistic UI data, and synchronizes them through a typed CloudBase port; Renderer receives cursor pages and sync states but never supplies an owner ID.

**Tech Stack:** TypeScript 6, Electron 43, Vue 3, Pinia 4, Zod 4, better-sqlite3 12, CloudBase PostgreSQL, CloudBase event functions, Vitest 4, pnpm 11.15.0.

**Spec:** `docs/superpowers/specs/2026-08-24-cloudbase-user-data-persistence-design.md`

## Global Constraints

- CloudBase environment remains `autoforge-d1gkhyfb419ba8455` in `ap-shanghai`; development, staging, and production use separate configured environments.
- CloudBase UID is the immutable owner. Handlers derive it from platform context and reject client `userId` fields.
- CloudBase is authoritative; SQLite is a per-user cache/outbox, not an authentication proof.
- Messages are immutable; conversation metadata uses revision checks; deletes use tombstones retained for 30 days.
- Conversation pages contain 50 rows. Initial message pages contain the newest 100 rows and load older rows by opaque cursor.
- Message insertion updates `last_activity_at`; metadata changes update `metadata_updated_at`.
- BYOK usage is always `credential_owner=user` and never becomes confirmed platform consumption.
- No API Key, token, prompt, response body, absolute path, Base64, service key, or SQL detail may enter Renderer state, logs, snapshots, or safe errors.
- Existing unowned conversations are never silently claimed or uploaded.
- Do not stage or alter the user's pre-existing chat UI changes; every `git add` command names only files from its task.

---

### Task 1: Add cursor, sync, consent, and usage contracts

**Files:**
- Modify: `packages/shared/src/desktop-api.ts`
- Modify: `packages/shared/src/errors.ts`
- Modify: `packages/shared/src/contracts.test.ts`

**Interfaces:**
- Produces `SyncState`, `CursorPage<T>`, paginated chat requests/responses, legacy import consent, account data preferences, and remote usage status.
- Consumes the existing `ConversationSummary`, `ChatMessage`, `ProviderUsageModality`, `ModelProviderId`, and strict IPC schema maps.

- [ ] **Step 1: Write failing shared-contract tests**

Add exact assertions for strict requests, opaque cursors, new timestamps, and rejected owner injection:

```ts
expect(listConversationsRequestSchema.parse({ limit: 50 })).toEqual({ limit: 50 })
expect(listMessagesRequestSchema.parse({ conversationId: 'conv_1', limit: 100 }))
  .toEqual({ conversationId: 'conv_1', limit: 100 })
expect(syncMutationSchema.safeParse({
  id: 'mut_1', userId: 'forged', kind: 'conversation.create', entityId: 'conv_1',
  baseRevision: 0, occurredAt: '2026-08-24T00:00:00.000Z', payload: {},
}).success).toBe(false)
expect(appErrorCodeSchema.parse('SYNC_CONFLICT')).toBe('SYNC_CONFLICT')
expect(appErrorCodeSchema.parse('UPGRADE_REQUIRED')).toBe('UPGRADE_REQUIRED')
```

- [ ] **Step 2: Run the contract test and verify RED**

Run: `pnpm exec vitest run packages/shared/src/contracts.test.ts`

Expected: failures show the old undefined/full-array chat requests and missing sync schemas/error codes.

- [ ] **Step 3: Implement the exact public contracts**

Add strict schemas equivalent to:

```ts
export const syncStateSchema = z.enum(['synced', 'pending', 'syncing', 'failed'])
export const opaqueCursorSchema = z.string().min(16).max(2048)
export const conversationSummarySchema = z.object({
  id: identifierSchema,
  title: nonEmptyStringSchema,
  titleState: z.enum(['pending', 'generating', 'ai_named', 'user_named', 'failed']),
  revision: z.number().int().nonnegative(),
  syncState: syncStateSchema,
  createdAt: timestampSchema,
  lastActivityAt: timestampSchema,
  metadataUpdatedAt: timestampSchema,
}).strict()
export const conversationPageSchema = z.object({
  items: z.array(conversationSummarySchema),
  nextCursor: opaqueCursorSchema.optional(),
}).strict()
export const messagePageSchema = z.object({
  items: z.array(chatMessageSchema),
  previousCursor: opaqueCursorSchema.optional(),
}).strict()
```

Change `DesktopAPI.chat.listConversations(input)` and `listMessages(input)` to return pages. Add exact mutation status, import preview/confirm, consent, and BYOK usage event schemas. Add safe error codes `SYNC_CONFLICT`, `SYNC_FAILED`, `UPGRADE_REQUIRED`, `IMPORT_CONFIRMATION_REQUIRED`, and `OUTBOX_LIMIT_EXCEEDED`.

Add strict account data preferences with an IANA timezone string validated in Main through `Intl.DateTimeFormat` and display currency `CNY | USD`. Remote defaults are `Asia/Shanghai` and `CNY`; changing preferences affects future query boundaries and display only, never rewrites historical event timestamps or amounts.

- [ ] **Step 4: Run shared tests and package typecheck**

Run: `pnpm exec vitest run packages/shared/src/contracts.test.ts`

Run: `pnpm --filter @autoforge/shared typecheck`

Expected: both pass.

- [ ] **Step 5: Commit the contract slice**

```bash
git add packages/shared/src/desktop-api.ts packages/shared/src/errors.ts packages/shared/src/contracts.test.ts
git commit -m "feat: define cloud conversation sync contracts"
```

---

### Task 2: Create owner-bound PostgreSQL schema and RPCs

**Files:**
- Create: `cloudbase/migrations/20260824090000_user_data_foundation.sql`
- Create: `cloudbase/user-data/migrations/0001_user_data_foundation.sql`
- Create: `cloudbase/user-data/migrations/0001_user_data_foundation.rollback.sql`
- Create: `tests/cloudbase/user-data-migration.test.ts`

**Interfaces:**
- Produces PostgreSQL tables `app_conversations`, `app_messages`, `app_model_runs`, `app_usage_events`, `app_sync_devices`, `app_sync_mutations`, `app_privacy_consents`, and `app_user_data_preferences`.
- Produces service-role RPCs `autoforge_sync_push`, `autoforge_sync_pull`, `autoforge_list_conversations`, `autoforge_list_messages`, `autoforge_preview_legacy_import`, `autoforge_import_legacy_batch`, `autoforge_get_usage_snapshot`, `autoforge_get_user_data_preferences`, and `autoforge_update_user_data_preferences`.
- Consumes `auth.users(id)` and the existing service-role-only security pattern.

- [ ] **Step 1: Write failing migration artifact tests**

Assert the canonical and feature copies are byte-identical and scan the SQL for owner foreign keys, grants, idempotency, revision, tombstones, and message ordering:

```ts
expect(canonical).toBe(featureCopy)
expect(canonical).toContain('REFERENCES auth.users(id)')
expect(canonical).toContain('UNIQUE (owner_user_id, mutation_id)')
expect(canonical).toContain('UNIQUE (conversation_id, ordinal)')
expect(canonical).toContain('REVOKE ALL ON TABLE app_messages FROM PUBLIC, anon, authenticated')
expect(canonical).toContain('GRANT EXECUTE ON FUNCTION autoforge_sync_push')
expect(canonical).not.toMatch(/GRANT .* TO authenticated/)
```

- [ ] **Step 2: Run the migration artifact test and verify RED**

Run: `pnpm exec vitest run tests/cloudbase/user-data-migration.test.ts`

Expected: failure because the migration files do not exist.

- [ ] **Step 3: Implement schema constraints and transactional RPCs**

Use UUID/text IDs supplied by the client only after strict length validation. The tables must include these database-enforced rules:

```sql
CREATE UNIQUE INDEX app_messages_conversation_ordinal_key
  ON app_messages(conversation_id, ordinal);
CREATE UNIQUE INDEX app_active_run_per_conversation
  ON app_model_runs(conversation_id)
  WHERE status IN ('queued', 'running', 'cancelling');
CREATE UNIQUE INDEX app_usage_operation_key
  ON app_usage_events(owner_user_id, operation_id, provider, purpose);
```

`autoforge_sync_push` accepts caller UID, protocol version, device ID, and a JSONB array capped at 100 entries/1 MB. For each mutation it locks the owner conversation, checks base revision, records the mutation receipt, assigns message ordinal in the same transaction, and returns per-mutation status plus a new opaque sync cursor. `autoforge_sync_pull` returns only rows for `p_caller_user_id` ordered by monotonic server sequence. Cursor encoding must not expose UID or raw sequence.

The rollback script revokes RPCs and removes functions/views only. It preserves tables and accepted user data for recovery.

- [ ] **Step 4: Run migration tests and SQL static checks**

Run: `pnpm exec vitest run tests/cloudbase/user-data-migration.test.ts`

Run: `cmp cloudbase/migrations/20260824090000_user_data_foundation.sql cloudbase/user-data/migrations/0001_user_data_foundation.sql`

Expected: tests pass and `cmp` exits 0.

- [ ] **Step 5: Commit the remote schema**

```bash
git add cloudbase/migrations/20260824090000_user_data_foundation.sql cloudbase/user-data/migrations/0001_user_data_foundation.sql cloudbase/user-data/migrations/0001_user_data_foundation.rollback.sql tests/cloudbase/user-data-migration.test.ts
git commit -m "feat: add owner-bound cloud user data schema"
```

---

### Task 3: Add the authenticated CloudBase user-data function

**Files:**
- Create: `cloudbase/user-data/function/package.json`
- Create: `cloudbase/user-data/function/index.js`
- Create: `cloudbase/user-data/function/user-data-handler.js`
- Create: `cloudbase/user-data/README.md`
- Create: `tests/cloudbase/user-data-handler.test.ts`

**Interfaces:**
- Consumes strict action payloads from Task 1 and service-role RPCs from Task 2.
- Produces CloudBase function `autoforge-user-data` with actions `syncPush`, `syncPull`, `listConversations`, `listMessages`, `previewLegacyImport`, `importLegacyBatch`, `recordConsent`, `getUserDataPreferences`, `updateUserDataPreferences`, and `getUsageSnapshot`.

- [ ] **Step 1: Write failing handler tests**

Cover context-derived UID, exact keys, batch limits, protocol mismatch, safe errors, and forged owner rejection:

```ts
await expect(handler({ action: 'syncPull', protocolVersion: 1, deviceId: 'dev_1' }, {}))
  .resolves.toEqual({ ok: false, error: { code: 'AUTH_REQUIRED' } })
await expect(handler({
  action: 'syncPull', protocolVersion: 1, deviceId: 'dev_1', userId: 'forged',
}, { auth: { uid: 'real_uid' } }))
  .resolves.toEqual({ ok: false, error: { code: 'INVALID_INPUT' } })
```

Assert the RPC receives `p_caller_user_id: 'real_uid'` and never receives a UID from the event.

- [ ] **Step 2: Run the handler test and verify RED**

Run: `pnpm exec vitest run tests/cloudbase/user-data-handler.test.ts`

Expected: module-not-found failure.

- [ ] **Step 3: Implement the handler and safe RPC client**

Mirror `cloudbase/user-roles/function/user-role-handler.js`: parse raw events as `unknown`, require exact keys, derive UID from `context.auth.uid` with the existing compatible fallbacks, and map only stable codes:

```js
const stableErrorCodes = new Set([
  'AUTH_REQUIRED', 'FORBIDDEN', 'INVALID_INPUT', 'SYNC_CONFLICT',
  'UPGRADE_REQUIRED', 'OUTBOX_LIMIT_EXCEEDED', 'SERVICE_UNAVAILABLE', 'INTERNAL_ERROR',
])
```

Use `AUTOFORGE_PG_RPC_BASE_URL` and `AUTOFORGE_PG_SERVICE_KEY` only inside the function. Never include upstream response bodies in returned errors. The README must provide dry-run/static verification and explicitly state that committing artifacts does not deploy them.

- [ ] **Step 4: Run focused handler tests**

Run: `pnpm exec vitest run tests/cloudbase/user-data-handler.test.ts tests/cloudbase/user-data-migration.test.ts`

Expected: all pass.

- [ ] **Step 5: Commit the function artifact**

```bash
git add cloudbase/user-data/function cloudbase/user-data/README.md tests/cloudbase/user-data-handler.test.ts
git commit -m "feat: add authenticated cloud user data function"
```

---

### Task 4: Split sensitive local data into a per-user cache and outbox

**Files:**
- Create: `apps/desktop/resources/user-cache-migrations/0001_user_cache.sql`
- Create: `apps/desktop/electron/main/database/user-data-client.ts`
- Create: `apps/desktop/electron/main/database/user-data-repositories.ts`
- Create: `apps/desktop/electron/main/database/user-data-client.test.ts`
- Modify: `apps/desktop/electron/main/database/client.ts`
- Modify: `apps/desktop/electron/main/index.ts`

**Interfaces:**
- Produces `UserDataStoreManager.open(userId)`, `.current()`, `.closeAndDelete(userId)`, and `.close()`.
- Produces per-user repositories `conversations`, `messages`, `conversationContexts`, `chatRuns`, `providerUsage`, and `outbox`.
- Consumes Electron `userData` path, SHA-256, and existing repository row parsers.

- [ ] **Step 1: Write failing isolation and atomicity tests**

Use a temporary root and prove:

```ts
const alice = manager.open('cloud-alice')
alice.outbox.recordWithConversation(createMutation)
manager.closeAndDelete('cloud-alice')
const bob = manager.open('cloud-bob')
expect(bob.conversations.listPage({ limit: 50 })).toEqual({ items: [] })
expect(readdirSync(root).some((name) => name.includes('cloud-alice'))).toBe(false)
```

Also prove conversation+outbox insertion rolls back together, filenames contain only a SHA-256-derived scope, pending count is capped at 10,000, and the global database no longer clears every user's conversation rows.

- [ ] **Step 2: Run the user-data database test and verify RED**

Run:

```bash
pnpm --filter @autoforge/desktop exec node scripts/run-vitest-electron.mjs run \
  --config vitest.node.config.ts electron/main/database/user-data-client.test.ts
```

Expected: module-not-found failure.

- [ ] **Step 3: Implement the dedicated cache schema and manager**

The cache migration creates local mirrors plus:

```sql
CREATE TABLE outbox_mutations (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  base_revision INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending','syncing','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER,
  last_error_code TEXT,
  occurred_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE sync_checkpoint (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  remote_cursor TEXT,
  protocol_version INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

Hash `userId` with domain separator `autoforge-user-cache-v1\0` and use only the first 32 lowercase hex characters in filenames. The manager must never return the path or user ID through Preload. Keep legacy tables in the global database read-only for explicit import; remove `claimLegacyAndListForUser()` from production list paths.

- [ ] **Step 4: Run focused database tests and global database regression tests**

Run the Step 2 command again.

Run:

```bash
pnpm --filter @autoforge/desktop exec node scripts/run-vitest-electron.mjs run \
  --config vitest.node.config.ts electron/main/database/database.test.ts
```

Expected: both pass.

- [ ] **Step 5: Commit the local isolation slice**

```bash
git add apps/desktop/resources/user-cache-migrations/0001_user_cache.sql apps/desktop/electron/main/database/user-data-client.ts apps/desktop/electron/main/database/user-data-repositories.ts apps/desktop/electron/main/database/user-data-client.test.ts apps/desktop/electron/main/database/client.ts apps/desktop/electron/main/index.ts
git commit -m "feat: isolate cloud user data caches"
```

---

### Task 5: Implement the typed CloudBase port and sync engine

**Files:**
- Create: `apps/desktop/electron/main/cloud/cloudbase-user-data-port.ts`
- Create: `apps/desktop/electron/main/cloud/cloudbase-user-data-port.test.ts`
- Create: `apps/desktop/electron/main/sync/user-data-sync-engine.ts`
- Create: `apps/desktop/electron/main/sync/user-data-sync-engine.test.ts`
- Modify: `apps/desktop/electron/main/auth/cloudbase-auth-port.ts`

**Interfaces:**
- Produces `CloudBaseUserDataPort.call(input): Promise<UserDataFunctionResponse>`.
- Produces `UserDataSyncEngine.start(userId, deviceId)`, `.flush()`, `.pull()`, `.pause()`, and `.status()`.
- Consumes the current authenticated CloudBase `callFunction` port and per-user repositories from Task 4.

- [ ] **Step 1: Write failing port and sync-state-machine tests**

Cover successful push/pull, duplicate mutation receipts, conflict quarantine, retry schedule, auth pause, 5xx retry, 4xx isolation, and UID switching:

```ts
engine.start('alice', 'device-a')
await engine.flush()
expect(outbox.find('mut_1')?.state).toBe('pending')
expect(clock.nextDelay()).toBe(1_000)
engine.pause()
engine.start('bob', 'device-a')
expect(port.calls.some((call) => call.mutations?.some((m) => m.id === 'mut_1'))).toBe(false)
```

- [ ] **Step 2: Run focused tests and verify RED**

```bash
pnpm --filter @autoforge/desktop exec node scripts/run-vitest-electron.mjs run \
  --config vitest.node.config.ts \
  electron/main/cloud/cloudbase-user-data-port.test.ts \
  electron/main/sync/user-data-sync-engine.test.ts
```

Expected: missing modules.

- [ ] **Step 3: Implement strict response parsing and deterministic retries**

Use the existing CloudBase function port; do not add direct database access. Parse function output with Zod before applying it. Retry transient failures at 1 s, 2 s, 4 s, 8 s, then cap at 5 minutes with jitter injected for deterministic tests. Authentication errors pause. `SYNC_CONFLICT`, `UPGRADE_REQUIRED`, and invalid remote rows enter failed/quarantined state with stable UI-safe metadata.

Apply each remote pull page and update `sync_checkpoint` in one SQLite transaction. A duplicate server sequence or mutation receipt is a no-op; a mismatched duplicate is a consistency failure.

- [ ] **Step 4: Run focused tests and desktop typecheck**

Run the Step 2 command again.

Run: `pnpm --filter @autoforge/desktop typecheck`

Expected: all pass.

- [ ] **Step 5: Commit the sync engine**

```bash
git add apps/desktop/electron/main/cloud apps/desktop/electron/main/sync apps/desktop/electron/main/auth/cloudbase-auth-port.ts
git commit -m "feat: synchronize per-user conversation caches"
```

---

### Task 6: Route chat services through the remote cache contract

**Files:**
- Modify: `apps/desktop/electron/main/application.ts`
- Modify: `apps/desktop/electron/main/application.test.ts`
- Modify: `apps/desktop/electron/main/ipc/register-ipc.ts`
- Modify: `apps/desktop/electron/preload/bridge.ts`
- Modify: `apps/desktop/src/stores/chat.ts`
- Modify: `apps/desktop/src/components/ContextSidebar.vue`
- Modify: `apps/desktop/tests/components/chat.test.ts`
- Modify: `apps/desktop/tests/components/workbench.test.ts`

**Interfaces:**
- Consumes paginated contracts from Task 1 and sync engine from Task 5.
- Produces cursor-aware list loading, optimistic local mutations, visible sync states, and title-only remote search.

- [ ] **Step 1: Write failing Main and Renderer tests**

Add tests proving session UID selects the cache, Renderer cannot pass an owner, ordinary message insertion moves a conversation to the top, cursor pages append without duplicates, and failed sync remains visible:

```ts
expect(await runtime.services.chat.listConversations({ limit: 50 })).toMatchObject({
  items: [expect.objectContaining({ id: conversation.id, syncState: 'pending' })],
})
expect(store.conversations.map((item) => item.id)).toEqual(['newer', 'older'])
```

- [ ] **Step 2: Run focused tests and verify RED**

```bash
pnpm --filter @autoforge/desktop exec node scripts/run-vitest-electron.mjs run \
  --config vitest.node.config.ts electron/main/application.test.ts
pnpm --filter @autoforge/desktop exec node scripts/run-vitest-electron.mjs run \
  --config vitest.config.ts tests/components/chat.test.ts tests/components/workbench.test.ts
```

Expected: failures for the old full-array API and global repositories.

- [ ] **Step 3: Implement Main routing and cursor-aware Renderer state**

On session establishment, open the UID cache, register the device projection, pull remote changes, then expose chat services. Each create/rename/delete/message append writes cache state plus outbox atomically. `listConversations` and `listMessages` read the local mirror for immediate display and trigger background refresh without changing owner.

Replace full-list assumptions in Pinia with `nextCursor`, per-conversation `previousCursor`, deduplication by ID, and stable sort by `lastActivityAt`. Add a small accessible sync status next to affected conversations and a retry action in settings; preserve the existing sidebar layout and unrelated worktree changes.

- [ ] **Step 4: Run focused tests, typecheck, and lint only changed files**

Run the Step 2 commands again.

Run: `pnpm --filter @autoforge/desktop typecheck`

Run:

```bash
pnpm exec eslint apps/desktop/electron/main/application.ts apps/desktop/electron/main/ipc/register-ipc.ts apps/desktop/electron/preload/bridge.ts apps/desktop/src/stores/chat.ts apps/desktop/src/components/ContextSidebar.vue
```

Expected: all pass.

- [ ] **Step 5: Commit the chat integration**

```bash
git add apps/desktop/electron/main/application.ts apps/desktop/electron/main/application.test.ts apps/desktop/electron/main/ipc/register-ipc.ts apps/desktop/electron/preload/bridge.ts apps/desktop/src/stores/chat.ts apps/desktop/src/components/ContextSidebar.vue apps/desktop/tests/components/chat.test.ts apps/desktop/tests/components/workbench.test.ts
git commit -m "feat: use cloud-backed conversation pages"
```

---

### Task 7: Add explicit legacy import and BYOK remote usage

**Files:**
- Create: `apps/desktop/electron/main/sync/legacy-user-data-import.ts`
- Create: `apps/desktop/electron/main/sync/legacy-user-data-import.test.ts`
- Modify: `apps/desktop/electron/main/billing/provider-usage-stream.ts`
- Modify: `apps/desktop/electron/main/billing/provider-usage-stream.test.ts`
- Modify: `apps/desktop/src/views/SettingsView.vue`
- Modify: `apps/desktop/src/components/settings/BillingUsagePanel.vue`
- Modify: `apps/desktop/tests/components/workbench.test.ts`

**Interfaces:**
- Produces legacy preview counts split into current-UID and unowned groups, idempotent import batches, and BYOK usage mutations.
- Consumes legacy global SQLite read-only repositories and the sync engine.

- [ ] **Step 1: Write failing migration and usage-classification tests**

Prove no preview changes ownership, unowned rows require a second explicit confirmation, duplicate batch IDs do not duplicate conversations, and local OpenRouter/DeepSeek calls serialize only allowed BYOK fields:

```ts
expect(preview).toEqual({ ownedCount: 4, unownedCount: 2, requiresUnownedConfirmation: true })
expect(event).toMatchObject({ credentialOwner: 'user', billable: false })
expect(event).not.toHaveProperty('apiKey')
```

- [ ] **Step 2: Run focused tests and verify RED**

```bash
pnpm --filter @autoforge/desktop exec node scripts/run-vitest-electron.mjs run \
  --config vitest.node.config.ts \
  electron/main/sync/legacy-user-data-import.test.ts \
  electron/main/billing/provider-usage-stream.test.ts
```

Expected: missing importer and missing credential-owner fields.

- [ ] **Step 3: Implement preview/confirm/import and safe BYOK events**

Read legacy data without calling `claimLegacyAndListForUser()`. Generate deterministic import item IDs from `batchId + legacyEntityId`, preserve original timestamps, and upload in batches of at most 100/1 MB. Require a separate boolean confirmation for unowned data and record the consent version server-side.

Before the first cloud conversation is created or uploaded, show and record the general cloud-sync consent version, timestamp, and client version. Refusal leaves legacy data read-only for export or deletion and blocks new cloud conversations; it must not be treated as import consent.

Serialize BYOK usage with purpose, modality, Provider, model, Token, occurred time, and `estimated`/`unavailable` cost status. Preserve only the existing irreversible key fingerprint needed for local reconciliation; exclude it from user exports and Renderer responses.

- [ ] **Step 4: Update settings copy and run tests**

Replace “统计来自本机当前保留的模型调用记录” with remote-source copy that separates confirmed platform cost, pending items, and BYOK estimates. Add account timezone/display-currency controls, import preview/confirm UI, and exact warnings for unowned history.

Run the Step 2 command again.

Run:

```bash
pnpm --filter @autoforge/desktop exec node scripts/run-vitest-electron.mjs run \
  --config vitest.config.ts tests/components/workbench.test.ts
```

Expected: all pass.

- [ ] **Step 5: Commit import and BYOK usage**

```bash
git add apps/desktop/electron/main/sync/legacy-user-data-import.ts apps/desktop/electron/main/sync/legacy-user-data-import.test.ts apps/desktop/electron/main/billing/provider-usage-stream.ts apps/desktop/electron/main/billing/provider-usage-stream.test.ts apps/desktop/src/views/SettingsView.vue apps/desktop/src/components/settings/BillingUsagePanel.vue apps/desktop/tests/components/workbench.test.ts
git commit -m "feat: import legacy chats and sync BYOK usage"
```

---

### Task 8: Verify milestone one and document deployment gates

**Files:**
- Modify: `cloudbase/user-data/README.md`
- Create: `docs/runbooks/cloudbase-user-data-foundation.md`
- Create: `apps/desktop/tests/e2e/cloud-user-data-sync.spec.ts`

**Interfaces:**
- Consumes all milestone-one artifacts.
- Produces an operator runbook, shadow-write/cutover gates, and a two-user/two-device Electron acceptance suite.

- [ ] **Step 1: Add the failing Electron acceptance cases**

Cover Alice/Bob isolation on one machine, Alice on two app profiles, cursor pagination, offline outbox replay, duplicate mutation retry, tombstone propagation, explicit legacy import, and unchanged BYOK cost classification. The test harness must use staging fixtures or a local handler/RPC double; it must not send paid Provider requests.

- [ ] **Step 2: Run the new E2E file and verify RED**

Run: `pnpm build && pnpm exec playwright test apps/desktop/tests/e2e/cloud-user-data-sync.spec.ts`

Expected: failure until the new bridge and fixture entry point are wired.

- [ ] **Step 3: Complete the runbook and E2E fixture wiring**

Document this exact gate order: apply schema, deploy function, verify owner denial, enable shadow write, compare counts/hashes, enable internal import, enable remote read, run dual-device Electron acceptance, then widen the feature flag. Include rollback by disabling remote read/write while preserving accepted remote rows. Do not include credentials or destructive table-drop commands.

- [ ] **Step 4: Run milestone verification**

```bash
pnpm exec vitest run packages/shared/src/contracts.test.ts tests/cloudbase/user-data-migration.test.ts tests/cloudbase/user-data-handler.test.ts
pnpm test
pnpm typecheck
pnpm lint
pnpm build
pnpm exec playwright test apps/desktop/tests/e2e/cloud-user-data-sync.spec.ts
```

Expected: every command exits 0; the E2E report shows user isolation, replay idempotency, and visible sync status.

- [ ] **Step 5: Commit milestone documentation and acceptance**

```bash
git add cloudbase/user-data/README.md docs/runbooks/cloudbase-user-data-foundation.md apps/desktop/tests/e2e/cloud-user-data-sync.spec.ts
git commit -m "test: verify cloud conversation sync milestone"
```
