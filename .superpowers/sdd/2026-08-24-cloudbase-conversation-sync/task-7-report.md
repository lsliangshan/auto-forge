# Task 7 report: explicit legacy import and BYOK remote usage

## Result

- Implemented the owner-free Main -> IPC -> Preload -> Renderer path for cloud-sync consent, read-only legacy preview, confirmed import, account preferences, and remote usage.
- New cloud conversations require the persisted `cloud_sync` document version before their first cache/outbox write. Renderer cancellation performs no consent, cache, outbox, or remote write.
- General cloud-sync and unowned-history import remain distinct consent purposes. The import UI collects both confirmations before persisting either; cancelling the unowned confirmation performs no write.
- Legacy import uses the Task 3 row-bearing `importLegacyBatch` action through the active user's Task 5 engine. It never overloads the metadata-only `legacy.import` mutation.
- BYOK events for OpenRouter and DeepSeek use the authenticated per-user outbox, are always user-owned/non-billable, and classify known Provider cost as `estimated` and absent cost as `unavailable`. Streaming and video events never serialize API keys or fingerprints.
- Commit message: `feat: import legacy chats and sync BYOK usage` (the final hash is recorded in the task handoff and ledger).

## Review follow-up

- All six cloud-data settings methods now run inside `UserDataAdmissionGate`. Dedicated legacy imports additionally capture the active UID/generation and the Task 5 engine verifies that binding before and after any pending drain; an A request cannot be adopted by B after an identity handoff.
- A remote `rejected` import result is a safe failure. Import stops at that batch and the Renderer cannot display completion.
- Renderer import requests no longer choose batch IDs. Main hashes the exact selected legacy set and the per-UID cache migration `0005_legacy_import_identity.sql` persists one root batch identity for that set and consent-version tuple. Ambiguous retries and restarts reuse the same root; changing the selected set or consent versions rotates it.
- Optimistic preference projections advance to `baseRevision + 1`. Consecutive offline updates therefore enqueue FIFO bases `0`, then `1`; an earlier receipt cannot overwrite a newer optimistic projection, and a later conflict keeps that projection visible and retryable.
- Local OpenRouter BYOK labels now say estimate/unavailable rather than confirmed/pending confirmation. Only the separately trusted platform-cost field retains “confirmed” language.
- CloudBase usage responses canonicalize SQL numeric strings such as `0.010000000000` to `0.01` before the strict public decimal schema. Monthly bounds use the saved IANA timezone, including east/west UTC month-boundary coverage.
- Imported conversation activity is the maximum of its conversation timestamps and latest selected message timestamp.
- Review round 2 centralizes the one-MiB wire limit in the strict CloudBase port. The Task 5 engine constructs and measures the exact final `importLegacyBatch` call, including action, protocol version, and the active device binding; the importer uses that same measurement before accepting a record into a batch. Near-limit batches therefore split before transport, without UUID-specific byte reservations, while an individually oversized record still fails safely.
- Import-projection follow-up: the SQL import RPC now appends deterministic `conversation.create` receipts before imported message receipts, advances each conversation through sequential `message.append` revisions, and keeps the reduced `legacy.import` receipt last. A duplicate batch still exits before row work, while the existing inner exception block keeps rejected batches transactional.
- Main now awaits ordinary paged pull after all accepted import batches, so the current per-UID cache is hydrated before success returns and another profile hydrates through the same pull path. A stopped/retrying pull surfaces its safe status instead of reporting import success. There are no direct local snapshot writes.
- Legacy SQLite `execution_id = NULL` is omitted from the strict import wire, while a present string execution ID is preserved.

## TDD evidence

RED was observed before implementation:

- Import/BYOK slice: the importer module was missing and two BYOK assertions failed because terminal safe events were absent.
- Shared/port/cache slice: dedicated action schemas were absent, the strict port rejected them, migration 4 was absent, and atomic consent projection APIs were absent.
- Engine slice: `importLegacyBatch` was absent from the active-user coordinator.
- Public path: preload methods were absent, IPC handlers were absent, first conversation creation succeeded without consent, and the settings usage/import controls were absent.
- Renderer first-create consent: no confirmation was shown and no consent-backed retry occurred.
- Video completion: no remote-safe BYOK event was emitted for terminal video cost.
- Review round 1: seven focused failures reproduced non-canonical SQL cost, stale imported activity, rejected import continuation, missing binding-generation verification, and non-sequential preference projections/receipt overwrite. Additional RED tests reproduced the renderer-controlled import identity, missing persisted root, and confirmed-cost BYOK labels.
- Review round 2: the real importer -> engine -> strict-port threshold test failed with `INVALID_INPUT` because the importer admitted a request whose final authenticated call was one byte above 1,048,576 bytes.
- Import-projection follow-up: the SQL static test first failed because no deterministic normal row receipts existed; the real Main/in-memory-port test then returned an empty current-profile cache because import success did not await pull, and a lost projection pull incorrectly returned a duplicate import success. A strict importer -> engine -> CloudBase-port test also failed with `INVALID_INPUT` because a normal absent SQLite execution ID was serialized as `null`.

GREEN verification is listed below.

## Import and consent boundaries

- Preview reads global legacy conversations with `list()` only. It never calls `claimLegacyAndListForUser()`, mutates ownership, or exposes another non-null UID's rows.
- Import selection includes only the authenticated UID and, when separately confirmed, unowned rows. Foreign UID-owned conversations and messages are excluded.
- Conversation/message identities are deterministic SHA-256-derived values from the import batch, entity kind, and legacy ID. Relationships and original timestamps are preserved.
- The public root identity is Main-owned and persisted per UID. Its selection fingerprint includes only the active UID/unowned-confirmed rows and their messages; other UID-owned rows cannot affect or enter the import.
- Rows are ordered conversation-first and sent in deterministic batches capped at 100 records and one MiB. The Task 5 lifecycle queue serializes each dedicated import call with the captured active UID/generation and current drain. Rejected batches stop the sequence.
- `privacy.consent` remains a durable FIFO outbox mutation. The additive per-UID SQLite projection recognizes consent across restart and applies pulled consent records.
- Refused first-conversation consent and cancelled unowned import confirmation are covered as no-write paths.

## Preferences and usage

- `preferences.update` remains an optimistic per-UID projection plus durable FIFO outbox mutation. Optimistic revisions advance sequentially and earlier receipts preserve newer pending values. Pulled or directly read preferences are projected locally with revision and update time.
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
- Per-UID cache: `user-data-client.ts` and test, `user-data-repositories.ts`, migrations `0004_account_sync_projection.sql` and `0005_legacy_import_identity.sql`.
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

Review follow-up verification:

- Shared contract suite: 81/81 passed.
- Focused Main/application/cache/import/engine/port/IPC/preload suite: 304/304 passed.
- Renderer workbench + BYOK label suites: 81/81 passed.
- All workspace typechecks: passed.
- ESLint over all review-changed TypeScript/Vue files: 0 errors; the same four pre-existing compact-markup warnings remain in `SettingsView.vue`.
- Review round 2 focused importer/engine/port suite: 60/60 passed; Desktop typecheck, focused lint, and `git diff --check` passed.
- Import-projection follow-up: migration tests passed 11/11; focused application/importer/engine/cache/strict-port tests passed 262/262; shared contracts passed 81/81; Desktop typecheck and focused ESLint passed. The two SQL migration copies remained byte-identical and `git diff --check` passed.

## Remaining staging-only gaps

- This task does not deploy CloudBase functions or PostgreSQL migrations. Task 8 must validate deployed Task 2/3 artifacts and real authenticated round trips in staging.
- `confirmedPlatformCost` remains `null` until the later platform-run gateway supplies trusted server-side platform billing; BYOK estimates never populate it.
- Media object bytes remain local and are not uploaded by this task.
