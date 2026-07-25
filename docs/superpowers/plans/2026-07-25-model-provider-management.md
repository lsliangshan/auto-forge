# Model Provider Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add real `deepseek` and `openrouter` provider management so credentials, model discovery, per-provider defaults, and complete chat/tool-call runs use the selected provider.

**Architecture:** Replace the OpenRouter-only cross-process contract with strict provider-aware contracts, while preserving API keys in Main-only `safeStorage`. Extract the existing tested SSE/retry/tool-call behavior into an OpenAI-compatible core, configure fixed OpenRouter and DeepSeek adapters, and snapshot the selected provider and model when each Agent run starts.

**Tech Stack:** Electron 43, Vue 3, Pinia, TypeScript 6, Zod, Vitest, Element Plus, `eventsource-parser`, SQLite/Drizzle repositories.

## Global Constraints

- Provider IDs are exactly `deepseek` and `openrouter`.
- Provider endpoints are fixed in Main; Renderer cannot submit a Base URL, headers, or Provider object.
- API keys remain Main-only in `safeStorage`; Renderer and IPC responses receive status only.
- Keep the existing `openrouter_api_key`; add `deepseek_api_key`.
- Each provider retains an independently user-editable default model.
- New chats do not automatically fall back to another provider.
- A chat and every tool-call continuation use the provider/model snapshot captured when the chat starts.
- Preserve the current uncommitted OpenRouter fix that accepts `context_length: 0` and omits it from `ModelInfo`.
- Do not include the unrelated uncommitted preload build changes in feature commits.
- Historical `OPENROUTER_REQUEST_FAILED` values remain parseable; new provider failures use `MODEL_PROVIDER_REQUEST_FAILED`.
- Do not claim real upstream verification unless valid user-owned provider credentials are available and an actual request completes.

## File Structure

- Modify `packages/shared/src/desktop-api.ts`: provider IDs, settings shape, credential status, provider-aware IPC and `DesktopAPI`.
- Modify `packages/shared/src/errors.ts`: add the provider-neutral request error while retaining the historical code.
- Modify `packages/shared/src/contracts.test.ts`: strict schema and secret-exposure regression tests.
- Modify `apps/desktop/electron/main/settings/settings-service.ts`: normalize legacy settings and persist the new shape.
- Create `apps/desktop/electron/main/settings/settings-service.test.ts`: focused migration and per-provider default tests.
- Create `apps/desktop/electron/main/chat/model-provider.ts`: provider-neutral message/event contracts and shared OpenAI-compatible SSE/retry implementation.
- Modify `apps/desktop/electron/main/chat/openrouter-provider.ts`: thin OpenRouter configuration and model mapping, including the existing zero-context fix.
- Modify `apps/desktop/electron/main/chat/openrouter-provider.test.ts`: retain OpenRouter behavior and neutral error assertions.
- Create `apps/desktop/electron/main/chat/deepseek-provider.ts`: fixed DeepSeek endpoints and model mapping.
- Create `apps/desktop/electron/main/chat/deepseek-provider.test.ts`: DeepSeek endpoint, key, models, stream, tool, and usage tests.
- Create `apps/desktop/electron/main/chat/model-provider-registry.ts`: exhaustive fixed-provider registry and credential-key mapping.
- Create `apps/desktop/electron/main/chat/model-provider-registry.test.ts`: exact routing and key-isolation tests.
- Modify `apps/desktop/electron/main/ipc/register-ipc.ts` and its test: register provider-aware fixed channels.
- Modify `apps/desktop/electron/preload/bridge.ts` and its test: expose only typed provider-aware methods.
- Modify `apps/desktop/electron/main/agent/agent-orchestrator.ts` and its test: provider-neutral types and one-time Provider resolution.
- Modify `apps/desktop/electron/main/application.ts` and its test: construct the registry, manage provider credentials, and snapshot active settings.
- Modify `apps/desktop/src/stores/settings.ts`: per-provider statuses/catalogs, switching, stale-response guards, and default updates.
- Modify `apps/desktop/src/views/SettingsView.vue`: provider selector, scoped credential actions, and per-provider model selection.
- Modify `apps/desktop/src/views/ChatView.vue`: active-provider models and selection reset.
- Modify `apps/desktop/src/components/ContextSidebar.vue`: rename the credential navigation item.
- Modify `apps/desktop/src/services/desktop-api.ts`: provider-neutral credential/model error copy.
- Modify `apps/desktop/tests/components/workbench.test.ts`: Renderer/store/provider interaction coverage.

---

### Task 1: Shared Provider Contracts and Legacy Settings Migration

**Files:**
- Modify: `packages/shared/src/desktop-api.ts`
- Modify: `packages/shared/src/errors.ts`
- Modify: `packages/shared/src/contracts.test.ts`
- Modify: `apps/desktop/electron/main/settings/settings-service.ts`
- Create: `apps/desktop/electron/main/settings/settings-service.test.ts`

**Interfaces:**
- Produces: `ModelProviderId`, `ProviderDefaultModels`, `ProviderCredentialStatus`.
- Produces: `AppSettings.activeProvider` and `AppSettings.defaultModels`.
- Produces: legacy-to-current normalization in `SettingsService`.
- Produces: `MODEL_PROVIDER_REQUEST_FAILED` while retaining `OPENROUTER_REQUEST_FAILED`.

- [ ] **Step 1: Write failing shared-contract tests**

Add focused cases to `packages/shared/src/contracts.test.ts`:

```ts
import {
  appErrorCodeSchema,
  appSettingsSchema,
  ipcChannels,
  ipcRequestSchemas,
  providerCredentialStatusSchema,
} from './index'

it('accepts only the two fixed model providers and two independent defaults', () => {
  const settings = appSettingsSchema.parse({
    theme: 'system',
    language: 'zh-CN',
    dataDirectory: '/data',
    logDirectory: '/logs',
    activeProvider: 'deepseek',
    defaultModels: {
      deepseek: 'deepseek-v4-flash',
      openrouter: 'openai/gpt-4.1-mini',
    },
    showCosts: true,
    developerMode: false,
    permissionDefault: 'ask',
  })
  expect(settings.activeProvider).toBe('deepseek')
  expect(() => appSettingsSchema.parse({ ...settings, activeProvider: 'custom' })).toThrow()
})

it('requires an explicit provider without allowing a key in status output', () => {
  expect(ipcRequestSchemas[ipcChannels.settingsValidateProviderCredential].parse({
    provider: 'openrouter',
  })).toEqual({ provider: 'openrouter' })
  expect(() => ipcRequestSchemas[ipcChannels.settingsListProviderModels].parse({
    provider: 'custom',
  })).toThrow()
  expect(providerCredentialStatusSchema.parse({
    provider: 'deepseek',
    configured: true,
    validation: 'valid',
  })).not.toHaveProperty('apiKey')
})

it('keeps historical provider errors readable while adding a neutral current error', () => {
  expect(appErrorCodeSchema.parse('OPENROUTER_REQUEST_FAILED')).toBe('OPENROUTER_REQUEST_FAILED')
  expect(appErrorCodeSchema.parse('MODEL_PROVIDER_REQUEST_FAILED')).toBe('MODEL_PROVIDER_REQUEST_FAILED')
})
```

