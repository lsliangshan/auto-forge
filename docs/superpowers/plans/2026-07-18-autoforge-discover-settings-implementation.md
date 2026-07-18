# AutoForge Discover And Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a production-oriented Electron desktop application that faithfully implements the selected AutoForge visual direction with exactly two menus, Discover and Settings, plus secure local persistence and tool-template download.

**Architecture:** The Vue renderer owns presentation and transient filter state. A typed preload allowlist connects it to Electron main services for SQLite-backed settings/installations and safe template export; shared contracts keep renderer and main-process payloads serializable and testable.

**Tech Stack:** Electron, electron-vite, Vue 3, TypeScript, Vue Router, Pinia, Tailwind CSS, Element Plus, better-sqlite3, Vitest, Vue Test Utils, Playwright Electron, electron-builder.

## Global Constraints

- The app navigation contains exactly `发现` and `设置`; no other primary menu is rendered.
- The default route is Discover and does not require login.
- Target viewport is 1440 × 1024; minimum window is 1080 × 720.
- Match `docs/design/autoforge-discover-direction.png`: warm-white shell, graphite type, cobalt actions, featured tool, category filters, and continuous tool list.
- Keep `contextIsolation`, `sandbox`, and `webSecurity` enabled and `nodeIntegration` disabled.
- Renderer code never imports Node.js or Electron and only calls typed `window.autoForge` methods.
- Tool installation is local persisted simulation; template download is a real filesystem copy after system directory selection.
- Do not overwrite an existing template directory.
- Preserve the user's existing `CHAT.md` modification.

---

### Task 1: Project Foundation And Catalog Domain

**Files:**
- Create: `package.json`, `.gitignore`, `.editorconfig`, `index.html`
- Create: `electron.vite.config.ts`, `electron-builder.yml`, `postcss.config.cjs`, `tailwind.config.ts`
- Create: `tsconfig.json`, `tsconfig.node.json`, `tsconfig.web.json`, `vitest.config.ts`
- Create: `src/shared/catalog.ts`, `src/shared/catalog.test.ts`, `src/shared/contracts.ts`

**Interfaces:**
- Produces: `ToolSummary`, `ToolCategory`, `filterTools(tools, query, category)`, `AutoForgeApi`, and serializable IPC payloads.

- [ ] **Step 1: Write the catalog filter test**

```ts
it('filters tools by normalized query and category', () => {
  expect(filterTools(seed, ' 网页 ', 'data')).toEqual([seed[0]])
})
```

- [ ] **Step 2: Run the test and verify RED**

Run: `npm run test:unit -- src/shared/catalog.test.ts`  
Expected: FAIL because `filterTools` does not exist.

- [ ] **Step 3: Implement the minimal catalog model and filter**

```ts
export function filterTools(tools: ToolSummary[], query: string, category: ToolCategory) {
  const needle = query.trim().toLocaleLowerCase('zh-CN')
  return tools.filter((tool) =>
    (category === 'all' || tool.category === category) &&
    (!needle || `${tool.name} ${tool.description} ${tool.developer}`.toLocaleLowerCase('zh-CN').includes(needle))
  )
}
```

- [ ] **Step 4: Run test and typecheck**

Run: `npm run test:unit -- src/shared/catalog.test.ts && npm run typecheck`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add package.json .gitignore .editorconfig index.html electron.vite.config.ts electron-builder.yml postcss.config.cjs tailwind.config.ts tsconfig.json tsconfig.node.json tsconfig.web.json vitest.config.ts src/shared
git commit -m "feat: establish AutoForge desktop foundation"
```

### Task 2: SQLite Services And Template Export

**Files:**
- Create: `src/main/database/migrations.ts`, `src/main/database/app-database.ts`, `src/main/database/app-database.test.ts`
- Create: `src/main/catalog/catalog-service.ts`
- Create: `src/main/installations/installation-service.ts`
- Create: `src/main/settings/settings-service.ts`
- Create: `src/main/templates/template-service.ts`, `src/main/templates/template-service.test.ts`
- Create: `resources/catalog/tools.json`
- Create: `resources/templates/automation-tool-template/manifest.json`
- Create: `resources/templates/automation-tool-template/package.json`
- Create: `resources/templates/automation-tool-template/tsconfig.json`
- Create: `resources/templates/automation-tool-template/README.md`
- Create: `resources/templates/automation-tool-template/src/index.ts`
- Create: `resources/templates/automation-tool-template/dist/index.js`
- Create: `resources/templates/automation-tool-template/dist/index.d.ts`

**Interfaces:**
- Consumes: shared `ToolSummary`, settings payloads, and install payloads.
- Produces: `AppDatabase`, `CatalogService`, `InstallationService`, `SettingsService`, and `TemplateService.exportTemplate(targetDirectory)`.

- [ ] **Step 1: Write failing migration and template tests**

```ts
const database = new AppDatabase(':memory:')
database.initialize()
expect(database.listTableNames()).toEqual(expect.arrayContaining(['app_settings', 'installed_tools']))

