# AutoForge App Logo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Store the approved AutoForge logo in the desktop project and use it for in-app branding, the renderer favicon, and macOS/Windows packages.

**Architecture:** Keep the approved transparent PNG as the canonical branding source under `apps/desktop/resources/branding`. Import that source directly into the two Vue brand surfaces, reference it from `index.html`, and generate platform packaging derivatives in the same branding directory. Configure electron-builder explicitly so macOS and Windows packages consume those derivatives.

**Tech Stack:** Vue 3, Vite, Vitest, Electron 43, electron-builder 26, PNG/ICNS/ICO assets

## Global Constraints

- Preserve the approved logo artwork and transparent background.
- Replace only existing `AF` brand placeholders; leave account-avatar initials unchanged.
- Keep AutoForge's existing graphite and cobalt visual system.
- Support the confirmed production targets: macOS and Windows.
- Do not refactor unrelated UI or packaging behavior.

---

### Task 1: Renderer brand surfaces

**Files:**
- Create: `apps/desktop/resources/branding/autoforge-logo.png`
- Modify: `apps/desktop/src/components/AppRail.vue`
- Modify: `apps/desktop/src/layouts/AuthLayout.vue`
- Modify: `apps/desktop/index.html`
- Test: `apps/desktop/tests/components/auth.test.ts`

**Interfaces:**
- Consumes: the approved transparent PNG generated for this project
- Produces: accessible `.app-mark` and `.auth-brand-logo` images plus the renderer favicon

- [ ] **Step 1: Write failing renderer tests**

Add assertions that the workbench and authentication layouts render the approved image with an empty decorative `alt`, while preserving the visible `AutoForge` brand name on authentication pages.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `pnpm --filter @autoforge/desktop exec vitest run --config vitest.config.ts tests/components/auth.test.ts`

Expected: FAIL because the current brand surfaces contain text placeholders instead of logo images.

- [ ] **Step 3: Add the source asset and minimal Vue/HTML references**

Copy the approved PNG to `resources/branding/autoforge-logo.png`, import it in `AppRail.vue` and `AuthLayout.vue`, replace only the `AF` placeholders with `<img>` elements, and add a PNG favicon link to `index.html`.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `pnpm --filter @autoforge/desktop exec vitest run --config vitest.config.ts tests/components/auth.test.ts`

Expected: all authentication component tests pass.

### Task 2: Native package icons

**Files:**
- Create: `apps/desktop/resources/branding/autoforge-logo.icns`
- Create: `apps/desktop/resources/branding/autoforge-logo.ico`
- Modify: `apps/desktop/electron-builder.yml`
- Test: `apps/desktop/electron/main/database/native-packaging.test.ts`

**Interfaces:**
- Consumes: `apps/desktop/resources/branding/autoforge-logo.png`
- Produces: explicit macOS and Windows application-icon paths for electron-builder

- [ ] **Step 1: Write a failing packaging configuration test**

Read `electron-builder.yml` and assert that the macOS icon is `resources/branding/autoforge-logo.icns` and the Windows icon is `resources/branding/autoforge-logo.ico`.

- [ ] **Step 2: Run the focused node test and verify RED**

Run: `pnpm --filter @autoforge/desktop exec vitest run --config vitest.node.config.ts electron/main/database/native-packaging.test.ts`

Expected: FAIL because platform icon paths are not configured.

- [ ] **Step 3: Generate package derivatives and configure electron-builder**

Generate a multi-resolution ICNS and ICO from the canonical transparent PNG, then add explicit `mac.icon` and `win.icon` entries without changing targets or other packaging behavior.

- [ ] **Step 4: Run the focused node test and verify GREEN**

Run: `pnpm --filter @autoforge/desktop exec vitest run --config vitest.node.config.ts electron/main/database/native-packaging.test.ts`

Expected: all native packaging tests pass.

### Task 3: Final verification

**Files:**
- Verify only; no planned source changes

**Interfaces:**
- Consumes: completed renderer and packaging tasks
- Produces: fresh evidence that tests, types, and production renderer packaging inputs are valid

- [ ] **Step 1: Verify image metadata**

Run `sips`/`identify` checks for square PNG dimensions, PNG alpha, ICNS readability, and ICO embedded sizes.

- [ ] **Step 2: Run the desktop test suites**

Run: `pnpm --filter @autoforge/desktop test`

Expected: both renderer and node Vitest suites pass.

- [ ] **Step 3: Run type checking and build**

Run: `pnpm --filter @autoforge/desktop typecheck && pnpm --filter @autoforge/desktop build`

Expected: both commands exit 0 and the renderer build includes the logo asset.
