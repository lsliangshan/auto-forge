# AutoForge Desktop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a complete, production-oriented AutoForge Electron desktop application whose primary experience faithfully implements the selected visual workflow editor and whose local runtime, SQLite persistence, IPC boundary, SDK example, tests, docs, and packaging configuration are runnable.

**Architecture:** The Vue renderer owns presentation and short-lived editor state; the preload bridge exposes a typed allowlist; Electron main services own persistence, workflow execution, plugin validation, browser windows, settings, and auth simulation. Shared domain modules keep IPC payloads and state transitions independently testable.

**Tech Stack:** Electron, electron-vite, Vue 3, TypeScript, Vue Router, Pinia, Vue Flow, Tailwind CSS, Element Plus, better-sqlite3, Vitest, Vue Test Utils, Playwright, electron-builder.

## Global Constraints

- Recreate the selected 1440 × 1024 light workflow-editor design; support a minimum app window of 1180 × 760.
- Keep `contextIsolation`, `sandbox`, and `webSecurity` enabled and `nodeIntegration` disabled.
- Renderer code must not access Node.js directly; all main-process capabilities use typed preload IPC.
- The first usable screen is the workflow editor and must not require login or display a blank initial state.
- Use Element Plus icons for UI iconography; do not add handmade SVG, emoji, gradients, or decorative raster placeholders.
- Persist workflows, runs, logs, browser history, settings, plugin permissions, and local session metadata in SQLite.
- Treat discovery and QR login as replaceable local adapters; do not invent a remote backend.
- Preserve `INIT.md`, `CHAT.md`, and unrelated working-tree changes.

---

### Task 1: Project Foundation and Shared Domain Contracts

**Files:**
- Create: `package.json`, `.npmrc`, `.gitignore`, `.editorconfig`
- Create: `electron.vite.config.ts`, `electron-builder.yml`, `tailwind.config.ts`, `postcss.config.cjs`
- Create: `tsconfig.json`, `tsconfig.node.json`, `tsconfig.web.json`, `vitest.config.ts`, `index.html`
- Create: `src/shared/contracts.ts`, `src/shared/workflow.ts`, `src/shared/workflow.test.ts`

**Interfaces:**
- Produces: `WorkflowStatus`, `WorkflowNode`, `WorkflowDocument`, `WorkflowSnapshot`, `transitionWorkflow(status, event)` and all typed IPC request/response contracts.

- [ ] **Step 1: Write the workflow-state test**

```ts
expect(transitionWorkflow('idle', 'start')).toBe('running')
expect(transitionWorkflow('running', 'pause')).toBe('paused')
expect(() => transitionWorkflow('completed', 'pause')).toThrow('Invalid workflow transition')
```

- [ ] **Step 2: Run the test and verify RED**

Run: `npm run test:unit -- src/shared/workflow.test.ts`  
Expected: FAIL because `transitionWorkflow` does not exist.

- [ ] **Step 3: Implement the shared state machine and IPC contracts**

Implement a total transition map for start, pause, resume, complete, fail, cancel, retry, and reset. Define serializable payloads for overview, workflow CRUD/run actions, browser actions, task discovery, auth, settings, and event subscriptions.

- [ ] **Step 4: Run the test and typecheck**

Run: `npm run test:unit -- src/shared/workflow.test.ts && npm run typecheck`  
Expected: PASS.

### Task 2: SQLite, Validation, and Main-Process Services

**Files:**
- Create: `src/main/database/migrations.ts`, `src/main/database/app-database.ts`, `src/main/database/app-database.test.ts`
- Create: `src/main/plugins/plugin-registry.ts`, `src/main/plugins/plugin-registry.test.ts`
- Create: `src/main/automation/permission-gateway.ts`, `src/main/automation/permission-gateway.test.ts`
- Create: `src/main/workflow/workflow-runner.ts`
- Create: `src/main/settings/settings-service.ts`, `src/main/auth/auth-service.ts`

**Interfaces:**
- Consumes: shared contracts from Task 1.
- Produces: `AppDatabase`, `PluginRegistry`, `PermissionGateway`, `WorkflowRunner`, `SettingsService`, and `AuthService`.

- [ ] **Step 1: Write failing database migration tests**

```ts
const database = new AppDatabase(':memory:')
database.initialize()
expect(database.listTableNames()).toContain('workflows')
expect(database.listTableNames()).toContain('workflow_runs')
```

- [ ] **Step 2: Write failing plugin and permission tests**

