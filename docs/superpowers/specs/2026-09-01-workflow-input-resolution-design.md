# Workflow Input Resolution Design

## Status

Approved section by section in chat on 2026-09-01 after a `grill-me` session.
This document specifies the design only. It does not contain the implementation.

## Goal

Allow every eligible workflow to keep its own parameter names, types, and field
count while AutoForge reliably maps a natural-language user request into that
workflow's exact input contract. Complete input should preserve the current
direct execution path. Incomplete or incorrect input should become a durable,
system-owned chat clarification flow instead of an invalid execution, a guessed
value, or an ambiguous `no_match` result.

The model extracts only values the user explicitly supplied. Main owns schema
projection, defaults, runtime bindings, strict validation, missing-field
diagnostics, state transitions, persistence, expiry, and redaction.

## Scope

This design covers:

- ordinary and `getConfig()`-backed workflows;
- model-facing partial input projection and strict execution validation;
- deterministic `ready`, `needs_input`, and `no_match` outcomes;
- cross-turn, restart-safe local parameter collection;
- field-level patch merging, static defaults, and controlled runtime bindings;
- deterministic clarification text in ordinary chat messages;
- cancellation, replacement, ambiguity, expiry, invalidation, and no-progress
  limits;
- sensitive-field policy and metadata-only diagnostics;
- backward compatibility for existing workflow manifests;
- unit, repository, migration, and Agent integration verification.

This design does not add a parameter form, a dedicated clarification card,
cross-device continuation, cloud synchronization of parameter collections,
workflow credential provisioning, a new workflow capability, or headed browser
testing. It does not expose existing model-provider or authentication secrets to
workflow code.

## Existing Behavior and Gaps

The current workflow catalog wraps every workflow's `inputSchema` in a model
tool. This already allows workflows with unrelated input shapes to coexist. The
model selects a tool and maps user language into that tool's JSON arguments,
after which Main performs AJV validation before reserving execution.

The gaps are:

- the model sees the strict execution Schema, so an incomplete tool call may be
  rejected or handled as a generic invalid call;
- ordinary workflow clarification relies on the model interpreting an
  `INVALID_INPUT` tool result and has no durable collection state;
- configured workflows classify missing required input as `no_match`;
- missing input, invalid input, and intent mismatch do not have distinct,
  authoritative lifecycle semantics;
- partial values cannot be safely merged across turns or restored after an app
  restart;
- JSON Schema `default` is not applied by the current AJV configuration;
- runtime-owned values and personal-data paths have no manifest-level contract;
- a later workflow or Schema change cannot invalidate an unfinished input
  collection because no such durable identity binding exists.

## Approved Product Behavior

### Chat interaction

- Clarification uses normal assistant text. No dynamic form or dedicated card
  is introduced.
- Main determines missing and invalid fields from the strict Schema. The model
  cannot declare input complete or invent a required value.
- A clarification asks at most three related missing fields. An invalid field
  is corrected alone before other missing fields are requested.
- Unambiguous normalization is allowed, such as `PDF` to `pdf`, a first
  attachment reference to index `0`, or a Chinese date to `YYYY-MM-DD`.
- Business choices with more than one reasonable value require clarification.
- Low-risk workflows execute as soon as input is ready. Existing permission
  approval remains authoritative for external actions and sensitive reads.

### Parameter sources

Parameter sources have this precedence:

1. explicit values in the current user message;
2. confirmed values in the active parameter collection;
3. attachments and controlled metadata on the current message;
4. historical values only when the user explicitly refers to them;
5. deterministic workflow defaults.

The model must not silently reuse names, dates, addresses, or similar personal
data merely because they appeared earlier in the conversation.

### Collection lifecycle

- Each conversation has at most one active parameter collection.
- A relevant reply continues the active collection.
- Explicit cancellation terminates it.
- A clearly independent request replaces it and is routed as a new request.
- An ambiguous reply asks whether to continue or replace the collection.
- Multi-workflow requests collect and execute one workflow at a time.
- Three consecutive user replies with no accepted parameter progress cancel the
  collection. Any accepted changed field resets the counter.
- A collection expires 24 hours after its last accepted progress.
- Expired, cancelled, resolved, or invalidated collections cannot reopen.
- Workflow identity, source, build, or Schema changes invalidate an unfinished
  collection and require a new request.

### Compatibility and fallback

- Existing manifests do not gain new required metadata.
- Existing complete tool calls continue to execute without a clarification
  round trip.
- `title`, `description`, and examples improve question quality but remain
  optional.
- A natural request with no matching workflow may continue to ordinary model
  answering or knowledge search.
- An explicit request for a named but inapplicable workflow receives a clear
  unsupported response; AutoForge does not pretend to execute it.
