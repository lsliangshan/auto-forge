# Chat Local Workflow Tool Runtime Design

## Status

Approved in chat on 2026-08-22. This document specifies the design only. It does
not authorize or contain the implementation.

## Goal

Allow the text-chat model to decide whether a user request needs an eligible
workflow. When it does, execute the workflow before showing the model's final
answer and give the verified workflow result back to the same model. When it
does not, preserve the normal direct model response.

Developer mode controls whether local development builds may participate in
chat. Installed workflows remain normal product capabilities when developer
mode is off. Workflow applicability must honor the manifest `cities` field:
omitted or empty means all cities; a non-empty list restricts execution to a
city resolved by the model and verified by Main.

## Scope

This change applies only to text-output chat routed through the Agent runtime.
It covers workflow discovery, semantic selection, city routing, sequential tool
execution, permissions, result validation, cancellation, chat presentation,
and provenance.

Image, audio, and video generation keep their current prompt-only routes. This
change does not add geolocation, IP-based location, a national administrative
division database, automatic workflow builds, new Worker capabilities, cloud
workflow distribution, or a workflow marketplace.

## Existing Behavior and Gaps

The current Main Agent already supports one provider tool call followed by one
workflow execution and a second provider request. The implementation does not
yet satisfy this design because:

- candidate discovery uses strict lexical matching before the model sees tools;
- natural Chinese requests can miss an otherwise obvious workflow;
- `cities` exists only in the manifest and is dropped at the Registry/shared
  contract boundary;
- a single provider response may execute only one accepted tool call, and a
  response with multiple calls fails immediately;
- model text emitted before a tool call is streamed and persisted before the
  workflow completes;
- workflow input validation in the Agent is less descriptive than developer
  input validation;
- workflow output is not validated against `outputSchema`;
- development execution is not bound to the exact source and build shown to the
  model, so an installed build with the same identity can be selected instead;
- a raw tool result can approach the transport limit without a model-context
  budget check;
- permission denial ends the Agent run instead of allowing the model to explain
  that the action was not performed;
- developer mode is read for candidate creation but is not rechecked before
  every execution.

## Approved Product Behavior

### Basic routing

- A tool-capable text model sees eligible workflow tools and autonomously
  chooses between a direct answer and a workflow call.
- A model without tool support answers ordinary questions normally. It mentions
  the limitation only when the user explicitly requests a workflow or the task
  cannot be completed without one.
- A user instruction not to use workflows is a hard constraint.
- A user request to use a named workflow is a strong preference, but developer
  mode, availability, city, schema, identity, and permission checks still apply.
- Unrelated questions produce no workflow execution record.

### Developer mode and build eligibility

- Installed, enabled, integrity-valid workflows remain eligible regardless of
  developer mode.
- Development workflows are eligible only while developer mode is enabled.
- A development project must be `ready`, have a successful build, and have
  matching source, manifest, and artifact fingerprints.
- Chat never builds a project implicitly. After an edit, the project remains
  unavailable to chat until the user builds it successfully.
- In developer mode, an eligible development build shadows an installed build
  with the same ID and version. With developer mode off, only the installed
  build remains.
- A candidate binds its exact source, version, and development build hash.
  Execution never falls back to another source or version.

### Cities

- Missing `cities` and `cities: []` both mean the workflow applies to every
  city. The shared runtime representation normalizes both forms to `[]`.
- A non-empty `cities` list restricts the workflow to those manifest values.
- The current message is the strongest city source, followed by an explicit
  answer to a city clarification, then the most recent explicit city in the
  same topic.
- The model must not infer city from IP address, OS region, model knowledge, or
  the fact that only one city-specific workflow exists.
- For a restricted workflow, the model maps the user's expression to one exact
  manifest value. For example, it may map `北京市` to manifest value `北京`, but
  Main accepts only the exact string `北京` in the tool request.
- If city is unknown, the model may recognize the relevant workflow but must ask
  the user for the city instead of calling it.
- A request covering multiple cities may call one applicable workflow per city,
  subject to the per-turn execution limit.
- City rules apply equally to installed and development manifests.

### Sequential calls

- A user turn may start at most five workflow executions.
- Calls are sequential. Each verified result returns to the same model before
  the model chooses the next action.
- The same workflow normally runs once per turn. A read-only workflow may retry
  once only when its arguments can be materially corrected.
- A started retry counts toward the five-execution limit.
- Side-effect or sensitive-read workflows never retry automatically.
- The model decision loop is limited to ten turns, independent of the workflow
  execution count.
