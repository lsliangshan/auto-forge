# Conversation Context Compression Design

## Problem

AutoForge persists every user and assistant message under a `conversation_id`,
but `AgentOrchestrator.run()` currently initializes the provider request with
only the current user input. A second message in the same conversation therefore
has no knowledge of the first exchange. Sending every persisted message without
a budget would eventually exceed the selected model's context window, especially
when workflow schemas and multimodal metadata are also present.

## Desired Behavior

- Every text response uses prior context from the same conversation.
- A new conversation never inherits context from another conversation.
- The normal chat UI continues to display the complete original transcript.
- Context summaries remain internal to Electron Main and are not exposed through
  Renderer state, Preload, IPC responses, or chat events.
- Historical attachments are represented by safe text metadata only. Their
  bytes, Base64 payloads, absolute paths, and URLs are never reloaded into later
  model requests.
- When the estimated request is too large, old context is summarized
  incrementally while recent messages remain verbatim.
- Context compression never silently drops an unsummarized message.
- Only one agent run may be active for a conversation at a time.

## Scope

This change applies to text-output chat routed through `AgentOrchestrator` for
both OpenRouter and DeepSeek. Image, audio, and video generation keep their
prompt-only behavior. The change does not add context controls, summary display,
summary editing, or manual compression UI.

## Architecture

### Main-owned context manager

Add a focused `ConversationContextManager` in the Main chat layer. It owns four
operations:

1. Read the stored summary checkpoint and ordered messages for one conversation.
2. Convert persisted `ChatBlock` values into safe model text.
3. Estimate the complete provider input and choose whether compression is
   required.
4. Produce the `ModelMessage[]` prefix used by the agent run.

`AgentOrchestrator` remains responsible for provider turns, workflow tools,
approvals, cancellation, persistence of the current run, and UI events. It asks
the context manager for the historical message prefix, then appends the current
user message. The context manager receives a narrow streaming provider port
that is structurally compatible with `AgentProviderPort`, rather than creating
a second provider registry or credential path.

Renderer, Preload, and IPC request/response shapes remain unchanged. The only
Renderer-visible contract addition is a safe display mapping for the new
`CONTEXT_LIMIT_EXCEEDED` error code.

### Request ordering and admission

The orchestrator tracks active conversation IDs in addition to active request
IDs. A second run for the same conversation returns `CONFLICT` before it writes
another user message. Runs in different conversations remain independent.

For an admitted run, the order is:

1. Persist the current user message, obtain its conversation ordinal, and create
   the chat run and empty assistant message.
2. Read the current summary checkpoint and a stable history snapshot restricted
   to ordinals lower than the current user message.
3. Resolve workflow candidates and their tool schemas.
4. Ask the context manager to fit the history snapshot, summary, current input, and
   tools into the selected model budget. Any internal summary provider request
   occurs only after the user input is durable.
5. Send `internal summary -> recent raw history -> current user input` to the
   normal provider stream.

The ordinal cutoff prevents the just-persisted user message and empty assistant
placeholder from entering history. It also lets snapshot or compression errors
use the existing persisted assistant/run terminalization path. This preserves
the guarantee that no provider or workflow operation precedes durable user
input. Terminal cleanup removes both request and conversation admission entries.

## Persistence and Ordering

### Deterministic message ordinals

Add migration `0003_conversation_context.sql`. It adds a nullable SQLite
`ordinal` column to `messages`, backfills existing rows with `ROW_NUMBER()` per
conversation ordered by `created_at` and SQLite insertion `rowid`, then creates
a unique index on `(conversation_id, ordinal)`.

All new message inserts allocate `MAX(ordinal) + 1` inside the existing
synchronous SQLite transaction. Repository reads order only by `ordinal` after
the migration. Runtime parsing treats a missing, non-integer, or non-positive
ordinal as corrupted internal state. This fixes the existing ambiguity where a
user and assistant message share a millisecond timestamp and random UUID order.

The existing insert sequence already writes the user message before its
assistant message. With per-conversation admission, adjacent ordinals form a
stable turn without adding a public turn identifier.

### Internal summary checkpoint

The same migration creates `conversation_contexts`:

```sql
CREATE TABLE conversation_contexts (
  conversation_id TEXT PRIMARY KEY
    REFERENCES conversations(id) ON DELETE CASCADE,
  summary_text TEXT NOT NULL,
  through_ordinal INTEGER NOT NULL CHECK (through_ordinal >= 0),
  estimated_tokens INTEGER NOT NULL CHECK (estimated_tokens >= 0),
  updated_at INTEGER NOT NULL
);
```