```ts
expect(registry.validateManifest(validManifest).id).toBe('order-sync')
expect(() => registry.validateManifest({ ...validManifest, entry: '../escape.js' })).toThrow()
expect(gateway.evaluate(['dom:read'], 'dom:write').allowed).toBe(false)
```

- [ ] **Step 3: Run targeted tests and verify RED**

Run: `npm run test:unit -- src/main/database/app-database.test.ts src/main/plugins/plugin-registry.test.ts src/main/automation/permission-gateway.test.ts`  
Expected: FAIL because the services do not exist.

- [ ] **Step 4: Implement minimal services**

Create idempotent migrations; typed workflow repositories; transaction-backed run/log persistence; strict manifest path and permission validation; seeded demo workflow; deterministic local QR-login state; and persistent settings access.

- [ ] **Step 5: Run targeted and full unit tests**

Run: `npm run test:unit`  
Expected: PASS with temporary or in-memory databases cleaned up.

### Task 3: Electron Window, Browser, IPC, and Preload Boundary

**Files:**
- Create: `src/main/browser/browser-window-manager.ts`, `src/main/browser/browser-url.ts`, `src/main/browser/browser-url.test.ts`
- Create: `src/main/ipc/register-ipc.ts`, `src/main/index.ts`
- Create: `src/preload/index.ts`, `src/preload/index.d.ts`

**Interfaces:**
- Consumes: main services and shared contracts.
- Produces: a secure main window, isolated browser windows, typed `window.autoForge`, and validated IPC handlers.

- [ ] **Step 1: Write the failing URL normalization test**

```ts
expect(normalizeBrowserUrl('example.com')).toBe('https://example.com/')
expect(() => normalizeBrowserUrl('javascript:alert(1)')).toThrow('Unsupported URL protocol')
```

- [ ] **Step 2: Run the URL test and verify RED**

Run: `npm run test:unit -- src/main/browser/browser-url.test.ts`  
Expected: FAIL because `normalizeBrowserUrl` does not exist.

- [ ] **Step 3: Implement URL validation, secure windows, IPC, and preload**

Register handlers once, validate every payload, convert thrown errors to safe serializable errors, open external links through the system browser, and expose only named methods and event unsubscriptions.

- [ ] **Step 4: Run unit tests and main-process typecheck**

Run: `npm run test:unit && npm run typecheck:main`  
Expected: PASS.

### Task 4: Workflow Editor Renderer

**Files:**
- Create: `src/renderer/src/main.ts`, `src/renderer/src/App.vue`, `src/renderer/src/env.d.ts`
- Create: `src/renderer/src/router/index.ts`, `src/renderer/src/stores/app.ts`, `src/renderer/src/stores/workflow.ts`
- Create: `src/renderer/src/layouts/AppShell.vue`
- Create: `src/renderer/src/views/WorkflowEditorView.vue`
- Create: `src/renderer/src/components/workflow/StepLibrary.vue`, `WorkflowCanvas.vue`, `NodeInspector.vue`, `RunConsole.vue`
- Create: `src/renderer/src/components/workflow/workflow-ui.test.ts`
- Create: `src/renderer/src/styles/index.css`, `src/renderer/src/styles/tokens.css`

**Interfaces:**
- Consumes: `window.autoForge`, Vue Flow node/edge models, shared workflow contracts.
- Produces: the selected workflow-editor visual and the create/configure/save/run/pause/resume/stop journey.

- [ ] **Step 1: Write failing UI tests**

```ts
expect(wrapper.get('[data-testid="step-search"]').exists()).toBe(true)
await wrapper.get('[data-testid="run-workflow"]').trigger('click')
expect(wrapper.emitted('run')).toHaveLength(1)
```

- [ ] **Step 2: Run the renderer test and verify RED**

Run: `npm run test:unit -- src/renderer/src/components/workflow/workflow-ui.test.ts`  
Expected: FAIL because the workflow components do not exist.

- [ ] **Step 3: Implement the app shell and editor**

Match the source image proportions and visual tokens. Implement searchable grouped steps, five seeded connected nodes, selected-node properties, zoom controls, save state, run state, expandable logs, responsive panel hiding below 1280px, keyboard focus, and accessible button labels.

- [ ] **Step 4: Run renderer tests and typecheck**

Run: `npm run test:unit -- src/renderer/src/components/workflow/workflow-ui.test.ts && npm run typecheck:renderer`  
Expected: PASS.

### Task 5: Supporting Product Views

