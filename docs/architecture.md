# AutoForge Architecture

AutoForge is a desktop automation platform built on Electron, Vite, Vue 3,
TypeScript, and Tailwind CSS.

The project follows the design from `INIT.md`: third-party developers write
automation tools, not Electron plugins. Tools call a restricted Playwright-like
SDK. AutoForge owns permission checks, workflow state, logging, and all Electron
or Chromium control surfaces.

## Layers

```txt
Tool manifest and automation script
  -> restricted Automation SDK
  -> permission gateway, workflow runner, logs
  -> Electron main process
  -> CDP / DOM injection / webContents in future runtime
  -> target web page
```

## Security defaults

- `contextIsolation: true`
- `nodeIntegration: false`
- `sandbox: true`
- `webSecurity: true`
- preload exposes a typed allowlist only
- plugin manifests declare permissions before execution

## Current scope

This scaffold includes a production-oriented local shell:

- Electron main process and secure BrowserWindow defaults
- typed preload bridge
- Vue 3 renderer workbench
- workflow status machine with pause, resume, reset, logs, and progress
- manifest validation and built-in example plugin
- public `@auto-forge/automation-sdk` workspace package
- shared SDK and contract types

The real CDP engine, isolated plugin worker, marketplace, signing, and review
service are intentionally left as next implementation milestones.

See `docs/automation-sdk.md` for the third-party tool integration guide.
