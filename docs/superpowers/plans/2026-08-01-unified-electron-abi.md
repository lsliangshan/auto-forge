# Unified Electron ABI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the workspace's only usable `better-sqlite3` native artifact on Electron 43 ABI 148, run native-consuming tests through Electron Node mode, and stop rebuilding the module on every development start.

**Architecture:** A conditional preparation script uses the installed Electron executable to open and query an in-memory `better-sqlite3` database; it rebuilds once only when that real probe fails, then probes again. A separate launcher runs the pinned Vitest CLI with `ELECTRON_RUN_AS_NODE=1`, allowing tests and the desktop Main process to share the same Electron ABI artifact while ordinary Node continues to run non-native tooling.

**Tech Stack:** Node.js 24.18.0 ESM scripts, Electron 43.1.1 / ABI 148, `@electron/rebuild` 4.2.0, `better-sqlite3` 12.11.1, Vitest 4.1.10, pnpm 11.15.0.

## Global Constraints

- Keep exactly one usable `better-sqlite3` native artifact, built for the installed Electron 43.1.1 runtime and ABI 148.
- Ordinary Node processes must not instantiate `better-sqlite3`; pnpm, Vite, TypeScript, ESLint, and build scripts remain ordinary Node tooling.
- Do not replace `better-sqlite3`, introduce a database sidecar, or change database and IPC behavior.
- Do not add a persistent ABI marker or cache; a real in-memory SQLite query under Electron is the compatibility source of truth.
- Resolve Electron, Vitest, and `better-sqlite3` from `apps/desktop/package.json`; never use global package binaries.
- Preserve current Vitest configs, test selection, working directories, CLI arguments, standard streams, and exit statuses.
- Preserve the existing workspace-boundary rejection before rebuilding a resolved native package.
- The first native-consuming command after installation may rebuild once; compatible repeated test, development, and packaging commands must not compile again.
- Touch only native preparation, test launching, lifecycle scripts, their focused tests, and the obsolete Node ABI preparation file.

## File Map

- Modify `apps/desktop/scripts/prepare-native-electron.mjs`: probe the real Electron binding, conditionally rebuild, re-probe, and export focused functions for tests.
- Create `apps/desktop/tests/integration/prepare-native-electron.test.ts`: cover probe construction, skip, rebuild, and failure behavior.
- Create `apps/desktop/scripts/run-vitest-electron.mjs`: resolve pinned runtimes and forward Vitest through Electron Node mode.
- Create `apps/desktop/tests/integration/run-vitest-electron.test.ts`: cover resolution inputs, argument/environment forwarding, and child failures.
- Modify `package.json`: prepare Electron ABI before root tests and launch repository Vitest through Electron.
- Modify `apps/desktop/package.json`: share conditional preparation across development, direct tests, and packaging; run both desktop Vitest configs through Electron.
- Modify `tests/workspace.test.ts`: lock the new lifecycle topology and absence of the Node ABI preparation script.
- Delete `apps/desktop/scripts/prepare-native-node.mjs`: remove the last path that rebuilds `better-sqlite3` for ordinary Node.

---

### Task 1: Conditional Electron Native Preparation

**Files:**
- Modify: `apps/desktop/scripts/prepare-native-electron.mjs`
- Create: `apps/desktop/tests/integration/prepare-native-electron.test.ts`

**Interfaces:**
- Consumes: pinned `electron/package.json`, resolved `electron` executable, resolved `better-sqlite3/package.json`, and `rebuild(options)` from `@electron/rebuild`.
- Produces: `nativeProbeSource: string`, `runNativeProbe(options): SpawnSyncReturns<string>`, and `prepareNativeElectron(options?): Promise<{ rebuilt: boolean }>`.
- `prepareNativeElectron` accepts optional test dependencies `{ probe, rebuildNative, write }`; production calls it with no arguments.

- [ ] **Step 1: Write a failing import-safety contract without importing the current side-effectful script**

The current script rebuilds at module top level, so the first red test must inspect its source rather than import it. Create `apps/desktop/tests/integration/prepare-native-electron.test.ts`:

```ts
import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

const sourceUrl = new URL('../../scripts/prepare-native-electron.mjs', import.meta.url)

describe('prepare-native-electron', () => {
  it('exports an import-safe preparation entry point', async () => {
    const source = await readFile(sourceUrl, 'utf8')

    expect(source).toContain('export async function prepareNativeElectron')
    expect(source).toContain("import.meta.url === pathToFileURL(resolve(entryPath)).href")
  })
})
```

