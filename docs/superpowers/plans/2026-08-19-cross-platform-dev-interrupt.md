# Cross-platform Development Interrupt Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make one `Ctrl+C` stop the complete AutoForge development process tree on macOS and Windows without pnpm lifecycle-failure output.

**Architecture:** A Node development supervisor owns the direct electron-vite child, absorbs duplicate interrupt delivery, forwards one shutdown request, and converts only intentional interruption to status `0`. A development-only Electron watchdog observes the electron-vite parent and enters the existing `app.quit()` cleanup path when that parent disappears.

**Tech Stack:** Node.js ESM, Electron 43, electron-vite 5, pnpm 11, TypeScript 6, Vitest 4.

## Global Constraints

- Support macOS and Windows without shell traps, process-group commands, `pkill`, or `taskkill`.
- Add no dependency and do not patch pnpm, electron-vite, or `node_modules`.
- Normalize only supervisor-initiated `SIGINT` or `SIGTERM`; preserve real failures.
- Use the existing Electron `app.quit()` and asynchronous `before-quit` cleanup.
- Disable parent monitoring in packaged builds.
- Do not change database, IPC, worker, network, window, or service contracts.

## File Map

- Create `apps/desktop/scripts/dev.mjs`: supervise the pinned electron-vite CLI.
- Create `apps/desktop/tests/integration/dev-supervisor.test.ts`: supervisor tests.
- Modify `apps/desktop/package.json`: route `dev` through the supervisor.
- Create `apps/desktop/electron/main/development-parent-watchdog.ts`: parent monitor.
- Create `apps/desktop/electron/main/development-parent-watchdog.test.ts`: monitor tests.
- Modify `apps/desktop/electron/main/index.ts`: install and dispose the monitor.

---

### Task 1: Supervise electron-vite

**Files:**
- Create: `apps/desktop/scripts/dev.mjs`
- Create: `apps/desktop/tests/integration/dev-supervisor.test.ts`
- Modify: `apps/desktop/package.json:7-10`

**Interfaces:**
- Produces `resolvePinnedElectronViteCli(): string`.
- Produces `runElectronViteDev(options?): Promise<number>`.
- Options inject `cli`, `executable`, `cwd`, `environment`, `platform`, `spawn`, and `signals`.

- [ ] **Step 1: Write the failing tests**

Create `apps/desktop/tests/integration/dev-supervisor.test.ts`:

```ts
import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'

interface SupervisorModule {
  resolvePinnedElectronViteCli(): string
  runElectronViteDev(options: Record<string, unknown>): Promise<number>
}

class FakeChild extends EventEmitter {
  kill = vi.fn(() => true)
}

async function loadSupervisor(): Promise<SupervisorModule> {
  return import('../../scripts/dev.mjs') as Promise<SupervisorModule>
}

function createHarness(platform: NodeJS.Platform = 'darwin') {
  const child = new FakeChild()
  const signals = new EventEmitter()
  const spawn = vi.fn(() => child)
  return {
    child,
    signals,
    spawn,
    options: {
      cli: '/workspace/electron-vite.js',
      executable: '/runtime/node',
      cwd: '/workspace/apps/desktop',
      environment: { EXISTING: 'preserved' },
      platform,
      spawn,
      signals,
    },
  }
}

describe('development supervisor', () => {
  it('resolves the pinned electron-vite CLI', async () => {
    const supervisor = await loadSupervisor()
    expect(supervisor.resolvePinnedElectronViteCli()).toMatch(
      /electron-vite.+bin[/\\]electron-vite\.js$/,
    )
  })

  it('forwards one interrupt and reports intentional shutdown as success', async () => {
    const supervisor = await loadSupervisor()
    const harness = createHarness()
    const status = supervisor.runElectronViteDev(harness.options)
    harness.signals.emit('SIGINT')
    harness.signals.emit('SIGINT')
    harness.child.emit('close', null, 'SIGINT')
    await expect(status).resolves.toBe(0)
    expect(harness.child.kill).toHaveBeenCalledTimes(1)
    expect(harness.child.kill).toHaveBeenCalledWith('SIGINT')
    expect(harness.signals.listenerCount('SIGINT')).toBe(0)
    expect(harness.signals.listenerCount('SIGTERM')).toBe(0)
  })

  it('uses supported termination semantics on Windows', async () => {
    const supervisor = await loadSupervisor()
    const harness = createHarness('win32')
    const status = supervisor.runElectronViteDev(harness.options)
    harness.signals.emit('SIGINT')
    harness.child.emit('close', 0, null)
    await expect(status).resolves.toBe(0)
    expect(harness.child.kill).toHaveBeenCalledWith('SIGTERM')
  })

  it('preserves spawn boundaries and a real nonzero exit', async () => {
    const supervisor = await loadSupervisor()
    const harness = createHarness()
    const status = supervisor.runElectronViteDev(harness.options)
    harness.child.emit('close', 7, null)
    await expect(status).resolves.toBe(7)
    expect(harness.spawn).toHaveBeenCalledWith(
      '/runtime/node',
      ['/workspace/electron-vite.js', 'dev'],
      {
        cwd: '/workspace/apps/desktop',
        env: { EXISTING: 'preserved' },
        stdio: 'inherit',
      },
    )
  })

  it('maps an unexpected signal to failure', async () => {
    const supervisor = await loadSupervisor()
    const harness = createHarness()
    const status = supervisor.runElectronViteDev(harness.options)
    harness.child.emit('close', null, 'SIGKILL')
    await expect(status).resolves.toBe(1)
  })

  it('rejects spawn failures', async () => {
    const supervisor = await loadSupervisor()
    const harness = createHarness()
    const failure = new Error('spawn failed')
    const status = supervisor.runElectronViteDev(harness.options)
    harness.child.emit('error', failure)
    await expect(status).rejects.toBe(failure)
  })
})
```

- [ ] **Step 2: Verify RED**

Run:

```bash
node apps/desktop/scripts/run-vitest-electron.mjs run apps/desktop/tests/integration/dev-supervisor.test.ts
```

Expected: FAIL in `loadSupervisor()` because `scripts/dev.mjs` is missing.

- [ ] **Step 3: Implement the supervisor**

Create `apps/desktop/scripts/dev.mjs`:

```js
import { spawn as spawnChild } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { pathToFileURL, URL } from 'node:url'

const desktopRequire = createRequire(new URL('../package.json', import.meta.url))

export function resolvePinnedElectronViteCli() {
  const packageDirectory = dirname(desktopRequire.resolve('electron-vite/package.json'))
  return join(packageDirectory, 'bin', 'electron-vite.js')
}

export async function runElectronViteDev({
  cli = resolvePinnedElectronViteCli(),
  executable = process.execPath,
  cwd = process.cwd(),
  environment = process.env,
  platform = process.platform,
  spawn = spawnChild,
  signals = process,
} = {}) {
  return new Promise((resolveStatus, reject) => {
    const child = spawn(executable, [cli, 'dev'], {
      cwd,
      env: environment,
      stdio: 'inherit',
    })
    let interrupted = false
    let settled = false
    const cleanup = () => {
      signals.removeListener('SIGINT', onSigint)
      signals.removeListener('SIGTERM', onSigterm)
    }
    const interrupt = (signal) => {
      if (interrupted || settled) return
      interrupted = true
      child.kill(platform === 'win32' ? 'SIGTERM' : signal)
    }
    const onSigint = () => { interrupt('SIGINT') }
    const onSigterm = () => { interrupt('SIGTERM') }
    signals.on('SIGINT', onSigint)
    signals.on('SIGTERM', onSigterm)
    child.once('error', (error) => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    })
    child.once('close', (code) => {
      if (settled) return
      settled = true
      cleanup()
      resolveStatus(interrupted ? 0 : (code ?? 1))
    })
  })
}

const entryPath = process.argv[1]
if (entryPath && import.meta.url === pathToFileURL(resolve(entryPath)).href) {
  try {
    process.exitCode = await runElectronViteDev()
  } catch (error) {
    console.error(error)
    process.exitCode = 1
  }
}
```