`through_ordinal` is the highest message ordinal represented by
`summary_text`. A missing row means an empty summary with checkpoint `0`.
Summary updates use an optimistic expected-checkpoint condition and execute in
one transaction. The summary text and checkpoint therefore advance together or
not at all. Conversation deletion removes the row through the foreign key.

The repository exposes internal records only to Main code. No shared desktop
API type is introduced for summaries.

## History Serialization

Persisted messages become provider-safe text as follows:

- User and assistant `text` blocks keep their text in block order.
- A historical media block becomes a bracketed marker containing only its kind,
  original display name, MIME type, and byte size.
- A workflow proposal becomes a short marker with workflow ID and JSON
  arguments.
- Workflow execution and result blocks become short status/result markers using
  data already present in the persisted block.
- Approval, cancellation, failure, and media-generation states become concise
  status markers when they are needed to explain an otherwise empty assistant
  message.
- Purely transient or unknown block shapes fail closed as internal invalid
  state; they are not stringified wholesale.

Historical workflow calls are not reconstructed as OpenAI `tool_call` messages
because the persisted transcript does not retain a complete provider protocol
exchange. Natural-language markers preserve the conversational outcome without
inventing call IDs or tool responses.

An empty historical message that has no meaningful safe representation is
omitted. The current message continues to use the existing `modelContent`, so
only current attachments can carry media bytes to a capable model.

## Budgeting

### Context limit

`ResolvedChatRoute` carries the selected `ModelInfo.contextLength` into the
agent run. If the provider catalog does not advertise a positive context
length, the context manager uses a conservative fallback of `32,000` tokens.

The maximum estimated input is `floor(contextLength * 0.60)`. The remaining
40 percent is reserved for provider tokenization differences and the assistant
response. The estimate includes:

- existing summary framing and text;
- serialized historical messages;
- current text and a conservative token reserve for current media;
- workflow tool names, descriptions, and JSON schemas;
- fixed per-message and per-request protocol overhead.

The estimator is deterministic and dependency-free. It counts CJK characters
individually, groups other Unicode text conservatively, includes serialized JSON
bytes, and adds fixed overhead per message and tool. It is a preflight safety
estimate, not a claim to reproduce every provider tokenizer.

Current media is not estimated from its Base64 wire length because vision and
audio/video models tokenize decoded media rather than the JSON encoding. Reserve
`2,048` tokens per image, `max(2,048, ceil(durationSeconds) * 64)` per audio
asset, and `max(4,096, ceil(durationSeconds) * 128)` per video asset. Cap each
audio or video reserve at `16,384`; when duration is unavailable, reserve
`8,192` for audio and `16,384` for video. These reserves participate only in
context admission and do not change the existing current-message media payload.

### Compression trigger and recent window

If the estimated request fits, the context manager performs no summary call and
returns every raw message after the stored checkpoint.

If it exceeds the input budget, the manager starts with the oldest raw messages
and selects a compression chunk. It initially protects the most recent four
complete user/assistant turns. If the remaining request is still too large, it
reduces the protected raw window one oldest message at a time, always retaining
the current input. Compression normally stops on a complete-turn boundary; it
may stop on a message boundary when a single large turn would otherwise prevent
progress. It never splits a persisted message.

The compression request has no tools or media and may use up to 90 percent of
the model context for input because its output is separately capped. If one
historical message plus the previous summary cannot fit that request, the
current run fails with `CONTEXT_LIMIT_EXCEEDED`; the message is not truncated.

After a successful compression, the manager recalculates the final chat request
from the returned summary and remaining raw messages. It repeats incremental
chunks only when one chunk is insufficient to reach the 60 percent target.

If the current input, tool schemas, summary framing, and minimal protocol
overhead exceed the 60 percent input budget by themselves, compression cannot
help and the run fails with `CONTEXT_LIMIT_EXCEEDED`.

## Summary Generation

Compression uses the same provider and selected model as the chat run. It sends
one internal non-tool request with:

1. A system instruction that requires a concise factual conversation memory,
   forbids invented facts, and defines the required sections.
2. The previous summary when one exists.
3. The next ordered history chunk.

The summary must preserve:

- user goals, constraints, and exact confirmed requirements;
- facts and decisions already established;
- unresolved questions and promised follow-up work;
- workflow names, arguments, outcomes, and relevant failures;
- attachment kind and display metadata needed for later references.