- [ ] **Step 2: Run the shared test and verify RED**

Run:

```bash
pnpm exec vitest run packages/shared/src/contracts.test.ts
```

Expected: FAIL because the provider types, settings fields, channels, credential schema, and neutral error do not exist.

- [ ] **Step 3: Implement the strict shared contracts**

In `packages/shared/src/desktop-api.ts`, replace the single `defaultModel` and OpenRouter-only credential contract with:

```ts
export const modelProviderIdSchema = z.enum(['deepseek', 'openrouter'])
export type ModelProviderId = z.infer<typeof modelProviderIdSchema>

export const providerDefaultModelsSchema = z.object({
  deepseek: nonEmptyStringSchema,
  openrouter: nonEmptyStringSchema,
}).strict()
export type ProviderDefaultModels = z.infer<typeof providerDefaultModelsSchema>

export const appSettingsSchema = z.object({
  theme: z.enum(['light', 'dark', 'system']),
  language: z.enum(['zh-CN', 'en-US']),
  dataDirectory: nonEmptyStringSchema,
  logDirectory: nonEmptyStringSchema,
  activeProvider: modelProviderIdSchema,
  defaultModels: providerDefaultModelsSchema,
  showCosts: z.boolean(),
  developerMode: z.boolean(),
  permissionDefault: z.literal('ask'),
}).strict()

export const providerCredentialStatusSchema = z.object({
  provider: modelProviderIdSchema,
  configured: z.boolean(),
  validation: z.enum(['unchecked', 'valid', 'invalid', 'unavailable']),
  message: z.string().optional(),
  checkedAt: timestampSchema.optional(),
}).strict()
export type ProviderCredentialStatus = z.infer<typeof providerCredentialStatusSchema>
```

Add `MODEL_PROVIDER_REQUEST_FAILED` to `packages/shared/src/errors.ts` with the safe message `The model provider request failed.` Keep the existing OpenRouter code and message for old persisted records.

Define these fixed channels and request schemas:

```ts
settingsSaveProviderApiKey: 'settings:save-provider-api-key',
settingsClearProviderApiKey: 'settings:clear-provider-api-key',
settingsValidateProviderCredential: 'settings:validate-provider-credential',
settingsListProviderModels: 'settings:list-provider-models',

export const providerRequestSchema = z.object({
  provider: modelProviderIdSchema,
}).strict()
export const saveProviderApiKeyRequestSchema = providerRequestSchema.extend({
  apiKey: nonEmptyStringSchema,
}).strict()
```

Update request/response maps and `DesktopAPI.settings` to:

```ts
saveProviderApiKey(provider: ModelProviderId, apiKey: string): Promise<ProviderCredentialStatus>
clearProviderApiKey(provider: ModelProviderId): Promise<void>
validateProviderCredential(provider: ModelProviderId): Promise<ProviderCredentialStatus>
listProviderModels(provider: ModelProviderId): Promise<ModelInfo[]>
```

Remove the four OpenRouter-only methods/channels from the current contract.

- [ ] **Step 4: Write failing settings migration tests**

Create `apps/desktop/electron/main/settings/settings-service.test.ts` with an in-memory `appSettings` repository and these cases:

```ts
it('migrates a legacy defaultModel to the OpenRouter default', () => {
  const { repository } = settingsRepository({
    theme: 'dark',
    language: 'zh-CN',
    dataDirectory: '/data',
    logDirectory: '/logs',
    defaultModel: 'legacy/openrouter-model',
    showCosts: true,
    developerMode: false,
    permissionDefault: 'ask',
  })
  const service = new SettingsService(repository, defaults)

  expect(service.get()).toMatchObject({
    activeProvider: 'openrouter',
    defaultModels: {
      openrouter: 'legacy/openrouter-model',
      deepseek: 'deepseek-v4-flash',
    },
  })
  expect(service.get()).not.toHaveProperty('defaultModel')
})

it('updates one provider default without changing the other', () => {
  const { repository } = settingsRepository()
  const service = new SettingsService(repository, defaults)

  service.update({
    defaultModels: {
      ...service.get().defaultModels,
      deepseek: 'deepseek-v4-pro',
    },
  })

  expect(service.get().defaultModels).toEqual({
    openrouter: 'openai/gpt-4.1-mini',
    deepseek: 'deepseek-v4-pro',
  })
})
```

The `defaults` fixture must use:

```ts
const defaults: AppSettings = {
  theme: 'system',
  language: 'zh-CN',
  dataDirectory: '/data',
  logDirectory: '/logs',
  activeProvider: 'openrouter',
  defaultModels: {
    openrouter: 'openai/gpt-4.1-mini',
    deepseek: 'deepseek-v4-flash',
  },
  showCosts: true,
  developerMode: false,
  permissionDefault: 'ask',
}
```

- [ ] **Step 5: Run the settings test and verify RED**

Run:

```bash
pnpm --filter @autoforge/desktop exec vitest run --config vitest.node.config.ts electron/main/settings/settings-service.test.ts
```

Expected: FAIL because `SettingsService.get()` currently returns the legacy field unchanged.

- [ ] **Step 6: Implement deterministic settings normalization**

In `settings-service.ts`, treat repository data as a legacy-capable raw record and return only current fields:

```ts
type LegacySettings = Partial<AppSettings> & { defaultModel?: unknown }

private normalize(value: unknown): AppSettings {
  const stored = typeof value === 'object' && value !== null
    ? value as LegacySettings
    : {}
  const storedDefaults = typeof stored.defaultModels === 'object' && stored.defaultModels !== null
    ? stored.defaultModels as Partial<ProviderDefaultModels>
    : {}
  return {
    ...this.defaults,
    activeProvider: stored.activeProvider === 'deepseek' ? 'deepseek' : 'openrouter',
    defaultModels: {
      openrouter: typeof storedDefaults.openrouter === 'string' && storedDefaults.openrouter.trim()
        ? storedDefaults.openrouter
        : typeof stored.defaultModel === 'string' && stored.defaultModel.trim()
          ? stored.defaultModel
          : this.defaults.defaultModels.openrouter,
      deepseek: typeof storedDefaults.deepseek === 'string' && storedDefaults.deepseek.trim()
        ? storedDefaults.deepseek
        : this.defaults.defaultModels.deepseek,
    },
    theme: stored.theme ?? this.defaults.theme,
    language: stored.language ?? this.defaults.language,
    dataDirectory: this.defaults.dataDirectory,
    logDirectory: this.defaults.logDirectory,
    showCosts: stored.showCosts ?? this.defaults.showCosts,
    developerMode: stored.developerMode ?? this.defaults.developerMode,
    permissionDefault: 'ask',
  }
}
```

`update()` must merge the normalized current settings with the validated patch and persist only that current shape.

- [ ] **Step 7: Verify Task 1 GREEN**

Run:

```bash
pnpm exec vitest run packages/shared/src/contracts.test.ts
pnpm --filter @autoforge/desktop exec vitest run --config vitest.node.config.ts electron/main/settings/settings-service.test.ts
pnpm typecheck
```

Expected: all commands exit 0.

- [ ] **Step 8: Commit Task 1**

```bash
git add packages/shared/src/desktop-api.ts packages/shared/src/errors.ts packages/shared/src/contracts.test.ts \
  apps/desktop/electron/main/settings/settings-service.ts \
  apps/desktop/electron/main/settings/settings-service.test.ts
git commit -m "feat: add model provider settings contracts"
```

---

### Task 2: Shared OpenAI-Compatible Core and Fixed Provider Registry

**Files:**
- Create: `apps/desktop/electron/main/chat/model-provider.ts`
- Modify: `apps/desktop/electron/main/chat/openrouter-provider.ts`
- Modify: `apps/desktop/electron/main/chat/openrouter-provider.test.ts`
- Create: `apps/desktop/electron/main/chat/deepseek-provider.ts`
- Create: `apps/desktop/electron/main/chat/deepseek-provider.test.ts`
- Create: `apps/desktop/electron/main/chat/model-provider-registry.ts`
- Create: `apps/desktop/electron/main/chat/model-provider-registry.test.ts`

**Interfaces:**
- Consumes: `ModelProviderId`, `ModelInfo`, and provider-neutral errors from Task 1.
- Produces: `ModelMessage`, `ModelTool`, `ModelStreamRequest`, `ModelStreamEvent`, `ModelProvider`.
- Produces: `ModelProviderRegistry.get(provider)` and `credentialKeyForProvider(provider)`.

- [ ] **Step 1: Write failing DeepSeek and registry tests**

Create `deepseek-provider.test.ts` with real `Response` objects and a fake fetch:

```ts
it('uses only the fixed DeepSeek endpoints and DeepSeek credential', async () => {
  const credential = { get: vi.fn(async () => 'sk-deepseek-private') }
  const fetch = vi.fn(async () => Response.json({
    object: 'list',
    data: [
      { id: 'deepseek-v4-pro', object: 'model', owned_by: 'deepseek' },
      { id: 'deepseek-v4-flash', object: 'model', owned_by: 'deepseek' },
    ],
  }))
  const provider = new DeepSeekProvider({ credential, fetch })

  await expect(provider.listModels()).resolves.toEqual([
    { id: 'deepseek-v4-flash', name: 'deepseek-v4-flash' },
    { id: 'deepseek-v4-pro', name: 'deepseek-v4-pro' },
  ])
  expect(fetch.mock.calls[0]?.[0]).toBe('https://api.deepseek.com/models')
  expect(credential.get).toHaveBeenCalledWith('deepseek_api_key')
})

it('parses DeepSeek text, tools, nullable usage, and final usage without exposing reasoning', async () => {
  const response = sseResponse([
    'data: {"id":"deep_1","choices":[{"index":0,"delta":{"reasoning_content":"private chain","content":"结果"}}],"usage":null}\n\n',
    'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"browser.search.baidu","arguments":"{\\"keyword\\":\\"天气\\"}"}}]},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":4,"completion_tokens":2,"total_tokens":6}}\n\n',
    'data: [DONE]\n\n',
  ])
  const provider = new DeepSeekProvider({
    credential: { get: vi.fn(async () => 'sk-deepseek-private') },
    fetch: vi.fn(async () => response),
  })

  const events = await collect(provider.stream({
    model: 'deepseek-v4-pro',
    messages: [{ role: 'user', content: '天气' }],
  }))

  expect(events).toContainEqual({ type: 'text_delta', choiceIndex: 0, text: '结果' })
  expect(events).toContainEqual(expect.objectContaining({
    type: 'tool_call',
    id: 'call_1',
    arguments: { keyword: '天气' },
  }))
  expect(events).toContainEqual({
    type: 'usage',
    inputTokens: 4,
    outputTokens: 2,
    totalTokens: 6,
  })
  expect(JSON.stringify(events)).not.toContain('private chain')
})
```

Create `model-provider-registry.test.ts`:

```ts
it('routes only the two fixed provider ids and maps separate credential keys', () => {
  const openrouter = providerStub()
  const deepseek = providerStub()
  const registry = new ModelProviderRegistry({ openrouter, deepseek })

  expect(registry.get('openrouter')).toBe(openrouter)
  expect(registry.get('deepseek')).toBe(deepseek)
  expect(credentialKeyForProvider('openrouter')).toBe('openrouter_api_key')
  expect(credentialKeyForProvider('deepseek')).toBe('deepseek_api_key')
})
```

- [ ] **Step 2: Run the provider tests and verify RED**

Run:

```bash
pnpm --filter @autoforge/desktop exec vitest run --config vitest.node.config.ts \
  electron/main/chat/deepseek-provider.test.ts \
  electron/main/chat/model-provider-registry.test.ts
```

Expected: FAIL because these modules do not exist.

- [ ] **Step 3: Extract the provider-neutral core without losing OpenRouter behavior**

Move the protocol types, SSE parser, retry policy, replay suppression, bounded diagnostics, and HTTP error mapping from `openrouter-provider.ts` into `model-provider.ts`. Rename the public protocol types:

```ts
export type ModelMessage =
  | { role: 'system' | 'user'; content: string }
  | {
    role: 'assistant'
    content: string | null
    tool_calls?: Array<{
      id: string
      type: 'function'
      function: { name: string; arguments: string }
    }>
  }
  | { role: 'tool'; content: string; tool_call_id: string }

export interface ModelTool {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: unknown
  }
}

export interface ModelStreamRequest {
  model: string
  messages: ModelMessage[]
  tools?: ModelTool[]
  signal?: AbortSignal
}
export type ModelStreamEvent =
  | { type: 'generation'; id: string }
  | { type: 'text_delta'; choiceIndex: number; text: string }
  | {
    type: 'tool_call'
    choiceIndex: number
    index: number
    id: string
    name: string
    arguments: unknown
  }
  | { type: 'finish'; choiceIndex: number; reason: string }
  | {
    type: 'usage'
    inputTokens: number
    outputTokens: number
    totalTokens: number
    costUsd?: string
  }

export interface ModelProvider {
  listModels(signal?: AbortSignal): Promise<ModelInfo[]>
  validateCredential(signal?: AbortSignal): Promise<{ valid: boolean }>
  stream(request: ModelStreamRequest): AsyncIterable<ModelStreamEvent>
}
```

Configure the shared implementation with:

```ts
export interface OpenAiCompatibleProviderConfig {
  chatEndpoint: string
  modelsEndpoint: string
  credential: { get(): Promise<string | undefined> }
  parseModels(value: unknown): ModelInfo[]
  includeUsageStreamOption: boolean
}

export interface OpenAiCompatibleProviderDependencies {
  fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>
  sleep?: (milliseconds: number, signal: AbortSignal | undefined) => Promise<void>
  random?: () => number
  diagnostic?: (value: {
    operation: 'models' | 'chat'
    status?: number
    code?: string | number
    error_type?: string
  }) => void
}

export class OpenAiCompatibleProvider implements ModelProvider {
  constructor(
    config: OpenAiCompatibleProviderConfig,
    dependencies: OpenAiCompatibleProviderDependencies = {},
  ) {}
}
```

The request body includes `stream_options: { include_usage: true }` only when `includeUsageStreamOption` is true. Update the stream schema to accept `usage: null` and ignore `reasoning_content`. Every former `OPENROUTER_REQUEST_FAILED` emitted by the active provider path becomes `MODEL_PROVIDER_REQUEST_FAILED`; cancellation and credential codes remain unchanged.

- [ ] **Step 4: Rebuild the two thin adapters**

`openrouter-provider.ts` configures:

```ts
const CHAT_ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions'
const MODELS_ENDPOINT = 'https://openrouter.ai/api/v1/models?supported_parameters=tools'

super({
  chatEndpoint: CHAT_ENDPOINT,
  modelsEndpoint: MODELS_ENDPOINT,
  credential: { get: () => dependencies.credential.get('openrouter_api_key') },
  parseModels: parseOpenRouterModels,
  includeUsageStreamOption: true,
}, dependencies)
```

Retain the current uncommitted behavior:

```ts
context_length: z.number().int().nonnegative().optional()

...(model.context_length === undefined || model.context_length === 0
  ? {}
  : { contextLength: model.context_length })
```

`deepseek-provider.ts` configures:

```ts
const CHAT_ENDPOINT = 'https://api.deepseek.com/chat/completions'
const MODELS_ENDPOINT = 'https://api.deepseek.com/models'

super({
  chatEndpoint: CHAT_ENDPOINT,
  modelsEndpoint: MODELS_ENDPOINT,
  credential: { get: () => dependencies.credential.get('deepseek_api_key') },
  parseModels: parseDeepSeekModels,
  includeUsageStreamOption: false,
}, dependencies)
```

DeepSeek model parsing requires a non-empty `id`, uses the ID as the display-name fallback, and sorts by ID.

- [ ] **Step 5: Implement the exhaustive registry**

In `model-provider-registry.ts`:

```ts
export type ProviderCredentialKey = 'deepseek_api_key' | 'openrouter_api_key'

export function credentialKeyForProvider(provider: ModelProviderId): ProviderCredentialKey {
  return provider === 'deepseek' ? 'deepseek_api_key' : 'openrouter_api_key'
}

export class ModelProviderRegistry {
  constructor(private readonly providers: Record<ModelProviderId, ModelProvider>) {}

  get(provider: ModelProviderId): ModelProvider {
    return this.providers[provider]
  }
}
```

- [ ] **Step 6: Update OpenRouter tests and verify Task 2 GREEN**

Keep every existing OpenRouter test. Change only imports renamed by the extraction and expectations for the neutral error code. Ensure the test for `unknown-context/model` remains present and green.

Run:

```bash
pnpm --filter @autoforge/desktop exec vitest run --config vitest.node.config.ts \
  electron/main/chat/openrouter-provider.test.ts \
  electron/main/chat/deepseek-provider.test.ts \
  electron/main/chat/model-provider-registry.test.ts
pnpm typecheck
```

Expected: all commands exit 0, and the OpenRouter zero-context regression remains covered.

- [ ] **Step 7: Commit Task 2 without unrelated preload files**

```bash
git add apps/desktop/electron/main/chat/model-provider.ts \
  apps/desktop/electron/main/chat/openrouter-provider.ts \
  apps/desktop/electron/main/chat/openrouter-provider.test.ts \
  apps/desktop/electron/main/chat/deepseek-provider.ts \
  apps/desktop/electron/main/chat/deepseek-provider.test.ts \
  apps/desktop/electron/main/chat/model-provider-registry.ts \
  apps/desktop/electron/main/chat/model-provider-registry.test.ts
git commit -m "feat: add DeepSeek model provider"
```

---

### Task 3: Provider-Aware IPC and Preload Bridge

**Files:**
- Modify: `apps/desktop/electron/main/ipc/register-ipc.ts`
- Modify: `apps/desktop/electron/main/ipc/register-ipc.test.ts`
- Modify: `apps/desktop/electron/preload/bridge.ts`
- Modify: `apps/desktop/electron/preload/bridge.test.ts`

**Interfaces:**
- Consumes: provider-aware `DesktopAPI.settings` and IPC schemas from Task 1.
- Produces: fixed provider-aware Main handlers and typed Preload calls.

- [ ] **Step 1: Write failing IPC and bridge tests**

In `register-ipc.test.ts`, replace the OpenRouter-only service stubs and add:

```ts
it('validates and forwards an explicit fixed provider for credential operations', async () => {
  const app = harness()
  await app.invoke(ipcChannels.settingsSaveProviderApiKey, {
    provider: 'deepseek',
    apiKey: 'sk-deepseek',
  })
  expect(app.dependencies.settings.saveProviderApiKey)
    .toHaveBeenCalledWith('deepseek', 'sk-deepseek')

  await expect(app.invoke(ipcChannels.settingsListProviderModels, {
    provider: 'custom',
  })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  expect(app.dependencies.settings.listProviderModels).not.toHaveBeenCalled()
})
```

In `bridge.test.ts`:

```ts
it('uses fixed provider credential channels without exposing a generic transport', async () => {
  const app = harness()
  await app.api.settings.saveProviderApiKey('deepseek', 'sk-deepseek')
  await app.api.settings.listProviderModels('openrouter')

  expect(app.ipcRenderer.invoke).toHaveBeenCalledWith(
    ipcChannels.settingsSaveProviderApiKey,
    { provider: 'deepseek', apiKey: 'sk-deepseek' },
  )
  expect(app.ipcRenderer.invoke).toHaveBeenCalledWith(
    ipcChannels.settingsListProviderModels,
    { provider: 'openrouter' },
  )
  expect(app.api).not.toHaveProperty('invoke')
})
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
pnpm --filter @autoforge/desktop exec vitest run --config vitest.node.config.ts \
  electron/main/ipc/register-ipc.test.ts \
  electron/preload/bridge.test.ts
```

Expected: FAIL because the handlers and bridge still expose OpenRouter-only methods.

- [ ] **Step 3: Implement the provider-aware fixed handlers**

Register:

```ts
register(ipcChannels.settingsSaveProviderApiKey, (input) =>
  options.services.settings.saveProviderApiKey(input.provider, input.apiKey))
register(ipcChannels.settingsClearProviderApiKey, (input) =>
  options.services.settings.clearProviderApiKey(input.provider))
register(ipcChannels.settingsValidateProviderCredential, (input) =>
  options.services.settings.validateProviderCredential(input.provider))
register(ipcChannels.settingsListProviderModels, (input) =>
  options.services.settings.listProviderModels(input.provider))
```

Delete registrations for the four old OpenRouter-only channels.

- [ ] **Step 4: Implement the typed Preload methods**

Expose only:

```ts
saveProviderApiKey: (provider, apiKey) =>
  invoke(ipcRenderer, ipcChannels.settingsSaveProviderApiKey, { provider, apiKey }),
clearProviderApiKey: (provider) =>
  invoke(ipcRenderer, ipcChannels.settingsClearProviderApiKey, { provider }),
validateProviderCredential: (provider) =>
  invoke(ipcRenderer, ipcChannels.settingsValidateProviderCredential, { provider }),
listProviderModels: (provider) =>
  invoke(ipcRenderer, ipcChannels.settingsListProviderModels, { provider }),
```

- [ ] **Step 5: Verify Task 3 GREEN**

Run:

```bash
pnpm --filter @autoforge/desktop exec vitest run --config vitest.node.config.ts \
  electron/main/ipc/register-ipc.test.ts \
  electron/preload/bridge.test.ts
pnpm typecheck
```

Expected: all commands exit 0.

- [ ] **Step 6: Commit Task 3**

```bash
git add apps/desktop/electron/main/ipc/register-ipc.ts \
  apps/desktop/electron/main/ipc/register-ipc.test.ts \
  apps/desktop/electron/preload/bridge.ts \
  apps/desktop/electron/preload/bridge.test.ts
git commit -m "feat: expose provider-aware settings bridge"
```

---

### Task 4: Main Runtime Credential Isolation and Agent Provider Snapshot

**Files:**
- Modify: `apps/desktop/electron/main/agent/agent-orchestrator.ts`
- Modify: `apps/desktop/electron/main/agent/agent-orchestrator.test.ts`
- Modify: `apps/desktop/electron/main/application.ts`
- Modify: `apps/desktop/electron/main/application.test.ts`

**Interfaces:**
- Consumes: `ModelProviderRegistry`, `credentialKeyForProvider`, and current settings.
- Produces: `AgentRunInput.provider`, resolved once into `ActiveAgentRun.provider`.
- Produces: provider-scoped save, clear, validate, model listing, and chat dispatch.

- [ ] **Step 1: Write failing Agent snapshot test**

Change the Agent test harness to expose a registry:

```ts
const providerInstances = {
  openrouter: { stream: vi.fn(() => events(turns.shift() ?? [])) },
  deepseek: { stream: vi.fn(() => events(turns.shift() ?? [])) },
}
const registry = {
  get: vi.fn((provider: ModelProviderId) => providerInstances[provider]),
}
```

Return `providers: registry` as the real `AgentOrchestratorDependencies` field, and expose `providerInstances` plus `registry` on the test harness result for the assertions below.

Add:

```ts
it('resolves a provider once and reuses it after a tool continuation', async () => {
  const dependencies = harness([toolTurn, [
    { type: 'finish', choiceIndex: 0, reason: 'stop' },
  ]])
  const original = dependencies.providerInstances.deepseek
  const replacement = { stream: vi.fn(() => events([])) }
  const orchestrator = new AgentOrchestrator(dependencies)

  const pending = await orchestrator.run({
    conversationId: 'c',
    content: '搜索',
    model: 'deepseek-v4-pro',
    provider: 'deepseek',
  })
  dependencies.providerInstances.deepseek = replacement
  await orchestrator.resumeApproval({
    executionId: pending.executionId!,
    ...approvalIdentity,
    decision: 'once',
  })

  expect(original.stream).toHaveBeenCalledTimes(2)
  expect(replacement.stream).not.toHaveBeenCalled()
  expect(dependencies.registry.get).toHaveBeenCalledTimes(1)
})
```

Update all existing `AgentOrchestrator.run()` fixtures to pass `provider: 'openrouter'` and update terminal neutral-error expectations.

- [ ] **Step 2: Run the Agent test and verify RED**

Run:

```bash
pnpm --filter @autoforge/desktop exec vitest run --config vitest.node.config.ts \
  electron/main/agent/agent-orchestrator.test.ts
```

Expected: FAIL because Agent runs still use one constructor-injected OpenRouter provider.

- [ ] **Step 3: Make the Agent provider-neutral and snapshot once**

Replace OpenRouter type imports with the generic model-provider types. Change dependencies and run input:

```ts
export interface AgentProviderRegistryPort {
  get(provider: ModelProviderId): AgentProviderPort
}

export interface AgentOrchestratorDependencies {
  providers: AgentProviderRegistryPort
  // existing dependencies unchanged
}

export interface AgentRunInput {
  conversationId: string
  content: string
  provider: ModelProviderId
  model: string
  requestId?: string
}
```

Add `provider: AgentProviderPort` to `ActiveAgentRun`, set it exactly once with `this.dependencies.providers.get(input.provider)`, and call `active.provider.stream(...)` for every model turn. Replace Agent terminal `OPENROUTER_REQUEST_FAILED` with `MODEL_PROVIDER_REQUEST_FAILED`.

- [ ] **Step 4: Write failing application routing and credential-isolation tests**

Update the application test factory to inject:

```ts
modelProviders: {
  openrouter: openRouterProvider,
  deepseek: deepSeekProvider,
}
```

Add:

```ts
it('stores provider credentials separately and routes models and new chats to the active provider', async () => {
  const runtime = createTestRuntime({
    openrouter: openRouterProvider,
    deepseek: deepSeekProvider,
  })

  await runtime.services.settings.saveProviderApiKey('openrouter', 'sk-openrouter')
  await runtime.services.settings.saveProviderApiKey('deepseek', 'sk-deepseek')
  await runtime.services.settings.update({ activeProvider: 'deepseek' })
  await runtime.services.settings.listProviderModels('deepseek')

  const conversation = await runtime.services.chat.createConversation()
  await runtime.services.chat.send({
    conversationId: conversation.id,
    content: 'hello',
  })

  await vi.waitFor(() => expect(deepSeekProvider.stream).toHaveBeenCalled())
  expect(openRouterProvider.stream).not.toHaveBeenCalled()
  expect(deepSeekProvider.stream).toHaveBeenCalledWith(expect.objectContaining({
    model: 'deepseek-v4-flash',
  }))
  expect(await runtime.services.settings.validateProviderCredential('openrouter'))
    .toMatchObject({ provider: 'openrouter', configured: true })
  expect(await runtime.services.settings.validateProviderCredential('deepseek'))
    .toMatchObject({ provider: 'deepseek', configured: true })
})
```

Add a clear-isolation assertion:

```ts
await runtime.services.settings.clearProviderApiKey('deepseek')
expect(await runtime.services.settings.validateProviderCredential('deepseek'))
  .toMatchObject({ configured: false, validation: 'unchecked' })
expect(await runtime.services.settings.validateProviderCredential('openrouter'))
  .toMatchObject({ configured: true })
```

- [ ] **Step 5: Run the application tests and verify RED**

Run:

```bash
pnpm --filter @autoforge/desktop exec vitest run --config vitest.node.config.ts \
  electron/main/application.test.ts
```

Expected: FAIL because the runtime still builds one OpenRouter provider and exposes OpenRouter-only settings services.

- [ ] **Step 6: Wire the fixed registry and scoped credential services**

Change `ApplicationRuntimeOptions` to accept optional injected providers:

```ts
modelProviders?: Partial<Record<ModelProviderId, ModelProvider>>
```

Construct the defaults with the shared `SecretStore`:

```ts
const providerRegistry = new ModelProviderRegistry({
  openrouter: options.modelProviders?.openrouter
    ?? new OpenRouterProvider({ credential: secretStore }),
  deepseek: options.modelProviders?.deepseek
    ?? new DeepSeekProvider({ credential: secretStore }),
})
```

Update settings defaults to the Task 1 current shape. Implement:

```ts
async function credentialStatus(provider: ModelProviderId): Promise<ProviderCredentialStatus> {
  const key = credentialKeyForProvider(provider)
  const configured = database.encryptedSecrets.raw(key) !== undefined
  if (!configured) return { provider, configured: false, validation: 'unchecked' }
  try {
    const result = await providerRegistry.get(provider).validateCredential()
    return {
      provider,
      configured: true,
      validation: result.valid ? 'valid' : 'invalid',
      checkedAt: new Date().toISOString(),
    }
  } catch (error) {
    if (toSafeAppError(error).code === 'CREDENTIAL_INVALID') {
      return { provider, configured: true, validation: 'invalid', checkedAt: new Date().toISOString() }
    }
    return {
      provider,
      configured: true,
      validation: 'unavailable',
      message: toSafeAppError(error).message,
      checkedAt: new Date().toISOString(),
    }
  }
}
```

Saving encrypts with the provider key and then calls `credentialStatus(provider)`. Clearing deletes only that key. Model listing resolves exactly the requested provider.

At chat send, capture one settings value:

```ts
const snapshot = settings.get()
void agent.run({
  conversationId: input.conversationId,
  content: input.content,
  provider: snapshot.activeProvider,
  model: input.model ?? snapshot.defaultModels[snapshot.activeProvider],
  requestId,
})
```

- [ ] **Step 7: Verify Task 4 GREEN**

Run:

```bash
pnpm --filter @autoforge/desktop exec vitest run --config vitest.node.config.ts \
  electron/main/agent/agent-orchestrator.test.ts \
  electron/main/application.test.ts
pnpm typecheck
```

Expected: all commands exit 0.

- [ ] **Step 8: Commit Task 4**

```bash
git add apps/desktop/electron/main/agent/agent-orchestrator.ts \
  apps/desktop/electron/main/agent/agent-orchestrator.test.ts \
  apps/desktop/electron/main/application.ts \
  apps/desktop/electron/main/application.test.ts
git commit -m "feat: route chats through selected provider"
```

---

### Task 5: Provider Management UI and Per-Provider Renderer State

**Files:**
- Modify: `apps/desktop/src/stores/settings.ts`
- Modify: `apps/desktop/src/views/SettingsView.vue`
- Modify: `apps/desktop/src/views/ChatView.vue`
- Modify: `apps/desktop/src/components/ContextSidebar.vue`
- Modify: `apps/desktop/src/services/desktop-api.ts`
- Modify: `apps/desktop/tests/components/workbench.test.ts`

**Interfaces:**
- Consumes: provider-aware `DesktopAPI.settings`.
- Produces: `credentialStatuses`, `modelsByProvider`, current-provider getters, `switchProvider`, `saveCredential`, `clearCredential`, `loadModels`, and `saveDefaultModel`.

- [ ] **Step 1: Update the test API fixture and write failing UI/store tests**

Change the workbench fixture settings to:

```ts
get: vi.fn().mockResolvedValue({
  theme: 'system',
  language: 'zh-CN',
  dataDirectory: '/data',
  logDirectory: '/logs',
  activeProvider: 'openrouter',
  defaultModels: {
    openrouter: 'openai/gpt-4.1-mini',
    deepseek: 'deepseek-v4-flash',
  },
  showCosts: false,
  developerMode: false,
  permissionDefault: 'ask',
}),
saveProviderApiKey: vi.fn(),
clearProviderApiKey: vi.fn(),
validateProviderCredential: vi.fn().mockImplementation(async (provider) => ({
  provider,
  configured: false,
  validation: 'unchecked',
})),
listProviderModels: vi.fn().mockResolvedValue([]),
```

Add these focused tests:

```ts
it('switches providers, clears the draft key, and restores each default model', async () => {
  const api = createApi()
  vi.mocked(api.settings.update).mockImplementation(async (patch) => ({
    ...await api.settings.get(),
    ...patch,
  }))
  vi.mocked(api.settings.validateProviderCredential).mockImplementation(async (provider) => ({
    provider,
    configured: true,
    validation: 'valid',
  }))
  vi.mocked(api.settings.listProviderModels).mockImplementation(async (provider) =>
    provider === 'deepseek'
      ? [{ id: 'deepseek-v4-pro', name: 'deepseek-v4-pro' }]
      : [{ id: 'openai/gpt-4.1-mini', name: 'GPT-4.1 Mini' }])

  const { wrapper } = await mountApp('/settings', api)
  await wrapper.get('#provider-api-key').setValue('unsaved-secret')
  wrapper.getComponent('[data-testid="provider-select"]').vm.$emit('change', 'deepseek')

  await vi.waitFor(() =>
    expect(api.settings.validateProviderCredential).toHaveBeenCalledWith('deepseek'))
  expect((wrapper.get('#provider-api-key').element as HTMLInputElement).value).toBe('')
  expect(useSettingsStore().defaultModel).toBe('deepseek-v4-flash')
})

it('saves and clears only the selected provider credential', async () => {
  const api = createApi()
  vi.mocked(api.settings.saveProviderApiKey).mockResolvedValue({
    provider: 'deepseek',
    configured: true,
    validation: 'valid',
  })
  const { wrapper, pinia } = await mountApp('/settings', api)
  const store = useSettingsStore()
  store.settings = {
    ...store.settings!,
    activeProvider: 'deepseek',
  }
  await wrapper.get('#provider-api-key').setValue('sk-deepseek-secret')
  await wrapper.get('[data-testid="save-api-key"]').trigger('click')

  await vi.waitFor(() =>
    expect(api.settings.saveProviderApiKey).toHaveBeenCalledWith('deepseek', 'sk-deepseek-secret'))
  expect(JSON.stringify(pinia.state.value)).not.toContain('sk-deepseek-secret')
})

it('keeps a saved default visible when refresh no longer returns it', async () => {
  const api = createApi()
  vi.mocked(api.settings.validateProviderCredential).mockResolvedValue({
    provider: 'openrouter',
    configured: true,
    validation: 'valid',
  })
  vi.mocked(api.settings.listProviderModels).mockResolvedValue([])
  await mountApp('/settings', api)

  await vi.waitFor(() => expect(api.settings.listProviderModels).toHaveBeenCalledWith('openrouter'))
  expect(useSettingsStore().modelOptions).toContainEqual({
    id: 'openai/gpt-4.1-mini',
    name: 'openai/gpt-4.1-mini（已保存模型）',
  })
})
```

Also update the settings queue test so `defaultModels` replaces `defaultModel`.

- [ ] **Step 2: Run Renderer tests and verify RED**

Run:

```bash
pnpm --filter @autoforge/desktop exec vitest run --config vitest.config.ts \
  tests/components/workbench.test.ts
```

Expected: FAIL because the store and views still use a single credential, model list, and default model.

- [ ] **Step 3: Implement per-provider Pinia state with stale guards**

Use:

```ts
credentialStatuses: {
  openrouter: { provider: 'openrouter', configured: false, validation: 'unchecked' },
  deepseek: { provider: 'deepseek', configured: false, validation: 'unchecked' },
},
modelsByProvider: {
  openrouter: [] as ModelInfo[],
  deepseek: [] as ModelInfo[],
},
_credentialVersions: { openrouter: 0, deepseek: 0 },
_modelVersions: { openrouter: 0, deepseek: 0 },
```

Add getters for `activeProvider`, `credential`, `models`, `defaultModel`, and `modelOptions`. `modelOptions` prepends:

```ts
{
  id: savedDefault,
  name: `${savedDefault}（已保存模型）`,
}
```

only when the current fetched list does not contain the saved value.

Every credential/model action accepts or snapshots a provider and calls the explicit bridge method. Apply responses only when that provider's version still matches. `switchProvider` persists `{ activeProvider: provider }`, then loads that provider status/catalog; if persistence fails, retain the previous settings and rethrow. `saveDefaultModel` sends a full two-key `defaultModels` value through the existing serialized settings queue.

- [ ] **Step 4: Implement the settings UI**

Replace the OpenRouter-only section with:

```vue
<section id="provider" class="settings-section">
  <header>
    <div>
      <h2>大模型供应商</h2>
      <p>每个供应商的 API Key 与默认模型独立保存。</p>
    </div>
    <span :class="['credential-status', credentialTone]">
      <i class="af-status-dot" :class="credentialTone" />
      {{ credentialLabel }}
    </span>
  </header>
  <div class="settings-form">
    <label for="model-provider">当前供应商</label>
    <el-select
      id="model-provider"
      data-testid="provider-select"
      :model-value="settings.activeProvider"
      :disabled="settings.saving"
      @change="switchProvider"
    >
      <el-option label="DeepSeek" value="deepseek" />
      <el-option label="OpenRouter" value="openrouter" />
    </el-select>
    <label for="provider-api-key">{{ providerLabel }} API Key</label>
    <div class="inline-control">
      <el-input
        id="provider-api-key"
        v-model="apiKey"
        type="password"
        show-password
        autocomplete="new-password"
        :placeholder="`输入新的 ${providerLabel} API Key`"
      />
      <el-button
        type="primary"
        :disabled="!apiKey.trim()"
        :loading="settings.saving"
        data-testid="save-api-key"
        @click="saveApiKey"
      >
        保存凭证
      </el-button>
    </div>
  </div>
</section>
```

