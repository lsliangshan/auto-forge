# Chat Pending State and Auto-Scroll Design

## Problem

The chat composer currently enters its running state only after Main returns a
`requestId` or emits a running event. Main performs credential validation,
media resolution, model-catalog loading, and route selection before returning,
so the send button can remain visible during a slow preflight even though the
message has already been admitted locally.

The message list is scrollable but has no automatic scroll behavior. A locally
inserted user message or a newly received assistant message can therefore land
below the visible viewport.

## Desired Behavior

- Immediately after a valid submission, the send button becomes a clickable
  button labeled exactly `取消发送`.
- Clicking `取消发送` before Main returns a `requestId` records a cancellation
  intent. Once the ID arrives, the existing `chat.cancel(requestId)` bridge call
  is invoked immediately.
- Clicking `取消发送` after a request ID exists uses the existing cancellation
  path directly.
- The running/cancellation state remains isolated by conversation.
- After a local user message is inserted, the message viewport scrolls to its
  latest content.
- After a new assistant message, block, block update, or streaming text delta
  is received, the viewport scrolls to its latest content again.
- Existing submission rollback, draft restoration, terminal-event race
  handling, IME behavior, and attachment behavior remain unchanged.

## Design

### Store-owned pending admission

Add conversation-scoped pending and pending-cancellation records to the chat
store. `isRunning` becomes true when either a pending admission or an active
request ID exists for the selected conversation.

`send()` sets pending admission synchronously after validating the input and
capturing the selected conversation, before invoking the desktop bridge. It
clears the pending marker on either acceptance or rejection.

If Main accepts:

1. Preserve the existing terminal-before-return guard.
2. Register the active request ID when the request is not already terminal.
3. If cancellation was requested while pending, clear the intent and invoke
   `chat.cancel(requestId)`.
4. A cancellation bridge failure uses the existing localized cancellation
   error flow and does not turn an accepted send into a rejected send.

If Main rejects, clear both pending records, roll back the optimistic message,
and keep the existing composer acknowledgement behavior that restores the
submitted draft.

`cancelCurrent()` first uses an already-known active request ID. When no ID is
known but admission is pending, it records the cancellation intent instead of
silently returning.

Reset and conversation-deletion paths remove the new conversation-scoped
records alongside existing active-request state.

### Composer state

The composer continues to use the `running` prop as the source of request
state. Its running button label changes from `取消生成` to exactly `取消发送`.
The existing cancel event is reused; no new component event or IPC contract is
introduced.

### Message auto-scroll

Expose the selected conversation's existing `_messageVersions` value through a
read-only store getter. The version already increments for optimistic user
message insertion, rollback, and every received chat block event, including
streaming text deltas.

`ChatView` holds a ref to the `.messages` container and watches the tuple of
selected conversation ID and selected message version. After Vue completes the
corresponding DOM update, it sets:

```ts
messagesElement.scrollTop = messagesElement.scrollHeight
```

This also scrolls to the latest content when selecting a conversation whose
message version differs. It intentionally follows new streamed content even if
the user previously scrolled upward, matching the requested unconditional
scroll-to-latest behavior.

## Alternatives Considered

### Component-local pending state

`ChatComposer` already tracks pending acknowledgements and could switch its own
button immediately. Cancellation intent and request IDs, however, belong to
different layers and conversations. Keeping that state in the component would
split request lifecycle ownership and make conversation switches race-prone.

### Early Main acknowledgement

Main could allocate and return a request ID before preflight. That would require
moving all preflight failures into asynchronous events and changing the IPC
acceptance contract. It is unnecessary for the requested UI behavior.

## Testing

Add focused regressions that prove:

- `isRunning` becomes true before an unresolved `chat.send()` bridge call
  settles.
- The composer displays `取消发送` during pending admission.
- Clicking it before request-ID resolution invokes `chat.cancel(requestId)`
  immediately after the ID arrives.
- A rejected admission clears pending state and restores existing submission
  behavior.
- A request that reaches a terminal event before `send()` returns is not
  resurrected.
- Local user-message insertion scrolls the message container to its current
  `scrollHeight`.
- New assistant messages and streaming deltas repeat the scroll after DOM
  rendering.

Run focused chat component tests, the desktop Renderer suite, type checking,
lint, build, and the full repository test suite. Finish with a real Electron
submission/cancellation and visible scroll check when the configured provider
and runtime permit it; otherwise report the exact runtime validation gap.