- [ ] **Step 4: Route the package lifecycle through it**

Change only `apps/desktop/package.json`:

```json
"dev": "node scripts/dev.mjs"
```

Keep `predev` unchanged so native Electron preparation still runs.

- [ ] **Step 5: Verify GREEN and boundaries**

```bash
node apps/desktop/scripts/run-vitest-electron.mjs run apps/desktop/tests/integration/dev-supervisor.test.ts
pnpm --filter @autoforge/desktop typecheck
pnpm lint -- apps/desktop/scripts/dev.mjs apps/desktop/tests/integration/dev-supervisor.test.ts
```

Expected: 6 tests PASS; type checking and lint exit `0`.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/package.json apps/desktop/scripts/dev.mjs apps/desktop/tests/integration/dev-supervisor.test.ts
git commit -m "fix: supervise desktop development shutdown"
```

---

### Task 2: Watch the Electron development parent

**Files:**
- Create: `apps/desktop/electron/main/development-parent-watchdog.ts`
- Create: `apps/desktop/electron/main/development-parent-watchdog.test.ts`
- Modify: `apps/desktop/electron/main/index.ts:1-25,182-215`

**Interfaces:**
- Produces `isProcessAlive(pid, sendSignal?): boolean`.
- Produces `startDevelopmentParentWatchdog(options): () => void`.
- The returned disposer is idempotent and is consumed by `before-quit`.

- [ ] **Step 1: Write failing watchdog tests**

Create `apps/desktop/electron/main/development-parent-watchdog.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'

interface WatchdogModule {
  isProcessAlive(pid: number, sendSignal?: (pid: number, signal: 0) => boolean): boolean
  startDevelopmentParentWatchdog(options: Record<string, unknown>): () => void
}

async function loadWatchdog(): Promise<WatchdogModule> {
  return import('./development-parent-watchdog.js') as Promise<WatchdogModule>
}

function createTimerHarness() {
  let callback: () => void = () => undefined
  const timer = { unref: vi.fn() }
  const schedule = vi.fn((next: () => void) => {
    callback = next
    return timer
  })
  const cancel = vi.fn()
  return { cancel, schedule, timer, tick: () => callback() }
}

