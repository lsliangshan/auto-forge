# Task 12 report — local conversion chat card

## Outcome and assumptions

- Worktree: `/Users/liangshan/Downloads/workspace/workspace_qisi/auto-forge/.worktrees/universal-file-converter`
- Base: `8fcea619d5621084d20fd3b51c7cdbeea7707a52`
- Implementation commit: `145917b85f9524ee5c5c42210dfb3edd7b37f3ab` (`feat: render local conversion results`)
- Task 10's authenticated, opaque-ID-only conversion bridge is the sole Renderer boundary. The card loads owner-local snapshots by `executionId`; no remote result is invented when that query has no local job.
- This task intentionally does not add engine fixtures, Task 13 packaging, or Task 14 E2E.

## RED / GREEN evidence

- RED tests were added before implementation: 15 focused card/store/UI probes, one strict shared-contract probe, one context projection probe, and one wire-payload sync probe. The repository-root commands in the Task 12 brief produced `No test files found` because the two Vitest configs are rooted at `apps/desktop`; the valid equivalent commands were then run from that directory. This discovery mismatch is recorded rather than presented as a test failure.
- The first discovered component run exposed 12 failures from an incomplete test bridge fixture; after supplying the normal desktop API boundary, all card requirements were exercised. The first node run exposed the pre-build shared-package boundary (`conversion` absent from the stale compiled shared contract); rebuilding `@autoforge/shared` made the actual Main context and sync consumers use the new schema.
- Final GREEN: conversion card/store/MessageBlock **15/15**; shared contracts **102/102**; conversation context plus user-data sync **81/81**; desktop production build passed; scoped ESLint and `git diff --check` passed.

## UI, lifecycle, and accessibility proof

- `ConversionBlock` renders queued, component-download, converting, verifying, completed, failed, cancelled, and interrupted states with localized text. Active states use a visible percentage and `role=progressbar` with value and text ARIA fields; failures use a stable Chinese retry message and `role=alert`.
- Completed local snapshots render every artifact display name and safe representation/page metadata. Save copy, reveal, and delete invoke only opaque `artifactId` commands. Actions are disabled for deleted or pending artifacts; deleted output remains visibly audited as `已删除` without a path.
- A terminal block with no local snapshot states exactly `转换结果仅在发起转换的设备上可用`.
- The Pinia store subscribes before querying, merges by job epoch and monotonic status/progress so an older list response cannot regress a newer event, and releases event subscriptions when the last card unmounts, on store disposal, and on logout/user change.

## Privacy and sync proof

- The shared strict block is exactly `{ type: 'conversion', blockId, executionId, state }`. Contract tests reject `bytes`, `path`, `sha256`, `artifactId`, `jobId`, metadata, and managed IPC fields.
- Provider/context projection reduces it to `本地文件转换: 进行中|已结束`, without execution, job, artifact, hash, byte, or path identifiers.
- The real user-data-sync outbox test serializes a conversion message and asserts its pushed JSON excludes byte, path, hash, artifact, job, metadata, and managed-path fields.

## Files

```text
apps/desktop/src/stores/conversion.ts
apps/desktop/src/components/conversion/ConversionBlock.vue
apps/desktop/src/components/chat/MessageBlock.vue
apps/desktop/src/stores/auth.ts
apps/desktop/tests/components/conversion-block.test.ts
packages/shared/src/events.ts
packages/shared/src/contracts.test.ts
apps/desktop/electron/main/chat/conversation-context.ts
apps/desktop/electron/main/chat/conversation-context.test.ts
apps/desktop/electron/main/sync/user-data-sync-engine.test.ts
```

## Baselines

- `apps/desktop/tests/components/chat.test.ts` remains **189 passed / 1 failed** at `keeps the persisted message creation time in renderer state`; the failure is a pre-existing chat-store timestamp assertion and no Task 12 code changes that store.
- Desktop typecheck remains blocked by unrelated existing diagnostics: one browser screenshot port, one provider-stream `purpose`, two sync-status narrowing errors, four CloudBase safe-code narrowing errors, plus three Renderer diagnostics in InspectorPanel/developer/Settings capability handling. No diagnostic references Task 12 files. The desktop production build does pass.

## Fix round 1 — progress-ruling closure

### Assumptions and scope