- Missing or invalid parameters are `needs_input`, never `no_match`.

## Domain Model

**Workflow input resolution** combines a current parameter patch, confirmed
partial input, static defaults, and runtime bindings, then checks the result
against the workflow's strict input Schema.

**Parameter collection** is one unfinished workflow input resolution that may
continue across chat turns. It is local to one conversation and bound to an
exact workflow and Schema identity.

**Parameter patch** is the partial object extracted from the current user
message. It contains only newly explicit values and is not an execution input.

**Workflow execution input** is the final object that passes the workflow's
original strict `inputSchema` and may cross the Worker execution seam.

Overall workflow invocation resolution has exactly three results:

```ts
type WorkflowInputResolution =
  | { kind: 'ready'; input: unknown }
  | { kind: 'needs_input'; collection: WorkflowInputCollection; questions: string[] }
  | { kind: 'no_match' }
```

`no_match` belongs to workflow or configured-item intent selection. Once a
specific workflow input Schema reaches `WorkflowInputResolver`, that module
returns only `ready` or `needs_input`; it does not infer intent from parameters.

A collection has `pending`, `resolved`, `cancelled`, `expired`, or
`invalidated` status. Only `pending` is active.

## Chosen Architecture

Create a deep `WorkflowInputResolver` module in Electron Main. Its external
Interface has two primary operations:

```ts
project(workflowSchema): ModelInputProjection

resolve({
  workflowIdentity,
  originalSchema,
  existingCollection,
  patch,
  runtimeBindings,
  now,
}): Ready | NeedsInput
```

`project()` produces the permissive model contract. `resolve()` hides patch
merging, defaults, bindings, AJV validation, diagnostics, deterministic
questions, redaction metadata, and Schema fingerprint checks.

The module has focused internal seams for schema compilation and runtime
binding lookup, but those are not part of the Agent-facing Interface.

### Callers and adapters

- `WorkflowCatalog` calls `project()` and places the resulting Schema in the
  model tool definition.
- `AgentOrchestrator` coordinates model turns, persistence, clarification text,
  cancellation, replacement, and transfer of ready input to execution.
- `WorkflowConfigSelector` remains responsible only for choosing a configured
  item. A configured-item adapter passes its partial input and item Schema to
  the same Resolver.
- `WorkflowInputCollectionRepository` exposes local collection reads,
  compare-and-swap writes, terminal transitions, and expiry cleanup.
- A SQLite adapter implements that repository.
- `WorkflowToolExecutor` accepts only ready input and retains final defensive
  validation, exact-source checks, permission checks, and execution ownership.

The existing `workflow_proposal` chat block is not reused. It is synchronized,
contains opaque arguments, and lacks exact Schema identity and lifecycle
semantics. Ordinary assistant text presents questions; the local collection row
is the state authority.

### Considered alternatives

Embedding the behavior directly in `AgentOrchestrator` was rejected because it
would duplicate ordinary/configured input logic and make projection, persistence,
redaction, and lifecycle behavior inseparable from provider streaming.

Adding a separate parameter-planning model request before every workflow call
was rejected because it duplicates tool calling and adds latency and cost while
still requiring strict local validation.

## Schema Contract

### Dual Schema projection

Compiling `inputSchema` produces an immutable contract containing:

- the original strict Schema;
- a permissive model-facing projection;
- a canonical Schema fingerprint;
- static default paths;
- runtime binding paths;
- personal-data paths;
- interactive-capability diagnostics.

The model projection recursively removes `required`, retains names, titles,
descriptions, types, enums, formats, ranges, and local references, removes
runtime-bound properties, and strips all `x-autoforge-*` annotations. A
collection projection may relax `oneOf` into candidate branches so partial
input can cross the model tool seam, but strict execution always uses the
original combinator.

Complete execution validation supports the existing synchronous JSON Schema
surface. Interactive clarification formally supports object roots, nested
objects, arrays, required fields, primitive types, enums, constants, formats,
patterns, length and numeric constraints, uniqueness, and local `$ref`.

For `oneOf`, `anyOf`, `if/then/else`, or dependent schemas, an already-valid
input may execute. Incomplete input that has more than one viable branch asks
the user to select a branch rather than guessing. `$async` and remote `$ref`
fail closed.

### AutoForge annotations

The design adds two optional input-property annotations:

```json
{
  "x-autoforge-binding": "current-date | current-user | attachments",
  "x-autoforge-sensitive": "personal | secret"
}
```

First-version runtime bindings are:

- `current-date`: a `YYYY-MM-DD` string in the current application time zone;
- `current-user`: the stable current execution user ID;
- `attachments`: controlled indexes for attachments on the current message.

