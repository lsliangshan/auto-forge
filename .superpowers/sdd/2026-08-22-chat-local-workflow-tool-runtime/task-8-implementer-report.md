# Task 8 Implementer Report

## Outcome

Implemented the sequential chat workflow loop with one pure state/timing owner, buffered provider text, sequential execution, structured tool continuation, authoritative workflow status/provenance, bounded retry/repair behavior, approval expiry, active-time enforcement, whole-run cancellation, and safe durable history.

## RED evidence

All production behavior was introduced after a focused failing test demonstrated the missing or incorrect boundary.

1. Pure loop creation:
   - Command: `node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts electron/main/agent/workflow-tool-loop.test.ts`
   - RED: suite failed because `./workflow-tool-loop.js` did not exist.
   - The tests named the five-start, ten-decision, one-repair, stable-input retry, active-time, and approval-time behavior before implementation.
2. New history blocks:
   - Command: focused `conversation-context.test.ts -t "serializes workflow status"`.
   - RED: `Historical block type is invalid` for `workflow_status`.
3. Existing workflow payload leakage:
   - Command: focused `conversation-context.test.ts -t "serializes text, workflows"`.
   - RED: serialized history contained `/Users/private/query.json` from proposal args.
4. Orchestrator protocol and ordering:
   - Command: focused Agent tests matching `buffers tool-call|repairs one|permits one|removes tools|enforces the Main policy`.
   - RED: 5/5 failed. Current code persisted the tool preamble, returned `INVALID_INPUT` on the first multi-call response, started a successful duplicate, did not remove tools after the fifth start, and performed discovery despite explicit opt-out.
5. External-action retry:
   - Command: focused Agent test `rejects an external-action retry`.
   - RED: second call returned `awaiting_approval`, proving a second side-effect attempt reached approval.
6. Automatic approval expiry:
   - Command: focused Agent test `automatically cancels`.
   - RED first because no injected expiry callback was registered, then again because an invalid approval incorrectly cleared the original pause/expiry state and no cancellation finalized.
7. Exact start boundary:
   - Command: focused executor test `loop start hook`.
   - RED: observed final order `source,start` instead of `loop-start,start`.
8. Safe legacy result history:
   - Command: focused context serialization test.
   - RED: an old `execution_result.summary` leaked `/Users/private/result.json`.
9. Policy token accounting:
   - Command: focused context test `reserves the Main policy prefix`.
   - RED: context preparation resolved despite the Main policy pushing the real provider request over budget.

## GREEN implementation

### Pure `WorkflowToolLoop`

- Owns the ten normal provider decisions, five transferred execution starts, one multi-call repair, candidate attempts, stable canonical input comparison, active elapsed time, approval pause, and approval expiry.
- `beginDecision()` increments before a normal provider request and returns safe `TOOL_CALL_LIMIT` or `MODEL_PROVIDER_TIMEOUT` failures.
- `startExecution()` is invoked through the executor's `beforeStart` hook immediately before `startReserved`; all Task 7 budget/mode/source/live-detail checks complete first.
- Validation, routing, denial, and multi-call repair do not call the start hook and consume no start.
- A candidate starts once normally. Only a failed started retryable candidate may start once more, and only when canonical `{ resolvedCity?, input }` JSON materially changes.
- Completed candidates, identical args, second retries, sensitive reads, and external actions return `INVALID_TOOL_SEQUENCE` without another start.

### Buffered provider protocol

- All normal-turn `text_delta` events remain in memory until the finish reason is known.
- A direct `stop` replays the original deltas through `appendText`, preserving persistence-before-Renderer emission and existing coalescing.
- A valid tool call discards its visible preamble, while preserving the original assistant call and call ID in model protocol history.
- The first multi-call response executes nothing and adds one system correction. A repeat terminalizes with `INVALID_TOOL_SEQUENCE`.
- Every structured success/error/denial/correction/failure/invalid/oversize result appends the original assistant tool call plus the matching `role: tool` message, wrapped in an explicit `UNTRUSTED_WORKFLOW_DATA` frame.
- After the fifth transferred start, the next provider request omits tools and includes a Main instruction to answer only from accumulated results.

### Status, provenance, timing, and cancellation