expect(() => service.exportTemplate(existingTarget)).toThrow(/already exists/i)
```

- [ ] **Step 2: Run tests and verify RED**

Run: `npm run test:unit -- src/main/database/app-database.test.ts src/main/templates/template-service.test.ts`  
Expected: FAIL because the services do not exist.

- [ ] **Step 3: Implement idempotent migrations and focused services**

```ts
export const migrations = [{
  version: 1,
  sql: `CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS installed_tools (tool_id TEXT PRIMARY KEY, version TEXT NOT NULL, installed_at TEXT NOT NULL);`
}]
```

Template export resolves the target directory, rejects an existing `auto-forge-tool-template` folder, and copies the complete template root without following links outside the bundled source.

- [ ] **Step 4: Run targeted and full unit tests**

Run: `npm run test:unit`  
Expected: PASS with temporary directories cleaned up.

- [ ] **Step 5: Commit**

```bash
git add src/main resources
git commit -m "feat: add local catalog persistence and template export"
```

### Task 3: Secure Electron IPC Boundary

**Files:**
- Create: `src/main/ipc/register-ipc.ts`, `src/main/index.ts`
- Create: `src/preload/index.ts`, `src/preload/index.d.ts`
- Create: `src/shared/ipc.ts`, `src/shared/ipc.test.ts`

**Interfaces:**
- Consumes: main services from Task 2.
- Produces: a secure `BrowserWindow`, validated IPC handlers, and typed `window.autoForge` methods: `listTools`, `listInstalledToolIds`, `installTool`, `getSettings`, `updateSettings`, and `exportToolTemplate`.

- [ ] **Step 1: Write the failing safe-error test**

```ts
expect(toSafeError(new Error('boom'))).toEqual({ code: 'INTERNAL_ERROR', message: 'boom' })
expect(toSafeError('secret')).toEqual({ code: 'INTERNAL_ERROR', message: 'Unexpected application error' })
```

- [ ] **Step 2: Run and verify RED**

Run: `npm run test:unit -- src/shared/ipc.test.ts`  
Expected: FAIL because `toSafeError` does not exist.

- [ ] **Step 3: Implement safe errors, handlers, preload, and window startup**

```ts
new BrowserWindow({
  minWidth: 1080,
  minHeight: 720,
  webPreferences: {
    preload: join(__dirname, '../preload/index.js'),
    contextIsolation: true,
    sandbox: true,
    webSecurity: true,
    nodeIntegration: false
  }
})
```

Every handler validates strings and known tool IDs before invoking a service. Preload exposes named methods only; it does not expose raw `ipcRenderer`.

- [ ] **Step 4: Run tests and main-process typecheck**

Run: `npm run test:unit && npm run typecheck:node`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main src/preload src/shared
git commit -m "feat: expose secure desktop capabilities"
```

### Task 4: Discover And Settings Renderer

**Files:**
- Create: `src/renderer/src/main.ts`, `src/renderer/src/App.vue`, `src/renderer/src/env.d.ts`
- Create: `src/renderer/src/router/index.ts`, `src/renderer/src/stores/app.ts`
- Create: `src/renderer/src/layouts/AppShell.vue`
- Create: `src/renderer/src/views/DiscoverView.vue`, `src/renderer/src/views/SettingsView.vue`
- Create: `src/renderer/src/components/catalog/FeaturedTool.vue`
- Create: `src/renderer/src/components/catalog/ToolList.vue`
- Create: `src/renderer/src/components/catalog/ToolDetailsDrawer.vue`
- Create: `src/renderer/src/components/common/EmptyState.vue`
- Create: `src/renderer/src/styles/index.css`, `src/renderer/src/styles/tokens.css`
- Create: `src/renderer/src/components/app-shell.test.ts`
- Create: `src/renderer/src/components/discover.test.ts`