Binding output must be compatible with the annotated property Schema. A bound
property is absent from the model projection and cannot be overridden by a
chat patch.

`personal` fields remain model-visible because users may explicitly supply
them, but their paths drive redaction. `secret` fields fail manifest/developer
validation in this version because AutoForge has no workflow-scoped secret
provisioning subsystem. Existing platform and model-provider credentials are
never valid workflow bindings.

### Defaults and merge order

Static JSON Schema `default` values are applied deterministically only when a
path is absent. The model cannot invent a default, and a personal or secret
field cannot use one.

Resolution order is fixed:

```text
confirmed partial input
  -> current field-level patch
  -> missing static defaults
  -> non-overridable runtime bindings
  -> strict original-Schema validation
```

Patch semantics are:

- absent fields preserve existing values;
- objects merge recursively;
- arrays and scalars replace their previous value;
- `null` is a value only when the strict Schema permits it and the user
  explicitly clears the field;
- current explicit corrections may overwrite confirmed values;
- runtime-bound fields cannot be patched.

The model extracts only values from the current user message. It does not
regenerate the complete stored input.

## Diagnostics and Clarification

Strict validation uses AJV with `allErrors`. The Resolver classifies errors as:

- missing required field;
- invalid type or format;
- invalid enum or range;
- unsupported additional field;
- ambiguous complex branch.

Question text is deterministic. It uses field `title`, `description`, `format`,
`enum`, and range constraints and never sends raw AJV text to the user. Schema
property order determines stable question order. One turn asks at most three
related fields under the same parent; a correction asks only for the first
invalid field.

A user reply makes progress only when at least one patch path passes its local
field constraints and changes the canonical partial input. Repeated values,
unknown fields, and locally invalid values do not reset the no-progress count.
Malformed model tool arguments are model failures, not user no-progress.

Diagnostics and logs may contain workflow identity, result kind, missing or
invalid field paths, timing, no-progress count, model/error category, and
Schema fingerprint. They never contain raw parameter values, full tool
arguments, personal values, or secret values. Developer mode does not relax
this rule.

## Persistent Collection

Add desktop migration `0021_workflow_input_collections.sql`. The table contains:

```text
id
conversation_id
status
workflow_id
workflow_version
source
build_hash
config_key
schema_fingerprint
partial_input_json
diagnostics_json
consecutive_no_progress
revision
created_at
updated_at
expires_at
```

The table belongs only to the desktop Main database. It is not added to the
user-cache migrations, cloud sync payload, or CloudBase schema.

Database constraints enforce valid statuses, nonnegative counters and
revisions, a conversation foreign key with cascade deletion, one pending row
per conversation through a partial unique index, and the absence of partial
input in terminal rows.

Repository writes use optimistic compare-and-swap on `revision`. A stale writer
returns a safe conflict and cannot overwrite a newer turn. Every terminal
transition and partial-input removal occurs in one transaction.

Expiry is 24 hours after the most recent accepted progress. A successful patch
resets `expires_at`; a no-progress reply does not. Expired rows are cleared
lazily when read and in a startup cleanup pass.

## Agent Data Flow

### Initial request

```text
eligible candidates
  -> workflow/configured-item intent selection
       -> no_match: approved direct-answer/knowledge fallback behavior
       -> matched workflow
            -> permissive model tool emits partial input
            -> apply defaults and runtime bindings
            -> strict validation
                 -> ready: existing permission and execution path
                 -> needs_input: persist pending collection and append questions
```

Configured workflows first select exactly one config item using its intent
description and city restriction. The selector may return partial item input.
Missing item input is passed to the Resolver as `needs_input`; only an intent
mismatch is `no_match`.

### Continuation request

When a valid pending collection exists, the Agent offers and forces one dynamic
decision tool:

```ts
interface WorkflowInputContinuationDecision {
  decision: 'continue' | 'cancel' | 'replace' | 'clarify'
  input?: PartialWorkflowInput
}
```

- `continue` resolves the current patch against the collection.
- `cancel` terminates and clears the collection.
- `replace` cancels the old collection and reroutes the same user message once.
- `clarify` retains the collection and asks whether to continue or replace.

Normal continuation uses one model request. Replacement may use a second model
request for ordinary workflow routing. The same turn can reroute at most once.
The decision tool prevents one user reply from feeding two active workflows.

After a continuation reaches `ready`, Main atomically marks the collection
`resolved` before entering the existing permission and execution path. A
subsequent workflow in the same user request begins only after the first
workflow has completed, preserving the existing sequential tool loop.

## State and Failure Model

The collection state machine is:

```text
absent -> pending
pending -> resolved | cancelled | expired | invalidated
```

Terminal states never transition back to pending.