- Replaced model-derived proposal/execution/result narration for new Agent runs with Main-owned `workflow_status` blocks updated by stable `blockId` through queued, awaiting approval, running, and terminal states.
- Final provider `stop` appends `workflow_provenance` only when a workflow actually crossed the start boundary, using the captured exact source, identity, city, execution ID, and terminal status.
- Direct answers append no provenance.
- Main policy is the first normal provider message, before internal summary/history, and is included in conversation token admission.
- Hard current-message opt-out skips workflow discovery and tool exposure.
- The no-tools policy tells the model to mention the limitation only for explicit or workflow-required requests.
- Approval timers are injected and unref'd by default. Approval time pauses active time; invalid approval input does not reset or clear the original expiry. Thirty-minute expiry cancels the pending reservation/run and releases the conversation lock.
- Whole-run cancellation aborts the provider signal, cancels a pending/active executor, suppresses late text/tool events, finalizes once, and retains existing usage-consistency handling.

### Safe durable history

- Added exhaustive serialization for `workflow_status` and `workflow_provenance` using workflow name, city, and status only.
- Removed proposal arguments and legacy execution-result summaries from later model history.
- Tests prove build hash, workflow/execution identifiers from the new safe summaries, input, raw result, local path, scope, and approval internals are absent.
- This clears the accepted Task 8 `workflow_status` typecheck debt.

## Files

- Created `apps/desktop/electron/main/agent/workflow-tool-loop.ts`
- Created `apps/desktop/electron/main/agent/workflow-tool-loop.test.ts`
- Modified `apps/desktop/electron/main/agent/agent-orchestrator.ts`
- Modified `apps/desktop/electron/main/agent/agent-orchestrator.test.ts`
- Modified `apps/desktop/electron/main/agent/workflow-tool-executor.ts` for the final pre-`startReserved` loop hook; no Task 7 security check was moved or weakened.
- Modified `apps/desktop/electron/main/agent/workflow-tool-executor.test.ts`
- Modified `apps/desktop/electron/main/chat/conversation-context.ts`
- Modified `apps/desktop/electron/main/chat/conversation-context.test.ts`
- Modified `apps/desktop/electron/main/application.test.ts` for the mandatory leading policy message.
- Modified `apps/desktop/tests/integration/agent-workflow.test.ts` for authoritative workflow status.

## Verification

- Focused loop/Agent/context/application/executor/real integration set: PASS, 6 files / 261 tests.
- `pnpm test`: PASS, 80 files / 1904 tests.
- `pnpm typecheck`: PASS for shared, workflow-sdk, workflow-schema, Electron Main, Preload, and Renderer; the prior Task 8 exhaustiveness debt is cleared.
- `pnpm build`: PASS for workspace packages, Electron Main/Preload/Renderer, and Worker CJS.
- Changed-file ESLint covering every changed TypeScript file: PASS with zero findings.
- `git diff --check`: PASS.
- Build diagnostics: only the existing VueUse `/* #__PURE__ */` Rollup-position warnings were emitted; build exited successfully.

## Self-review

- Counter transitions: routing excluded; each provider turn increments once before streaming; repair increments no start; the fifth actual start is allowed; a sixth tool is not offered; an eleventh provider decision is never made.
- Start ownership: the callback runs after all Task 7 preflight checks and directly before `startReserved`. A preflight error never records an attempt; an invocation-time start rejection records a failed started attempt.
- Retry: canonical JSON sorts object keys; city participates; identical arguments do not retry; only one changed-input failed read-only retry is possible; external/sensitive candidates are rejected before a second approval.
- Ordering: no provider text is persisted or emitted before finish reason; tool preambles are absent from visible/final blocks; direct stop uses the existing append path; final provenance is last.
- Protocol: every correctable/terminal tool result retains the original call ID, same provider snapshot/model, and an explicit untrusted-data frame.
- Timers: active time is checked before provider decisions and at the exact workflow-start callback; approval pause is excluded; both explicit resume and injected expiry use the same loop clock.
- Cancellation: terminal guard prevents duplicate finalize; provider/Worker signals are aborted; late text/calls are suppressed; pending reservation cleanup remains owned by Task 7 executor lifecycle.
- Authority: status/provenance use frozen Task 7 candidate/source/city data, never model text. Task 7 selector, live-fingerprint, authorization marker, and ExecutionService ownership remain intact.
- History: policy is counted but remains outside summaries; status/provenance history omits build/input/result/path/scope; current-message media and routing usage paths are unchanged.

## Concerns / follow-up ownership

- Task 10 still owns Renderer presentation/merging for the new `workflow_status` and `workflow_provenance` blocks; Task 8 emits stable `blockId` updates for it.
- Task 11 still owns full visible Electron acceptance across Renderer -> Preload -> IPC -> Main -> Provider -> Worker -> Provider -> Renderer.
- Repository-wide lint was not used as an acceptance gate because the plan requests changed-file lint and prior tasks record unrelated baseline findings; every Task 8 changed TypeScript file is clean.
