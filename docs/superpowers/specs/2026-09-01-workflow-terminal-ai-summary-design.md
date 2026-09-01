# Workflow Terminal AI Summary Design

## Status

Approved in chat on 2026-09-01.

This design replaces the temporary behavior that ends an Agent run as soon as
a conversion card is created. It does not include the separate, unfinished
request to add a global "always allow" permission choice.

## Goal

Chat should show the workflow status, approval state, and task-specific result
card without adding a redundant "已使用工作流" card at the end. After a
workflow and all of its asynchronous child work reach a terminal state,
AutoForge must obtain the trusted final result and let the configured AI model
produce one closing response from that result.

For file conversion, "workflow completed" cannot mean only "conversion job
accepted". The AI closing response must wait until every conversion job created
by the workflow is completed, failed, cancelled, or interrupted.

## Required Product Behavior

1. New chat responses do not contain a `workflow_provenance` block.
2. Existing persisted `workflow_provenance` blocks are not rendered, so old
   "已使用工作流" cards also disappear from chat.
3. Workflow status cards, approval cards, conversion cards, execution details,
   logs, and Inspector data remain available.
4. Synchronous workflows continue to use their terminal `Execution` result as
   the source for the final model turn.
5. Agent-owned file conversions run in foreground mode at the host capability
   boundary, regardless of a workflow's omitted or requested `background`
   value. Manual developer executions retain the existing background option.
6. A multi-attachment conversion does not reach workflow completion until every
   submitted conversion has reached a terminal state.
7. The model receives only the trusted, sanitized workflow result after the
   terminal execution snapshot is available. It does not receive a transient
   `queued` receipt as the final result.
8. The model produces one closing response after the final result. It must not
   claim a status that conflicts with the workflow or conversion cards.
9. Partial conversion failure is represented in the final structured workflow
   result and summarized once by the model after all attachments settle.
10. Cancellation, timeout, account changes, conversation deletion, and
    application shutdown continue to use the existing lifecycle cleanup.

## Chosen Architecture

### Terminal status ownership

`ExecutionService` remains the owner of workflow execution lifecycle. Its
`startReserved(...).finished` promise is the trusted terminal execution query
for Agent orchestration. The Agent validates that the returned execution
identity matches the reservation and then converts the terminal result into the
bounded tool result already used for the next model turn.

The model never queries execution state directly. Renderer state, card labels,
and workflow output text are not authority for terminal status.

### Foreground conversion at the host boundary

The file-conversion capability already supports `background: false`, including
waiting, cancellation, timeout, terminal result validation, and safe output
projection. The implementation will reuse that path.

When an execution carries Agent-issued file-conversion authorization,
`ExecutionService` treats every `file.convert` request as foreground. This is
enforced in Main rather than left to workflow or model arguments. Developer and
manual workflow runs without Agent authorization keep their current explicit
background behavior.

The universal conversion workflow continues submitting attachments in input
order. Each foreground submission returns only after its conversion job is
terminal, so the workflow output contains `completed` or `failed` results rather
than final-answer `queued` receipts. The workflow execution becomes terminal
only after all attachments have been processed.

### Agent closing turn

After `started.finished` returns, `AgentOrchestrator` updates the workflow status
card and appends the sanitized tool exchange. It then performs the normal model
decision that generates the closing text.

The temporary shortcut keyed by an authoritative conversion card is removed;
creating a conversion card no longer terminalizes the Agent run. The conversion
card remains the live visual status while the foreground conversion is running.
The model turn starts only after the execution result is terminal.

For completed workflow executions whose structured result contains per-item
failures, the model receives the complete bounded result and generates one
summary. For execution-level failure, the existing safe tool error is used.
Explicit user cancellation remains terminal and does not trigger a new model
request.

### Provenance presentation

Workflow identity and execution status remain in the workflow status card,
execution records, and Inspector. The end-of-message provenance card is removed
from the chat presentation:

- the Agent stops appending `workflow_provenance` blocks to new messages;
- the Renderer filters that block type from existing messages;
- the shared schema remains readable for backward compatibility and sync of old
  data.

This is a presentation change, not deletion of durable execution audit data.

## Data Flow

1. The user submits a chat request.
2. The model selects a workflow and the Agent requests approval when required.
3. `ExecutionService` starts the reserved workflow execution.
4. A file-conversion capability request is recognized as Agent-authorized and
   forced into the existing foreground wait path.
5. Conversion jobs publish progress to the conversion card while the workflow
   remains running.
6. Every conversion reaches a terminal state; the capability returns sanitized
   output names, formats, sizes, or safe error codes.
7. The workflow finishes and `started.finished` returns the trusted terminal
   execution snapshot.
8. The Agent updates the workflow card, appends the bounded tool result, and
   asks the configured model for one closing response.
9. The Agent persists the closing text and terminalizes the chat run.
10. No `workflow_provenance` block is appended or rendered.

## Error and Lifecycle Contract

- Conversion success: the model receives `completed` results and safe output
  metadata after all jobs settle.
- Partial failure: successful and failed item results are both included in the
  final workflow result; the model summarizes them together.
- Conversion-level cancellation or interruption: the workflow receives a safe
  terminal failure result. User-initiated Agent cancellation still cancels the
  whole chat run without a closing model request.
- Workflow timeout: foreground conversion is aborted through the existing
  execution lifetime signal and the run follows the current timeout path.
- Model failure after workflow completion: cards retain the authoritative
  terminal state and the chat shows the existing safe model error; no stale
  queued claim is created.
- Application shutdown or account/conversation invalidation: existing drain and
  cancellation ordering remains authoritative.

No polling loop, new database table, new background continuation record, or
post-finalization message mutation is introduced.

## Compatibility and Scope

- Existing workflow and conversion block schemas remain compatible.
- Existing `workflow_provenance` data remains parseable but invisible in chat.
- Manual developer runs can still request background conversion.
- The change applies the terminal-before-AI rule to Agent-owned conversions;
  other workflows already wait for their terminal `Execution` result.
- Permission behavior, including the proposed global "always allow" option, is
  outside this design.

## Verification

### Agent and execution tests

- An Agent-owned conversion request that asks for background execution still
  waits for the conversion terminal result.
- The Agent does not make the closing model call while a conversion is queued,
  converting, or verifying.
- After conversion completion, the second model request contains `completed`
  output data and does not contain a final `queued` receipt.
- Multiple attachments produce exactly one closing model response after all
  jobs settle.
- Partial failure produces one model response containing both successful and
  failed item results.
- Cancellation and timeout release foreground waits and do not leak active
  executions.
- Manual developer background conversion retains its immediate queued receipt.

### Chat and application tests

- New completed workflow messages contain no `workflow_provenance` block.
- Historical messages containing `workflow_provenance` render no "已使用工作流"
  card and no empty visual container.
- Workflow status, approval, and conversion cards remain visible and update to
  terminal state.
- The final text appears after the conversion card reaches terminal state and
  does not contradict that state.
- The existing multi-attachment current-message binding and local-only file
  handling remain intact.

### Build checks

- Desktop node and renderer type checks pass.
- Targeted Agent, execution-service, conversion, chat component, and application
  integration tests pass.
- Desktop production build succeeds.
- Headed browser testing remains out of scope unless separately authorized.
