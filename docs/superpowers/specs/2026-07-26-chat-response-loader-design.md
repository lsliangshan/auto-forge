# Chat Response Loader Design

## Problem

The chat store inserts a valid user message and enters its pending request state
synchronously, but the conversation does not show an assistant-side response
indicator until Main emits the first reply block. Credential checks, model
selection, request admission, and provider startup can therefore leave the user
looking at only their own message even though generation has begun.

## Desired Behavior

- Immediately after a valid user submission is admitted locally, show a
  transient AutoForge assistant message directly below the user message.
- The transient message contains a spinning loader and the exact text
  `正在生成回复…`.
- Remove the loader as soon as the first assistant `block` or `block_update`
  event arrives for that conversation.
- Also remove the loader when the request fails, is cancelled, or reaches a
  terminal state without producing reply content.
- Keep loader state isolated by conversation.
- Scroll the message viewport to the latest content when the loader appears and
  when the first real assistant content replaces it.
- Do not persist the loader and do not change the desktop IPC or Main-process
  chat event contract.

## Design

### Store-owned awaiting-response state

Add a conversation-scoped awaiting-response record to the chat store. A valid
`send()` sets the selected conversation's marker synchronously at the same
point that pending request state is established, before calling the desktop
bridge.

The state remains separate from `isRunning`: a request can continue running
after its first response block has appeared, while the loader must already be
gone. A dedicated marker therefore represents the narrower interval between
local submission and first assistant content.

Expose a getter for the selected conversation so `ChatView` can render the
loader without duplicating request lifecycle state.

Clear the marker in every terminal path:

1. On the first non-status `block` or `block_update` event for the
   conversation, before applying that real assistant content.
2. On `completed`, `cancelled`, or `failed` status for the conversation,
   including terminal events that arrive before `chat.send()` returns its
   request ID.
3. When the bridge rejects the send and the optimistic user message is rolled
   back.
4. When local chat data is reset or the conversation is deleted.

Only one request can run in a conversation under the existing `isRunning`
guard, so a conversation-scoped boolean marker is sufficient. No request-to-
loader collection or new correlation identifier is needed.

### Loader presentation

Render the loader in `ChatView` after the real message loop. It uses the same
two-column `.message.assistant` structure as persisted assistant messages:

- Role label: `AutoForge`
- Body: the existing Element Plus spinning `Loading` icon
- Text: `正在生成回复…`

The loader is a transient view element rather than a synthetic
`UiChatMessage`. It therefore cannot be persisted, merged into message
snapshots, or mistaken for provider output.

The existing empty-state panel is hidden while the loader is visible. In
normal submission flow the optimistic user message already makes the
conversation non-empty, but this condition keeps the rendering rule explicit.

### Auto-scroll integration

The current auto-scroll watcher reacts to the selected conversation's message
version. Optimistic user insertion already increments that version, so the
loader and user message render in the same Vue update and the existing
post-flush scroll includes both.

The first assistant block also increments the same version. Its update removes
the loader, renders the real assistant message, and triggers another scroll to
the latest content. No second scroll counter or DOM observer is introduced.

Terminal events without content remove the loader but do not add content below
the current viewport, so they do not require an extra scroll trigger.

## Alternatives Considered

### Derive the loader from the final message and `isRunning`

This avoids new store state, but `isRunning` remains true while an already
visible assistant response streams or waits for workflow execution. The loader
would therefore remain visible after the first real content and misrepresent
the request phase.

### Keep loader state inside `ChatView`

The view could set local state on submit and clear it when the message list
changes. That would split request lifecycle ownership between the component
and store, and would make rejection, cancellation, terminal-before-return
races, reset, deletion, and conversation switching harder to keep consistent.

### Insert a synthetic assistant message into the store

A placeholder message would reuse the existing message renderer, but it would
enter snapshot merge and event-update paths intended for real persisted
messages. Keeping it as a transient view element avoids fake IDs and special
message persistence rules.

## Testing

Add focused regressions that prove:

- Awaiting-response state becomes true synchronously while the bridge send
  promise is unresolved.
- `ChatView` immediately renders one AutoForge loader with the exact text
  `正在生成回复…`.
- The first `block` event removes the loader and renders the real content.
- A first `block_update` event also removes the loader.
- Failed, cancelled, and content-free completed requests remove the loader,
  including terminal-before-send-return ordering.
- Bridge rejection clears the loader alongside the existing optimistic-message
  rollback.
- Reset and conversation deletion remove their awaiting-response markers.
- Loader state is isolated when selecting a different conversation.
- Existing message auto-scroll includes the loader on local submission and the
  first real reply after replacement.

Run the focused chat component tests, the desktop Renderer suite, type
checking, lint, build, and the full repository test suite. Restore the Electron
`better-sqlite3` ABI after Node-based tests, then verify in the real Electron
window that a submitted message immediately shows the loader below it, the
viewport is at the latest content, and the loader disappears when the first
model content arrives or the request is cancelled.