describe('development parent watchdog', () => {
  it('treats ESRCH as missing and other errors as alive', async () => {
    const watchdog = await loadWatchdog()
    const missing = Object.assign(new Error('missing'), { code: 'ESRCH' })
    const denied = Object.assign(new Error('denied'), { code: 'EPERM' })
    expect(watchdog.isProcessAlive(42, () => { throw missing })).toBe(false)
    expect(watchdog.isProcessAlive(42, () => { throw denied })).toBe(true)
    expect(watchdog.isProcessAlive(42, () => true)).toBe(true)
  })

  it('does not schedule in a packaged app', async () => {
    const watchdog = await loadWatchdog()
    const harness = createTimerHarness()
    const quit = vi.fn()
    const dispose = watchdog.startDevelopmentParentWatchdog({
      packaged: true,
      parentPid: 42,
      quit,
      schedule: harness.schedule,
      cancel: harness.cancel,
    })
    dispose()
    expect(harness.schedule).not.toHaveBeenCalled()
    expect(harness.cancel).not.toHaveBeenCalled()
    expect(quit).not.toHaveBeenCalled()
  })

  it('quits once only after a development parent disappears', async () => {
    const watchdog = await loadWatchdog()
    const harness = createTimerHarness()
    const quit = vi.fn()
    watchdog.startDevelopmentParentWatchdog({
      packaged: false,
      parentPid: 42,
      quit,
      isParentAlive: () => false,
      schedule: harness.schedule,
      cancel: harness.cancel,
    })
    harness.tick()
    harness.tick()
    expect(quit).toHaveBeenCalledTimes(1)
    expect(harness.timer.unref).toHaveBeenCalledTimes(1)
  })

  it('does nothing while the parent is alive', async () => {
    const watchdog = await loadWatchdog()
    const harness = createTimerHarness()
    const quit = vi.fn()
    watchdog.startDevelopmentParentWatchdog({
      packaged: false,
      parentPid: 42,
      quit,
      isParentAlive: () => true,
      schedule: harness.schedule,
      cancel: harness.cancel,
    })
    harness.tick()
    expect(quit).not.toHaveBeenCalled()
  })

  it('does not quit after disposal or a probe exception', async () => {
    const watchdog = await loadWatchdog()
    const disposed = createTimerHarness()
    const failed = createTimerHarness()
    const quit = vi.fn()
    const dispose = watchdog.startDevelopmentParentWatchdog({
      packaged: false,
      parentPid: 42,
      quit,
      isParentAlive: () => false,
      schedule: disposed.schedule,
      cancel: disposed.cancel,
    })
    dispose()
    disposed.tick()
    watchdog.startDevelopmentParentWatchdog({
      packaged: false,
      parentPid: 42,
      quit,
      isParentAlive: () => { throw new Error('probe failed') },
      schedule: failed.schedule,
      cancel: failed.cancel,
    })
    failed.tick()
    expect(disposed.cancel).toHaveBeenCalledTimes(1)
    expect(quit).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Verify RED**

```bash
node apps/desktop/scripts/run-vitest-electron.mjs run apps/desktop/electron/main/development-parent-watchdog.test.ts
```

Expected: FAIL because the watchdog module is missing.

- [ ] **Step 3: Implement the watchdog**

Create `apps/desktop/electron/main/development-parent-watchdog.ts`:

```ts
export interface DevelopmentWatchdogTimer {
  unref?(): void
}

export interface DevelopmentParentWatchdogOptions {
  packaged: boolean
  parentPid: number
  quit(): void
  isParentAlive?(pid: number): boolean
  intervalMs?: number
  schedule?(callback: () => void, intervalMs: number): DevelopmentWatchdogTimer
  cancel?(timer: DevelopmentWatchdogTimer): void
}

export function isProcessAlive(
  pid: number,
  sendSignal: (pid: number, signal: 0) => boolean = process.kill,
): boolean {
  try {
    sendSignal(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

export function startDevelopmentParentWatchdog({
  packaged,
  parentPid,
  quit,
  isParentAlive = isProcessAlive,
  intervalMs = 250,
  schedule = (callback, milliseconds) => setInterval(callback, milliseconds),
  cancel = (timer) => clearInterval(timer as NodeJS.Timeout),
}: DevelopmentParentWatchdogOptions): () => void {
  if (packaged) return () => undefined
  let disposed = false
  let quitRequested = false
  const checkParent = () => {
    if (disposed || quitRequested) return
    try {
      if (isParentAlive(parentPid)) return
    } catch {
      return
    }
    quitRequested = true
    quit()
  }
  const timer = schedule(checkParent, intervalMs)
  timer.unref?.()
  return () => {
    if (disposed) return
    disposed = true
    cancel(timer)
  }
}
```

- [ ] **Step 4: Verify GREEN**

```bash
node apps/desktop/scripts/run-vitest-electron.mjs run apps/desktop/electron/main/development-parent-watchdog.test.ts
```

Expected: 5 tests PASS.

- [ ] **Step 5: Integrate with Electron Main**

In `apps/desktop/electron/main/index.ts`, add:

```ts
import {
  isProcessAlive,
  startDevelopmentParentWatchdog,
} from './development-parent-watchdog.js'
```

Add lifecycle state:

```ts
let disposeDevelopmentParentWatchdog: (() => void) | undefined
```

At the start of the single-instance `else` branch:

```ts
disposeDevelopmentParentWatchdog = startDevelopmentParentWatchdog({
  packaged: app.isPackaged,
  parentPid: process.ppid,
  isParentAlive: isProcessAlive,
  quit: () => app.quit(),
})
```

Update the existing `before-quit` first-entry path:

```ts
app.on('before-quit', (event: Event) => {
  if (quitting) return
  event.preventDefault()
  quitting = true
  disposeDevelopmentParentWatchdog?.()
  disposeDevelopmentParentWatchdog = undefined
  void shutdown().finally(() => app.quit())
})
```

- [ ] **Step 6: Verify focused behavior and boundaries**

```bash
node apps/desktop/scripts/run-vitest-electron.mjs run \
  apps/desktop/electron/main/development-parent-watchdog.test.ts \
  apps/desktop/electron/main/startup.test.ts
pnpm --filter @autoforge/desktop typecheck
pnpm lint -- \
  apps/desktop/electron/main/development-parent-watchdog.ts \
  apps/desktop/electron/main/development-parent-watchdog.test.ts \
  apps/desktop/electron/main/index.ts
```

Expected: focused tests PASS; type checking and lint exit `0`.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/electron/main/development-parent-watchdog.ts \
  apps/desktop/electron/main/development-parent-watchdog.test.ts \
  apps/desktop/electron/main/index.ts
git commit -m "fix: quit desktop when dev host exits"
```

---

### Task 3: Verify the original boundary and full regression safety

**Files:**
- Verification only; no source changes.

**Interfaces:**
- Consumes the supervisor and watchdog from Tasks 1 and 2.
- Produces evidence for clean output, process removal, port release, and existing tests.

- [ ] **Step 1: Run focused tests together**

```bash
node apps/desktop/scripts/run-vitest-electron.mjs run \
  apps/desktop/tests/integration/dev-supervisor.test.ts \
  apps/desktop/electron/main/development-parent-watchdog.test.ts
```

Expected: 11 tests PASS.

- [ ] **Step 2: Run the real root command and interrupt once**

```bash
expect -c '
  log_user 1
  set timeout 60
  spawn pnpm dev
  expect {
    "starting electron app..." {}
    timeout { puts "DEV_START_TIMEOUT"; exit 124 }
    eof { puts "DEV_EARLY_EXIT"; exit 125 }
  }
  after 500
  send "\003"
  expect eof
  puts "DEV_INTERRUPT_WAIT [wait]"
'
```

Expected: startup succeeds, one `^C` appears, wait status is `0`, and output
contains neither `ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL` nor `ELIFECYCLE`.

- [ ] **Step 3: Check processes and ports**

```bash
ps -axo pid,ppid,pgid,tty,state,command | \
  rg '/auto-forge/.*/electron-vite.js dev|electron/dist/Electron.app/Contents/MacOS/Electron \.$' | \
  rg -v 'rg ' || true
lsof -nP -iTCP:5173 -sTCP:LISTEN || true
lsof -nP -iTCP:5174 -sTCP:LISTEN || true
```

Expected: no output. On Windows, use the equivalent PowerShell process and
port checks when that environment is available; automated tests cover Windows
signal selection and the packaged guard.

- [ ] **Step 4: Run complete verification**

```bash
pnpm test
pnpm typecheck
pnpm lint
pnpm build
```

Expected: every command exits `0`. Report unrelated pre-existing failures
separately without changing unrelated code.

- [ ] **Step 5: Check the final diff**

```bash
git status --short
git diff --check HEAD~2..HEAD
git diff --stat HEAD~2..HEAD
```

Expected: no uncommitted files; only the six files in the File Map changed;
`git diff --check` prints nothing.
