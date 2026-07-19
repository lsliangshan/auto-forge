# AutoForge Production MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a production-grade macOS and Windows Electron desktop application that provides real OpenRouter chat, local TypeScript workflow development and installation, permission-gated isolated workflow execution, and a visible Chromium automation window.

**Architecture:** Use a pnpm workspace with one electron-vite desktop app and three focused packages for cross-process contracts, workflow manifests, and the workflow SDK. The Electron main process is the trusted orchestrator; the Vue renderer uses a typed preload bridge; every workflow run executes in a child process and reaches Playwright only through a permission-checking capability broker in main.

**Tech Stack:** Electron 43.1.1, electron-vite 5.0.0, Vite 7.3.6, Vue 3.5.40, TypeScript 6.0.3, Tailwind CSS 4.3.3, Element Plus 2.14.3, Pinia 4.0.2, Vue Router 5.2.0, Monaco Editor 0.55.1, Zod 4.4.3, AJV 8.20.0, Drizzle ORM 0.45.2, better-sqlite3 12.11.1, esbuild 0.28.1, Chokidar 5.0.0, eventsource-parser 3.1.0, playwright-chromium 1.61.1, Vitest 4.1.10, Playwright Test 1.61.1, electron-builder 26.15.3.

## Global Constraints

- Support macOS and Windows; do not add Linux-specific behavior.
- Use Node.js `>=22.12.0 <27` and pnpm `11.15.0`.
- Keep the current user-owned deletions as the rebuild baseline; do not restore the previous implementation from Git.
- Production runtime must never fall back to mock conversations, mock workflows, or mock OpenRouter responses.
- The OpenRouter API key stays in Electron main and is encrypted with asynchronous `safeStorage` APIs.
- Renderer must have no direct Node.js, filesystem, SQLite, Playwright, or credential access.
- IPC is fixed-name and Zod-validated; never expose generic `invoke`, raw `ipcRenderer`, arbitrary file access, or shell execution.
- Workflows are TypeScript only and run in a fresh child process with an environment allowlist, a temporary directory, timeout, cancellation, and JSON Lines RPC.
- Workflow code never imports Playwright or Node capabilities directly; browser actions pass through the main-process capability broker.
- Automation opens a visible isolated Chromium profile by default.
- The main navigation copy is exactly `聊天`, `工作流`, `开发`, `执行记录`, `设置`.
- Add only the remote-free desktop MVP; do not add accounts, cloud sync, a remote marketplace, review administration, payments, comments, or auto-update infrastructure.
- Follow test-first development for every behavior task: write one focused failing test, confirm the expected failure, implement the smallest behavior, and rerun the focused and relevant suites.

---

## File Structure

```text
auto-forge/
├── .github/workflows/ci.yml
├── apps/desktop/
│   ├── electron/main/
│   │   ├── agent/agent-orchestrator.ts
│   │   ├── browser/browser-capability.ts
│   │   ├── chat/openrouter-provider.ts
│   │   ├── database/{client,migrations,repositories}.ts
│   │   ├── ipc/register-ipc.ts
│   │   ├── permissions/policy-engine.ts
│   │   ├── security/{redaction,secret-store}.ts
│   │   ├── settings/settings-service.ts
│   │   ├── workflows/{execution-service,project-service,registry,retriever}.ts
│   │   ├── index.ts
│   │   └── window.ts
│   ├── electron/preload/index.ts
│   ├── electron/preload/index.d.ts
│   ├── electron/workers/workflow-runner.ts
│   ├── resources/migrations/0001_init.sql
│   ├── src/
│   │   ├── components/{AppRail,ContextSidebar,InspectorPanel}.vue
│   │   ├── components/chat/{ApprovalCard,ChatComposer,ExecutionCard,MessageBlock}.vue
│   │   ├── components/developer/{CodeEditor,DebugPanel,FileTree}.vue
│   │   ├── layouts/WorkbenchLayout.vue
│   │   ├── router/index.ts
│   │   ├── services/desktop-api.ts
│   │   ├── stores/{chat,developer,execution,settings,workflow}.ts
│   │   ├── styles/index.css
│   │   ├── views/{Chat,Developer,Executions,Settings,Workflows}View.vue
│   │   ├── App.vue
│   │   ├── env.d.ts
│   │   └── main.ts
│   ├── tests/{components,integration}/
│   ├── electron-builder.yml
│   ├── electron.vite.config.ts
│   ├── index.html
│   ├── package.json
│   ├── tsconfig.json
│   ├── tsconfig.node.json
│   ├── tsconfig.web.json
│   ├── vitest.config.ts
│   └── vitest.node.config.ts
├── examples/browser-search-baidu/
│   ├── src/index.ts
│   ├── manifest.json
│   ├── package.json
│   └── tsconfig.json
├── packages/shared/src/
│   ├── desktop-api.ts
│   ├── errors.ts
│   ├── events.ts
│   ├── worker-protocol.ts
│   └── index.ts
├── packages/workflow-schema/
│   ├── src/{manifest,validator}.ts
│   └── manifest.schema.json
├── packages/workflow-sdk/src/{context,define-workflow,index}.ts
├── tests/e2e/app.spec.ts
├── .editorconfig
├── .gitignore
├── eslint.config.js
├── package.json
├── playwright.config.ts
├── pnpm-workspace.yaml
├── tsconfig.base.json
└── vitest.config.ts
```

---

### Task 1: Workspace and Reproducible Build Skeleton

**Files:**
- Create: `.editorconfig`
- Create: `.gitignore`
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `tsconfig.base.json`
- Create: `eslint.config.js`
- Create: `vitest.config.ts`
- Create: `apps/desktop/package.json`
- Create: `apps/desktop/electron.vite.config.ts`
- Create: `apps/desktop/tsconfig.json`
- Create: `apps/desktop/tsconfig.node.json`
- Create: `apps/desktop/tsconfig.web.json`
- Create: `apps/desktop/index.html`
- Create: `apps/desktop/vitest.config.ts`
- Create: `apps/desktop/vitest.node.config.ts`
- Create: `apps/desktop/src/main.ts`
- Create: `apps/desktop/src/App.vue`
- Create: `packages/shared/package.json`
- Create: `packages/workflow-schema/package.json`
- Create: `packages/workflow-sdk/package.json`
- Test: `tests/workspace.test.ts`