- Candidate routing, pre-start validation failures, permission denial, and one
  multi-call protocol correction do not consume an execution slot.
- When the fifth execution finishes, the Agent removes tools and asks the model
  to answer from available results. If information remains insufficient, the
  model asks the user to narrow the request or continue in a new turn.

### Visible response order

- Main buffers the model's first response until it knows whether the response
  contains a tool call.
- For a direct answer, Main streams the buffered text normally.
- For a tool call, Main discards any model-generated preamble and emits only a
  system-owned workflow status block.
- The final model answer is shown only after the tool loop stops.
- Main appends system-owned provenance containing the actual workflows, cities,
  execution states, and execution-record links. The model cannot create or
  modify provenance.

## Architecture

Use a layered Agent tool runtime. `AgentOrchestrator` remains the coordinating
facade and owns run admission, persistence, provider streaming, cancellation,
and Renderer events. Focused components own the new decisions.

### WorkflowCatalog

`WorkflowCatalog` creates an immutable candidate snapshot for one Agent run. It:

1. reads installed and development workflows from the Registry;
2. applies enabled, integrity, developer-mode, ready-build, and fingerprint
   gates;
3. normalizes omitted `cities` to `[]`;
4. makes eligible development builds shadow matching installed identities;
5. records source, version, build hash, schemas, permissions, cities, names,
   descriptions, categories, and activation examples;
6. produces a stable tool identity that can be resolved only to that snapshot.

The catalog does not guess user city and does not execute workflows.

### WorkflowRouter

`WorkflowRouter` prevents tool schemas from consuming excessive model context
without reviving brittle keyword filtering.

- If all complete eligible tool definitions use no more than 20 percent of the
  selected model's input budget, all are sent to the normal decision request.
- Otherwise, the same selected chat model receives one internal, no-tools
  routing request containing compact workflow metadata: identity, name,
  description, cities, category, and positive/negative activation examples.
- The internal request returns an ordered shortlist of at most 20 candidates.
  The router takes the largest prefix whose complete definitions still fit the
  20 percent tool budget. If even one selected definition cannot fit, the run
  fails with the existing context-limit behavior before any workflow starts.
- The compact routing request is itself checked against the normal model input
  budget. It fails closed with the existing context-limit behavior if the
  compact catalog cannot fit; it does not silently drop catalog entries.
- The routing request is not visible, does not count as a workflow execution or
  one of the ten tool-loop decisions, and cannot authorize execution.

### WorkflowToolLoop

`WorkflowToolLoop` owns the provider/tool protocol state:

```text
preparing
  -> routing (only when complete tools exceed budget)
  -> deciding
       -> completed (direct answer)
       -> correcting_sequence
       -> validating_tool
            -> deciding (correctable pre-start result)
            -> awaiting_approval
            -> running_workflow
                 -> validating_result
                      -> deciding
  -> finalizing
  -> completed
```

Every non-terminal state can transition to `cancelled`. Unrecoverable provider,
protocol, or internal failures transition to `failed`.

The loop accepts one tool call at a time. If a provider response contains
multiple calls, none executes. The loop gives the model one protocol correction
request requiring a single next call. A repeated violation ends with
`INVALID_TOOL_SEQUENCE`.

### WorkflowToolExecutor

`WorkflowToolExecutor` is the sole Agent path to `ExecutionService`. It validates
in this order:

1. remaining execution and model-decision budgets;
2. current developer-mode authorization for a development candidate;
3. exact candidate source, ID, version, and build hash;
4. city requirements;
5. workflow input with the shared semantic validator;
6. host-owned permission policy and any user approval;
7. output against the declared `outputSchema`;
8. model-context result size.

Only after checks 1-6 pass does it start the workflow and increment the
execution count. The executor supplies the shared output validator to the
execution completion boundary so `ExecutionService` persists `completed` only
for an output that passes check 7; an invalid output persists `failed` with
`INVALID_OUTPUT`. Check 8 controls whether a valid completed result may enter
model context and does not rewrite the underlying execution outcome.
`ExecutionService` continues to own Worker reservation, execution,
per-workflow timeout, capability dispatch, persistence, cancellation, and
cleanup.

## Contracts

### Workflow detail

The shared Registry detail shape adds:

```ts
type WorkflowSource = 'installed' | 'development'

interface WorkflowRuntimeIdentity {
  id: string
  version: string
  source: WorkflowSource
  buildHash?: string
}

interface WorkflowDetail {
  // existing fields
  cities: string[]
  runtimeIdentity: WorkflowRuntimeIdentity
}
```

