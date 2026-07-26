# Immediate Chat Submit Feedback Design

## Problem

Submitting the chat composer currently keeps the submitted text visible until
`chat.send()` finishes its Renderer-to-Main IPC call. Main performs credential
validation, media resolution, model-catalog loading, and route selection before
returning a request ID, so a slow preflight makes the Enter key appear
unresponsive.

The chat store already inserts the user message optimistically before awaiting
IPC. The delayed composer acknowledgement, rather than the Enter handler, is
the source of the perceived delay.

## Desired Behavior

- Pressing Enter immediately admits the message locally, shows the optimistic
  user message, and clears the submitted text from the composer.
- Shift+Enter and IME composition behavior remain unchanged.
- A second submission remains blocked while the first submission is awaiting
  Main acceptance.
- If Main rejects the submission, the optimistic message is removed through
  the existing store flow and the submitted text is restored.
- Text typed after the immediate clear is not overwritten. When a failed
  submission and a newer draft both exist, preserve both as separate
  paragraphs in the composer.
- Attachments remain in the existing draft flow until Main accepts them.

## Design

Keep the IPC contract and Main preflight unchanged. The fix belongs at the
existing `ChatComposer` acknowledgement boundary:

1. Capture the conversation ID and exact submitted text.
2. Register the pending submission before emitting `submit`, preserving the
   existing duplicate-submit guard.
3. Clear only the captured conversation's text immediately before emitting.
4. On an accepted acknowledgement, remove the pending marker and leave the
   composer cleared.
5. On a rejected acknowledgement, remove the pending marker and restore the
   submitted text. If the user has already typed another draft in that
   conversation, append the newer draft after a blank line rather than
   overwriting it.
6. Ignore duplicate or stale acknowledgements using the existing pending
   sequence and captured conversation checks.

The store continues to own optimistic message insertion, IPC failure rollback,
draft attachment removal after acceptance, and localized error reporting.

## Alternatives Considered

### Return a request ID from Main before preflight

This would make the IPC resolve earlier, but it changes the cross-process
acceptance contract and requires preflight failures to move entirely into the
asynchronous event channel. That is a larger and riskier change than needed for
the composer feedback problem.

### Clear only after Main accepts

This preserves submitted text without restoration logic, but it is the current
behavior and directly causes the reported delay.

## Testing

Add focused component regressions that prove:

- An unresolved `chat.send()` promise does not prevent the composer from
  clearing immediately after Enter.
- A rejected send restores the submitted text.
- A rejected send does not overwrite text entered after submission and
  preserves both drafts.
- Existing IME, Shift+Enter, running-state, conversation isolation, attachment,
  optimistic-message rollback, and duplicate-submit tests continue to pass.

Run the focused chat component suite first, followed by the desktop test suite
and type/build checks used by this package. Perform a real Electron chat
submission when the local runtime and credential configuration are available;
otherwise report that runtime validation as partial.