- [ ] **Step 2: Run the import-safety contract and confirm it fails without rebuilding**

Run from `apps/desktop`:

```bash
pnpm exec vitest run --config vitest.node.config.ts tests/integration/prepare-native-electron.test.ts
```

Expected: FAIL on the missing exported function and entry guard. Because the test only reads source text, it must not print `Building modules: better-sqlite3` or change the installed binding.

- [ ] **Step 3: Add the minimal import-safe seam without changing unconditional behavior yet**

Retain the current resolution and workspace-boundary code, move the existing rebuild call into an exported function, and add the established ESM entry guard:

```js
import { realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL, URL } from 'node:url'
import { rebuild } from '@electron/rebuild'

const desktopDirectory = realpathSync(fileURLToPath(new URL('..', import.meta.url)))
const workspaceDirectory = realpathSync(fileURLToPath(new URL('../../..', import.meta.url)))
const desktopRequire = createRequire(new URL('../package.json', import.meta.url))
const electronVersion = desktopRequire('electron/package.json').version
const databasePackage = realpathSync(desktopRequire.resolve('better-sqlite3/package.json'))
const databaseRelativePath = relative(workspaceDirectory, databasePackage)

if (
  databaseRelativePath === '..'
  || databaseRelativePath.startsWith(`..${sep}`)
  || isAbsolute(databaseRelativePath)
) {
  throw new Error(`Refusing to rebuild better-sqlite3 outside this workspace: ${databasePackage}`)
}

export async function prepareNativeElectron({
  rebuildNative = rebuild,
  write = (message) => process.stdout.write(message),
} = {}) {
  write(`Rebuilding better-sqlite3 for Electron ${electronVersion} in ${workspaceDirectory}\n`)
  await rebuildNative({
    buildPath: desktopDirectory,
    projectRootPath: workspaceDirectory,
    electronVersion,
    arch: process.arch,
    platform: process.platform,
    onlyModules: ['better-sqlite3'],
    force: true,
    types: ['prod'],
  })
  return { rebuilt: true }
}

const entryPath = process.argv[1]
if (entryPath && import.meta.url === pathToFileURL(resolve(entryPath)).href) {
  await prepareNativeElectron()
}
```

- [ ] **Step 4: Run the import-safety contract and confirm it passes without rebuilding**

Run:

```bash
pnpm exec vitest run --config vitest.node.config.ts tests/integration/prepare-native-electron.test.ts
```

Expected: PASS with no `Building modules: better-sqlite3` output.

- [ ] **Step 5: Replace the source-only contract with failing behavioral tests**

Replace the test file with the real imported contract now that importing is side-effect free:

```ts
import { describe, expect, it, vi } from 'vitest'
// @ts-expect-error The native preparation entry point is a plain Node ESM script.
import {
  nativeProbeSource,
  prepareNativeElectron,
  runNativeProbe,
} from '../../scripts/prepare-native-electron.mjs'

describe('prepare-native-electron', () => {
  it('probes by opening and querying an in-memory database', () => {
    expect(nativeProbeSource).toContain("new Database(':memory:')")
    expect(nativeProbeSource).toContain('SELECT 1 AS value')
    expect(nativeProbeSource).toContain('database.close()')
  })

  it('runs the probe with Electron Node mode and the resolved database directory', () => {
    const spawn = vi.fn(() => ({ status: 0 }))

    runNativeProbe({
      electronExecutable: '/runtime/Electron',
      databaseDirectory: '/workspace/node_modules/better-sqlite3',
      environment: { EXISTING: 'preserved' },
      spawn,
    })

    expect(spawn).toHaveBeenCalledWith(
      '/runtime/Electron',
      ['-e', nativeProbeSource, '/workspace/node_modules/better-sqlite3'],
      expect.objectContaining({
        encoding: 'utf8',
        env: { EXISTING: 'preserved', ELECTRON_RUN_AS_NODE: '1' },
      }),
    )
  })

  it('skips rebuilding when the Electron probe succeeds', async () => {
    const probe = vi.fn(() => ({ status: 0 }))
    const rebuildNative = vi.fn()
    const write = vi.fn()

    await expect(prepareNativeElectron({ probe, rebuildNative, write }))
      .resolves.toEqual({ rebuilt: false })
    expect(probe).toHaveBeenCalledTimes(1)
    expect(rebuildNative).not.toHaveBeenCalled()
    expect(write).toHaveBeenCalledWith(expect.stringContaining('already compatible'))
  })

  it('rebuilds once after a failed probe and verifies the result', async () => {
    const probe = vi.fn()
      .mockReturnValueOnce({ status: 1, stderr: 'ABI mismatch' })
      .mockReturnValueOnce({ status: 0 })
    const rebuildNative = vi.fn(async () => undefined)

    await expect(prepareNativeElectron({ probe, rebuildNative, write: vi.fn() }))
      .resolves.toEqual({ rebuilt: true })
    expect(probe).toHaveBeenCalledTimes(2)
    expect(rebuildNative).toHaveBeenCalledTimes(1)
    expect(rebuildNative).toHaveBeenCalledWith(expect.objectContaining({
      onlyModules: ['better-sqlite3'],
      force: true,
      types: ['prod'],
    }))
  })

  it('propagates rebuild failures without running a second probe', async () => {
    const failure = new Error('rebuild failed')
    const probe = vi.fn(() => ({ status: 1 }))
    const rebuildNative = vi.fn(async () => { throw failure })

    await expect(prepareNativeElectron({ probe, rebuildNative, write: vi.fn() }))
      .rejects.toBe(failure)
    expect(probe).toHaveBeenCalledTimes(1)
  })

  it('fails when the rebuilt artifact still cannot run under Electron', async () => {
    const probe = vi.fn()
      .mockReturnValueOnce({ status: 1 })
      .mockReturnValueOnce({ status: 1, stderr: 'still incompatible' })

    await expect(prepareNativeElectron({
      probe,
      rebuildNative: vi.fn(async () => undefined),
      write: vi.fn(),
    })).rejects.toThrow('still incompatible')
    expect(probe).toHaveBeenCalledTimes(2)
  })

  it('does not rebuild when Electron itself cannot be spawned', async () => {
    const failure = new Error('spawn failed')
    const probe = vi.fn(() => ({ error: failure, status: null }))
    const rebuildNative = vi.fn()

    await expect(prepareNativeElectron({ probe, rebuildNative, write: vi.fn() }))
      .rejects.toBe(failure)
    expect(rebuildNative).not.toHaveBeenCalled()
  })
})
```

Run:

```bash
pnpm exec vitest run --config vitest.node.config.ts tests/integration/prepare-native-electron.test.ts
```

Expected: FAIL because `nativeProbeSource` and `runNativeProbe` do not exist and compatible bindings are still rebuilt unconditionally.

- [ ] **Step 6: Implement the probe and conditional preparation**

Replace the import-safe seam with this final implementation while retaining the realpath workspace check:

```js
import { spawnSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL, URL } from 'node:url'
import { rebuild } from '@electron/rebuild'

const desktopDirectory = realpathSync(fileURLToPath(new URL('..', import.meta.url)))
const workspaceDirectory = realpathSync(fileURLToPath(new URL('../../..', import.meta.url)))
const desktopRequire = createRequire(new URL('../package.json', import.meta.url))
const electronVersion = desktopRequire('electron/package.json').version
const electronExecutable = desktopRequire('electron')
const databasePackage = realpathSync(desktopRequire.resolve('better-sqlite3/package.json'))
const databaseDirectory = dirname(databasePackage)
const databaseRelativePath = relative(workspaceDirectory, databasePackage)

if (
  databaseRelativePath === '..'
  || databaseRelativePath.startsWith(`..${sep}`)
  || isAbsolute(databaseRelativePath)
) {
  throw new Error(`Refusing to rebuild better-sqlite3 outside this workspace: ${databasePackage}`)
}

export const nativeProbeSource = [
  'const Database = require(process.argv[1])',
  "const database = new Database(':memory:')",
  "const row = database.prepare('SELECT 1 AS value').get()",
  'database.close()',
  "if (row?.value !== 1) throw new Error('Unexpected SQLite probe result')",
].join(';')

export function runNativeProbe({
  electronExecutable: executable = electronExecutable,
  databaseDirectory: directory = databaseDirectory,
  environment = process.env,
  spawn = spawnSync,
} = {}) {
  return spawn(executable, ['-e', nativeProbeSource, directory], {
    encoding: 'utf8',
    env: { ...environment, ELECTRON_RUN_AS_NODE: '1' },
  })
}

function probeError(result) {
  if (result.error) return result.error
  const detail = result.stderr?.trim()
  return new Error(
    `Electron ${electronVersion} could not load better-sqlite3 after rebuilding${detail ? `: ${detail}` : ''}`,
  )
}

export async function prepareNativeElectron({
  probe = runNativeProbe,
  rebuildNative = rebuild,
  write = (message) => process.stdout.write(message),
} = {}) {
  const initial = probe()
  if (initial.error) throw initial.error
  if (initial.status === 0) {
    write(`better-sqlite3 is already compatible with Electron ${electronVersion}\n`)
    return { rebuilt: false }
  }

  write(`Rebuilding better-sqlite3 for Electron ${electronVersion} in ${workspaceDirectory}\n`)
  await rebuildNative({
    buildPath: desktopDirectory,
    projectRootPath: workspaceDirectory,
    electronVersion,
    arch: process.arch,
    platform: process.platform,
    onlyModules: ['better-sqlite3'],
    force: true,
    types: ['prod'],
  })

  const verified = probe()
  if (verified.error || verified.status !== 0) throw probeError(verified)
  write(`better-sqlite3 is compatible with Electron ${electronVersion}\n`)
  return { rebuilt: true }
}

const entryPath = process.argv[1]
if (entryPath && import.meta.url === pathToFileURL(resolve(entryPath)).href) {
  await prepareNativeElectron()
}
```

