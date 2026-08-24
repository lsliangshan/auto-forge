# CloudBase Media and Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add private cross-device media, shared context checkpoints, offline identity leases, device revocation, recent deletion, export, and recoverable lifecycle operations on top of the cloud conversation foundation.

**Architecture:** PostgreSQL stores object metadata, references, device state, context CAS checkpoints, deletion state, and export jobs. Electron Main uploads/downloads bytes through short-lived owner-bound CloudBase Storage tickets while keeping paths and URLs out of Renderer; the per-user cache persists only safe metadata and transient local copies. Lifecycle operations are idempotent server commands backed by tombstones and scheduled cleanup.

**Tech Stack:** TypeScript 6, Electron 43, better-sqlite3 12, CloudBase PostgreSQL, CloudBase PG Storage with RLS, CloudBase functions, Vue 3, Zod 4, Vitest 4, Playwright.

**Spec:** `docs/superpowers/specs/2026-08-24-cloudbase-user-data-persistence-design.md`

## Global Constraints

- Private media is owner-readable only. Do not use public URLs or a public-read bucket.
- Object bytes never pass through Renderer, ordinary IPC payloads, PostgreSQL, logs, or snapshots.
- Upload tickets bind owner, object key, MIME, byte size, SHA-256, and a short expiration. Download tickets expire after 10 minutes.
- One attachment is capped at 50 MB and one account at 5 GB; approaching quota warns, reaching quota blocks only new uploads.
- Temporary files, intermediate frames, and failed generation outputs never upload.
- Complete transcript remains visible; context summaries remain internal and are excluded from export.
- Offline lease duration is exactly 72 hours and never authorizes platform calls, exports, quota changes, or administrator actions.
- Normal logout flushes pending data. Forced logout requires explicit discard and deletes the UID cache.
- Conversation soft deletion lasts 30 days. Usage ledger is not deleted with a conversation.
- CloudBase storage operations must follow current private-object/RLS behavior documented at `https://docs.cloudbase.net/storage/sdk` and `https://docs.cloudbase.net/en/storage/pg/serving`.
- Do not stage or modify unrelated pre-existing workspace changes.

---

### Task 1: Add media, device, offline lease, trash, and export contracts

**Files:**
- Modify: `packages/shared/src/desktop-api.ts`
- Modify: `packages/shared/src/errors.ts`
- Modify: `packages/shared/src/contracts.test.ts`

**Interfaces:**
- Produces `RemoteMediaObject`, media transfer status, `OfflineLeaseSummary`, `SyncDevice`, trash pages, logout mode, export jobs, and account reauthentication/deletion contracts.
- Consumes existing `MediaAsset`, `MediaKind`, cursor, timestamp, and sync state schemas.

- [ ] **Step 1: Write failing contract tests**

```ts
expect(authLogoutRequestSchema.parse({ mode: 'normal' })).toEqual({ mode: 'normal' })
expect(authLogoutRequestSchema.parse({ mode: 'discard_pending' }))
  .toEqual({ mode: 'discard_pending' })
expect(remoteMediaObjectSchema.safeParse({
  id: 'asset_1', objectKey: 'secret/path', downloadUrl: 'https://long-lived.example/a',
}).success).toBe(false)
expect(appErrorCodeSchema.parse('PENDING_SYNC_BLOCKS_LOGOUT')).toBe('PENDING_SYNC_BLOCKS_LOGOUT')
expect(appErrorCodeSchema.parse('OFFLINE_LEASE_EXPIRED')).toBe('OFFLINE_LEASE_EXPIRED')
```

- [ ] **Step 2: Run shared tests and verify RED**

Run: `pnpm exec vitest run packages/shared/src/contracts.test.ts`

Expected: missing contracts and old undefined logout request.

- [ ] **Step 3: Implement strict safe contracts**

Define outputs without storage paths or URLs:

