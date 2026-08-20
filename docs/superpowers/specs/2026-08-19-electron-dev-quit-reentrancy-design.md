# Electron development quit reentrancy design

## Problem

The first cross-platform interrupt fix removes pnpm's `SIGINT` error and closes
the Electron window, but a terminal `Ctrl+C` can still leave the Electron Main
process and its Helper processes alive. The remaining Main process is reparented
to PID 1 and keeps the macOS Dock running indicator visible.

The failure was reproduced against the real process chain by sending `SIGINT`
to the foreground process group. The supervisor, electron-vite, and pnpm exited,
while Electron remained alive for more than 30 seconds. Temporary lifecycle
instrumentation established this sequence:

```text
before-quit:first
  -> shutdown:start
  -> shutdown:complete (about 4 ms)
  -> shutdown:finally
  -> app.quit()
  -> before-quit:repeat
  -> no will-quit event
```

The runtime cleanup is not stalled. The failure is a reentrant final
`app.quit()` call made from the cleanup promise's microtask while Electron is
still unwinding the first prevented `before-quit` request. It is timing-sensitive:
some runs exit normally and others leave an orphaned Main process.

## Goals

- A terminal `Ctrl+C` closes the window and terminates Electron Main and all
  Helper processes without a residual Dock running indicator.
- Development cleanup still completes before the final quit request.
- The final development quit request runs in a later event-loop turn, outside
  the first prevented `before-quit` dispatch.
- The behavior is identical on macOS, Windows, and Linux development hosts.
- Packaged application quit timing and lifecycle behavior remain unchanged.
- The pnpm intentional-interrupt success behavior remains unchanged.

## Non-goals

- Do not force-kill Electron or enumerate descendant processes.
- Do not introduce a shutdown timeout or call `app.exit()`.
- Do not redesign `runtime.close()` or its service cleanup ordering.
- Do not change macOS window-close behavior outside terminal-driven shutdown.
- Do not add a runtime dependency.

## Design

Add a small Electron-independent shutdown completion helper under Electron Main.
It accepts the packaged flag, the existing asynchronous shutdown operation, the
final quit callback, and an injectable deferral function.

The helper preserves the current packaged path: after cleanup settles, it calls
the final quit callback immediately. In development, it schedules that callback
with Node's cross-platform `setImmediate`, ensuring Electron has returned from
the first prevented native quit dispatch before the second `app.quit()` begins.
Cleanup rejection still schedules the final quit, matching the current `finally`
semantics.

The existing `before-quit` listener keeps ownership of the one-time `quitting`
guard, watchdog disposal, IPC disposal, and runtime cleanup. It delegates only
the cleanup-to-final-quit transition to the helper. The watchdog, development
supervisor, database, services, windows, and IPC contracts do not change.

```text
first before-quit
  -> preventDefault
  -> dispose watchdog
  -> await shutdown
  -> development: setImmediate(final app.quit)
  -> first quit dispatch fully unwinds
  -> final app.quit
  -> repeated before-quit is not prevented
  -> will-quit
  -> process exits
```

## Module boundaries

- `application-shutdown-completion.ts` owns only the transition from settled
  cleanup to the final quit request. It has no Electron import.
- `index.ts` continues to own Electron lifecycle events and application state.
- `development-parent-watchdog.ts` continues to detect parent disappearance.
- `scripts/dev.mjs` continues to supervise electron-vite and normalize only an
  intentional interrupt.

No DTO, database, cache, repository, service, or external API is added or
shared across boundaries.

## Failure behavior

- If cleanup succeeds, development schedules one final quit on the next event
  loop turn.
- If cleanup rejects, development still schedules one final quit; the existing
  shutdown failure behavior is otherwise unchanged.
- Repeated `before-quit` events do not restart cleanup or schedule extra work.
- Packaged builds retain the current immediate final quit after cleanup.
- Unexpected electron-vite failures remain nonzero and visible to pnpm.

## Testing and acceptance

Use test-driven development at the shutdown-completion seam:

1. A development test with synchronously settled cleanup must prove the final
   quit callback is not called until the injected deferred callback runs.
2. A cleanup-rejection test must prove development still defers exactly one
   final quit.
3. A packaged test must prove the existing immediate final quit is preserved.
4. Existing watchdog and supervisor tests must remain green.

The real regression must capture the newly started Electron Main PID directly,
send `SIGINT` to the foreground development process group as a terminal does,
and poll that exact PID. Path-only matching is insufficient because linked
worktrees can share dependency paths. The regression passes only when, within
five seconds:

- the development command exits successfully without pnpm lifecycle errors;
- the captured Electron Main PID and its Helper descendants no longer exist;
- the renderer development port is released; and
- no diagnostic instrumentation remains.

Run the focused tests repeatedly, then the complete test suite, type checking,
targeted lint, and the production build. A native Windows smoke test remains a
recommended environment check, while the deferral contract itself is covered
by platform-independent unit tests.