**Interfaces:**
- Consumes: `window.autoForge`, shared catalog types, and selected visual reference.
- Produces: two-menu navigation, functional Discover search/filter/detail/install journey, and Settings preference/template-export journey.

- [ ] **Step 1: Write failing shell and discover tests**

```ts
expect(wrapper.findAll('[data-testid="primary-nav-item"]')).toHaveLength(2)
expect(wrapper.text()).toContain('发现')
expect(wrapper.text()).toContain('设置')

await wrapper.get('[data-testid="tool-search"]').setValue('网页')
expect(wrapper.findAll('[data-testid="tool-row"]')).toHaveLength(1)
```

- [ ] **Step 2: Run and verify RED**

Run: `npm run test:unit -- src/renderer/src/components/app-shell.test.ts src/renderer/src/components/discover.test.ts`  
Expected: FAIL because renderer components do not exist.

- [ ] **Step 3: Implement the selected visual and interactions**

Use CSS variables for reference colors and spacing. Keep the featured recommendation visually dominant, render categories as filters rather than menus, use one continuous list surface, and hide nonessential metadata at the 1080px minimum width. Include loading, empty, error, install-in-progress, installed, template-export success, and template-export failure states.

- [ ] **Step 4: Run renderer tests and typecheck**

Run: `npm run test:unit && npm run typecheck:renderer`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer
git commit -m "feat: build Discover and Settings experience"
```

### Task 5: Documentation And Production Build

**Files:**
- Create: `README.md`, `docs/architecture.md`, `docs/development.md`, `docs/tool-template.md`
- Create: `tests/e2e/app.spec.ts`, `playwright.config.ts`
- Modify: `package.json`, `electron-builder.yml`

**Interfaces:**
- Produces: developer setup, architecture and template documentation; unit/type/build scripts; Electron smoke coverage; unpacked application packaging.

- [ ] **Step 1: Add the Electron smoke test**

```ts
test('opens Discover and navigates to Settings', async () => {
  await expect(page.getByRole('heading', { name: '发现自动化工具' })).toBeVisible()
  await page.getByRole('link', { name: '设置' }).click()
  await expect(page.getByRole('heading', { name: '设置' })).toBeVisible()
})
```

- [ ] **Step 2: Run the full automated verification**

Run: `npm run test:unit && npm run typecheck && npm run build`  
Expected: PASS without TypeScript or Vite errors.

- [ ] **Step 3: Verify template contents and unpacked packaging**

Run: `npm run verify:template && npm run dist:dir`  
Expected: the template contains its root, source, manifest, README, compiled JavaScript and declarations; electron-builder creates an unpacked app for the current platform.

- [ ] **Step 4: Commit**

```bash
git add README.md docs tests playwright.config.ts package.json electron-builder.yml
git commit -m "docs: document and verify AutoForge desktop app"
```

### Task 6: Visual QA And Final Verification

**Files:**
- Create: `design-qa.md`
- Create: `artifacts/qa/autoforge-discover.png`
- Modify: renderer files only where same-viewport comparison exposes concrete P0/P1/P2 issues.

**Interfaces:**
- Consumes: `docs/design/autoforge-discover-direction.png` and the running renderer.
- Produces: same-state 1440 × 1024 screenshot comparison and `design-qa.md` with `final result: passed`.

- [ ] **Step 1: Run the renderer and capture 1440 × 1024**

Open the local renderer in the Codex in-app browser, verify search, category filtering, detail drawer, install, Discover/Settings navigation, and template-export feedback. Save the screenshot to `artifacts/qa/autoforge-discover.png`.

- [ ] **Step 2: Compare reference and implementation**

Open both images in one visual inspection. Record layout, typography, color, spacing, icon and interaction differences in `design-qa.md`.

- [ ] **Step 3: Fix blocking visual issues and repeat**

Fix every P0/P1/P2 issue, recapture at the same viewport and state, and repeat until `design-qa.md` contains `final result: passed`.

- [ ] **Step 4: Run final verification**

Run: `npm run test:unit && npm run typecheck && npm run build && npm run verify:template`  
Expected: every command exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/renderer artifacts/qa design-qa.md
git commit -m "test: complete AutoForge visual QA"
```