Do not print the expected initial ABI error stack: it is the signal to rebuild. Preserve the second probe's stderr in the final thrown diagnostic.

- [ ] **Step 7: Run all preparation tests**

Run:

```bash
pnpm exec vitest run --config vitest.node.config.ts tests/integration/prepare-native-electron.test.ts
```

Expected: all preparation tests PASS; the tests use injected probes and do not rebuild the real workspace binding.

- [ ] **Step 8: Commit the conditional preparation unit**

```bash
git add apps/desktop/scripts/prepare-native-electron.mjs apps/desktop/tests/integration/prepare-native-electron.test.ts
git commit -m "fix: prepare Electron native ABI conditionally"
```

---

### Task 2: Electron Node Mode Vitest Launcher

**Files:**
- Create: `apps/desktop/scripts/run-vitest-electron.mjs`
- Create: `apps/desktop/tests/integration/run-vitest-electron.test.ts`

**Interfaces:**
- Consumes: the pinned Electron executable and the `vitest.mjs` adjacent to pinned `vitest/package.json`.
- Produces: `resolvePinnedTestRuntime(): { electronExecutable: string; vitestCli: string; vitestPackageDirectory: string }` and `runVitestInElectron(args, options?): number`.
- Later package scripts call `node apps/desktop/scripts/run-vitest-electron.mjs run ...` from the root or `node scripts/run-vitest-electron.mjs run ...` from the desktop package.

- [ ] **Step 1: Write failing launcher contract tests**

Create `apps/desktop/tests/integration/run-vitest-electron.test.ts`:

```ts
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
// @ts-expect-error The Electron Vitest launcher is a plain Node ESM script.
import {
  resolvePinnedTestRuntime,
  runVitestInElectron,
} from '../../scripts/run-vitest-electron.mjs'

describe('run-vitest-electron', () => {
  it('resolves the workspace-pinned Electron executable and Vitest CLI', () => {
    const runtime = resolvePinnedTestRuntime()

    expect(runtime.electronExecutable).toContain('electron')
    expect(runtime.vitestCli).toBe(join(
      runtime.vitestPackageDirectory,
      'vitest.mjs',
    ))
  })

  it('forwards arguments, cwd, environment, and Electron Node mode', () => {
    const spawn = vi.fn(() => ({ status: 7 }))
    const status = runVitestInElectron(['run', 'tests/workspace.test.ts'], {
      runtime: {
        electronExecutable: '/runtime/Electron',
        vitestCli: '/workspace/vitest.mjs',
        vitestPackageDirectory: '/workspace',
      },
      cwd: '/workspace',
      environment: { EXISTING: 'preserved' },
      spawn,
    })

    expect(spawn).toHaveBeenCalledWith(
      '/runtime/Electron',
      ['/workspace/vitest.mjs', 'run', 'tests/workspace.test.ts'],
      {
        cwd: '/workspace',
        env: { EXISTING: 'preserved', ELECTRON_RUN_AS_NODE: '1' },
        stdio: 'inherit',
      },
    )
    expect(status).toBe(7)
  })

  it('throws spawn failures', () => {
    const failure = new Error('spawn failed')

    expect(() => runVitestInElectron([], {
      runtime: {
        electronExecutable: 'Electron',
        vitestCli: 'vitest.mjs',
        vitestPackageDirectory: '.',
      },
      spawn: () => ({ error: failure, status: null }),
    })).toThrow(failure)
  })

  it('returns failure when a child exits without a status', () => {
    expect(runVitestInElectron([], {
      runtime: {
        electronExecutable: 'Electron',
        vitestCli: 'vitest.mjs',
        vitestPackageDirectory: '.',
      },
      spawn: () => ({ status: null }),
    })).toBe(1)
  })
})
```