`buildHash` is required for development and absent for installed workflows.
Shared schemas must reject an invalid source/hash combination.

### Internal model tool arguments

Each model-visible workflow tool wraps the existing workflow schema:

```ts
interface WorkflowToolArguments {
  resolvedCity?: string
  input: unknown
}
```

`resolvedCity` is required and must equal a manifest member when `cities` is
non-empty. It is omitted for unrestricted workflows. Only `input` crosses the
Worker boundary.

### Chat workflow events and provenance

System-owned chat blocks carry:

- execution ID;
- workflow name, version, source, and development build hash when applicable;
- resolved city or an all-cities marker;
- `queued`, `awaiting_approval`, `running`, `completed`, `failed`, or
  `cancelled` state;
- one-based execution index and limit;
- a safe error summary when present.

Renderer displays these blocks and links to existing execution records. It does
not derive authoritative state from model text.

### New Agent error codes

- `CITY_REQUIRED`
- `CITY_NOT_SUPPORTED`
- `WORKFLOW_CHANGED`
- `INVALID_TOOL_SEQUENCE`
- `TOOL_CALL_LIMIT`
- `INVALID_OUTPUT`
- `RESULT_TOO_LARGE`

Existing execution and provider errors remain unchanged. Renderer-visible
messages are safe, specific, and bounded; stack traces, absolute paths, secrets,
and raw sensitive parameters never enter model context or generic chat errors.

## Permission and Security Model

Main owns a fixed capability risk classifier. A workflow cannot label its own
capability as safe.

- Safe navigation: current `browser.open`, `browser.url`, and `browser.close`
  can execute automatically while the other eligibility gates pass.
- Sensitive read: future clipboard, filesystem, or authenticated-data reads
  require confirmation or an applicable exact policy grant outside the
  chat-auto-call flow.
- Potential external action: current `browser.fill` and `browser.click`, plus
  future writes, notifications, and submitting network operations, require
  per-execution confirmation.
- Unknown capabilities use the highest risk.

Chat approval offers only reject or once. Existing developer/manual execution
may retain exact persistent grants. Approval binds execution, permission index,
workflow source, ID, version, build hash, city, capability, scope, and the action
summary. Any bound value change invalidates the decision.

Capabilities declared by schemas but not implemented by the Worker remain
unsupported. This feature does not expand the SDK or Worker capability surface.

Renderer, model output, workflow code, workflow output, and remote page content
are untrusted. Tool results are framed as data and cannot override system
instructions, grant permissions, alter source identity, or justify another tool
call without support in the original user intent and system policy.

## Validation, Results, and History

Input uses the same semantic AJV and format validation path as developer runs.
Correctable validation results return to the model so it can repair arguments;
missing or ambiguous business information causes a user clarification instead
of guessed input.

After Worker success, Main validates the complete result against
`outputSchema` before persisting a successful execution terminal. A mismatch is
persisted as `failed` with `INVALID_OUTPUT` and never reaches the model as a
successful tool result.

The model-visible serialized result must fit both:

- 25 percent of the selected model's current input budget; and
- an absolute 256 KiB limit.

The smaller limit wins. An oversized result becomes `RESULT_TOO_LARGE` for the
Agent tool result; it is not silently truncated or summarized. Because the
workflow output itself passed its contract, the linked execution remains
`completed`, retains the complete accepted transport result, and records that
the result was unavailable to the model because of its size.

The current Agent run may use a validated, budgeted result. Durable conversation
context stores only workflow identity, city, state, and a safe concise summary.
It does not persist raw tool protocol messages or full workflow results in later
model history. The Renderer transcript and execution records remain visible to
the user.

## Failure, Retry, Cancellation, and Timing

- A pre-start city or input problem returns a structured result to the model and
  does not consume an execution slot.
- Permission rejection does not start the workflow. The model explains that the
  action was not performed.
- Execution failure and timeout return a safe structured result. The model may
  answer independently only when it clearly states that no successful workflow
  result was used.
- A read-only workflow may retry once with materially changed arguments. A
  started retry consumes an execution slot.
- Sensitive-read and external-action workflows do not retry automatically.
- Chat cancel and an Agent-owned execution-card cancel terminate the whole Agent
  run: provider request, active Worker, and all future calls. Completed external
  effects are not represented as rolled back.
- Each workflow keeps its manifest `timeoutMs`.
- Agent active execution time is limited to ten minutes. Time spent awaiting
  user approval pauses this budget.