- Repository read or write failure fails closed and does not execute.
- A malformed model patch returns a bounded model tool error and does not
  create or modify a collection.
- A no-progress user patch increments the collection counter.
- Three consecutive no-progress replies cancel and clear the collection.
- Missing current-message attachments may remain `needs_input` and ask the user
  to attach files.
- An unavailable runtime binding that the user cannot supply returns a stable
  binding-unavailable error instead of asking for that bound field.
- Workflow ID, version, source, development build, configured item, or Schema
  fingerprint mismatch invalidates and clears the collection.
- Input that is not `ready` never reserves an execution, creates an execution
  record, or consumes a workflow execution slot.
- Existing permission approval starts only after input is ready.
- Approval denial, execution failure, or output failure does not reopen a
  resolved collection.
- Final defensive Executor validation remains mandatory. A workflow-change
  failure at that seam invalidates any still-associated collection.

## Security and Privacy

- Renderer, model output, workflow code, workflow output, and persisted partial
  input are not execution authority.
- Runtime bindings come from a fixed Main-owned registry, not arbitrary
  manifest code.
- Model-facing schema projection cannot weaken final execution validation.
- Existing platform credentials are never readable through workflow bindings.
- Personal fields are used only when explicitly supplied or explicitly
  referenced by the user.
- Parameter values do not enter generic logs, telemetry, safe error summaries,
  execution summaries, or model tool-error payloads.
- Local pending input is cleared on every terminal transition and expiry.
- Pending collections are not synchronized to another device. A different
  device must start the workflow request again.

## Migration and Compatibility

- Existing manifests remain valid without the new annotations.
- Complete existing calls retain the current execution path and outer
  `{ input }` tool envelope.
- Built-in workflows add useful field titles and descriptions as examples, but
  metadata remains optional for third-party workflows.
- Existing strict AJV execution validation stays in place.
- No legacy pending state exists to migrate.
- Existing conversation sync ignores the new local-only table.
- No Renderer schema or dedicated chat block is added.

The implementation must inspect and preserve pre-existing uncommitted changes,
especially in shared contracts and workflow-schema files. It must not perform
unrelated cleanup or formatting.

## Verification

### Resolver tests

- Workflows with completely different field names and counts receive distinct
  model projections and strict inputs.
- Complete input resolves to `ready` without creating a collection.
- Missing required fields and invalid values resolve to deterministic
  `needs_input` questions.
- Object patches merge recursively; arrays and scalars replace; explicit valid
  corrections overwrite old values.
- Defaults apply only to absent fields; bindings override patches and are
  hidden from the model projection.
- Personal fields are redacted from diagnostics; secret fields, `$async`, and
  remote references fail closed.
- Local references work in projection and strict validation.
- Complex branches execute when complete and request disambiguation when
  incomplete.
- Question grouping, correction priority, progress detection, and the
  three-no-progress limit are deterministic.

### Repository and migration tests

- The migration creates the required checks, foreign key, partial unique index,
  and optimistic revision behavior.
- One conversation cannot own two pending collections.
- Terminal transitions clear partial input atomically.
- Conversation deletion cascades to collection rows.
- Accepted progress renews the 24-hour expiry; no-progress does not.
- Startup and lazy cleanup expire and clear stale rows.
- No user-cache or cloud-sync mutation contains a collection.

### Agent integration tests

- A complete ordinary workflow still executes directly.
- An incomplete ordinary workflow asks, persists, resumes, and executes after a
  valid reply without reserving early.
- Restart recovery uses the local collection and exact workflow identity.
- Cancellation, replacement, clarification, expiry, three no-progress replies,
  and workflow/Schema invalidation follow the state machine.
- A configured workflow distinguishes missing item input from `no_match`.
- A new explicit workflow request replaces the pending collection; an ambiguous
  request does not feed two workflows.
- Multi-workflow requests collect and execute serially.
- Existing permission approval, execution budgets, direct answers, knowledge
  fallback, cancellation, and final workflow summary behavior do not regress.

### Contract, documentation, and build checks

- Workflow Schema and SDK tests cover valid and invalid annotation shapes.
- Built-in workflow examples demonstrate field titles and descriptions.
- `CONTEXT.md`, the workflow development guide, and the dual-Schema ADR match
  the implemented contract.
- Targeted package and desktop tests pass, followed by `pnpm typecheck`,
  `pnpm lint`, and complete `pnpm test` when practical.
- No headed browser test is run without separate authorization.

## Success Criteria

The feature is complete only when every approved verification scenario passes,
no incomplete input can reserve or start a workflow, pending parameter values
remain local and are cleared at terminal states, existing complete workflows
remain compatible, and validation confirms that user pre-existing changes were
not overwritten or accidentally committed.