Credential copy maps the five approved states. Switching clears the component-local `apiKey` only after the store accepts the provider. Confirmation text includes `DeepSeek` or `OpenRouter`. The default-model section uses `settings.modelOptions`, saves through `saveDefaultModel`, and disables controls unless the current credential is configured.

Update `ContextSidebar.vue` to link `#provider` with text `大模型供应商`.

- [ ] **Step 5: Update ChatView for active-provider models**

Use `settings.modelOptions` in the conversation model selector. Watch the pair of active provider and default:

```ts
watch(
  () => [settings.activeProvider, settings.defaultModel] as const,
  ([, model]) => { selectedModel.value = model },
  { immediate: true },
)
```

Send with `selectedModel || settings.defaultModel`. Load models only for the current configured provider. A provider switch must reset the per-conversation override so an OpenRouter model ID cannot leak into a new DeepSeek request.

Add provider-neutral user-facing mappings in `src/services/desktop-api.ts`:

```ts
CREDENTIAL_UNAVAILABLE: '请先配置当前供应商的 API Key',
CREDENTIAL_INVALID: '当前供应商的 API Key 无效',
MODEL_PROVIDER_REQUEST_FAILED: '模型服务暂不可用，请稍后重试',
```

- [ ] **Step 6: Verify Task 5 GREEN**

Run:

```bash
pnpm --filter @autoforge/desktop exec vitest run --config vitest.config.ts \
  tests/components/workbench.test.ts
pnpm typecheck
```

Expected: all commands exit 0.

- [ ] **Step 7: Commit Task 5**

```bash
git add apps/desktop/src/stores/settings.ts \
  apps/desktop/src/views/SettingsView.vue \
  apps/desktop/src/views/ChatView.vue \
  apps/desktop/src/components/ContextSidebar.vue \
  apps/desktop/src/services/desktop-api.ts \
  apps/desktop/tests/components/workbench.test.ts
git commit -m "feat: manage model providers in settings"
```

---

### Task 6: Full Verification and Honest Live-Check Boundary

**Files:**
- Verify only unless a failing check identifies a feature regression.

**Interfaces:**
- Consumes: all completed tasks.
- Produces: fresh evidence for tests, types, build, lint, formatting, and worktree scope.

- [ ] **Step 1: Run every focused provider/settings suite together**

```bash
pnpm exec vitest run \
  packages/shared/src/contracts.test.ts \
  apps/desktop/electron/main/settings/settings-service.test.ts \
  apps/desktop/electron/main/chat/openrouter-provider.test.ts \
  apps/desktop/electron/main/chat/deepseek-provider.test.ts \
  apps/desktop/electron/main/chat/model-provider-registry.test.ts \
  apps/desktop/electron/main/ipc/register-ipc.test.ts \
  apps/desktop/electron/preload/bridge.test.ts \
  apps/desktop/electron/main/agent/agent-orchestrator.test.ts \
  apps/desktop/electron/main/application.test.ts \
  apps/desktop/tests/components/workbench.test.ts
```

Expected: all selected tests pass.

- [ ] **Step 2: Run the complete automated suite**

```bash
pnpm test
```

Expected: exit 0 with zero failed tests.

- [ ] **Step 3: Run static and production checks**

```bash
pnpm typecheck
pnpm build
pnpm lint
git diff --check
```

Expected: every command exits 0.

- [ ] **Step 4: Inspect scope and preserve pre-existing work**

```bash
git status --short
git diff --stat
git diff -- apps/desktop/electron.vite.config.ts \
  apps/desktop/electron/main/index.ts \
  apps/desktop/electron/preload/build-config.test.ts
```

Expected: provider feature changes are accounted for, the pre-existing preload changes remain intact, and no API key or generated secret appears in the diff.

- [ ] **Step 5: Determine whether real upstream verification is authorized and possible**

Check only for credential availability without printing values. If no user-provided valid credentials are available in the running app, record:

```text
Real DeepSeek/OpenRouter model-list and chat verification: not run; valid user credentials were not available to this implementation session.
```

If the user has supplied credentials through the app, verify for each provider:

1. Select the provider.
2. Validate the credential.
3. Refresh its model list.
4. Choose and persist a default model.
5. Send a chat request.
6. Confirm the upstream request used that provider and the reply completed.

Never place the key in terminal arguments, logs, screenshots, tests, or the final response.

- [ ] **Step 6: Review requirements line by line**

Confirm:

- `deepseek` and `openrouter` both appear in the settings selector.
- Credentials are separately stored and cleared.
- Models are fetched from the selected provider.
- Defaults are separately editable and restored.
- A running Agent does not switch Provider mid-run.
- Missing credentials never cause a fallback.
- Legacy OpenRouter key/default behavior is preserved.
- Renderer/IPC never receive a secret.
- Existing `context_length: 0` behavior remains tested.

- [ ] **Step 7: Commit only verification-driven fixes if required**

If no changes were needed, do not create an empty commit. If verification required scoped corrections:

```bash
git add packages/shared/src/desktop-api.ts \
  packages/shared/src/errors.ts \
  packages/shared/src/contracts.test.ts \
  apps/desktop/electron/main/settings/settings-service.ts \
  apps/desktop/electron/main/settings/settings-service.test.ts \
  apps/desktop/electron/main/chat/model-provider.ts \
  apps/desktop/electron/main/chat/openrouter-provider.ts \
  apps/desktop/electron/main/chat/openrouter-provider.test.ts \
  apps/desktop/electron/main/chat/deepseek-provider.ts \
  apps/desktop/electron/main/chat/deepseek-provider.test.ts \
  apps/desktop/electron/main/chat/model-provider-registry.ts \
  apps/desktop/electron/main/chat/model-provider-registry.test.ts \
  apps/desktop/electron/main/ipc/register-ipc.ts \
  apps/desktop/electron/main/ipc/register-ipc.test.ts \
  apps/desktop/electron/preload/bridge.ts \
  apps/desktop/electron/preload/bridge.test.ts \
  apps/desktop/electron/main/agent/agent-orchestrator.ts \
  apps/desktop/electron/main/agent/agent-orchestrator.test.ts \
  apps/desktop/electron/main/application.ts \
  apps/desktop/electron/main/application.test.ts \
  apps/desktop/src/stores/settings.ts \
  apps/desktop/src/views/SettingsView.vue \
  apps/desktop/src/views/ChatView.vue \
  apps/desktop/src/components/ContextSidebar.vue \
  apps/desktop/src/services/desktop-api.ts \
  apps/desktop/tests/components/workbench.test.ts
git commit -m "fix: complete model provider verification"
```