**Files:**
- Create: `src/renderer/src/views/TasksView.vue`, `BrowserView.vue`, `DiscoverView.vue`, `RunsView.vue`, `SettingsView.vue`, `LoginView.vue`
- Create: `src/renderer/src/components/common/PageHeader.vue`, `EmptyState.vue`, `StatusPill.vue`
- Modify: `src/renderer/src/router/index.ts`, `src/renderer/src/layouts/AppShell.vue`

**Interfaces:**
- Consumes: app store and preload methods.
- Produces: working navigation, task filtering/running, browser navigation history, local discovery/install states, run records, template-directory selection, theme preference, and QR-login simulation.

- [ ] **Step 1: Write failing navigation and settings component tests**

Test that every named route resolves, the settings download action calls the bridge, and login polling reaches the success state.

- [ ] **Step 2: Run targeted tests and verify RED**

Run: `npm run test:unit -- src/renderer/src/views`  
Expected: FAIL because the routes and views are missing.

- [ ] **Step 3: Implement supporting views with realistic local data**

Use continuous grouped surfaces rather than dashboard card grids. Keep all main navigation and visible primary controls functional, with loading, empty, success, and error feedback.

- [ ] **Step 4: Run all renderer tests and typecheck**

Run: `npm run test:unit && npm run typecheck:renderer`  
Expected: PASS.

### Task 6: Public SDK, Example Tool, and Documentation

**Files:**
- Create: `packages/automation-sdk/package.json`, `packages/automation-sdk/tsconfig.json`, `packages/automation-sdk/src/index.ts`, `packages/automation-sdk/src/index.test.ts`, `packages/automation-sdk/README.md`
- Create: `resources/plugins/example-login-tool/manifest.json`, `package.json`, `tsconfig.json`, `src/index.ts`, `README.md`
- Create: `scripts/package-example-tool.mjs`
- Create: `README.md`, `README.en.md`, `docs/architecture.md`, `docs/automation-sdk.md`, `docs/development.md`, `docs/publishing-tools.md`

**Interfaces:**
- Produces: `defineAutomationTool`, `AutomationContext`, restricted page/storage/network interfaces, a compiled example tool, a deterministic zip command, and zero-to-publish instructions.

- [ ] **Step 1: Write failing SDK contract tests**

```ts
const tool = defineAutomationTool({ manifest, run: async () => undefined })
expect(tool.manifest.id).toBe('example-login-tool')
```

- [ ] **Step 2: Run the SDK test and verify RED**

Run: `npm run test:sdk`  
Expected: FAIL because the SDK entry does not exist.

- [ ] **Step 3: Implement the restricted SDK and example**

Expose no Electron, Node.js, filesystem, cookie, or raw CDP API. Document each capability, permission, manifest field, build step, install flow, debugging path, versioning rule, and publication checklist.

- [ ] **Step 4: Build and package the example**

Run: `npm run build:sdk && npm run package:example`  
Expected: `artifacts/example-login-tool-1.0.0.zip` contains the top-level tool folder, manifest, README, package metadata, source, and compiled declarations/output.

### Task 7: Production Verification and Visual QA

**Files:**
- Create: `tests/e2e/app.spec.ts`, `playwright.config.ts`, `design-qa.md`
- Modify: production configuration only where verification exposes a concrete issue.

**Interfaces:**
- Consumes: the complete app and selected reference image.
- Produces: passing unit/type/build checks, Electron smoke coverage, a same-viewport implementation screenshot, and `design-qa.md` with `final result: passed`.

- [ ] **Step 1: Add Electron smoke tests**

Cover app launch, visible workflow editor, save state, run/pause/resume, route navigation, and restart persistence.

- [ ] **Step 2: Run the full automated verification**

Run: `npm run test:unit && npm run test:sdk && npm run typecheck && npm run build`  
Expected: PASS without TypeScript or Vite errors.

- [ ] **Step 3: Run and capture the renderer at 1440 × 1024**

Open the local renderer in the Codex in-app browser, exercise the editor's primary controls, check the console, and save the screenshot under `artifacts/qa/`.

- [ ] **Step 4: Compare source and implementation**

Compare `docs/design/autoforge-visual-direction.png` and the implementation screenshot in one visual input. Record fonts, spacing, colors, icon fidelity, copy, and interactions in `design-qa.md`. Fix every P0/P1/P2 issue and repeat until `final result: passed`.

- [ ] **Step 5: Verify packaging configuration**

Run: `npm run dist:dir`  
Expected: electron-builder produces unpacked application output for the current platform.