```ts
export const remoteMediaObjectSchema = z.object({
  id: identifierSchema,
  kind: mediaKindSchema,
  mimeType: nonEmptyStringSchema,
  displayName: nonEmptyStringSchema,
  byteSize: z.number().int().nonnegative().max(50 * 1024 * 1024),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  state: z.enum(['pending', 'uploading', 'ready', 'failed', 'deleted']),
  syncState: syncStateSchema,
}).strict()
export const exportJobSchema = z.object({
  id: identifierSchema,
  state: z.enum(['queued', 'running', 'ready', 'failed', 'expired']),
  expiresAt: timestampSchema.optional(),
}).strict()
```

Add device list/revoke, recent-delete list/restore/permanent-delete, export create/status/download, and `auth.logout({ mode })` IPC contracts. Add stable error codes `PENDING_SYNC_BLOCKS_LOGOUT`, `OFFLINE_LEASE_EXPIRED`, `DEVICE_REVOKED`, `MEDIA_QUOTA_EXCEEDED`, `MEDIA_TRANSFER_FAILED`, and `EXPORT_REAUTH_REQUIRED`.

Add `auth.sendAccountDeletionCode()`, `auth.deleteAccount({ challengeId, code, confirmation })`, and strict confirmation text `DELETE`. The verification code is request-only and must never appear in an output schema, Store persistence, log, or snapshot. Add `ACCOUNT_DELETION_PENDING` and `ACCOUNT_DELETION_FAILED` safe errors.

- [ ] **Step 4: Run shared tests and typecheck**

Run: `pnpm exec vitest run packages/shared/src/contracts.test.ts`

Run: `pnpm --filter @autoforge/shared typecheck`

Expected: both pass.

- [ ] **Step 5: Commit the reliability contracts**

```bash
git add packages/shared/src/desktop-api.ts packages/shared/src/errors.ts packages/shared/src/contracts.test.ts
git commit -m "feat: define cloud media and lifecycle contracts"
```

---

### Task 2: Add remote media, context, device, trash, and export schema

**Files:**
- Create: `cloudbase/migrations/20260824100000_media_reliability.sql`
- Create: `cloudbase/user-data/migrations/0002_media_reliability.sql`
- Create: `cloudbase/user-data/migrations/0002_media_reliability.rollback.sql`
- Create: `tests/cloudbase/media-reliability-migration.test.ts`

**Interfaces:**
- Produces `app_media_objects`, `app_message_media`, `app_conversation_contexts`, `app_data_exports`, `app_account_deletion_jobs`, offline lease/device fields, cleanup queues, and storage RLS policies.
- Produces RPCs for ticket issuance/finalization, context CAS, device revoke, trash restore/permanent delete, export state, and cleanup leasing.
- Consumes milestone-one owner tables and service-role caller UID.

- [ ] **Step 1: Write failing schema artifact tests**

Assert canonical-copy equality and security constraints:

```ts
expect(sql).toContain("CHECK (byte_size BETWEEN 0 AND 52428800)")
expect(sql).toContain('UNIQUE (owner_user_id, sha256)')
expect(sql).toContain('expected_revision')
expect(sql).toContain("deleted_at + interval '30 days'")
expect(sql).toContain('CREATE POLICY')
expect(sql).toContain('storage.objects')
expect(sql).not.toMatch(/public-read|GRANT .*authenticated/i)
```

- [ ] **Step 2: Run migration test and verify RED**

Run: `pnpm exec vitest run tests/cloudbase/media-reliability-migration.test.ts`

Expected: files are absent.

- [ ] **Step 3: Implement schema, RLS, and lifecycle RPCs**

Use an owner-private bucket named `autoforge-user-media`. Object names are server-generated and do not contain display names:

```sql
CREATE TABLE app_media_objects (
  id text PRIMARY KEY,
  owner_user_id bigint NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  object_key text NOT NULL,
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  mime_type text NOT NULL,
  byte_size bigint NOT NULL CHECK (byte_size BETWEEN 0 AND 52428800),
  display_name text NOT NULL,
  state text NOT NULL CHECK (state IN ('pending','ready','failed','deleting')),
  reference_count integer NOT NULL DEFAULT 0 CHECK (reference_count >= 0),
  purge_after timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_user_id, sha256),
  UNIQUE (object_key)
);
```

