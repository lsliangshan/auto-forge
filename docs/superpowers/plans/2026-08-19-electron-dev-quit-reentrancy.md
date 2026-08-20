# Electron Development Quit Reentrancy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure a terminal `Ctrl+C` fully terminates the development Electron Main and Helper processes by deferring the final development `app.quit()` until the next event-loop turn.

**Architecture:** Add one Electron-independent helper that owns the transition from settled application cleanup to the final quit request. Packaged builds retain the current immediate final quit; development builds schedule it with `setImmediate`, and the existing Main lifecycle listener delegates only this transition to the helper.

**Tech Stack:** Node.js ESM, Electron 43, TypeScript 6, Vitest 4, pnpm 11.

## Global Constraints

- Support macOS, Windows, and Linux development hosts without shell-specific production code.
- Do not force-kill Electron, enumerate descendants in production, add a timeout, or call `app.exit()`.
- Do not change `runtime.close()`, service cleanup order, database, IPC, window, or supervisor contracts.
- Preserve packaged application quit timing and lifecycle behavior.
- Preserve intentional-interrupt status `0` and real nonzero electron-vite failures.
- Add no runtime dependency and do not patch `node_modules`.

## File Map

- Create `apps/desktop/electron/main/application-shutdown-completion.ts`: settle cleanup and request the final quit with development-only deferral.
- Create `apps/desktop/electron/main/application-shutdown-completion.test.ts`: lock down development deferral, cleanup rejection, and packaged behavior.
- Modify `apps/desktop/electron/main/index.ts`: delegate the cleanup-to-final-quit transition to the helper.

---

### Task 1: Add the shutdown completion seam

**Files:**
- Create: `apps/desktop/electron/main/application-shutdown-completion.test.ts`
- Create: `apps/desktop/electron/main/application-shutdown-completion.ts`

**Interfaces:**
- Produces `ApplicationShutdownCompletionOptions` with `packaged`, `shutdown`, `quit`, and optional `defer` dependencies.
- Produces `completeApplicationShutdown(options): Promise<void>`.
- Development schedules `quit` once after cleanup settles; packaged builds call it immediately.

- [ ] **Step 1: Write the failing tests**

Create `apps/desktop/electron/main/application-shutdown-completion.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import { completeApplicationShutdown } from './application-shutdown-completion.js'

describe('application shutdown completion', () => {
  it('defers the final development quit until the scheduled callback runs', async () => {
    const scheduled: Array<() => void> = []
    const quit = vi.fn()

    await completeApplicationShutdown({
      packaged: false,
      shutdown: async () => undefined,
      quit,
      defer: (callback) => { scheduled.push(callback) },
    })

    expect(quit).not.toHaveBeenCalled()
    expect(scheduled).toHaveLength(1)
    scheduled[0]!()
    expect(quit).toHaveBeenCalledTimes(1)
  })

  it('still defers one development quit when cleanup rejects', async () => {
    const failure = new Error('cleanup failed')
    const scheduled: Array<() => void> = []
    const quit = vi.fn()

    const completion = completeApplicationShutdown({
      packaged: false,
      shutdown: async () => { throw failure },
      quit,
      defer: (callback) => { scheduled.push(callback) },
    })

    await expect(completion).rejects.toBe(failure)
    expect(quit).not.toHaveBeenCalled()
    expect(scheduled).toHaveLength(1)
    scheduled[0]!()
    expect(quit).toHaveBeenCalledTimes(1)
  })

  it('preserves the immediate packaged final quit', async () => {
    const defer = vi.fn()
    const quit = vi.fn()

    await completeApplicationShutdown({
      packaged: true,
      shutdown: async () => undefined,
      quit,
      defer,
    })

    expect(defer).not.toHaveBeenCalled()
    expect(quit).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 2: Run the tests and verify RED**

Run:

```bash
node apps/desktop/scripts/run-vitest-electron.mjs run \
  apps/desktop/electron/main/application-shutdown-completion.test.ts
```

Expected: FAIL because `application-shutdown-completion.js` cannot be resolved.

- [ ] **Step 3: Add the minimal implementation**

Create `apps/desktop/electron/main/application-shutdown-completion.ts`:

```ts
export interface ApplicationShutdownCompletionOptions {
  packaged: boolean
  shutdown(): Promise<void>
  quit(): void
  defer?(callback: () => void): void
}

export async function completeApplicationShutdown({
  packaged,
  shutdown,
  quit,
  defer = (callback) => { setImmediate(callback) },
}: ApplicationShutdownCompletionOptions): Promise<void> {
  try {
    await shutdown()
  } finally {
    if (packaged) quit()
    else defer(quit)
  }
}
```

- [ ] **Step 4: Run the tests and verify GREEN**

Run:

```bash
node apps/desktop/scripts/run-vitest-electron.mjs run \
  apps/desktop/electron/main/application-shutdown-completion.test.ts
```

Expected: 1 file and 3 tests PASS with no warnings.

- [ ] **Step 5: Run targeted type and lint checks**

Run:

```bash
pnpm --filter @autoforge/desktop typecheck
pnpm exec eslint \
  apps/desktop/electron/main/application-shutdown-completion.ts \
  apps/desktop/electron/main/application-shutdown-completion.test.ts