**Interfaces:**
- Produces: workspace packages `@autoforge/desktop`, `@autoforge/shared`, `@autoforge/workflow-schema`, and `@autoforge/workflow-sdk`.
- Produces: root commands `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, and `pnpm dist:dir`.

- [ ] **Step 1: Write the workspace smoke test**

```ts
// tests/workspace.test.ts
import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('workspace', () => {
  it('declares every production package and the required verification scripts', async () => {
    const root = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
    expect(root.packageManager).toBe('pnpm@11.15.0')
    expect(root.scripts).toMatchObject({
      lint: 'eslint .',
      typecheck: 'pnpm -r --if-present typecheck',
      test: 'vitest run',
      build: 'pnpm -r --filter "./packages/**" build && pnpm --filter @autoforge/desktop build',
    })
  })
})
```

- [ ] **Step 2: Run the smoke test and verify the rebuild baseline fails**

Run: `corepack pnpm dlx vitest@4.1.10 run tests/workspace.test.ts`

Expected: FAIL because the rebuilt root `package.json` does not exist in the working tree.

- [ ] **Step 3: Create the minimal workspace configuration**

Create root `package.json` with the locked toolchain and these scripts:

```json
{
  "name": "auto-forge",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@11.15.0",
  "engines": { "node": ">=22.12.0 <27" },
  "scripts": {
    "lint": "eslint .",
    "typecheck": "pnpm -r --if-present typecheck",
    "test": "vitest run",
    "build": "pnpm -r --filter \"./packages/**\" build && pnpm --filter @autoforge/desktop build",
    "dev": "pnpm -r --filter \"./packages/**\" build && pnpm --filter @autoforge/desktop dev",
    "test:e2e": "pnpm build && playwright test",
    "dist:dir": "pnpm build && pnpm --filter @autoforge/desktop dist:dir"
  },
  "devDependencies": {
    "@eslint/js": "10.0.1",
    "@playwright/test": "1.61.1",
    "@types/node": "24.13.3",
    "eslint": "10.7.0",
    "eslint-plugin-vue": "10.9.2",
    "typescript": "6.0.3",
    "typescript-eslint": "8.64.0",
    "vitest": "4.1.10"
  }
}
```

Use `pnpm-workspace.yaml`:

```yaml
packages:
  - apps/*
  - packages/*
  - examples/*
```

Create the desktop package with `main: out/main/index.js` and this exact dependency surface:

```json
{
  "name": "@autoforge/desktop",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "out/main/index.js",
  "scripts": {
    "dev": "electron-vite dev",
    "build": "electron-vite build && tsup electron/workers/workflow-runner.ts --format cjs --platform node --out-dir out/workers --clean false",
    "typecheck": "tsc --noEmit -p tsconfig.node.json && vue-tsc --noEmit -p tsconfig.web.json",
    "test": "vitest run --config vitest.config.ts && vitest run --config vitest.node.config.ts",
    "dist:dir": "electron-builder --dir --config electron-builder.yml"
  },
  "dependencies": {
    "@autoforge/shared": "workspace:*",
    "@autoforge/workflow-schema": "workspace:*",
    "@autoforge/workflow-sdk": "workspace:*",
    "@element-plus/icons-vue": "2.3.2",
    "ajv": "8.20.0",
    "ajv-formats": "3.0.1",
    "better-sqlite3": "12.11.1",
    "chokidar": "5.0.0",
    "drizzle-orm": "0.45.2",
    "element-plus": "2.14.3",
    "eventsource-parser": "3.1.0",
    "monaco-editor": "0.55.1",
    "pinia": "4.0.2",
    "playwright-chromium": "1.61.1",
    "vue": "3.5.40",
    "vue-router": "5.2.0",
    "zod": "4.4.3"
  },
  "devDependencies": {
    "@tailwindcss/vite": "4.3.3",
    "@types/better-sqlite3": "7.6.13",
    "@vitejs/plugin-vue": "6.0.8",
    "@vue/compiler-sfc": "3.5.40",
    "@vue/test-utils": "2.4.11",
    "electron": "43.1.1",
    "electron-builder": "26.15.3",
    "electron-vite": "5.0.0",
    "esbuild": "0.28.1",
    "happy-dom": "20.11.0",
    "tailwindcss": "4.3.3",
    "tsup": "8.5.1",
    "typescript": "6.0.3",
    "vite": "7.3.6",
    "vitest": "4.1.10",
    "vue-tsc": "3.3.7"
  }
}
```

Add `.superpowers/`, `node_modules/`, `out/`, `dist/`, test artifacts, staged browser binaries, local databases, logs, and `.env*` to `.gitignore`, while retaining `.env.example`.

Configure the root test runner as explicit Vitest projects so node and Vue tests never share an accidental environment:

```ts
// vitest.config.ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: [
      'packages/*',
      'apps/desktop/vitest.config.ts',
      'apps/desktop/vitest.node.config.ts',
      {
        test: {
          name: 'examples',
          environment: 'node',
          include: ['examples/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'root',
          environment: 'node',
          include: ['tests/**/*.test.ts'],
          exclude: ['tests/e2e/**'],
        },
      },
    ],
  },
})
```

`apps/desktop/vitest.config.ts` uses the Vue plugin, name `desktop-renderer`, `happy-dom`, and only `tests/components/**/*.test.ts`. `apps/desktop/vitest.node.config.ts` uses name `desktop-node`, the Node environment, and includes `electron/**/*.test.ts` plus `tests/integration/**/*.test.ts`.

- [ ] **Step 4: Install dependencies and verify the smoke test passes**

Run: `corepack pnpm install`

Expected: a new `pnpm-lock.yaml`, no peer dependency error, and Playwright Chromium downloaded for the current platform.

Run: `corepack pnpm test -- tests/workspace.test.ts`

Expected: PASS.

- [ ] **Step 5: Verify empty renderer and package builds**

Run: `corepack pnpm typecheck && corepack pnpm build`

Expected: all package type checks pass and `apps/desktop/out/renderer/index.html` exists.

- [ ] **Step 6: Commit the build skeleton**

```bash
git add .editorconfig .gitignore package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json eslint.config.js vitest.config.ts tests/workspace.test.ts apps/desktop packages/*/package.json
git commit -m "chore: scaffold AutoForge workspace"
```

### Task 2: Shared Contracts and Safe IPC Surface

**Files:**
- Create: `packages/shared/src/errors.ts`
- Create: `packages/shared/src/events.ts`
- Create: `packages/shared/src/worker-protocol.ts`
- Create: `packages/shared/src/desktop-api.ts`
- Create: `packages/shared/src/index.ts`
- Test: `packages/shared/src/contracts.test.ts`

**Interfaces:**
- Produces: `AppError`, `ChatEvent`, `ExecutionEvent`, `WorkerRequest`, `WorkerResponse`, `DesktopAPI`, and every Zod request schema.
- Consumes: Zod 4.4.3.

- [ ] **Step 1: Write failing contract tests**

```ts
import { describe, expect, it } from 'vitest'
import { approvalDecisionSchema, workerMessageSchema } from './index'

describe('cross-process contracts', () => {
  it('rejects a persistent approval without an exact workflow version', () => {
    expect(() => approvalDecisionSchema.parse({
      executionId: 'exec_1', decision: 'always', workflowId: 'browser.search.baidu',
      capability: 'browser.open', scope: { origins: ['https://www.baidu.com'] },
    })).toThrow()
  })

  it('rejects an unknown worker message instead of forwarding it', () => {
    expect(() => workerMessageSchema.parse({ type: 'shell', command: 'pwd' })).toThrow()
  })
})
```

- [ ] **Step 2: Verify the test fails because contracts are absent**

Run: `corepack pnpm exec vitest run packages/shared/src/contracts.test.ts`

Expected: FAIL with unresolved `approvalDecisionSchema` and `workerMessageSchema` exports.

- [ ] **Step 3: Implement exact discriminated unions and schemas**

Use these public shapes:

```ts
export type ExecutionStatus =
  | 'queued' | 'awaiting_approval' | 'running'
  | 'completed' | 'failed' | 'cancelled' | 'interrupted'

export type ChatBlock =
  | { type: 'text'; text: string }
  | { type: 'reasoning_status'; label: string }
  | { type: 'workflow_proposal'; workflowId: string; workflowName: string; args: unknown }
  | { type: 'approval'; executionId: string }
  | { type: 'workflow_execution'; executionId: string }
  | { type: 'execution_result'; executionId: string; summary: string }
  | { type: 'error'; code: string; message: string }

export interface DesktopAPI {
  chat: {
    listConversations(): Promise<ConversationSummary[]>
    createConversation(): Promise<ConversationSummary>
    renameConversation(conversationId: string, title: string): Promise<ConversationSummary>
    deleteConversation(conversationId: string): Promise<void>
    send(input: ChatSendInput): Promise<{ requestId: string }>
    cancel(requestId: string): Promise<void>
    onEvent(listener: (event: ChatEvent) => void): () => void
  }
  workflows: {
    list(query?: WorkflowQuery): Promise<WorkflowSummary[]>
    get(id: string, version?: string): Promise<WorkflowDetail>
    setEnabled(id: string, enabled: boolean): Promise<void>
    installProject(projectId: string): Promise<WorkflowDetail>
  }
  developer: {
    createProject(name: string): Promise<DeveloperProject>
    registerProject(): Promise<DeveloperProject | null>
    readFile(projectId: string, relativePath: string): Promise<string>
    writeFile(projectId: string, relativePath: string, content: string): Promise<void>
    validate(projectId: string): Promise<ValidationResult>
    run(input: DeveloperRunInput): Promise<{ executionId: string }>
  }
  executions: {
    list(query?: ExecutionQuery): Promise<ExecutionSummary[]>
    get(executionId: string): Promise<ExecutionDetail>
    decide(input: ApprovalDecision): Promise<void>
    cancel(executionId: string): Promise<void>
    onEvent(listener: (event: ExecutionEvent) => void): () => void
  }
  permissions: {
    listGrants(): Promise<PermissionGrant[]>
    revoke(grantId: string): Promise<void>
  }
  settings: {
    get(): Promise<AppSettings>
    update(patch: AppSettingsPatch): Promise<AppSettings>
    saveOpenRouterKey(apiKey: string): Promise<CredentialStatus>
    clearOpenRouterKey(): Promise<void>
    validateOpenRouterKey(): Promise<CredentialStatus>
    listModels(): Promise<ModelInfo[]>
    clearLocalData(scope: 'conversations' | 'executions' | 'all'): Promise<void>
  }
}
```

Define fixed channel constants beside schemas; do not accept arbitrary channel strings.

- [ ] **Step 4: Run focused and package tests**

Run: `corepack pnpm exec vitest run packages/shared/src/contracts.test.ts`

Expected: PASS for valid discriminators and rejection cases.

Run: `corepack pnpm --filter @autoforge/shared typecheck`

Expected: PASS with no `any` in exported APIs.

- [ ] **Step 5: Commit shared contracts**

```bash
git add packages/shared
git commit -m "feat: define secure desktop contracts"
```

### Task 3: Workflow Manifest, SDK, and Deterministic Retrieval

**Files:**
- Create: `packages/workflow-schema/manifest.schema.json`
- Create: `packages/workflow-schema/src/manifest.ts`
- Create: `packages/workflow-schema/src/validator.ts`
- Create: `packages/workflow-schema/src/validator.test.ts`
- Create: `packages/workflow-sdk/src/context.ts`
- Create: `packages/workflow-sdk/src/define-workflow.ts`
- Create: `packages/workflow-sdk/src/index.ts`
- Create: `apps/desktop/electron/main/workflows/retriever.ts`
- Test: `apps/desktop/electron/main/workflows/retriever.test.ts`

**Interfaces:**
- Produces: `WorkflowManifest`, `validateManifest(value): ValidationResult`, `defineWorkflow<TInput,TOutput>()`, `WorkflowContext`, and `retrieveWorkflows(query, candidates, limit)`.
- Consumes: shared capability and workflow summary types.

- [ ] **Step 1: Write failing schema and retrieval tests**

```ts
it('requires activation examples and exact browser origins', () => {
  const result = validateManifest({ id: 'bad', permissions: [{ capability: 'browser.open' }] })
  expect(result.valid).toBe(false)
})

it('prefers a positive example and excludes a negative example', () => {
  const ranked = retrieveWorkflows('使用百度搜索今日天气', [baiduWorkflow, answerWeatherWorkflow], 3)
  expect(ranked.map((item) => item.id)).toEqual(['browser.search.baidu'])
})
```

- [ ] **Step 2: Verify both tests fail for missing modules**

Run: `corepack pnpm exec vitest run packages/workflow-schema/src/validator.test.ts apps/desktop/electron/main/workflows/retriever.test.ts`

Expected: FAIL because validator and retriever do not exist.

- [ ] **Step 3: Implement Manifest validation and SDK boundaries**

The JSON Schema must set `additionalProperties: false`, require all design fields, validate reverse-DNS IDs, semver versions, relative entry paths, SHA-256 hex strings, `timeoutMs` from 1,000 to 300,000, and browser origins as HTTPS URLs. Compile it once with AJV and `ajv-formats`.

Use this SDK entry contract:

```ts
export interface WorkflowDefinition<TInput, TOutput> {
  run(context: WorkflowContext, input: TInput): Promise<TOutput>
}

export function defineWorkflow<TInput, TOutput>(
  definition: WorkflowDefinition<TInput, TOutput>,
): WorkflowDefinition<TInput, TOutput> {
  return Object.freeze(definition)
}
```

The browser capability exposes `open(url)`, `fill(locator, value)`, `click(locator)`, `url()`, and `close()`; it does not expose a raw Playwright page.

- [ ] **Step 4: Implement deterministic ranking**

Normalize Chinese and Latin text to lowercase tokens. Score exact name `100`, positive activation phrase `60`, description tokens `20`, and category tokens `10`; subtract `120` for each matching negative example. Exclude disabled, invalid, or integrity-failed candidates and return only scores above zero, sorted by score then workflow ID.

- [ ] **Step 5: Verify schema, SDK, and retrieval**

Run: `corepack pnpm exec vitest run packages/workflow-schema packages/workflow-sdk apps/desktop/electron/main/workflows/retriever.test.ts`

Expected: PASS, including negative-example exclusion and stable tie ordering.

- [ ] **Step 6: Commit workflow foundations**

```bash
git add packages/workflow-schema packages/workflow-sdk apps/desktop/electron/main/workflows/retriever.ts apps/desktop/electron/main/workflows/retriever.test.ts
git commit -m "feat: add workflow schema sdk and retrieval"
```

### Task 4: SQLite Persistence, Settings, and Encrypted Secrets

**Files:**
- Create: `apps/desktop/resources/migrations/0001_init.sql`
- Create: `apps/desktop/electron/main/database/client.ts`
- Create: `apps/desktop/electron/main/database/migrations.ts`
- Create: `apps/desktop/electron/main/database/repositories.ts`
- Create: `apps/desktop/electron/main/database/database.test.ts`
- Create: `apps/desktop/electron/main/security/secret-store.ts`
- Create: `apps/desktop/electron/main/security/secret-store.test.ts`
- Create: `apps/desktop/electron/main/settings/settings-service.ts`

**Interfaces:**
- Produces: `openAppDatabase(path)`, repositories for every design table, `markInterruptedExecutions()`, `SecretStore`, and `SettingsService`.
- Consumes: Electron async safeStorage methods through an injected `SafeStoragePort` so unit tests do not load Electron.

- [ ] **Step 1: Write failing migration and secret tests**

```ts
it('migrates a fresh database and interrupts abandoned executions', () => {
  const db = openTestDatabase()
  db.executions.insert({ id: 'exec_1', status: 'running', workflowId: 'w', workflowVersion: '1.0.0' })
  expect(db.executions.markInterrupted()).toBe(1)
  expect(db.executions.get('exec_1')?.status).toBe('interrupted')
})

it('never stores the OpenRouter key as plaintext', async () => {
  const port = fakeSafeStorage()
  const store = new SecretStore(secretRepository, port)
  await store.set('openrouter_api_key', 'sk-or-secret')
  expect(secretRepository.raw('openrouter_api_key')).not.toContain('sk-or-secret')
  expect(await store.get('openrouter_api_key')).toBe('sk-or-secret')
})
```

- [ ] **Step 2: Verify tests fail before database code exists**

Run: `corepack pnpm exec vitest run apps/desktop/electron/main/database/database.test.ts apps/desktop/electron/main/security/secret-store.test.ts`

Expected: FAIL with missing database and secret-store modules.

- [ ] **Step 3: Create schema and repositories**

The migration must create all tables from the design with foreign keys enabled, unique `(workflow_id, version)` installation identity, indexed execution status/timestamps, ordered message blocks, and permission uniqueness over `(workflow_id, workflow_version, capability, scope_hash)`. Repository mutations that update chat runs, executions, and messages must use transactions.

- [ ] **Step 4: Implement asynchronous safeStorage adapter**

```ts
export interface SafeStoragePort {
  isAvailable(): Promise<boolean>
  encrypt(value: string): Promise<Buffer>
  decrypt(value: Buffer): Promise<{ value: string; shouldReEncrypt: boolean }>
}
```

Reject saving a key when encryption is unavailable. Store encrypted bytes as base64. If decryption reports `shouldReEncrypt`, rewrite the secret in the same operation.

- [ ] **Step 5: Verify migrations, transactions, recovery, and encryption**

Run: `corepack pnpm exec vitest run apps/desktop/electron/main/database apps/desktop/electron/main/security`

Expected: PASS with a temporary on-disk SQLite database and no plaintext secret.

- [ ] **Step 6: Commit persistence**

```bash
git add apps/desktop/resources/migrations apps/desktop/electron/main/database apps/desktop/electron/main/security apps/desktop/electron/main/settings
git commit -m "feat: persist app state and encrypted secrets"
```

### Task 5: Workflow Projects, Build, Install, and Integrity

**Files:**
- Create: `apps/desktop/electron/main/workflows/project-service.ts`
- Create: `apps/desktop/electron/main/workflows/registry.ts`
- Create: `apps/desktop/electron/main/workflows/project-service.test.ts`
- Create: `apps/desktop/electron/main/security/redaction.ts`
- Create: `apps/desktop/electron/main/security/redaction.test.ts`

**Interfaces:**
- Produces: `WorkflowProjectService.create/register/read/write/validate/build/install`, `WorkflowRegistry.list/get/setEnabled/verifyIntegrity`, and `redact(value, sensitivePaths)`.
- Consumes: manifest validator, esbuild, chokidar, database repositories, and SHA-256.

- [ ] **Step 1: Write failing project safety and integrity tests**

```ts
it('rejects a file path that escapes the registered project', async () => {
  await expect(service.readFile('project_1', '../secret.txt')).rejects.toMatchObject({ code: 'PATH_OUTSIDE_PROJECT' })
})

it('disables an installed workflow when a declared file hash changes', async () => {
  await tamperWith(installedEntry)
  const result = await registry.verifyIntegrity('browser.search.baidu', '1.0.0')
  expect(result).toEqual({ valid: false, disabled: true })
})
```

- [ ] **Step 2: Verify focused tests fail**

Run: `corepack pnpm exec vitest run apps/desktop/electron/main/workflows/project-service.test.ts apps/desktop/electron/main/security/redaction.test.ts`

Expected: FAIL because services are missing.

- [ ] **Step 3: Implement project boundaries and builds**

Resolve every relative path, verify it remains within the canonical project root, allow only UTF-8 files under the project, and cap editable files at 2 MiB. Build `src/index.ts` with esbuild to a single ESM `dist/index.js`, externalizing only `@autoforge/workflow-sdk`. Revalidate the Manifest after build, hash every declared file, and install by copying into an application-owned version directory through a temporary directory plus atomic rename.

- [ ] **Step 4: Implement registry and redaction**

Registry results must distinguish `installed` and `development` sources. Development candidates require developer mode, a current successful build, and a valid Manifest. Redaction recursively replaces authorization headers, cookies, tokens, API keys, and Manifest-sensitive input paths with `[REDACTED]` before persistence or IPC.

- [ ] **Step 5: Verify project and integrity behavior**

Run: `corepack pnpm exec vitest run apps/desktop/electron/main/workflows apps/desktop/electron/main/security/redaction.test.ts`

Expected: PASS for path traversal, build failure, invalid Manifest, atomic installation, tampering, and secret redaction.

- [ ] **Step 6: Commit workflow lifecycle**

```bash
git add apps/desktop/electron/main/workflows apps/desktop/electron/main/security/redaction.ts apps/desktop/electron/main/security/redaction.test.ts
git commit -m "feat: manage local workflow lifecycle"
```

### Task 6: Permission Policy, Worker Protocol, and Execution State Machine

**Files:**
- Create: `apps/desktop/electron/main/permissions/policy-engine.ts`
- Create: `apps/desktop/electron/main/permissions/policy-engine.test.ts`
- Create: `apps/desktop/electron/main/workflows/execution-service.ts`
- Create: `apps/desktop/electron/main/workflows/execution-service.test.ts`
- Create: `apps/desktop/electron/workers/workflow-runner.ts`

**Interfaces:**
- Produces: `PolicyEngine.evaluate/record/revoke`, `ExecutionService.start/decide/cancel`, and a worker executable that consumes and emits shared protocol messages.
- Consumes: permission and execution repositories, workflow registry, redactor, and `child_process.fork`.

- [ ] **Step 1: Write failing permission and execution tests**

```ts
it('invalidates an always grant after workflow version changes', () => {
  policy.record(alwaysGrant({ version: '1.0.0' }))
  expect(policy.evaluate(request({ version: '1.1.0' }))).toEqual({ allowed: false, requiresApproval: true })
})

it('kills a timed-out worker and stores a terminal failure', async () => {
  const execution = await service.start(runFixture({ timeoutMs: 20 }))
  await execution.finished
  expect(repository.get(execution.id)?.status).toBe('failed')
  expect(workerPort.wasTerminated(execution.id)).toBe(true)
})
```

- [ ] **Step 2: Verify the tests fail**

Run: `corepack pnpm exec vitest run apps/desktop/electron/main/permissions apps/desktop/electron/main/workflows/execution-service.test.ts`

Expected: FAIL with missing policy and execution services.

- [ ] **Step 3: Implement exact permission matching**

Canonicalize scopes by sorting keys and arrays before SHA-256 hashing. A saved grant matches only workflow ID, exact version, capability, and exact canonical scope. `once` grants are in-memory and execution-bound; `always` grants persist. Never auto-approve a broader origin or capability from a narrower grant.

- [ ] **Step 4: Implement Worker lifecycle**

Fork the bundled runner with stdio pipes, `cwd` set to a fresh temporary execution directory, and `env` restricted to locale, platform runtime essentials, and an execution nonce. Send one `start` message, parse one JSON object per line through shared Zod schemas, reject lines over 1 MiB, and terminate on protocol violation, timeout, cancellation, or child exit. Persist state transitions and emit renderer events after the transaction commits.

- [ ] **Step 5: Verify state transitions and cleanup**

Run: `corepack pnpm exec vitest run apps/desktop/electron/main/permissions apps/desktop/electron/main/workflows/execution-service.test.ts`

Expected: PASS for approval pause/resume, exact grant matching, cancellation, timeout, invalid JSON, oversized messages, and crash cleanup.

- [ ] **Step 6: Commit execution isolation**

```bash
git add apps/desktop/electron/main/permissions apps/desktop/electron/main/workflows/execution-service.ts apps/desktop/electron/main/workflows/execution-service.test.ts apps/desktop/electron/workers/workflow-runner.ts
git commit -m "feat: isolate and authorize workflow execution"
```

### Task 7: Visible Chromium Capability Broker

**Files:**
- Create: `apps/desktop/electron/main/browser/browser-capability.ts`
- Create: `apps/desktop/electron/main/browser/browser-capability.test.ts`
- Create: `apps/desktop/scripts/stage-browser.mjs`

**Interfaces:**
- Produces: `BrowserCapabilityService.open/fill/click/url/close/closeExecution`.
- Consumes: Playwright Chromium, policy engine, execution service event sink, and per-execution browser ownership.

- [ ] **Step 1: Write failing origin and ownership tests**

```ts
it('rejects navigation outside the granted origin', async () => {
  await expect(browser.open(context, 'https://example.com')).rejects.toMatchObject({ code: 'CAPABILITY_SCOPE_DENIED' })
})

it('closes every context owned by a cancelled execution', async () => {
  await browser.open(approvedContext, fixtureUrl)
  await browser.closeExecution(approvedContext.executionId)
  expect(browser.activeContexts(approvedContext.executionId)).toBe(0)
})
```

- [ ] **Step 2: Verify tests fail**

Run: `corepack pnpm exec vitest run apps/desktop/electron/main/browser/browser-capability.test.ts`

Expected: FAIL because the capability service is missing.

- [ ] **Step 3: Implement the broker**

Launch Chromium with `headless: false`, create one persistent temporary profile per execution, and associate every context and page with `executionId`. Before each `open`, `fill`, or `click`, ask Policy Engine to validate the exact declared capability and origin. Convert only role/name and CSS locators from SDK requests to Playwright locators; require exactly one matching element before interaction and return a safe ambiguity error otherwise.

`stage-browser.mjs` obtains `chromium.executablePath()`, copies the containing Playwright browser directory into `apps/desktop/resources/ms-playwright`, and writes a small `browser-runtime.json` with the relative executable path. Development uses the installed Playwright cache. Packaged startup reads the manifest, resolves it under `process.resourcesPath`, verifies the executable exists, and passes that explicit path to `chromium.launch`; it never downloads a browser at runtime.

- [ ] **Step 4: Add real fixture-page integration coverage**

Serve a local HTTP fixture only in tests, authorize its exact origin, verify fill/click/result, then assert the context directory is deleted after close. The production manifest rejects HTTP origins; the test-only policy port explicitly permits the loopback fixture.

- [ ] **Step 5: Run browser tests visibly and headlessly in CI mode**

Run: `corepack pnpm exec vitest run apps/desktop/electron/main/browser/browser-capability.test.ts`

Expected: PASS locally with a visible browser for the behavior test and PASS under `CI=1` with the test port configured for headless execution.

- [ ] **Step 6: Commit browser capability**

```bash
git add apps/desktop/electron/main/browser
git commit -m "feat: broker visible browser automation"
```

### Task 8: OpenRouter Streaming and Agent Orchestration

**Files:**
- Create: `apps/desktop/electron/main/chat/openrouter-provider.ts`
- Create: `apps/desktop/electron/main/chat/openrouter-provider.test.ts`
- Create: `apps/desktop/electron/main/agent/agent-orchestrator.ts`
- Create: `apps/desktop/electron/main/agent/agent-orchestrator.test.ts`
- Test: `apps/desktop/tests/integration/agent-workflow.test.ts`

**Interfaces:**
- Produces: `OpenRouterProvider.listModels/validateCredential/stream`, `AgentOrchestrator.run/cancel/resumeApproval`.
- Consumes: secret store, repositories, retriever, policy engine, execution service, and event sinks.

- [ ] **Step 1: Write failing SSE and orchestration tests**

```ts
it('ignores SSE comments and assembles streamed tool-call arguments', async () => {
  const events = await collect(provider.stream(request, fixtureSseWithCommentsAndToolCall))
  expect(events.at(-1)).toEqual({ type: 'tool_call', id: 'call_1', name: 'browser.search.baidu', arguments: { keyword: '今日天气' } })
})

it('pauses for approval before starting a matched workflow', async () => {
  const run = await orchestrator.run(userMessage('使用百度搜索“今日天气”'))
  expect(run.status).toBe('awaiting_approval')
  expect(executionPort.started).toHaveLength(0)
})
```

- [ ] **Step 2: Verify provider and orchestrator tests fail**

Run: `corepack pnpm exec vitest run apps/desktop/electron/main/chat apps/desktop/electron/main/agent`

Expected: FAIL because provider and orchestrator are absent.

- [ ] **Step 3: Implement OpenRouter Provider**

Use `fetch` against `https://openrouter.ai/api/v1/chat/completions`, Bearer auth, `stream: true`, and `eventsource-parser`. Ignore SSE comments, merge text deltas and indexed tool-call deltas, capture usage and generation ID, and map HTTP/network errors to stable app errors. Retry only network failures, 429, and 5xx with bounded jittered backoff; never retry 400/401/403 or cancellation. List tool-capable text models from `/api/v1/models?supported_parameters=tools`.

- [ ] **Step 4: Implement the Agent loop**

Limit one run to eight model turns and one active tool execution at a time. Persist the user message before calling the provider. Convert retrieved manifests to tool definitions, validate tool arguments, create an execution, pause on approval, append the tool result with the original tool call ID, then request the final answer. Persist partial text on interruption and mark the run terminal in one transaction.

- [ ] **Step 5: Verify the complete local test-provider loop**

Run: `corepack pnpm exec vitest run apps/desktop/electron/main/chat apps/desktop/electron/main/agent apps/desktop/tests/integration/agent-workflow.test.ts`

Expected: PASS for text streaming, comment frames, tool-call assembly, approval, tool-result round trip, retry classes, cancellation, and partial-message persistence.

- [ ] **Step 6: Commit chat orchestration**

```bash
git add apps/desktop/electron/main/chat apps/desktop/electron/main/agent apps/desktop/tests/integration/agent-workflow.test.ts
git commit -m "feat: orchestrate OpenRouter workflow chat"
```

### Task 9: Electron Main, Typed Preload, and IPC Validation

**Files:**
- Create: `apps/desktop/electron/main/window.ts`
- Create: `apps/desktop/electron/main/ipc/register-ipc.ts`
- Create: `apps/desktop/electron/main/ipc/register-ipc.test.ts`
- Create: `apps/desktop/electron/main/index.ts`
- Create: `apps/desktop/electron/preload/index.ts`
- Create: `apps/desktop/electron/preload/index.d.ts`

**Interfaces:**
- Produces: secure `BrowserWindow`, all fixed IPC handlers, `window.autoForge: DesktopAPI`, startup migration and recovery.
- Consumes: every main service and shared IPC schema.

- [ ] **Step 1: Write failing IPC security tests**

```ts
it('rejects an invalid chat request before invoking the orchestrator', async () => {
  await expect(invoke('chat:send', { conversationId: '', content: '' })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  expect(orchestrator.run).not.toHaveBeenCalled()
})

it('rejects a request from an untrusted sender', async () => {
  await expect(invokeFrom('https://attacker.invalid', 'settings:get')).rejects.toMatchObject({ code: 'UNTRUSTED_SENDER' })
})
```

- [ ] **Step 2: Verify IPC tests fail**

Run: `corepack pnpm exec vitest run apps/desktop/electron/main/ipc/register-ipc.test.ts`

Expected: FAIL because IPC registration is absent.

- [ ] **Step 3: Implement window security and startup**

Create the main window only after `app.whenReady()`, database migration, and interrupted-execution recovery. Enable context isolation, sandbox, and web security; disable Node integration. Deny permission requests, restrict navigation to the application origin, deny window creation, and open only validated HTTPS links via `shell.openExternal`.

- [ ] **Step 4: Implement fixed IPC and preload**

Register one handler per shared channel. Validate sender and input before service invocation, validate outputs before returning, and convert all failures through `toSafeAppError`. Preload exposes a literal nested object matching `DesktopAPI`; event subscriptions remove exactly the listener they added and return an unsubscribe function.

- [ ] **Step 5: Verify IPC and Electron bundle**

Run: `corepack pnpm exec vitest run apps/desktop/electron/main/ipc && corepack pnpm --filter @autoforge/desktop build`

Expected: PASS and bundles for main, preload, renderer, and workflow runner with no renderer import of Node built-ins.

- [ ] **Step 6: Commit Electron boundaries**

```bash
git add apps/desktop/electron/main/index.ts apps/desktop/electron/main/window.ts apps/desktop/electron/main/ipc apps/desktop/electron/preload apps/desktop/electron.vite.config.ts
git commit -m "feat: expose secure Electron application bridge"
```

### Task 10: Four-Zone Vue Workbench and Product Pages

**Files:**
- Create: `apps/desktop/src/styles/index.css`
- Create: `apps/desktop/src/router/index.ts`
- Create: `apps/desktop/src/services/desktop-api.ts`
- Create: `apps/desktop/src/layouts/WorkbenchLayout.vue`
- Create: `apps/desktop/src/components/AppRail.vue`
- Create: `apps/desktop/src/components/ContextSidebar.vue`
- Create: `apps/desktop/src/components/InspectorPanel.vue`
- Create: `apps/desktop/src/components/chat/MessageBlock.vue`
- Create: `apps/desktop/src/components/chat/ApprovalCard.vue`
- Create: `apps/desktop/src/components/chat/ExecutionCard.vue`
- Create: `apps/desktop/src/components/chat/ChatComposer.vue`
- Create: `apps/desktop/src/stores/{chat,execution,workflow,settings}.ts`
- Create: `apps/desktop/src/views/{Chat,Workflows,Executions,Settings}View.vue`
- Test: `apps/desktop/tests/components/workbench.test.ts`
- Test: `apps/desktop/tests/components/chat.test.ts`

**Interfaces:**
- Produces: the exact five-item navigation, structured chat blocks, approval actions, workflow management, execution history, and settings UI.
- Consumes: `window.autoForge`, shared DTOs, Vue Router, Pinia, Element Plus, and Tailwind.

- [ ] **Step 1: Write failing navigation and approval tests**

```ts
it('renders exactly the five confirmed navigation items', () => {
  const wrapper = mountApp('/chat')
  expect(wrapper.findAll('[data-testid="app-nav-item"]').map((item) => item.text()))
    .toEqual(['聊天', '工作流', '开发', '执行记录', '设置'])
})

it('submits an exact once approval from the chat card', async () => {
  const wrapper = mountChatWithApproval('exec_1')
  await wrapper.get('[data-testid="approve-once"]').trigger('click')
  expect(api.executions.decide).toHaveBeenCalledWith({ executionId: 'exec_1', decision: 'once' })
})
```

- [ ] **Step 2: Verify component tests fail**

Run: `corepack pnpm exec vitest run apps/desktop/tests/components/workbench.test.ts apps/desktop/tests/components/chat.test.ts`

Expected: FAIL because the layout and chat components are absent.

- [ ] **Step 3: Implement the workbench shell**

Use a 52px app rail, a route-specific 240px context sidebar, a fluid central workspace, and a collapsible 320px inspector. At widths below 1180px, collapse the inspector behind a button; keep the app rail and current task reachable. Apply Tailwind through `@tailwindcss/vite`, use Element Plus controls/icons, and define CSS variables for the confirmed cool gray, graphite, cobalt, warning, and success palette.

- [ ] **Step 4: Implement stores and pages against real API state**

Stores load from `desktopApi`; they do not create sample conversations or workflows. Chat subscribes once to chat and execution events and updates blocks by stable IDs. Workflows shows loading, empty, error, installed, development, enabled, disabled, and integrity-failed states. Settings never reads back the stored key; it displays credential status only.

- [ ] **Step 5: Verify components and responsive layout state**

Run: `corepack pnpm exec vitest run apps/desktop/tests/components`

Expected: PASS for navigation, responsive inspector control, stream updates, approval choices, empty/error states, enable/disable, cancellation, and credential-status display.

- [ ] **Step 6: Commit the product UI**

```bash
git add apps/desktop/src apps/desktop/tests/components apps/desktop/index.html
git commit -m "feat: build AutoForge desktop workbench"
```

### Task 11: Monaco Developer Workbench and Baidu Example

**Files:**
- Create: `apps/desktop/src/components/developer/CodeEditor.vue`
- Create: `apps/desktop/src/components/developer/FileTree.vue`
- Create: `apps/desktop/src/components/developer/DebugPanel.vue`
- Create: `apps/desktop/src/stores/developer.ts`
- Create: `apps/desktop/src/views/DeveloperView.vue`
- Create: `apps/desktop/tests/components/developer.test.ts`
- Create: `examples/browser-search-baidu/manifest.json`
- Create: `examples/browser-search-baidu/src/index.ts`
- Create: `examples/browser-search-baidu/package.json`
- Create: `examples/browser-search-baidu/tsconfig.json`
- Test: `examples/browser-search-baidu/src/index.test.ts`

**Interfaces:**
- Produces: file tree, Monaco editing, debounced save/validate, debug input form, execution log/result display, and a valid real example workflow.
- Consumes: developer DesktopAPI, workflow SDK, Manifest schema, Monaco workers, and browser capability.

- [ ] **Step 1: Write failing editor and example tests**

```ts
it('saves edited content and refreshes validation without exposing a filesystem API', async () => {
  const wrapper = mountDeveloperProject(projectFixture)
  editorHarness.setValue('export default defineWorkflow({ async run() { return {} } })')
  await vi.advanceTimersByTimeAsync(400)
  expect(api.developer.writeFile).toHaveBeenCalledWith('project_1', 'src/index.ts', expect.any(String))
  expect(api.developer.validate).toHaveBeenCalledWith('project_1')
})

it('opens Baidu, fills the keyword, and clicks the named button through ctx.browser', async () => {
  const result = await workflow.run(context, { keyword: '今日天气' })
  expect(context.browser.calls).toEqual([
    ['open', 'https://www.baidu.com'],
    ['fill', { role: 'textbox' }, '今日天气'],
    ['click', { role: 'button', name: '百度一下' }],
  ])
  expect(result.success).toBe(true)
})
```

- [ ] **Step 2: Verify editor and example tests fail**

Run: `corepack pnpm exec vitest run apps/desktop/tests/components/developer.test.ts examples/browser-search-baidu/src/index.test.ts`

Expected: FAIL because the developer workbench and example do not exist.

- [ ] **Step 3: Implement Monaco with Vite workers**

Register editor, JSON, TypeScript, and CSS workers through `self.MonacoEnvironment.getWorker`. Dispose editor models and workers on unmount. Load only the selected project file through DesktopAPI, save after a 400ms idle delay, show dirty/saving/saved states, and render returned validation diagnostics without reading local paths directly.

- [ ] **Step 4: Implement debug UI and valid example**

Generate the debug form from Manifest `inputSchema`, allow only declared permission simulation, and stream execution events into the debug console. The example Manifest uses ID `browser.search.baidu`, version `1.0.0`, exact `https://www.baidu.com` origins, positive and negative examples, a 30-second timeout, and SHA-256 entries produced by the build step. Its workflow calls only `ctx.logger` and `ctx.browser`.

- [ ] **Step 5: Verify developer loop**

Run: `corepack pnpm exec vitest run apps/desktop/tests/components/developer.test.ts examples/browser-search-baidu`

Expected: PASS for file selection, delayed save, diagnostics, schema-driven inputs, debug cancellation, and browser call order.

Run: `corepack pnpm --filter @autoforge/desktop build`

Expected: Monaco workers and example workflow assets are present in the production output.

- [ ] **Step 6: Commit developer mode and example**

```bash
git add apps/desktop/src/components/developer apps/desktop/src/stores/developer.ts apps/desktop/src/views/DeveloperView.vue apps/desktop/tests/components/developer.test.ts examples/browser-search-baidu
git commit -m "feat: add workflow developer workbench"
```

### Task 12: Electron E2E, Packaging, CI, and Documentation

**Files:**
- Create: `tests/e2e/app.spec.ts`
- Create: `playwright.config.ts`
- Create: `apps/desktop/electron-builder.yml`
- Create: `.github/workflows/ci.yml`
- Create: `README.md`
- Create: `docs/architecture.md`
- Create: `docs/development.md`
- Create: `docs/security.md`
- Create: `.env.example`

**Interfaces:**
- Produces: release-ready directory builds, macOS DMG/ZIP and Windows NSIS/portable configuration, CI verification, and reproducible local setup documentation.
- Consumes: completed desktop application and the local integration Provider available only under test environment flags.

- [ ] **Step 1: Write failing Electron E2E**

```ts
test('completes the local chat to approved workflow loop', async ({}, testInfo) => {
  const app = await launchAutoForge(testInfo)
  const window = await app.firstWindow()
  await window.getByTestId('openrouter-test-provider').click()
  await window.getByTestId('chat-input').fill('使用百度搜索“今日天气”')
  await window.getByTestId('send-message').click()
  await expect(window.getByTestId('approval-card')).toBeVisible()
  await window.getByTestId('approve-once').click()
  await expect(window.getByTestId('execution-status')).toHaveText('执行成功')
  await expect(window.getByTestId('assistant-message')).toContainText('已完成百度搜索')
  await app.close()
})
```

- [ ] **Step 2: Verify the E2E fails before test bootstrap and selectors exist**

Run: `corepack pnpm test:e2e --grep "local chat to approved workflow loop"`

Expected: FAIL because E2E launch helpers and deterministic test Provider wiring are not complete.

- [ ] **Step 3: Implement test-only bootstrap and remaining E2E cases**

Gate the local Provider behind `AUTOFORGE_E2E=1`; production builds must tree-shake or reject it when the flag is absent. Add tests for first launch, conversation persistence, developer example validation/install, execution cancellation, and interrupted-run recovery. Use temporary user-data directories for every test and clean them after application exit.

- [ ] **Step 4: Configure packaging and CI**

electron-builder must package application resources, SQLite migration, bundled worker, Monaco assets, and platform Chromium. Unpack native modules and Playwright browser resources from ASAR. Configure macOS `dmg` and `zip`, Windows `nsis` and `portable`, artifact names with version/arch, and signing environment variables without secrets. CI runs lint, typecheck, unit/integration tests, build, and Electron E2E on macOS and Windows; packaging uses unsigned directory output unless signing credentials are present.

- [ ] **Step 5: Write operational documentation**

README must document prerequisites, `corepack pnpm install`, `pnpm dev`, API Key setup, developer workflow, verification commands, and platform packaging. Architecture and security docs must state the trust boundary, IPC validation, Worker isolation, permission model, credential storage, log redaction, and the fact that Windows `safeStorage` protects against other users but not every process under the same user account.

- [ ] **Step 6: Run the full release gate**

Run: `corepack pnpm lint`

Expected: exit 0, no warnings configured as errors.

Run: `corepack pnpm typecheck`

Expected: exit 0 across shared, schema, SDK, main, preload, worker, and renderer.

Run: `corepack pnpm test`

Expected: all contract, unit, component, and integration tests pass.

Run: `corepack pnpm test:e2e`

Expected: all Electron E2E tests pass and no Electron, Worker, or Chromium processes remain.

Run: `corepack pnpm build && corepack pnpm dist:dir`

Expected: production bundles and a launchable unsigned macOS directory package on the current host; Windows CI produces its corresponding directory package.

- [ ] **Step 7: Inspect the production UI at both target sizes**

Launch the directory package and capture 1440×1024 and 1180×720 screenshots of Chat and Developer pages. Verify no clipped navigation, unreachable approval action, overlapping inspector, blank Monaco editor, console error, or missing icon. Store QA images under `artifacts/qa/` only if they are intentionally part of the final handoff.

- [ ] **Step 8: Commit release verification**

```bash
git add tests/e2e playwright.config.ts apps/desktop/electron-builder.yml .github/workflows/ci.yml README.md docs/architecture.md docs/development.md docs/security.md .env.example
git commit -m "test: verify AutoForge production desktop app"
```

---

## Final Verification and Handoff

- Confirm `git status --short` contains only user-owned unrelated changes.
- Confirm no API key, token, cookie, local database, log, browser profile, or `.env` file is tracked.
- Confirm every committed line is attributable to the approved desktop MVP.
- Report macOS checks actually run on the current host separately from Windows checks run in CI; do not claim a Windows package was verified locally on macOS.
- Report any signing or notarization step as pending until real credentials are supplied.

## Official References Used

- Electron security checklist: https://www.electronjs.org/docs/latest/tutorial/security
- Electron safeStorage: https://www.electronjs.org/docs/latest/api/safe-storage
- electron-vite TypeScript guide: https://electron-vite.org/guide/typescript
- OpenRouter API reference: https://openrouter.ai/docs/api/reference/overview
- OpenRouter streaming: https://openrouter.ai/docs/api/reference/streaming
- OpenRouter tool calling: https://openrouter.ai/docs/guides/features/tool-calling
