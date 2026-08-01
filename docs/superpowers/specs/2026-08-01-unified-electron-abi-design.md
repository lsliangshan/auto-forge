# Unified Electron ABI Design

## Problem

AutoForge currently alternates one installed `better-sqlite3` native artifact
between two incompatible ABIs:

- ordinary Node 24 uses ABI 137 for the repository test suite;
- Electron 43 uses ABI 148 for the desktop Main process.

The root `pretest` rebuilds `better-sqlite3` for ordinary Node, while the
desktop `predev` unconditionally runs `electron-rebuild -f`. As a result,
every `npm run dev` reports `Building modules: better-sqlite3`, even when the
installed dependency and Electron version have not changed. Omitting that
forced rebuild under the current test setup is unsafe because a preceding
`npm test` may have left the native artifact on ABI 137.

## Goals

- Keep exactly one usable `better-sqlite3` native artifact in the workspace,
  built for the installed Electron runtime and ABI 148.
- Run every test that can load `better-sqlite3` through Electron's Node mode so
  tests and the desktop Main process use the same native ABI.
- Make repeated `npm run dev` and `npm test` commands skip native compilation
  when the existing Electron artifact is loadable.
- Automatically rebuild after a dependency, Electron version, platform, or
  architecture change makes the current artifact incompatible.
- Preserve the existing test selection, development startup, packaging, and
  packaged-native verification behavior.

## Non-goals

- Do not replace `better-sqlite3`, move the database into a sidecar process, or
  change the database or IPC architecture.
- Do not run all repository tooling inside Electron. pnpm, Vite, TypeScript,
  ESLint, and build scripts continue to run under ordinary Node when they do
  not load `better-sqlite3`.
- Do not keep separate Node-ABI and Electron-ABI copies of the native binding.
- Do not add a persistent ABI cache or marker file. The runtime load probe is
  the source of truth.

## Design

### Electron-only native-module policy

The workspace treats the installed Electron runtime as the sole supported
host for `better-sqlite3`. Ordinary Node processes may resolve JavaScript and
type declarations from the package but must not instantiate a database or
load its native binding.

The root test command and the desktop test command launch Vitest with the
installed Electron executable and `ELECTRON_RUN_AS_NODE=1`. Electron then
behaves as a Node CLI while retaining Electron ABI 148. Vitest arguments,
working directory, standard input/output, exit status, and existing config
files remain unchanged.

A focused feasibility check already ran the desktop database suite this way:
Vitest 4.1.10 completed all 68 database tests under Electron 43.1.1 and ABI
148.

### Vitest launcher

Add one desktop script whose only responsibility is to run the installed
Vitest CLI through the installed Electron executable in Node mode.

The launcher:

1. Resolves Electron and Vitest from `apps/desktop/package.json` so it uses the
   workspace-pinned packages rather than global commands.
2. Spawns Electron with `ELECTRON_RUN_AS_NODE=1`, forwards all received Vitest
   arguments, inherits the caller's working directory and standard streams,
   and returns the child exit status.
3. Preserves the caller's environment except for the required
   `ELECTRON_RUN_AS_NODE` value.
4. Reports resolution or spawn failures directly and exits nonzero.

The root `test` script uses this launcher for the same repository-wide
`vitest run` command it executes today. The desktop package uses it for both
its Renderer and Node-configured Vitest runs. The `environment: 'node'` name in
`vitest.node.config.ts` remains correct: it describes the Vitest environment,
while Electron supplies the compatible Node runtime.

### Conditional Electron native preparation

Replace unconditional native rebuilding with a single preparation script used
before development, tests, and packaging.

The preparation flow is:

1. Resolve the installed Electron executable and the workspace-local
   `better-sqlite3` package.
2. Start Electron with `ELECTRON_RUN_AS_NODE=1` and run a probe that opens an
   in-memory `better-sqlite3` database, executes a trivial query, and closes
   it. Merely importing the package is insufficient because the binding can be
   loaded lazily.
3. If the probe succeeds, print a concise compatibility message and exit
   without invoking `@electron/rebuild`.
4. If the probe fails, rebuild only `better-sqlite3` for the pinned Electron
   version, current platform, and current architecture.
5. Run the same in-memory database probe again. Propagate a nonzero result if
   the rebuilt artifact still cannot run under Electron.

This direct execution check covers a stale Node ABI, a changed Electron ABI,
platform or architecture mismatch, a missing binding, and a corrupt build
without inventing a second compatibility database.

The shared `prepare:native-electron` package command runs `install-electron`
before this script because Electron 43 initializes its binary lazily. Keeping
initialization in the shared command makes direct preparation, development,
tests, and packaging safe through the same entry point. `install-electron` is
expected to be a quick no-op after initialization and is separate from native
module compilation.

### Script lifecycle changes

- Root `pretest` invokes the desktop `prepare:native-electron` command instead
  of rebuilding for ordinary Node.
- Root `test` runs repository-wide Vitest through the Electron Vitest launcher.
- Desktop `pretest` invokes `prepare:native-electron` so a direct package test
  is safe.
- Desktop `test` runs both existing Vitest configs through the launcher.
- Desktop `predev` invokes `prepare:native-electron` instead of calling
  `electron-rebuild -f` directly.
- Desktop `prepare:native-electron` initializes Electron, then runs the
  conditional and self-verifying preparation script; packaging continues to
  use this shared entry point.
- Remove `prepare-native-node.mjs` after no lifecycle script can invoke it.
- Update workspace contract tests to assert the new script topology rather
  than the old ABI-switching commands.

The first native-consuming command after a fresh install may rebuild once.
Subsequent tests and development starts reuse the verified Electron artifact.

## Failure behavior

- If Electron has not been initialized, the lifecycle fails at
  `install-electron` with its original diagnostic.
- If the current native binding is incompatible, preparation shows that it is
  rebuilding for the pinned Electron version, then retries the real probe.
- If rebuilding or the second probe fails, the command exits nonzero and does
  not start Vitest, Electron development, or packaging with an unverified
  database binding.
- The preparation script continues to reject a resolved `better-sqlite3`
  package outside the current workspace before rebuilding it.

## Testing and acceptance

Add focused regression coverage for the launcher and preparation decisions,
including:

- compatible Electron probe skips `@electron/rebuild`;
- failed initial probe performs exactly one rebuild and re-probes;
- failed rebuild or failed second probe exits nonzero;
- the probe opens and queries an in-memory database rather than only importing
  `better-sqlite3`;
- the Vitest launcher resolves pinned binaries, preserves arguments and the
  working directory, sets `ELECTRON_RUN_AS_NODE=1`, and propagates failures;
- workspace scripts contain no Node-ABI preparation path.

Then verify the real boundaries in this order:

1. Run the focused script and workspace contract tests.
2. Run the full repository test suite through Electron Node mode and confirm
   all native database tests pass under ABI 148.
3. Run the desktop Renderer and Node-configured suites directly.
4. Run type checking, lint, and the production build.
5. Run `npm test` followed by `npm run dev`; confirm development reaches the
   real Electron Main process, SQLite migrations, visible window, and port
   5173 without `Building modules: better-sqlite3` on the second command.
6. Run `npm run dev` again and confirm the native artifact is reused without
   rebuilding.
7. Run the packaged-native verification path and confirm the packaged app
   loads `better-sqlite3` under the installed Electron runtime.

The change is complete only when both the full test suite and real Electron
startup succeed while repeated commands no longer compile `better-sqlite3`.