```

Expected: both commands exit `0` with no task-file lint findings.

- [ ] **Step 6: Commit the tested seam**

```bash
git add \
  apps/desktop/electron/main/application-shutdown-completion.ts \
  apps/desktop/electron/main/application-shutdown-completion.test.ts
git commit -m "fix: defer Electron development quit completion"
```

---

### Task 2: Wire the Main lifecycle and verify the real process exit

**Files:**
- Modify: `apps/desktop/electron/main/index.ts:1-20,219-226`
- Consume: `apps/desktop/electron/main/application-shutdown-completion.ts`

**Interfaces:**
- Consumes `completeApplicationShutdown(options): Promise<void>` from Task 1.
- Keeps the existing `quitting` guard and development watchdog disposer unchanged.

- [ ] **Step 1: Confirm the pre-fix real regression is RED**

In a second terminal, create a probe directory and record the existing Electron
Main PID set:

```bash
dev_exit_probe_dir=$(mktemp -d)
pgrep -f 'Electron.app/Contents/MacOS/Electron \.$' | sort \
  > "$dev_exit_probe_dir/before.pids" || true
```

Start the actual development command in a PTY:

```bash
pnpm --filter @autoforge/desktop dev
```

After `starting electron app...`, return to the probe terminal, record the set
again, and derive the newly added PID:

```bash
pgrep -f 'Electron.app/Contents/MacOS/Electron \.$' | sort \
  > "$dev_exit_probe_dir/after.pids"
captured_electron_pid=$(comm -13 \
  "$dev_exit_probe_dir/before.pids" \
  "$dev_exit_probe_dir/after.pids" | tail -1)
test -n "$captured_electron_pid"
ps -o pid=,ppid=,pgid=,command= -p "$captured_electron_pid"
```

Send `Ctrl+C` through the PTY, wait five seconds, then check that exact PID:

```bash
kill -0 "$captured_electron_pid"
```

Expected before wiring: command exits without pnpm lifecycle errors, but the
captured Electron PID still exists and has been reparented to PID 1. If timing
makes this run green, repeat up to five times; the existing race was previously
observed in repeated process-group runs. Remove only the probe directory after
the final check:

```bash
rm -r "$dev_exit_probe_dir"
```

- [ ] **Step 2: Wire the tested helper into Electron Main**

Add this import in `apps/desktop/electron/main/index.ts` beside the other local
Main imports:

```ts
import { completeApplicationShutdown } from './application-shutdown-completion.js'
```

Replace only the current cleanup completion line:

```ts
void shutdown().finally(() => app.quit())
```

with:

```ts
void completeApplicationShutdown({
  packaged: app.isPackaged,
  shutdown,
  quit: () => app.quit(),
})
```

Do not change the first-event `preventDefault`, `quitting` guard, watchdog
disposal, or the repeated `before-quit` behavior.

- [ ] **Step 3: Run all focused shutdown tests**

Run:

```bash
node apps/desktop/scripts/run-vitest-electron.mjs run \
  apps/desktop/electron/main/application-shutdown-completion.test.ts \
  apps/desktop/electron/main/development-parent-watchdog.test.ts \
  apps/desktop/tests/integration/dev-supervisor.test.ts
```

Expected: 3 files and 17 tests PASS.

- [ ] **Step 4: Verify the real `Ctrl+C` regression five times**

For each run, execute the same PTY and PID-set procedure from Step 1, including
creating a fresh `dev_exit_probe_dir` and assigning `captured_electron_pid`. After
`Ctrl+C`, poll the captured Electron PID every 250 ms for at most five seconds:

```bash
for exit_check in {1..20}; do
  if ! kill -0 "$captured_electron_pid" 2>/dev/null; then
    echo ELECTRON_EXITED
    break
  fi
  sleep 0.25
done
```

For every run, verify:

```bash
ps -p "$captured_electron_pid"
lsof -nP -iTCP:5173 -sTCP:LISTEN
lsof -nP -iTCP:5174 -sTCP:LISTEN
```

Expected on all five runs: `ELECTRON_EXITED`; `ps` prints no captured process;
the port used by that run has no listener; terminal output contains neither
`ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL` nor `ELIFECYCLE`.

- [ ] **Step 5: Run repository verification**

Run:

```bash
pnpm test
pnpm typecheck
pnpm exec eslint \
  apps/desktop/electron/main/application-shutdown-completion.ts \
  apps/desktop/electron/main/application-shutdown-completion.test.ts \
  apps/desktop/electron/main/index.ts
pnpm build
rg -n '\[DEBUG-dev-exit-' apps/desktop || true
git diff --check
```

Expected: tests, type checking, targeted lint, build, and diff check exit `0`;
the debug-marker scan has no output. Existing nonfatal third-party build warnings
must be reported separately and must not be confused with task failures.

- [ ] **Step 6: Commit the lifecycle wiring**

```bash
git add apps/desktop/electron/main/index.ts
git commit -m "fix: complete deferred Electron development shutdown"
```

- [ ] **Step 7: Review the final branch diff**

Run:

```bash
git status --short
git diff --check c6cd8de..HEAD
git diff --stat c6cd8de..HEAD
git log --oneline c6cd8de..HEAD
```

Expected: worktree clean; diff check exits `0`; the diff contains only the
approved design, plan, shutdown helper, its tests, and Main lifecycle wiring.