Storage RLS compares authenticated subject/UID to the owner scope recorded for the object. Ticket RPCs take desired MIME, byte size, and SHA-256, derive owner and object key server-side, enforce account quota transactionally, and return a one-use transfer claim. Finalization verifies stored metadata before setting `ready`.

Context CAS updates summary and `through_ordinal` together. Restore increments conversation revision and clears tombstone only while purge has not occurred. Cleanup workers lease rows with `FOR UPDATE SKIP LOCKED`; failures remain retryable and audited.

`app_account_deletion_jobs` stores a request ID, UID text snapshot, state, timestamps, and safe error code without a foreign key to `auth.users`. `autoforge_prepare_account_deletion` atomically revokes devices, makes all owner rows inaccessible, enqueues object keys for cleanup, and returns an idempotent receipt that survives auth-user deletion.

- [ ] **Step 4: Run artifact tests and compare migrations**

Run: `pnpm exec vitest run tests/cloudbase/media-reliability-migration.test.ts`

Run: `cmp cloudbase/migrations/20260824100000_media_reliability.sql cloudbase/user-data/migrations/0002_media_reliability.sql`

Expected: pass and `cmp` exits 0.

- [ ] **Step 5: Commit the remote reliability schema**

```bash
git add cloudbase/migrations/20260824100000_media_reliability.sql cloudbase/user-data/migrations/0002_media_reliability.sql cloudbase/user-data/migrations/0002_media_reliability.rollback.sql tests/cloudbase/media-reliability-migration.test.ts
git commit -m "feat: add cloud media and lifecycle schema"
```

---

### Task 3: Extend the CloudBase function with owner-bound media tickets and lifecycle actions

**Files:**
- Modify: `cloudbase/user-data/function/user-data-handler.js`
- Modify: `cloudbase/user-data/function/index.js`
- Modify: `cloudbase/user-data/function/package.json`
- Modify: `tests/cloudbase/user-data-handler.test.ts`
- Create: `tests/cloudbase/user-data-media-handler.test.ts`

**Interfaces:**
- Produces actions `createMediaUpload`, `finalizeMediaUpload`, `createMediaDownload`, `advanceContext`, `listDevices`, `revokeDevice`, `listDeletedConversations`, `restoreConversation`, `permanentlyDeleteConversation`, `createExport`, `getExportStatus`, and `prepareAccountDeletion`.
- Consumes caller UID and Task 2 RPCs/storage service.

- [ ] **Step 1: Write failing handler boundary tests**

Cover forged object keys, forged owner, expired ticket, MIME/size mismatch, cross-owner download, stale context revision, revoked device, and export without recent reauthentication. Assert successful responses expose a short-lived transfer URL only in the dedicated Main-only action response, never in list/message payloads.

- [ ] **Step 2: Run handler tests and verify RED**

Run:

```bash
pnpm exec vitest run tests/cloudbase/user-data-handler.test.ts tests/cloudbase/user-data-media-handler.test.ts
```

Expected: new actions are rejected as invalid input.

- [ ] **Step 3: Implement exact action parsers and storage adapter**

Each action requires exact keys and `protocolVersion`. `createMediaUpload` accepts only asset ID, MIME, size, SHA-256, and display name; it never accepts object key or owner. `createMediaDownload` accepts asset ID and returns a URL expiring in 600 seconds after owner validation. `finalizeMediaUpload` verifies the same transfer claim and remote object metadata.

Use a narrow injected storage port in handler tests:

```js
const storage = {
  createUploadTicket(input) {},
  inspectObject(input) {},
  createDownloadTicket(input) {},
  deleteObject(input) {},
}
```

