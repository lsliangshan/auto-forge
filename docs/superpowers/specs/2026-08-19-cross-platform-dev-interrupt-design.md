# Cross-platform development interrupt design

## Problem

The root development command starts the desktop application through several
process layers:

```text
pnpm dev
  -> pnpm --filter @autoforge/desktop dev
    -> electron-vite dev
      -> Electron
```

When the terminal sends `SIGINT` for `Ctrl+C`, pnpm can stop its direct child
without delivering the interrupt to the final Electron process. The
electron-vite and pnpm processes then exit with a signal, so pnpm reports
`ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL`, while Electron is reparented and remains
visible in the macOS Dock. Sending `SIGINT` directly to that orphaned Electron
process closes it, which confirms that the application can shut down but does
not receive the original interrupt.

## Goals

- A single `Ctrl+C` from the root or desktop development command shuts down
  electron-vite, Electron, its Helper processes, and the renderer dev server.
- An intentional `SIGINT` or `SIGTERM` is reported to pnpm as a successful
  development shutdown, without `ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL` or
  `ELIFECYCLE` output.
- Electron follows its existing `app.quit()` and `before-quit` shutdown path
  instead of being force-killed.
- The behavior works on macOS and Windows without platform-specific shell
  syntax or external process-management commands.
- Unexpected startup failures and nonzero electron-vite exits remain failures.
- Production and packaged application lifecycle behavior is unchanged.

## Non-goals

- Do not change pnpm or patch electron-vite in `node_modules`.
- Do not redesign the application runtime shutdown sequence.
- Do not add a general-purpose process supervisor or new runtime dependency.
- Do not suppress unrelated warnings, build failures, or unexpected exits.
- Do not change window-close behavior on macOS or Windows.

## Design

### Development process supervisor

Add a small Node script under `apps/desktop/scripts` and make the desktop
`dev` lifecycle invoke it instead of invoking `electron-vite dev` directly.
The script has one responsibility: supervise the electron-vite child during
development.

The supervisor will:

1. Resolve the workspace-pinned electron-vite CLI and spawn it with the current
   working directory, environment, and inherited standard streams.
2. Listen for both `SIGINT` and `SIGTERM` with persistent, idempotent handlers.
   pnpm may deliver the same interrupt more than once, so subsequent signals
   received during the same shutdown are ignored.
3. Forward the first intentional interrupt to the direct electron-vite child.
   On Windows the child is terminated with the signal semantics supported by
   Node; Electron itself is not force-killed.
4. Exit with status `0` after the interrupted child closes, so pnpm treats the
   user-requested stop as successful.
5. Propagate an ordinary child exit code or unexpected signal as a failure when
   no supervisor-initiated shutdown is in progress.
6. Report CLI resolution and spawn errors and exit nonzero.

The supervisor does not enumerate descendants and does not depend on POSIX
process groups, `pkill`, or Windows `taskkill`. This keeps the script portable
and avoids bypassing Electron's cleanup path.

### Electron development-parent watchdog

The Electron Main process gains a development-only parent-liveness watchdog.
At startup it captures the electron-vite parent PID. While the application is
not packaged, a lightweight unreferenced timer checks whether that original
parent still exists. If electron-vite has exited or Electron has been
reparented, the watchdog requests `app.quit()` exactly once.

That quit request uses the existing lifecycle:

```text
parent disappears
  -> app.quit()
    -> before-quit
      -> shutdown()
        -> runtime.close()
          -> app.quit()
```

The watchdog is disabled for packaged builds. It is also disposed when normal
application shutdown begins, so it cannot initiate a second quit while the
existing asynchronous cleanup is running.

The parent-liveness decision is kept in a small testable helper. The helper
accepts the parent PID, a liveness probe, a quit callback, and timer functions;
it has no Electron dependency. The Main entry point supplies `process.ppid`, a
`process.kill(pid, 0)` probe, and `app.quit()`.

## Module boundaries

- `apps/desktop/scripts`: owns development command supervision and exit-status
  normalization. It does not know about application services or Electron
  windows.
- Electron Main startup: owns graceful application shutdown when its
  development host disappears. It does not manage pnpm or electron-vite.
- Existing runtime shutdown: continues to own IPC, database, worker, network,
  and service cleanup.

There is no DTO, database, cache, repository, service, or external API change.
The only cross-layer trigger is the disappearance of the development parent;
the action remains the existing Electron `app.quit()` lifecycle.

## Failure behavior

- If electron-vite cannot be resolved or spawned, the supervisor exits
  nonzero and prints the original error.
- If electron-vite fails before an interrupt, its exit status remains nonzero
  and pnpm continues to report the real failure.
- If `SIGINT` or `SIGTERM` initiates shutdown, repeated delivery is ignored and
  the supervisor reports success only after its direct child has closed.
- If the parent-liveness probe fails because the parent is gone, Electron
  requests a graceful quit once. Other probe errors are treated as liveness so
  a transient permission or platform error cannot close a healthy app.
- A hard kill such as `SIGKILL`, operating-system crash, or power loss remains
  outside the graceful-shutdown contract.

## Testing and acceptance

Use test-driven development at two seams.

### Focused tests

- Supervisor test: a fixture child receives a forwarded interrupt; duplicate
  interrupts do not trigger duplicate forwarding; intentional shutdown returns
  status `0`.
- Supervisor failure tests: resolution, spawn, ordinary nonzero exit, and
  unexpected signal failures stay nonzero.
- Watchdog tests: a live parent performs no action; a missing parent calls quit
  once; repeated ticks remain idempotent; disposal prevents later quit; probe
  errors do not close the app.

### Real regression test

Run the actual root development command, wait until Electron has started, and
send `SIGINT` only to the outer pnpm process rather than to the whole process
group. This reproduces terminals and task runners that forward the interrupt
only through the parent chain.

The regression passes only when:

1. the command exits without pnpm lifecycle-failure text;
2. the supervised command returns a successful intentional-shutdown status;
3. no AutoForge Electron Main or Helper process remains;
4. renderer ports 5173 and 5174 are released; and
5. the workspace remains clean apart from the intended source and test changes.

Finally run the focused test files, desktop tests, type checking, lint, and the
production build. Packaged startup is not expected to install the watchdog and
must retain the existing lifecycle behavior.
