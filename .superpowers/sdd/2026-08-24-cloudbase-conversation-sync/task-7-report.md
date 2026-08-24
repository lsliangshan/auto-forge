# Task 7 report: explicit legacy import and BYOK remote usage

## Result

- Implemented the owner-free Main -> IPC -> Preload -> Renderer path for cloud-sync consent, read-only legacy preview, confirmed import, account preferences, and remote usage.
- New cloud conversations require the persisted `cloud_sync` document version before their first cache/outbox write. Renderer cancellation performs no consent, cache, outbox, or remote write.
- General cloud-sync and unowned-history import remain distinct consent purposes. The import UI collects both confirmations before persisting either; cancelling the unowned confirmation performs no write.
- Legacy import uses the Task 3 row-bearing `importLegacyBatch` action through the active user's Task 5 engine. It never overloads the metadata-only `legacy.import` mutation.
- BYOK events for OpenRouter and DeepSeek use the authenticated per-user outbox, are always user-owned/non-billable, and classify known Provider cost as `estimated` and absent cost as `unavailable`. Streaming and video events never serialize API keys or fingerprints.
- Commit message: `feat: import legacy chats and sync BYOK usage` (the final hash is recorded in the task handoff and ledger).

## TDD evidence

RED was observed before implementation:

- Import/BYOK slice: the importer module was missing and two BYOK assertions failed because terminal safe events were absent.
- Shared/port/cache slice: dedicated action schemas were absent, the strict port rejected them, migration 4 was absent, and atomic consent projection APIs were absent.
- Engine slice: `importLegacyBatch` was absent from the active-user coordinator.
- Public path: preload methods were absent, IPC handlers were absent, first conversation creation succeeded without consent, and the settings usage/import controls were absent.
- Renderer first-create consent: no confirmation was shown and no consent-backed retry occurred.
- Video completion: no remote-safe BYOK event was emitted for terminal video cost.

GREEN verification is listed below.

## Import and consent boundaries

- Preview reads global legacy conversations with `list()` only. It never calls `claimLegacyAndListForUser()`, mutates ownership, or exposes another non-null UID's rows.
- Import selection includes only the authenticated UID and, when separately confirmed, unowned rows. Foreign UID-owned conversations and messages are excluded.
- Conversation/message identities are deterministic SHA-256-derived values from the import batch, entity kind, and legacy ID. Relationships and original timestamps are preserved.
- Rows are ordered conversation-first and sent in deterministic batches capped at 100 records and one MiB. The Task 5 lifecycle queue serializes each dedicated import call with the active binding and current drain.
- `privacy.consent` remains a durable FIFO outbox mutation. The additive per-UID SQLite projection recognizes consent across restart and applies pulled consent records.
- Refused first-conversation consent and cancelled unowned import confirmation are covered as no-write paths.

## Preferences and usage

- `preferences.update` remains an optimistic per-UID projection plus durable FIFO outbox mutation. Pulled or directly read preferences are projected locally with revision and update time.
- Main validates account timezones with `Intl.DateTimeFormat`; display currency remains the strict `CNY | USD` contract. Invalid timezone tests prove no outbox write.
- `getUserDataPreferences` and `getUsageSnapshot` use the expanded strict CloudBase port and derive identity only from the authenticated function context.
- Remote usage distinguishes platform-confirmed cost, unacknowledged BYOK records, BYOK estimates, unavailable-cost records, tokens, account timezone/currency, and last sync time. BYOK estimates are never displayed as confirmed spend.

## BYOK attribution and secrecy

- All eight production `trackProviderStream` callers now pass an explicit bounded purpose: assistant reply, workflow routing, browser routing, browser field matching, browser page evidence, context compression, conversation title, and media generation.
- OpenRouter retains its Main-local reconciliation event/fingerprint behavior while also emitting a sanitized outbox event. DeepSeek emits the sanitized outbox event without creating an OpenRouter reconciliation record.
- Completed and costless tracked OpenRouter video jobs emit sanitized `media_generation` BYOK events through the same authenticated sink.
- Wire and Renderer contracts contain no API key, fingerprint, end-user owner input, path, or arbitrary UID.

## Files changed

- Shared contracts/tests: `packages/shared/src/desktop-api.ts`, `packages/shared/src/contracts.test.ts`.
- Import/sync/port: `legacy-user-data-import.ts` and test, `user-data-sync-engine.ts` and test, `cloudbase-user-data-port.ts` and test.
- Per-UID cache: `user-data-client.ts` and test, `user-data-repositories.ts`, migration `0004_account_sync_projection.sql`.
- BYOK attribution: `provider-usage-stream.ts` and test, repository interface, eight stream call sites, `video-job-runner.ts` and focused test.
- Public Main boundary: `application.ts` and test, `register-ipc.ts` and test, preload `bridge.ts` and test.
- Renderer: chat/settings stores, `SettingsView.vue`, `BillingUsagePanel.vue`, and `workbench.test.ts`.

## Verification

- Shared contract test: 81/81 passed.
- Expanded Main importer/BYOK/video/port/cache/engine/preload/IPC/application group: 381/381 passed across 9 files before the final no-write assertions; the final application + video rerun passed 226/226.
- Renderer workbench suite: 75/75 passed.
- Desktop Main + Renderer typecheck: passed.
- Shared typecheck and build: passed.
- ESLint over every changed TypeScript/Vue file: exited 0 with no errors. It reports four pre-existing compact-markup warnings in unchanged portions of `SettingsView.vue`.
- `git diff --check`: passed before commit.

## Remaining staging-only gaps

- This task does not deploy CloudBase functions or PostgreSQL migrations. Task 8 must validate deployed Task 2/3 artifacts and real authenticated round trips in staging.
- `confirmedPlatformCost` remains `null` until the later platform-run gateway supplies trusted server-side platform billing; BYOK estimates never populate it.
- Media object bytes remain local and are not uploaded by this task.
