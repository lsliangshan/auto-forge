# DeepSeek Default Provider and API Key Status Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make DeepSeek the default provider for new and provider-less legacy settings while showing a clear locally persisted API Key status for each provider.

**Architecture:** Keep the existing provider registry, `SecretStore`, `safeStorage`, SQLite `encrypted_secrets` repository, IPC contracts, and provider-scoped Renderer state. Change only default selection and normalization fallback behavior, then derive the user-facing “已设置 API Key” copy from the existing `ProviderCredentialStatus.configured` field.

**Tech Stack:** Electron, Vue 3, TypeScript, Pinia, SQLite/Drizzle, Vitest, Element Plus

## Global Constraints

- API Keys remain Main-only and are encrypted with Electron `safeStorage` before SQLite persistence.
- DeepSeek and OpenRouter continue to use independent `deepseek_api_key` and `openrouter_api_key` records.
- Existing explicit `activeProvider: 'openrouter'` and `activeProvider: 'deepseek'` choices must be preserved.
- Missing or invalid legacy `activeProvider` values normalize to DeepSeek.
- A successful local write displays `API Key 已保存到本地数据库`.
- Renderer state, IPC responses, logs, and errors never contain an API Key.
- Do not add a duplicate `hasApiKey` setting or a new credential table.

---

### Task 1: DeepSeek Default and Legacy Normalization

**Files:**
- Modify: `apps/desktop/electron/main/settings/settings-service.test.ts`
- Modify: `apps/desktop/electron/main/settings/settings-service.ts`
- Modify: `apps/desktop/electron/main/application.ts`
- Modify: `apps/desktop/src/stores/settings.ts`
- Modify: `apps/desktop/src/views/SettingsView.vue`
- Modify: `apps/desktop/tests/components/workbench.test.ts`

**Interfaces:**
- Consumes: `AppSettings.activeProvider: 'deepseek' | 'openrouter'`
- Produces: `SettingsService.get()` that preserves explicit valid choices and uses `defaults.activeProvider` when the stored field is absent or invalid.
- Produces: Renderer fallback values that are DeepSeek before persisted settings finish loading.

- [ ] **Step 1: Write failing settings normalization tests**

In `apps/desktop/electron/main/settings/settings-service.test.ts`, change the test defaults to DeepSeek and add explicit coverage:

```ts
const defaults: AppSettings = {
  theme: 'system',
  language: 'zh-CN',
  dataDirectory: '/data',
  logDirectory: '/logs',
  activeProvider: 'deepseek',
  defaultModels: {
    openrouter: 'openai/gpt-4.1-mini',
    deepseek: 'deepseek-v4-flash',
  },
  showCosts: true,
  developerMode: false,
  permissionDefault: 'ask',
}

it('uses DeepSeek when legacy settings do not contain a provider', () => {
  const service = new SettingsService(settingsRepository({
    theme: 'dark',
    defaultModel: 'legacy/openrouter-model',
  }), defaults)

  expect(service.get().activeProvider).toBe('deepseek')
})

it('preserves an explicitly saved OpenRouter provider', () => {
  const service = new SettingsService(settingsRepository({
    activeProvider: 'openrouter',
  }), defaults)

  expect(service.get().activeProvider).toBe('openrouter')
})

it('uses DeepSeek when a legacy provider value is invalid', () => {
  const service = new SettingsService(settingsRepository({
    activeProvider: 'custom-provider',
  }), defaults)

  expect(service.get().activeProvider).toBe('deepseek')
})
```

Update the existing legacy migration expectation from `activeProvider: 'openrouter'` to `activeProvider: 'deepseek'`.

- [ ] **Step 2: Run the settings test and verify RED**

Run:

```bash
corepack pnpm exec vitest run --config vitest.node.config.ts electron/main/settings/settings-service.test.ts
```

Working directory: `apps/desktop`

Expected: the provider-less legacy test fails because `SettingsService.normalize()` currently defaults every non-DeepSeek value to OpenRouter.

- [ ] **Step 3: Implement the minimal normalization change**

In `apps/desktop/electron/main/settings/settings-service.ts`, replace the binary fallback with explicit preservation plus the configured default:

```ts
activeProvider: stored.activeProvider === 'deepseek'
  ? 'deepseek'
  : stored.activeProvider === 'openrouter'
    ? 'openrouter'
    : this.defaults.activeProvider,
```

Do not change the legacy `defaultModel` to `defaultModels.openrouter` migration.