Production initialization uses CloudBase server credentials available only in the function environment. Do not log returned signed URLs or raw storage errors.

- [ ] **Step 4: Run handler tests**

Run the Step 2 command again.

Expected: all pass.

- [ ] **Step 5: Commit the media function boundary**

```bash
git add cloudbase/user-data/function/user-data-handler.js cloudbase/user-data/function/index.js cloudbase/user-data/function/package.json tests/cloudbase/user-data-handler.test.ts tests/cloudbase/user-data-media-handler.test.ts
git commit -m "feat: issue private cloud media tickets"
```

---

### Task 4: Upload and download private media in Electron Main

**Files:**
- Create: `apps/desktop/electron/main/media/cloud-media-transfer.ts`
- Create: `apps/desktop/electron/main/media/cloud-media-transfer.test.ts`
- Modify: `apps/desktop/electron/main/media/media-asset-service.ts`
- Modify: `apps/desktop/electron/main/media/media-lifecycle.ts`
- Modify: `apps/desktop/electron/main/media/media-lifecycle.test.ts`
- Modify: `apps/desktop/electron/main/media/media-protocol.ts`

**Interfaces:**
- Produces `CloudMediaTransfer.enqueueUpload(assetId)`, `.ensureLocal(assetId)`, `.cancelForUser(userId)`, and `.retryFailed()`.
- Consumes local asset streams, safe metadata, SHA-256, and Main-only upload/download ticket actions.

- [ ] **Step 1: Write failing transfer tests**

Use local HTTP doubles and actual temporary files to prove streaming upload, 50 MB hard stop, ticket expiry refresh, hash mismatch rejection, atomic download, Range-serving from the local cache, and no signed URL persistence:

```ts
await transfer.ensureLocal('asset_1')
expect(readFileSync(localPath)).toEqual(expectedBytes)
expect(sqlite.prepare('SELECT signed_url FROM media_assets').get()).toBeUndefined()
```

- [ ] **Step 2: Run focused media tests and verify RED**

```bash
pnpm --filter @autoforge/desktop exec node scripts/run-vitest-electron.mjs run \
  --config vitest.node.config.ts \
  electron/main/media/cloud-media-transfer.test.ts \
  electron/main/media/media-lifecycle.test.ts
```

Expected: missing transfer module and remote states.

- [ ] **Step 3: Implement streaming transfer and cache lifecycle**

Open files only inside the existing controlled media root. Upload with `fs.createReadStream`, enforce the declared and observed byte limit, and refresh an expired ticket once. Download to `.staging`, stream-compute SHA-256 and byte count, then atomically rename only when both match remote metadata.

Message/list APIs return safe metadata only. `autoforge-media://asset/<id>` calls `ensureLocal` in Main, then serves the verified local file with the existing MIME and Range behavior. Never redirect the protocol to a signed URL.

- [ ] **Step 4: Run media tests and typecheck**

Run the Step 2 command again.

Run: `pnpm --filter @autoforge/desktop typecheck`

Expected: pass.

- [ ] **Step 5: Commit private media transfer**

```bash
git add apps/desktop/electron/main/media/cloud-media-transfer.ts apps/desktop/electron/main/media/cloud-media-transfer.test.ts apps/desktop/electron/main/media/media-asset-service.ts apps/desktop/electron/main/media/media-lifecycle.ts apps/desktop/electron/main/media/media-lifecycle.test.ts apps/desktop/electron/main/media/media-protocol.ts
git commit -m "feat: synchronize private conversation media"
```

---

### Task 5: Synchronize internal context checkpoints with CAS

**Files:**
- Modify: `apps/desktop/electron/main/chat/conversation-context.ts`
- Modify: `apps/desktop/electron/main/chat/conversation-context.test.ts`
- Modify: `apps/desktop/electron/main/sync/user-data-sync-engine.ts`
- Modify: `apps/desktop/electron/main/sync/user-data-sync-engine.test.ts`
- Modify: `apps/desktop/electron/main/database/user-data-repositories.ts`