- An approval expires after 30 minutes and cancels the Agent run.
- Closing developer mode cancels pending or not-yet-started development calls
  and prevents later calls. An already-running Worker may finish safely; its
  provenance records that it started while developer mode was enabled.
- One active run is allowed per conversation, including approval waits. Runs in
  different conversations remain independent.

## Renderer Behavior

The chat interface renders the existing response flow plus system-owned workflow
blocks:

1. show the normal generation state while Main decides;
2. show `正在调用 <workflow>` when a tool call is accepted;
3. show approval inline when required and keep the conversation composer locked;
4. update sequential execution states under the same assistant turn;
5. stream the final model answer only after the loop stops;
6. append compact, expandable provenance linked to execution records.

If city is unknown, the model asks for it as a normal answer and no execution
record is created. If a development project has unbuilt edits, the Developer UI
marks it `有未构建修改，暂不可用于聊天`; chat does not build it.

## Verification

### Contract and unit tests

- omitted and empty `cities` normalize to all cities;
- non-empty city values propagate from manifest through Registry and model tool
  definitions;
- installed/development runtime identity and build-hash combinations validate;
- eligible development shadows an installed duplicate only in developer mode;
- source and build changes invalidate a captured candidate;
- risk classification is host-owned and unknown capabilities fail closed;
- five execution and ten decision limits count exactly as specified;
- multi-call responses receive one repair and then fail deterministically;
- output-schema and model-result-size checks reject invalid results;
- persisted workflow history contains only the safe summary shape.

### Main Agent integration tests

- developer mode off prevents every development workflow call while leaving an
  installed workflow eligible;
- developer mode on exposes only ready, clean development builds;
- an unrelated prompt returns directly without an execution record;
- `我想办理北京工作居住证` can select the `北京工作居住证` workflow without
  exact phrase matching;
- an unknown city causes a clarification, and a later explicit city permits the
  next turn to execute;
- `北京市` can be mapped by the model to allowed manifest value `北京`;
- a mismatched or missing restricted city fails before Worker start;
- a multi-city request executes applicable workflows sequentially;
- a tool-call preamble is not displayed or persisted as the final answer;
- workflow success returns the verified result to the same provider before the
  final answer;
- permission reject, failure, timeout, cancellation, developer-mode transition,
  and build-hash transition follow the specified terminal states;
- side-effect workflows never retry automatically;
- a tool result containing prompt-injection text cannot change tool policy;
- same-conversation admission rejects a second run while other conversations
  remain concurrent;
- a model without tools follows the approved direct-answer behavior.

### Renderer and real Electron verification

Verify the actual Renderer -> Preload -> IPC -> Main -> Provider -> Worker ->
Provider -> Renderer chain with a deterministic fake provider and workflow, then
perform visible Electron checks for:

- settings toggle behavior;
- developer build availability messaging;
- workflow status, approval, cancellation, and final provenance;
- final answer appearing only after workflow completion;
- execution record identity, city, arguments, result, duration, and failure;
- the natural-language Beijing workflow prompt, not only an exact activation
  phrase.

A build, provider HTTP success, or `completed` execution row alone is not
acceptance.

## Acceptance Criteria

1. With developer mode off, a development workflow starts zero times.
2. With developer mode on, a relevant, ready, city-applicable workflow executes
   before the final answer becomes visible.
3. An irrelevant prompt starts no workflow and receives a direct answer.
4. Missing and empty `cities` apply to all cities.
5. A restricted workflow asks for an unknown city and rejects an unsupported
   city before execution.
6. No user turn starts more than five workflow executions, and calls are always
   sequential.
7. Final provenance matches the actual execution source, version, build, city,
   and terminal status.
8. Main enforces current developer mode, exact identity, schemas, permission,
   output size, and untrusted-result handling at execution time.
9. Cancellation prevents later model output and workflow calls in that run.
10. The visible transcript remains complete while durable model context contains
    only safe workflow summaries.

## Implementation Constraints

- Preserve the existing Renderer -> Preload -> Main trust boundary.
- Keep secrets and permission policy in Main.
- Reuse `ExecutionService`, Worker isolation, existing provider tool protocol,
  execution records, and conversation admission instead of creating parallel
  runtimes.
- Update shared schemas, TypeScript types, defaults, callers, and tests together.
- Build changed shared packages before root typecheck so workspace consumers do
  not read stale `dist` output.
- Keep changes limited to this feature; do not implement currently unsupported
  capabilities or unrelated workflow lifecycle changes.