- This round implements the four Important rulings only. The two deferred Minors (tone/live-region polishing and broader fixture-only coverage) remain intentionally deferred.
- A conversion block belongs only to the assistant chat message and contains exactly `type`, `blockId`, `executionId`, and `state`. Conversion jobs/artifacts remain in the authenticated device-local Main repository.

### RED / GREEN counts

- RED: **2 behavioural failures** were captured. The real Application runner reached a terminal conversion job but emitted no `block_update`, exposing that the code read the global chat-run/message repository instead of the current user's repository. The real Agent approval path also produced no active conversion block because approval state clears the transient capability before tool start.
- GREEN: the focused Application terminal persistence/event test and Agent approval test pass after the smallest fixes. Card/store/MessageBlock is **18/18**, shared contracts **103/103**, context plus user-data sync **81/81**. The combined Application/Agent/IPC/preload run is **441 passed / 2 existing baseline failures**: the legacy-import temporary-directory `ENOTEMPTY` cleanup race and the pre-existing context-summary budget failure.

### Contract, lifecycle, and privacy proof

- On the actual Agent workflow path, a declared `file.convert` permission appends and persists one strict active block after execution reservation/start. It never includes job, artifact, path, hash, bytes, or metadata. The Application runner turns the matching active block terminal exactly once only after every execution job is terminal, persists it through the user-local message repository, and emits the same strict `block_update`.
- `conversion:list-for-execution` now returns either `{ availability: 'local', jobs }` or `{ availability: 'unavailable', jobs: [] }`; missing and cross-owner requests are indistinguishable. The renderer shows exactly `转换结果仅在发起转换的设备上可用` only for unavailable, retains genuine load errors separately, and clears an earlier load error on a valid event.
- Same-epoch snapshots union jobs/artifacts, preserve a deleted artifact as absorbing, retain fuller representations, and prevent terminal status regression. The store keeps subscription/hub/release state under `Symbol.for('autoforge.conversion-store.runtime')`; the two-module reload test releases the first feed before exactly one replacement feed is created.
- JSON assertions cover Agent events, Application persisted/event payloads, shared block-update parsing, and existing context/sync serialization. They reject or exclude `bytes`, `path`, `sha256`, `artifactId`, `jobId`, and metadata/internal local details.

### Fix-round files and gates

```text
apps/desktop/electron/main/agent/agent-orchestrator.ts
apps/desktop/electron/main/agent/agent-orchestrator.test.ts
apps/desktop/electron/main/application.ts
apps/desktop/electron/main/application.test.ts
apps/desktop/electron/main/ipc/register-ipc.test.ts
apps/desktop/src/components/conversion/ConversionBlock.vue
apps/desktop/src/stores/conversion.ts
apps/desktop/tests/components/conversion-block.test.ts
packages/shared/src/desktop-api.ts
packages/shared/src/events.ts
packages/shared/src/contracts.test.ts
```

- `pnpm --filter @autoforge/shared build` passed; scoped ESLint and `git diff --check` passed.
- Workspace/desktop typecheck remains at the same 8 unrelated pre-existing diagnostics after this round; no Task 12 file is named.
- Production build was started after the scoped checks; final completion/SHA are recorded with the implementation commit.

## Fix round 2 — terminal and observation races

- Terminal conversion blocks now require a terminal owning workflow execution, at least one job, and every job terminal. The Application test holds the second foreground submission at pack acquisition and proves the first completed job leaves the block active; it then releases the final job and verifies one terminal block update plus a payload-free outbox message mutation.
- Agent finalization reads the latest persisted message and preserves a terminal conversion block over its stale active in-memory copy. Terminal replacement is owned by the user-local message repository, records the same payload-free message mutation/outbox path, and is replay-idempotent because only active blocks can transition.
- Renderer list loads capture an execution-local observation generation. Every valid event advances it, so late local, unavailable, and rejected results cannot clear the event snapshot or reintroduce an error.
- Same-epoch merges now union artifacts before resolving job lifecycle, retain immutable artifact identity fields, keep deleted absorbing, union icon representations, preserve richer metadata from lower-rank observations, and keep progress monotonic.
- Focused GREEN: conversion card/store **21/21**; terminal Application lifecycle **1/1**; Agent persistence race **1/1**. The combined Main suite retains the two recorded baseline failures plus an intermittent isolated developer-draft conflict that passes when re-run alone.