**Interfaces:**
- Produces remote context records with `throughOrdinal`, summary text, estimated tokens, Provider, model, budget parameters, and revision.
- Consumes remote message ordinals and the existing summary-generation provider port.

- [ ] **Step 1: Write failing cross-device checkpoint tests**

Prove device B consumes device A's checkpoint without a second summary call, stale CAS reloads the winning checkpoint, transcript remains complete, and no summary appears in public message/page/export responses.

- [ ] **Step 2: Run context and sync tests and verify RED**

```bash
pnpm --filter @autoforge/desktop exec node scripts/run-vitest-electron.mjs run \
  --config vitest.node.config.ts \
  electron/main/chat/conversation-context.test.ts \
  electron/main/sync/user-data-sync-engine.test.ts
```

Expected: context is local-only and has no remote revision.

- [ ] **Step 3: Implement remote-first checkpoint reads and CAS writes**

Before assembling history, apply pending remote pull pages for that conversation, then read the cached remote checkpoint. After a successful non-empty `finish: stop`, enqueue `context.advance` with expected revision and checkpoint. On `SYNC_CONFLICT`, pull the winner and recompute; do not silently overwrite or append a duplicate summary.

Retain exact existing budgeting and media serialization behavior. Summary text remains absent from shared schemas and diagnostic objects.

- [ ] **Step 4: Run focused tests**

Run the Step 2 command again.

Expected: pass with one summary provider call across the two-device fixture.

- [ ] **Step 5: Commit shared context state**

```bash
git add apps/desktop/electron/main/chat/conversation-context.ts apps/desktop/electron/main/chat/conversation-context.test.ts apps/desktop/electron/main/sync/user-data-sync-engine.ts apps/desktop/electron/main/sync/user-data-sync-engine.test.ts apps/desktop/electron/main/database/user-data-repositories.ts
git commit -m "feat: share conversation context checkpoints"
```

---

### Task 6: Add offline leases, device management, and safe logout

**Files:**
- Create: `apps/desktop/electron/main/auth/offline-session-lease.ts`
- Create: `apps/desktop/electron/main/auth/offline-session-lease.test.ts`
- Create: `apps/desktop/electron/main/sync/device-service.ts`
- Create: `apps/desktop/electron/main/sync/device-service.test.ts`
- Modify: `apps/desktop/electron/main/application.ts`
- Modify: `apps/desktop/electron/main/application.test.ts`
- Modify: `apps/desktop/electron/main/security/secret-store.ts`
- Modify: `apps/desktop/electron/main/auth/cloudbase-auth-port.ts`
- Modify: `apps/desktop/electron/main/auth/cloudbase-auth-service.ts`
- Modify: `apps/desktop/electron/main/auth/cloudbase-auth-service.test.ts`

**Interfaces:**
- Produces a signed/validated local lease record and `DeviceService.register/list/revoke`.
- Consumes CloudBase session validation, role version, installation ID, current UID cache, and sync engine.

- [ ] **Step 1: Write failing lease and logout tests**

Cover 72-hour validity, UID/device/role binding, tamper rejection, expired restrictions, revoked-device online rejection, normal logout with pending data, forced discard, five-minute account-deletion challenges, and verification-code redaction:

```ts
await expect(runtime.services.auth.logout({ mode: 'normal' }))
  .rejects.toMatchObject({ code: 'PENDING_SYNC_BLOCKS_LOGOUT' })
await runtime.services.auth.logout({ mode: 'discard_pending' })
expect(userCacheExists('alice')).toBe(false)
```

- [ ] **Step 2: Run focused tests and verify RED**

```bash
pnpm --filter @autoforge/desktop exec node scripts/run-vitest-electron.mjs run \
  --config vitest.node.config.ts \
  electron/main/auth/offline-session-lease.test.ts \
  electron/main/sync/device-service.test.ts \
  electron/main/application.test.ts
```

Expected: lease/device modules are missing and logout has no mode.