`ModelStreamRequest` gains an optional internal `maxOutputTokens` field. The
OpenAI-compatible wire adapter maps it to `max_tokens`. Summary generation sets
this to `min(2048, floor(contextLength * 0.10))`; ordinary chat does not set it
and keeps its current output behavior.

The manager consumes summary stream text internally and accepts it only when it
receives a non-empty result followed by `finish: stop`. It does not forward
summary deltas, usage, generation IDs, or status events to the Renderer. It uses
the current run's abort signal, so cancellation also cancels compression.

The stored summary is wrapped as a `system` message that explicitly labels it
as earlier-conversation memory rather than a new user instruction.

## Failure Handling

- A provider, cancellation, malformed-stream, or empty-summary failure leaves
  the previous summary and checkpoint unchanged.
- The current chat run follows the existing failed or cancelled terminal path;
  no unsummarized history is discarded as a fallback.
- `CONTEXT_LIMIT_EXCEEDED` is a new safe application error. Its Renderer copy
  is exactly `当前输入和会话上下文超出模型限制，请缩短输入或新建会话`.
- Internal summary text is never added to assistant blocks, message rows, chat
  events, diagnostics, or error details.
- Provider diagnostics retain the existing redaction boundary and must not log
  request messages or summary text.

## Alternatives Considered

### Re-summarize the entire conversation on every overflow

This needs less checkpoint logic but its input cost and latency grow with the
conversation. Repeated rewriting also increases summary drift. Incremental
checkpoints keep work proportional to newly aged-out messages.

### Drop old messages with a sliding window

This is cheap but violates the requirement to manage conversation context:
confirmed decisions and unresolved requirements disappear without notice.

### Local extractive compression

Rule-based sentence or keyword selection avoids a model request but cannot
reliably preserve references, decisions, workflow outcomes, or unresolved
questions across Chinese and English chat. A deterministic estimator is useful
for budgeting, but not as the semantic compressor.

### Expose summaries in the transcript

A visible or editable summary would add UI state, public contracts, and user
confusion about whether the summary is a real chat message. The approved design
keeps the original transcript as the only user-visible history.

## Testing

### Context manager unit tests

- A second message receives the first user and assistant messages in order.
- A new conversation receives no context from another conversation.
- A request below budget performs no compression call.
- An overflow request compresses the oldest eligible messages and keeps the
  recent raw window.
- A later overflow sends the old summary plus only newly aged-out messages to
  the compressor.
- Multiple chunks advance checkpoints monotonically and produce a final request
  below budget.
- Historical media produces metadata markers with no Base64, URL, or absolute
  path.
- Workflow blocks become safe natural-language markers.
- Compression cancellation, provider failure, missing `finish: stop`, and empty
  output do not advance the checkpoint.
- An unfit current request or single historical message returns
  `CONTEXT_LIMIT_EXCEEDED` without truncation.

### Persistence tests

- Migration backfills stable per-conversation ordinals using insertion order as
  the timestamp tie-breaker.
- New message inserts allocate strictly increasing ordinals.
- Different conversations maintain independent ordinal sequences.
- Summary advancement requires the expected prior checkpoint and commits text
  and ordinal atomically.
- Conversation deletion cascades to `conversation_contexts`.

### Orchestrator and application tests

- The provider's second-turn request contains the prior raw exchange followed
  by the current user message.
- Context is assembled only for text-output routes.
- Selected model `contextLength` reaches the context manager; unknown length
  uses `32,000`.
- Tool schemas participate in the budget and remain available to the normal
  agent loop after compression.
- A second active run in the same conversation returns `CONFLICT` without
  persisting another message; a different conversation can run concurrently.
- Summary activity emits no chat blocks or status events.
- Context failure uses the existing atomic assistant/run finalization path.
- `maxOutputTokens` is sent as `max_tokens` only for the internal summary call.

### Verification

Run the focused context, repository, migration, provider, orchestrator, and
application tests first. Then run the full repository test suite, typecheck,
lint, production build, and `git diff --check`. Because the project switches
`better-sqlite3` between Electron and Node ABIs, use the repository's existing
test scripts and finish with the project's normal build/start preparation
rather than invoking raw Vitest under an arbitrary ABI.

Finally verify in the real Electron app:

1. Ask a question, then use a pronoun or omitted subject in the second message
   and confirm the model resolves it from the first turn.
2. Continue a controlled long conversation until compression is triggered and
   confirm the complete original transcript remains visible.
3. Confirm a later question can use an early confirmed fact represented only by
   the internal summary.
4. Confirm a new conversation cannot answer from the prior conversation.
5. Confirm historical attachments are not re-read or resent.