- [ ] **Step 4: Add failing application and Renderer default assertions**

In `apps/desktop/electron/main/application.test.ts`, add an assertion before any provider update:

```ts
await expect(runtime.services.settings.get()).resolves.toMatchObject({
  activeProvider: 'deepseek',
})
```

In the `createApi()` fixture in `apps/desktop/tests/components/workbench.test.ts`, change:

```ts
activeProvider: 'deepseek'
```

Add a store fallback test:

```ts
it('uses DeepSeek while persisted settings are not loaded', () => {
  Object.defineProperty(window, 'autoForge', { configurable: true, value: createApi() })
  const store = useSettingsStore()

  expect(store.activeProvider).toBe('deepseek')
})
```

- [ ] **Step 5: Run the application and Renderer tests and verify RED**

Run:

```bash
corepack pnpm exec vitest run --config vitest.node.config.ts electron/main/application.test.ts
corepack pnpm exec vitest run --config vitest.config.ts tests/components/workbench.test.ts
```

Working directory: `apps/desktop`

Expected: the application default assertion and unloaded store fallback fail because both still use OpenRouter.

- [ ] **Step 6: Change the production defaults**

In `apps/desktop/electron/main/application.ts`, set:

```ts
activeProvider: 'deepseek',
```

In `apps/desktop/src/stores/settings.ts`, set the getter fallback:

```ts
activeProvider: (state): ModelProviderId => state.settings?.activeProvider ?? 'deepseek',
```

In `apps/desktop/src/views/SettingsView.vue`, initialize the local selection consistently:

```ts
const selectedProvider = ref<ModelProviderId>('deepseek')
```

- [ ] **Step 7: Run Task 1 tests and verify GREEN**

Run:

```bash
corepack pnpm exec vitest run --config vitest.node.config.ts electron/main/settings/settings-service.test.ts electron/main/application.test.ts
corepack pnpm exec vitest run --config vitest.config.ts tests/components/workbench.test.ts
```

Working directory: `apps/desktop`

Expected: all selected tests pass. The legacy `defaultModel` remains the OpenRouter default model while the active provider becomes DeepSeek.

### Task 2: Persisted API Key Status and Success Feedback

**Files:**
- Modify: `apps/desktop/electron/main/application.test.ts`
- Modify: `apps/desktop/src/views/SettingsView.vue`
- Modify: `apps/desktop/tests/components/workbench.test.ts`

**Interfaces:**
- Consumes: `ProviderCredentialStatus` with `configured` and `validation`.
- Consumes: `DesktopAPI.settings.saveProviderApiKey(provider, apiKey)`.
- Produces: visible status text whose “已设置” portion reflects the presence of the provider’s encrypted SQLite record.

- [ ] **Step 1: Add a database persistence characterization test**

Extend the provider isolation test in `apps/desktop/electron/main/application.test.ts` so the database is closed and reopened after saving both keys:

```ts
await runtime.services.settings.saveProviderApiKey('openrouter', 'sk-openrouter')
await runtime.services.settings.saveProviderApiKey('deepseek', 'sk-deepseek')
await runtime.close()

const restarted = createApplicationRuntime({
  ...runtimeOptions,
  modelProviders: { openrouter, deepseek },
})

await expect(restarted.services.settings.validateProviderCredential('openrouter'))
  .resolves.toMatchObject({ provider: 'openrouter', configured: true })
await expect(restarted.services.settings.validateProviderCredential('deepseek'))
  .resolves.toMatchObject({ provider: 'deepseek', configured: true })
await restarted.close()
```

Keep the runtime options in a shared local constant inside the test so both runtime instances use the same SQLite path and fake `safeStorage`.

- [ ] **Step 2: Run the application test and verify the persistence evidence**

Run:

```bash
corepack pnpm exec vitest run --config vitest.node.config.ts electron/main/application.test.ts
```

Working directory: `apps/desktop`

Expected: PASS if existing local persistence is intact. This is a characterization test; if it fails, fix only the provider-key persistence path before continuing.

- [ ] **Step 3: Write failing status-copy and success-feedback tests**

In `apps/desktop/tests/components/workbench.test.ts`, import `ElMessage` and extend the saved-key test:

```ts
const success = vi.spyOn(ElMessage, 'success')
vi.mocked(api.settings.saveProviderApiKey).mockResolvedValue({
  provider: 'deepseek',
  configured: true,
  validation: 'valid',
})

const { wrapper } = await mountApp('/settings', api)
await vi.waitFor(() => expect(wrapper.find('#provider-api-key').exists()).toBe(true))
await wrapper.get('#provider-api-key').setValue('sk-sensitive-value')
await wrapper.get('[data-testid="save-api-key"]').trigger('click')

await vi.waitFor(() => expect(wrapper.text()).toContain('已设置 API Key · 已验证'))
expect(success).toHaveBeenCalledWith('API Key 已保存到本地数据库')
```

Add a table-driven component test that mounts the settings page with each Main-provided status:

```ts
const labels = [
  [{ provider: 'deepseek', configured: false, validation: 'unchecked' }, '未设置 API Key'],
  [{ provider: 'deepseek', configured: true, validation: 'valid' }, '已设置 API Key · 已验证'],
  [{ provider: 'deepseek', configured: true, validation: 'invalid' }, '已设置 API Key · 验证失败'],
  [{ provider: 'deepseek', configured: true, validation: 'unavailable' }, '已设置 API Key · 暂时无法验证'],
  [{ provider: 'deepseek', configured: true, validation: 'unchecked' }, '已设置 API Key · 尚未验证'],
] as const

for (const [credential, label] of labels) {
  const api = createApi()
  vi.mocked(api.settings.get).mockResolvedValue({
    theme: 'system',
    language: 'zh-CN',
    dataDirectory: '/data',
    logDirectory: '/logs',
    activeProvider: 'deepseek',
    defaultModels: {
      openrouter: 'openai/gpt-4.1-mini',
      deepseek: 'deepseek-v4-flash',
    },
    showCosts: false,
    developerMode: false,
    permissionDefault: 'ask',
  })
  vi.mocked(api.settings.validateProviderCredential).mockResolvedValue(credential)
  const { wrapper } = await mountApp('/settings', api)
  await vi.waitFor(() => expect(wrapper.text()).toContain(label))
  wrapper.unmount()
}
```

- [ ] **Step 4: Run the Renderer test and verify RED**

Run:

```bash
corepack pnpm exec vitest run --config vitest.config.ts tests/components/workbench.test.ts
```

Working directory: `apps/desktop`

Expected: FAIL because the current UI says `已配置并验证` and the success Toast says `凭证已安全保存`.

- [ ] **Step 5: Implement the exact status copy**

In `apps/desktop/src/views/SettingsView.vue`, replace the computed labels with:

```ts
const credentialLabel = computed(() => {
  const credential = settings.credential
  if (!credential?.configured) return '未设置 API Key'
  if (credential.validation === 'valid') return '已设置 API Key · 已验证'
  if (credential.validation === 'invalid') return '已设置 API Key · 验证失败'
  if (credential.validation === 'unavailable') return '已设置 API Key · 暂时无法验证'
  return '已设置 API Key · 尚未验证'
})
```

After `settings.saveCredential(key)` succeeds, use:

```ts
ElMessage.success('API Key 已保存到本地数据库')
```

Do not store a separate UI-only configured flag.

- [ ] **Step 6: Run Task 2 tests and verify GREEN**

Run:

```bash
corepack pnpm exec vitest run --config vitest.node.config.ts electron/main/application.test.ts
corepack pnpm exec vitest run --config vitest.config.ts tests/components/workbench.test.ts
```

Working directory: `apps/desktop`

Expected: persistence, status-copy, success-feedback, and secret-retention assertions all pass.

### Task 3: Full Verification

**Files:**
- Verify only: all changed source and test files

**Interfaces:**
- Consumes: completed Task 1 and Task 2 behavior.
- Produces: evidence that the current working tree passes all automated gates.

- [ ] **Step 1: Run the complete test suite**

Run:

```bash
corepack pnpm test
```

Working directory: repository root

Expected: all tests pass with zero failures.

- [ ] **Step 2: Run type checking**

Run:

```bash
corepack pnpm typecheck
```

Expected: all workspace TypeScript projects pass.

- [ ] **Step 3: Run Lint**

Run:

```bash
corepack pnpm lint
```

Expected: exit code 0 with zero errors. Existing repository Vue formatting warnings may remain.

- [ ] **Step 4: Run the production build**

Run:

```bash
corepack pnpm build
```

Expected: shared packages, Electron Main, Preload, Renderer, and workflow runner build successfully.

- [ ] **Step 5: Check the final diff**

Run:

```bash
git diff --check
git status --short
```

Expected: no whitespace errors. Confirm that implementation files remain uncommitted unless the user explicitly asks for a commit, and that no API Key appears outside test fixtures.