- [ ] **Step 3: Implement lease and logout ordering**

Store lease material through `SecretStore` under a UID-hashed key; include `issuedAt`, `expiresAt = issuedAt + 72 hours`, device ID, UID, and role version. Validate integrity before opening the user cache. Offline authorization exposes only `readCache`, `writeDraft`, and `queueMutation` capabilities.

Normal logout calls `flush`, waits for terminal success, signs out, closes and deletes the UID cache, then clears lease/session material. `discard_pending` first requires the exact caller intent, deletes cache/outbox/media, clears lease/session, and performs remote sign-out as best effort. A failed remote sign-out must not leave a readable cache after explicit discard.

Add CloudBase Auth Port methods that initiate reauthentication and call the current-user deletion endpoint with the access token, verification code, and device ID. Keep the challenge callback/code in Main memory for at most five minutes. Account deletion ordering is: prepare the server deletion receipt, call CloudBase identity deletion, delete the UID cache/media/lease/session, and navigate to login. If identity deletion fails, retain only the encrypted auth session needed for an explicit retry; do not restore business rows already marked inaccessible.

- [ ] **Step 4: Run focused tests and typecheck**

Run the Step 2 command again.

Run: `pnpm --filter @autoforge/desktop typecheck`

Expected: pass.

- [ ] **Step 5: Commit offline identity and device controls**

```bash
git add apps/desktop/electron/main/auth/offline-session-lease.ts apps/desktop/electron/main/auth/offline-session-lease.test.ts apps/desktop/electron/main/sync/device-service.ts apps/desktop/electron/main/sync/device-service.test.ts apps/desktop/electron/main/application.ts apps/desktop/electron/main/application.test.ts apps/desktop/electron/main/security/secret-store.ts apps/desktop/electron/main/auth/cloudbase-auth-port.ts apps/desktop/electron/main/auth/cloudbase-auth-service.ts apps/desktop/electron/main/auth/cloudbase-auth-service.test.ts
git commit -m "feat: enforce offline leases and safe logout"
```

---

### Task 7: Add recent deletion, export, cleanup, and user-facing controls

**Files:**
- Create: `cloudbase/user-data/scripts/run-lifecycle-cleanup.mjs`
- Create: `cloudbase/user-data/scripts/run-export-worker.mjs`
- Create: `tests/cloudbase/user-data-lifecycle-worker.test.ts`
- Modify: `apps/desktop/electron/main/application.ts`
- Modify: `apps/desktop/electron/main/ipc/register-ipc.ts`
- Modify: `apps/desktop/electron/preload/bridge.ts`
- Modify: `apps/desktop/src/components/ContextSidebar.vue`
- Modify: `apps/desktop/src/views/SettingsView.vue`
- Modify: `apps/desktop/tests/components/chat.test.ts`
- Modify: `apps/desktop/tests/components/workbench.test.ts`

**Interfaces:**
- Produces recently-deleted pages, restore/permanent-delete flows, versioned export archives, and idempotent cleanup workers.
- Consumes tombstone/object/export RPCs and recent online reauthentication.

- [ ] **Step 1: Write failing lifecycle worker and UI tests**

Prove restore before deadline, permanent delete confirmation, expired cleanup, usage preservation, export exclusion of summaries/key fingerprints, one-use download, account deletion cleanup after the auth user is gone, and visible remaining days. Worker retry must not double-delete objects, re-expose deleted rows, or recreate exports.

- [ ] **Step 2: Run focused tests and verify RED**

```bash
pnpm exec vitest run tests/cloudbase/user-data-lifecycle-worker.test.ts
pnpm --filter @autoforge/desktop exec node scripts/run-vitest-electron.mjs run \
  --config vitest.config.ts tests/components/chat.test.ts tests/components/workbench.test.ts
```

Expected: workers/actions/UI are absent.

- [ ] **Step 3: Implement lifecycle workers and export format**