Include `vitestPackageDirectory` in the real resolver's returned object so the first test can prove `vitest.mjs` comes from the pinned package directory rather than a global executable.

- [ ] **Step 2: Run the launcher tests and confirm they fail**

Run from `apps/desktop`:

```bash
pnpm exec vitest run --config vitest.node.config.ts tests/integration/run-vitest-electron.test.ts
```

Expected: FAIL because `run-vitest-electron.mjs` does not exist.

- [ ] **Step 3: Implement the minimal launcher**

Create `apps/desktop/scripts/run-vitest-electron.mjs`:

```js
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { pathToFileURL, URL } from 'node:url'

const desktopRequire = createRequire(new URL('../package.json', import.meta.url))

export function resolvePinnedTestRuntime() {
  const vitestPackageDirectory = dirname(desktopRequire.resolve('vitest/package.json'))
  return {
    electronExecutable: desktopRequire('electron'),
    vitestCli: join(vitestPackageDirectory, 'vitest.mjs'),
    vitestPackageDirectory,
  }
}

export function runVitestInElectron(args, {
  runtime = resolvePinnedTestRuntime(),
  cwd = process.cwd(),
  environment = process.env,
  spawn = spawnSync,
} = {}) {
  const result = spawn(
    runtime.electronExecutable,
    [runtime.vitestCli, ...args],
    {
      cwd,
      env: { ...environment, ELECTRON_RUN_AS_NODE: '1' },
      stdio: 'inherit',
    },
  )
  if (result.error) throw result.error
  return result.status ?? 1
}

const entryPath = process.argv[1]
if (entryPath && import.meta.url === pathToFileURL(resolve(entryPath)).href) {
  process.exitCode = runVitestInElectron(process.argv.slice(2))
}
```

- [ ] **Step 4: Run launcher tests and a real focused Electron Vitest process**

Run:

```bash
pnpm exec vitest run --config vitest.node.config.ts tests/integration/run-vitest-electron.test.ts
node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts electron/main/database/database.test.ts
```

Expected: launcher unit tests PASS; the real launcher reports `68 passed` for `database.test.ts` while loading `better-sqlite3` under Electron.

- [ ] **Step 5: Commit the launcher unit**

```bash
git add apps/desktop/scripts/run-vitest-electron.mjs apps/desktop/tests/integration/run-vitest-electron.test.ts
git commit -m "test: run Vitest with Electron ABI"
```

---

### Task 3: Wire One ABI Through Test, Development, and Packaging Lifecycles

**Files:**
- Modify: `package.json`
- Modify: `apps/desktop/package.json`
- Modify: `tests/workspace.test.ts`
- Delete: `apps/desktop/scripts/prepare-native-node.mjs`

**Interfaces:**
- Consumes: `prepareNativeElectron()` and `runVitestInElectron()` entry points from Tasks 1 and 2.
- Produces: one package-script graph in which root and desktop tests prepare and execute the Electron ABI, development uses the conditional preparer, packaging retains the same preparer, and nothing rebuilds for ordinary Node.

- [ ] **Step 1: Change the workspace contract test first**

Update `tests/workspace.test.ts` to assert the exact script graph and deleted Node preparer:

```ts
import { access, readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('workspace', () => {
  it('declares every production package and the required verification scripts', async () => {
    const root = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
    const desktop = JSON.parse(await readFile(new URL('../apps/desktop/package.json', import.meta.url), 'utf8'))
    expect(root.packageManager).toBe('pnpm@11.15.0')
    expect(root.scripts).toMatchObject({
      lint: 'eslint .',
      pretest: 'pnpm --filter @autoforge/desktop prepare:native-electron',
      typecheck: 'pnpm -r --if-present typecheck',
      test: 'node apps/desktop/scripts/run-vitest-electron.mjs run',
      build: 'pnpm -r --filter "./packages/**" build && pnpm --filter @autoforge/desktop build',
    })
    expect(desktop.scripts).toMatchObject({
      predev: 'pnpm prepare:native-electron',
      pretest: 'pnpm prepare:native-electron',
      test: 'node scripts/run-vitest-electron.mjs run --config vitest.config.ts && node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts',
      'prepare:native-electron': 'install-electron && node scripts/prepare-native-electron.mjs',
    })
    await expect(access(new URL(
      '../apps/desktop/scripts/prepare-native-node.mjs',
      import.meta.url,
    ))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
```

- [ ] **Step 2: Run the contract test through the new launcher and confirm it fails**

Run from the repository root:

```bash
node apps/desktop/scripts/run-vitest-electron.mjs run tests/workspace.test.ts
```

Expected: FAIL because package scripts still reference the old Node ABI preparer and unconditional Electron rebuild, and `prepare-native-node.mjs` still exists.

- [ ] **Step 3: Replace root test lifecycle scripts**

Change only these fields in root `package.json`:

```json
{
  "scripts": {
    "pretest": "pnpm --filter @autoforge/desktop prepare:native-electron",
    "test": "node apps/desktop/scripts/run-vitest-electron.mjs run"
  }
}
```

Keep every other root script unchanged.

- [ ] **Step 4: Replace desktop lifecycle scripts**

Change the desktop script entries to:

```json
{
  "scripts": {
    "predev": "pnpm prepare:native-electron",
    "dev": "electron-vite dev",
    "pretest": "pnpm prepare:native-electron",
    "test": "node scripts/run-vitest-electron.mjs run --config vitest.config.ts && node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts",
    "prepare:native-electron": "install-electron && node scripts/prepare-native-electron.mjs"
  }
}
```

Keep `build`, `typecheck`, `stage:browser`, `verify:packaged-native`, and `dist:dir` unchanged. `dist:dir` already calls `pnpm prepare:native-electron`, so it automatically receives the shared initialization, conditional probe, and verification behavior.

- [ ] **Step 5: Delete the ordinary Node ABI preparation path**

Delete only:

```text
apps/desktop/scripts/prepare-native-node.mjs
```

Then confirm no executable package configuration or script refers to it:

```bash
rg -n "prepare-native-node|electron-rebuild -f -w better-sqlite3" \
  package.json apps/desktop/package.json apps/desktop/scripts
```

Expected: no matches. Historical design and plan documents may retain the old command as context and must not be edited.

- [ ] **Step 6: Run the workspace contract through Electron**

Run:

```bash
node apps/desktop/scripts/run-vitest-electron.mjs run tests/workspace.test.ts
```

Expected: PASS.

- [ ] **Step 7: Exercise both public test entry points**

Run:

```bash
npm test -- tests/workspace.test.ts
pnpm --filter @autoforge/desktop test -- tests/integration/prepare-native-electron.test.ts tests/integration/run-vitest-electron.test.ts
```

Expected: both commands first report that `better-sqlite3` is already compatible with Electron 43.1.1, do not print `Building modules: better-sqlite3`, run Vitest under Electron, and PASS.

- [ ] **Step 8: Commit lifecycle unification**

```bash
git add package.json apps/desktop/package.json tests/workspace.test.ts apps/desktop/scripts/prepare-native-node.mjs
git commit -m "fix: unify better-sqlite3 on Electron ABI"
```

---

### Task 4: Full Verification at Test, Development, and Packaged Boundaries

**Files:**
- Verify only; no planned source changes.

**Interfaces:**
- Consumes: the unified lifecycle from Tasks 1-3.
- Produces: evidence that full tests and the real desktop app use Electron ABI 148 without repeated compilation.

- [ ] **Step 1: Run focused native-runtime and workspace tests together**

Run from the repository root:

```bash
node apps/desktop/scripts/run-vitest-electron.mjs run \
  tests/workspace.test.ts \
  apps/desktop/tests/integration/prepare-native-electron.test.ts \
  apps/desktop/tests/integration/run-vitest-electron.test.ts
```

Expected: all focused tests PASS.

- [ ] **Step 2: Run full repository and desktop test suites**

Run:

```bash
npm test
pnpm --filter @autoforge/desktop test
```

