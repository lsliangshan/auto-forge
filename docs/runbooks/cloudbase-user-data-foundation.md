# Cloud user-data foundation rollout runbook

## Purpose and safety boundary

This runbook promotes the conversation-sync foundation through staging and production gates. It is an operator procedure, not an automatic deployment script. Use the approved change-management system, secret manager, database backup policy, and feature-flag control plane for the target environment.

Never paste credentials into tickets or logs. Evidence must omit raw UIDs, tokens, message bodies, local paths, and Provider keys. Do not drop, truncate, or delete accepted remote data during rollout or rollback.

Before starting, record the application commit, migration checksum, function artifact checksum, environment, operator, reviewer, rollback owner, and observation window. Every gate requires its evidence and reviewer sign-off before the next gate begins.

## Rollout gates

The following order is mandatory.

### 1. Apply schema

Have an authorized database operator apply the reviewed user-data foundation migration to the target environment. Confirm the canonical and deployment migration artifacts are byte-identical before application. Record the migration checksum and database runtime version.

Go criteria:

- All tables, indexes, policies, and service-role RPCs are present at the expected version.
- Direct client roles have no table access and no direct RPC grants.
- The existing rollback artifact remains data-preserving.

Stop if the migration reports an unexpected object, permission, or runtime error.

### 2. Deploy function

Have an authorized CloudBase operator deploy the reviewed `autoforge-user-data` function artifact. Supply the PostgreSQL RPC endpoint and service credential only through the environment secret facility. Confirm logs redact arguments and native database diagnostics.

Go criteria:

- The deployed artifact checksum matches the reviewed artifact.
- Function configuration is server-side only.
- Response-size and strict action validation are active.

### 3. Verify unauthenticated and cross-owner denial

Use one anonymous request and two isolated staging accounts. Attempt each public action without authentication, then attempt to read, mutate, import, or page data belonging to the other account. Include forged owner-shaped fields in negative requests.

Go criteria:

- Anonymous calls return the stable authentication error.
- Cross-owner reads and writes return a stable denial or an owner-filtered empty result.
- No response or log reveals internal SQL errors, numeric owner IDs, tokens, or row content.
- Counts and mutation cursors for both accounts remain unchanged after denied requests.

### 4. Enable shadow write

Enable remote writes only for the internal rollout cohort while keeping local data authoritative and remote reads disabled. Exercise creates, renames, message appends, deletes, consent, preferences, legacy import, and BYOK usage records.

Go criteria:

- Local behavior remains unchanged when the remote service is unavailable.
- Accepted mutations are owner-scoped and ordered; retries do not create additional logical rows.
- Retry, quarantine, conflict, and response-size metrics remain within the approved thresholds.

### 5. Compare counts and deterministic hashes

For each internal account and entity type, compare local logical rows with the remote owner-scoped projection. Canonicalize the approved fields, sort by stable entity identity and revision, and calculate deterministic hashes inside the trusted environment. Record only counts, hashes, revision ranges, and pass/fail status.

Go criteria:

- Conversation, message, tombstone, consent, preference, import-receipt, and usage counts match their expected projections.
- Deterministic hashes match for non-tombstoned content and approved metadata.
- Tombstones, revisions, and cursor checkpoints are monotonic.
- Any mismatch is explained and corrected before remote reads are enabled.

### 6. Enable internal import

Enable explicit legacy import for the internal cohort. Test owned history and separately confirmed unowned history. Include a 100-record import batch so the resulting 101 pull events cross a page boundary.

Go criteria:

- General cloud-sync consent and unowned-history consent are visibly separate and persisted with their exact document versions.
- Refusal or cancellation uploads nothing.
- A successful import becomes visible in the current profile before success is reported and hydrates another profile through ordinary pull.
- Repeating the same batch returns duplicate without new events or revision changes.

### 7. Enable remote read

Enable remote reads for the same internal cohort, leaving the wider feature flag closed. Restart clients and verify they rebuild their owner-scoped cache from ordinary cursor pages without direct snapshot injection.

Go criteria:

- Alice cannot see Bob's rows through UI, IPC, function responses, or pagination.
- Offline outboxes replay after connectivity returns.
- Deletes propagate as tombstones and remain absent after restart.
- Cursor lag converges to the approved threshold without skipped or repeated projections.

### 8. Run dual-device real Electron acceptance

Run signed or release-equivalent Electron builds in two independent device profiles using staging accounts. Execute the milestone matrix: one-profile Alice/Bob isolation, same-account two-profile convergence, cursor pagination, offline replay, ambiguous duplicate retry, tombstone propagation, explicit legacy import, and BYOK usage classification.

Go criteria:

- Required state is visible in the Renderer on both devices.
- No production CloudBase environment or paid Provider request is used for test automation.
- BYOK estimated and unavailable costs are never labelled as confirmed platform spend.
- Logs and screenshots contain no secrets or raw owner identifiers.

### 9. Widen feature flag

Widen the remote-write, import, and remote-read cohort only after the preceding evidence is approved. Increase exposure in controlled increments with an observation window between increments.

Go criteria:

- Error, retry, conflict, cursor-lag, and mismatch rates remain below the approved thresholds.
- Support and rollback owners are available for the observation window.
- Product, security, database, and release owners sign the rollout record.

## Monitoring and acceptance matrix

Monitor per-environment aggregates without logging row content:

| Invariant | Evidence | Alert condition |
| --- | --- | --- |
| Owner isolation | denied anonymous/cross-owner probes and owner-scoped row counts | any unauthorized row exposure or mutation |
| Idempotency | duplicate status, stable event count, stable revisions | duplicate creates a row, event, or revision |
| Tombstones | delete-to-second-device latency and restart result | deleted row reappears or misses the latency target |
| Cursor health | checkpoint age, pages per pull, retry/quarantine rate | stalled cursor, repeated page, or sustained quarantine |
| Projection parity | deterministic counts and hashes | unexplained count/hash mismatch |
| Legacy import | accepted/rejected/duplicate counts and 101-event paging | partial batch, missing projection, or changed duplicate |
| Usage classification | estimated, unavailable, and confirmed-platform aggregates | BYOK marked billable or confirmed without trusted platform data |
| Service safety | stable error-code rate and redaction checks | native diagnostics, credentials, UIDs, or content in logs |

## Rollback

Rollback is feature control, not data destruction.

1. Stop widening the cohort.
2. Disable remote writes and legacy import for affected clients.
3. Disable remote reads and return clients to the established local behavior.
4. Preserve queued local mutations and every already accepted remote row for reconciliation or a later re-enable.
5. Keep the remote schema and tables intact. Do not run destructive drops, truncation, or deletion as an incident response.
6. Record the last known-good commit, cursor ranges, affected cohort, mismatch counts, and monitoring window without including row content.
7. If the function/RPC surface must be withdrawn, use the separately reviewed data-preserving rollback artifact through normal operator approval.

Rollback is complete when local operation is stable, remote read/write traffic has ceased for the affected cohort, accepted remote rows remain queryable by authorized operators, and the incident owner has a reconciliation plan.

## Final sign-off

The rollout record must contain explicit approvals from the product owner, security reviewer, database operator, CloudBase operator, desktop release owner, and incident/rollback owner. Open gaps—including staging-only SQL behavior, real authentication, cross-owner probes, or dual-device evidence—block production widening rather than becoming post-launch follow-ups.