The cleanup worker leases due tombstones and account-deletion jobs, deletes private objects in batches of at most 50, then marks rows purged. Account jobs store only the minimum UID text receipt and safe progress needed after `auth.users` cascade; completion removes that residual receipt on the normal audit-retention schedule. The export worker writes:

```text
autoforge-export/
  manifest.json
  conversations.json
  usage-events.json
  usage-events.csv
  media/
  checksums.sha256
```

Exclude context summaries, debug logs, API key fingerprints, tokens, storage object keys, and signed URLs. Store the archive as a private object and return a one-use 10-minute download ticket only after recent online reauthentication.

- [ ] **Step 4: Implement Renderer controls and run tests**

Add “最近删除”, remaining-day copy, restore, permanent delete, device list/revoke, export state, pending-logout dialog, account reauthentication/delete flow, and storage quota status without exposing internal IDs. Run the Step 2 commands again.

Expected: all pass.

- [ ] **Step 5: Commit lifecycle and UI**

```bash
git add cloudbase/user-data/scripts/run-lifecycle-cleanup.mjs cloudbase/user-data/scripts/run-export-worker.mjs tests/cloudbase/user-data-lifecycle-worker.test.ts apps/desktop/electron/main/application.ts apps/desktop/electron/main/ipc/register-ipc.ts apps/desktop/electron/preload/bridge.ts apps/desktop/src/components/ContextSidebar.vue apps/desktop/src/views/SettingsView.vue apps/desktop/tests/components/chat.test.ts apps/desktop/tests/components/workbench.test.ts
git commit -m "feat: add cloud data lifecycle controls"
```

---

### Task 8: Verify milestone two and disaster-recovery operations

**Files:**
- Create: `docs/runbooks/cloudbase-media-lifecycle.md`
- Create: `docs/runbooks/cloudbase-user-data-recovery.md`
- Create: `apps/desktop/tests/e2e/cloud-media-reliability.spec.ts`
- Modify: `cloudbase/user-data/README.md`

**Interfaces:**
- Consumes all milestone-two components.
- Produces private-media, offline, restore/export, backup, and deletion-replay acceptance evidence.

- [ ] **Step 1: Write the failing real-boundary acceptance cases**

Cover cross-device media availability, denied cross-owner ticket, interrupted upload retry, context reuse, 72-hour lease boundaries with an injected clock, device revoke, pending logout choices, trash restore, permanent delete, account deletion reauthentication/cleanup continuation, and export checksum verification.

- [ ] **Step 2: Run the E2E file and verify RED**

Run: `pnpm build && pnpm exec playwright test apps/desktop/tests/e2e/cloud-media-reliability.spec.ts`

Expected: failure until the staging storage and lifecycle fixture is wired.

- [ ] **Step 3: Write exact operator runbooks**

Document private bucket/RLS verification, quota alarms, cleanup scheduling, export worker scheduling, encrypted backup retention of at most 30 days, RPO 5 minutes, RTO 4 hours, and quarterly restore steps. Recovery must restore a snapshot into an isolated environment, replay account/conversation deletion tombstones, verify object references, and only then permit cutover.

- [ ] **Step 4: Run milestone verification**

```bash
pnpm exec vitest run tests/cloudbase/media-reliability-migration.test.ts tests/cloudbase/user-data-media-handler.test.ts tests/cloudbase/user-data-lifecycle-worker.test.ts
pnpm test
pnpm typecheck
pnpm lint
pnpm build
pnpm exec playwright test apps/desktop/tests/e2e/cloud-media-reliability.spec.ts
```

Expected: all commands exit 0 and the Electron report includes visible private-media, offline, trash, and export results.

- [ ] **Step 5: Commit milestone-two verification**

```bash
git add docs/runbooks/cloudbase-media-lifecycle.md docs/runbooks/cloudbase-user-data-recovery.md apps/desktop/tests/e2e/cloud-media-reliability.spec.ts cloudbase/user-data/README.md
git commit -m "test: verify cloud media reliability milestone"
```