Expected: both suites PASS under the Electron launcher. Native database tests must not report an ABI 137/148 mismatch, and the second command must skip rebuilding.

- [ ] **Step 3: Verify the actual native runtime reports Electron ABI 148**

Run:

```bash
electron_bin=$(pnpm --filter @autoforge/desktop exec node -p "require('electron')")
database_dir=$(pnpm --filter @autoforge/desktop exec node -e "const path=require('node:path'); process.stdout.write(path.dirname(require.resolve('better-sqlite3/package.json')))")
ELECTRON_RUN_AS_NODE=1 "$electron_bin" -e "const Database=require(process.argv[1]); const database=new Database(':memory:'); const row=database.prepare('SELECT 1 AS value').get(); database.close(); console.log(JSON.stringify({electron:process.versions.electron,modules:process.versions.modules,value:row.value}))" "$database_dir"
```

Expected exact data values: `electron` is `43.1.1`, `modules` is `148`, and `value` is `1`.

- [ ] **Step 4: Run static and production-build verification**

Run:

```bash
npm run typecheck
npm run lint
npm run build
```

Expected: every command exits 0. Existing lint warnings are acceptable only if lint still exits 0; new errors or warnings in changed files must be fixed.

- [ ] **Step 5: Establish a clean development-start baseline**

Before starting, check for a retained listener or AutoForge process:

```bash
lsof -nP -iTCP:5173 -sTCP:LISTEN
pgrep -fl "auto-forge|electron-vite|Electron" || true
```

If a process is clearly from this checkout, stop only that verified PID and re-run both commands. Do not kill unrelated Electron applications or broad process-name matches.

- [ ] **Step 6: Start the real desktop app after the full test suite**

Run `npm run dev` in a managed PTY and keep its session open:

```bash
npm run dev
```

Expected terminal evidence:

- preparation prints `better-sqlite3 is already compatible with Electron 43.1.1`;
- no `Building modules: better-sqlite3` appears;
- electron-vite builds Main, Preload, and Renderer and reaches `starting electron app...`;
- no `AutoForge could not start safely.`, native ABI exception, or Preload load exception appears.

- [ ] **Step 7: Verify the running Main process, Renderer listener, database, and window**

While the managed PTY remains active, run in a second terminal:

```bash
lsof -nP -iTCP:5173 -sTCP:LISTEN
pgrep -fl "/auto-forge/.*Electron|electron-vite"
```

Identify the repository Electron Main PID from its full command line, then verify that exact PID has the real database open:

```bash
electron_bin=$(pnpm --filter @autoforge/desktop exec node -p "require('electron')")
electron_main_pid=$(ps ax -o pid= -o command= | awk -v executable="$electron_bin" '$2 == executable { print $1; exit }')
test -n "$electron_main_pid"
ps -p "$electron_main_pid" -o pid=,command=
lsof -p "$electron_main_pid" | rg "autoforge\.sqlite"
```

Verify a visible development window on macOS:

```bash
osascript -e 'tell application "System Events" to tell process "Electron" to count windows'
```

Expected: port 5173 has a listener, the verified Electron process belongs to this checkout, `autoforge.sqlite` is open, and the window count is at least 1. If macOS Accessibility permission blocks only the window query, report that single validation as partial rather than treating process or port evidence as a visible window.

- [ ] **Step 8: Stop cleanly and repeat development startup**

Send Ctrl-C to the managed `npm run dev` PTY, wait for it to exit, and verify port 5173 is released:

```bash
lsof -nP -iTCP:5173 -sTCP:LISTEN
```

Start `npm run dev` once more. Expected: the second start again skips `Building modules: better-sqlite3` and reaches a working Electron Main process, SQLite database, Renderer listener, and visible window. Stop it cleanly with Ctrl-C after verification.

- [ ] **Step 9: Verify the packaged native boundary**

Run:

```bash
npm run dist:dir
```

Expected: build, browser staging, conditional Electron preparation, `electron-builder --dir`, and `verify-packaged-native` all exit 0. The packaged probe must report that `better-sqlite3` loaded under Electron 43.1.1.

- [ ] **Step 10: Inspect the final repository state**

Run:

```bash
git status --short
git log -n 4 --oneline
```

Expected: no uncommitted implementation changes remain, and the three task commits are visible after the design and plan commits. If a verification command generated untracked build artifacts that are already ignored, `git status --short` remains empty; do not delete unrelated user files.
