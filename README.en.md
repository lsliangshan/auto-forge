# AutoForge

Build Once, Automate Everywhere.

AutoForge is a desktop web automation platform built with Electron, Vite,
Vue 3, TypeScript, and Tailwind CSS.

The first production scaffold focuses on security boundaries, plugin manifests,
a restricted Playwright-like SDK contract, and a workflow state machine.

## Architecture

```txt
Third-party automation tool
  -> restricted Playwright-like SDK
  -> permission checks / workflow state / logs
  -> Electron main process
  -> CDP / DOM injection / webContents
  -> target web page
```

Tool authors write automation scripts, not Electron plugins. Tools do not get
direct access to Node.js, Electron, the local file system, arbitrary IPC, or a
full CDP session.

## Directories

```txt
src/main              Electron main process, IPC, plugin registry, workflow runner
src/preload           typed and restricted preload bridge
src/renderer/src      Vue 3 workbench UI
src/shared            shared contracts and SDK types
packages/automation-sdk public Automation SDK package
resources/plugins     example plugin manifest and tool code
docs                  architecture notes
```

Third-party tool integration guide: [docs/automation-sdk.md](docs/automation-sdk.md).

## Development

```bash
npm install
npm run dev
```

## Verification

```bash
npm run typecheck
npm run build:sdk
npm run build
```

## Packaging

```bash
npm run dist
```
