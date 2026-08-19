# OpenRouter Image Request Resilience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 OpenRouter 图片生成在 120 秒内可靠结束，保留用户选择的 Seedream 参数，记录严格脱敏的供应商诊断，并避免把泛化 HTTP 400 错误断言成模型参数非法。

**Architecture:** `OpenRouterProvider` 在图片请求边界合并用户取消信号与内部 120 秒 deadline，并保持一次用户操作只发送一个 POST。新的 `ProviderDiagnosticLog` 只接受现有白名单诊断 DTO，通过单一串行队列写入有界 JSONL；`application.ts` 将按 Provider 绑定的回调注入默认 Provider。Renderer 只调整固定中文文案，不扩大 IPC 或数据库契约。

**Tech Stack:** TypeScript 6、Electron 43、Node.js `fs/promises`、Vitest 4、Vue 3。

## Global Constraints

- 图片请求 deadline 固定为 `120_000` 毫秒。
- 用户取消优先于内部超时：用户信号已取消时必须返回 `CANCELLED`。
- 每次用户操作最多发送一个付费图片 POST；禁止自动重试。
- 保留 `resolution`、`aspect_ratio` 和 `n` 的现有序列化，不做 Seedream 特例降级。
- 诊断日志禁止包含提示词、请求正文、Header、API Key、响应正文、供应商原始消息和任意非白名单 metadata。
- 诊断日志只允许 `occurredAt/provider/operation/status/code/error_type`，文件上限 `512 KiB`。
- 不修改数据库 Schema、聊天消息结构、计费账本或视频请求策略。
- 自动测试禁止发起真实付费模型请求。
- 保留工作区中与品牌资源相关的既有未提交改动；每次只暂存本计划列出的文件。

---

### Task 1: 有界供应商诊断日志

**Files:**
- Create: `apps/desktop/electron/main/chat/provider-diagnostic-log.ts`
- Create: `apps/desktop/electron/main/chat/provider-diagnostic-log.test.ts`
- Modify: `apps/desktop/electron/main/chat/model-provider.ts:145-164`

**Interfaces:**
- Consumes: `ProviderOperation` 现有枚举。
- Produces: `ProviderDiagnostic`、`ProviderDiagnosticLog.forProvider(provider)` 和 `ProviderDiagnosticLog.flush()`。

- [ ] **Step 1: 导出严格诊断 DTO**

在 `model-provider.ts` 中把依赖内联类型替换为：

```ts
export interface ProviderDiagnostic {
  operation: ProviderOperation
  status?: number
  code?: string | number
  error_type?: string
}

export interface OpenAiCompatibleProviderDependencies {
  credential: ModelCredentialPort
  fetch?: FetchPort
  sleep?: SleepPort
  random?: () => number
  diagnostic?: (diagnostic: ProviderDiagnostic) => void
}
```

- [ ] **Step 2: 写诊断日志失败测试**

创建 `provider-diagnostic-log.test.ts`：

```ts
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ProviderDiagnosticLog } from './provider-diagnostic-log.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('ProviderDiagnosticLog', () => {
  it('persists only bounded provider diagnostic fields', async () => {
    const root = await mkdtemp(join(tmpdir(), 'autoforge-provider-diagnostic-'))
    roots.push(root)
    const log = new ProviderDiagnosticLog(root, () => new Date('2026-08-19T09:00:00.000Z'))

    log.forProvider('openrouter')({
      operation: 'image',
      status: 400,
      code: 'invalid_request',
      error_type: 'invalid_request',
      raw: 'must-not-be-written',
    } as never)
    await log.flush()

    const contents = await readFile(join(root, 'model-provider.jsonl'), 'utf8')
    expect(JSON.parse(contents)).toEqual({
      occurredAt: '2026-08-19T09:00:00.000Z',
      provider: 'openrouter',
      operation: 'image',
      status: 400,
      code: 'invalid_request',
      error_type: 'invalid_request',
    })
    expect(contents).not.toContain('must-not-be-written')
  })

  it('restarts the single log before an entry would exceed 512 KiB', async () => {
    const root = await mkdtemp(join(tmpdir(), 'autoforge-provider-diagnostic-'))
    roots.push(root)
    await writeFile(join(root, 'model-provider.jsonl'), 'x'.repeat(512 * 1024))
    const log = new ProviderDiagnosticLog(root, () => new Date('2026-08-19T09:00:00.000Z'))

    log.forProvider('deepseek')({ operation: 'models', status: 503 })
    await log.flush()

    const contents = await readFile(join(root, 'model-provider.jsonl'), 'utf8')
    expect(contents.length).toBeLessThan(512 * 1024)
    expect(JSON.parse(contents)).toMatchObject({ provider: 'deepseek', status: 503 })
  })

  it('never throws file-system failures back to the provider', async () => {
    const root = await mkdtemp(join(tmpdir(), 'autoforge-provider-diagnostic-'))
    roots.push(root)
    const blocked = join(root, 'not-a-directory')
    await writeFile(blocked, 'file')
    const log = new ProviderDiagnosticLog(blocked)

    expect(() => log.forProvider('openrouter')({ operation: 'image', status: 400 })).not.toThrow()
    await expect(log.flush()).resolves.toBeUndefined()
  })
})
```

- [ ] **Step 3: 运行测试确认 RED**

Run:

```bash
cd apps/desktop
node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts electron/main/chat/provider-diagnostic-log.test.ts
```

Expected: FAIL，因为 `provider-diagnostic-log.ts` 尚不存在。

- [ ] **Step 4: 实现最小有界日志模块**

创建 `provider-diagnostic-log.ts`：

```ts
import { mkdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ModelProviderId } from '@autoforge/shared'
import type { ProviderDiagnostic, ProviderOperation } from './model-provider.js'

const MAX_LOG_BYTES = 512 * 1024
const LOG_NAME = 'model-provider.jsonl'
const OPERATIONS = new Set<ProviderOperation>(['models', 'chat', 'image', 'video', 'generation'])

function safeMetadata(value: unknown): string | number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.length <= 64 && /^[a-z0-9_.-]+$/i.test(value)) {
    return value
  }
  return undefined
}

async function existingBytes(path: string): Promise<number> {
  try {
    return (await stat(path)).size
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0
    throw error
  }
}

export class ProviderDiagnosticLog {
  private tail = Promise.resolve()

  constructor(
    private readonly directory: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  forProvider(provider: ModelProviderId): (diagnostic: ProviderDiagnostic) => void {
    return (diagnostic) => {
      this.tail = this.tail.then(async () => {
        if (!OPERATIONS.has(diagnostic.operation)) return
        const status = Number.isInteger(diagnostic.status)
          && diagnostic.status! >= 100
          && diagnostic.status! <= 599
          ? diagnostic.status
          : undefined
        const code = safeMetadata(diagnostic.code)
        const errorType = safeMetadata(diagnostic.error_type)
        const line = `${JSON.stringify({
          occurredAt: this.now().toISOString(),
          provider,
          operation: diagnostic.operation,
          ...(status === undefined ? {} : { status }),
          ...(code === undefined ? {} : { code }),
          ...(typeof errorType === 'string' ? { error_type: errorType } : {}),
        })}\n`
        await mkdir(this.directory, { recursive: true })
        const path = join(this.directory, LOG_NAME)
        const replace = await existingBytes(path) + Buffer.byteLength(line) > MAX_LOG_BYTES
        await writeFile(path, line, { encoding: 'utf8', flag: replace ? 'w' : 'a' })
      }).catch(() => undefined)
    }
  }

  async flush(): Promise<void> {
    await this.tail
  }
}
```

- [ ] **Step 5: 运行测试确认 GREEN**

Run:

```bash
cd apps/desktop
node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts electron/main/chat/provider-diagnostic-log.test.ts
```

Expected: 3 tests passed，输出中没有文件系统警告。

- [ ] **Step 6: 提交诊断日志模块**

```bash
git add apps/desktop/electron/main/chat/model-provider.ts apps/desktop/electron/main/chat/provider-diagnostic-log.ts apps/desktop/electron/main/chat/provider-diagnostic-log.test.ts
git commit -m "feat: add bounded provider diagnostics"
```

### Task 2: 将脱敏诊断接入默认 Provider

**Files:**
- Modify: `apps/desktop/electron/main/application.ts:1-55,326-360`
- Modify: `apps/desktop/electron/main/application.test.ts:1-8,1478-1510`

**Interfaces:**
- Consumes: `ProviderDiagnosticLog.forProvider('openrouter' | 'deepseek')`。
- Produces: 默认 OpenRouter/DeepSeek 请求失败时写入同一个 `model-provider.jsonl` 串行队列。

- [ ] **Step 1: 写 Application 集成失败测试**

给 `application.test.ts` 的 `node:fs/promises` import 加上 `readFile`，并在现有 Provider
代理测试附近新增：

```ts
it('writes only safe diagnostics for default model providers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'autoforge-application-provider-diagnostic-'))
  directories.push(root)
  networkProxy.fetch.mockImplementation(async (input) => {
    const provider = String(input).includes('openrouter.ai') ? 'openrouter' : 'deepseek'
    return Response.json({
      error: {
        code: 400,
        message: `RAW_${provider}_MESSAGE`,
        metadata: { error_type: 'invalid_request', raw: `RAW_${provider}_METADATA` },
      },
    }, { status: 400 })
  })
  const runtime = createApplicationRuntime(options(root, { networkProxy }))
  await runtime.services.settings.saveProviderApiKey('openrouter', 'sk-openrouter')
  await runtime.services.settings.saveProviderApiKey('deepseek', 'sk-deepseek')

  await expect(runtime.services.settings.validateProviderCredential('openrouter'))
    .resolves.toMatchObject({ validation: 'unavailable' })
  await expect(runtime.services.settings.validateProviderCredential('deepseek'))
    .resolves.toMatchObject({ validation: 'unavailable' })

  const path = join(root, 'logs', 'model-provider.jsonl')
  await vi.waitFor(async () => {
    const records = (await readFile(path, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
    expect(records).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: 'openrouter', operation: 'models', status: 400 }),
      expect.objectContaining({ provider: 'deepseek', operation: 'models', status: 400 }),
    ]))
    expect(JSON.stringify(records)).not.toContain('RAW_')
  })
  await runtime.close()
})
```

- [ ] **Step 2: 运行测试确认 RED**

Run:

```bash
cd apps/desktop
node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts electron/main/application.test.ts -t "writes only safe diagnostics for default model providers"
```

Expected: FAIL，日志文件不存在。

- [ ] **Step 3: 在 Application 中注入同一日志队列**

在 `application.ts` 导入：

```ts
import { ProviderDiagnosticLog } from './chat/provider-diagnostic-log.js'
```

在 `secretStore` 创建后、`providerRegistry` 创建前加入：

```ts
const providerDiagnostics = new ProviderDiagnosticLog(options.paths.logs)
```

默认 Provider 构造改为：

```ts
const providerRegistry = new ModelProviderRegistry({
  openrouter: options.modelProviders?.openrouter ?? new OpenRouterProvider({
    credential: secretStore,
    fetch: options.networkProxy.fetch.bind(options.networkProxy) as typeof globalThis.fetch,
    diagnostic: providerDiagnostics.forProvider('openrouter'),
  }),
  deepseek: options.modelProviders?.deepseek ?? new DeepSeekProvider({
    credential: secretStore,
    fetch: options.networkProxy.fetch.bind(options.networkProxy) as typeof globalThis.fetch,
    diagnostic: providerDiagnostics.forProvider('deepseek'),
  }),
})
```

- [ ] **Step 4: 运行集成与日志测试确认 GREEN**

Run:

```bash
cd apps/desktop
node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts electron/main/chat/provider-diagnostic-log.test.ts electron/main/application.test.ts -t "ProviderDiagnosticLog|writes only safe diagnostics for default model providers"
```

Expected: 新日志测试和 Application 集成测试通过；没有真实网络调用。

- [ ] **Step 5: 提交生产接线**

```bash
git add apps/desktop/electron/main/application.ts apps/desktop/electron/main/application.test.ts
git commit -m "feat: persist safe provider diagnostics"
```

### Task 3: 图片请求 120 秒 deadline

**Files:**
- Modify: `apps/desktop/electron/main/chat/openrouter-provider.ts:15-25,192-198,364-432`
- Modify: `apps/desktop/electron/main/chat/openrouter-provider.test.ts:1000-1145`

**Interfaces:**
- Consumes: 调用方可选 `AbortSignal`。
- Produces: `generateImage` 在 120 秒时返回 `MODEL_PROVIDER_TIMEOUT`；调用方取消仍返回 `CANCELLED`。

- [ ] **Step 1: 写挂起请求和取消优先级失败测试**

在 `openrouter-provider.test.ts` 的付费图片单次请求测试附近新增：

```ts
function abortablePendingFetch() {
  return vi.fn((_input: string | URL | Request, init?: RequestInit) => (
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal
      if (signal?.aborted) {
        reject(signal.reason)
        return
      }
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
    })
  ))
}

it('times out one hanging paid image POST after 120 seconds without retrying', async () => {
  vi.useFakeTimers()
  try {
    const fetch = abortablePendingFetch()
    const provider = new OpenRouterProvider({ credential, fetch })
    const result = provider.generateImage({
      model: 'bytedance-seed/seedream-4.5',
      prompt: 'draw',
      options: { count: 1, resolution: '1K', aspectRatio: '16:9', format: 'png' },
      parameterSupport: { resolution: true, aspectRatio: true, outputFormat: false },
      references: [],
    }).then(() => undefined, (error: unknown) => error)

    await vi.advanceTimersByTimeAsync(119_999)
    expect(fetch).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)

    await expect(result).resolves.toMatchObject({ code: 'MODEL_PROVIDER_TIMEOUT' })
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    vi.useRealTimers()
  }
})

it('keeps user cancellation authoritative before the image deadline', async () => {
  vi.useFakeTimers()
  try {
    const controller = new AbortController()
    const fetch = abortablePendingFetch()
    const provider = new OpenRouterProvider({ credential, fetch })
    const result = provider.generateImage({
      model: 'bytedance-seed/seedream-4.5',
      prompt: 'draw',
      options: { count: 1, resolution: '1K', aspectRatio: '16:9', format: 'png' },
      parameterSupport: { resolution: true, aspectRatio: true, outputFormat: false },
      references: [],
      signal: controller.signal,
    }).then(() => undefined, (error: unknown) => error)

    controller.abort()

    await expect(result).resolves.toMatchObject({ code: 'CANCELLED' })
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    vi.useRealTimers()
  }
})
```

- [ ] **Step 2: 运行测试确认 RED**

Run:

```bash
cd apps/desktop
node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts electron/main/chat/openrouter-provider.test.ts -t "image deadline|hanging paid image POST"
```

Expected: 挂起测试无法在推进 120 秒后得到 `MODEL_PROVIDER_TIMEOUT`。

- [ ] **Step 3: 实现 deadline helper**

在 `openrouter-provider.ts` 常量区加入：

```ts
const IMAGE_REQUEST_TIMEOUT_MS = 120_000
```

在 `failure` 后加入：

```ts
async function withImageRequestDeadline<T>(
  callerSignal: AbortSignal | undefined,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const deadline = new AbortController()
  const timer = setTimeout(() => deadline.abort(), IMAGE_REQUEST_TIMEOUT_MS)
  const signal = callerSignal
    ? AbortSignal.any([callerSignal, deadline.signal])
    : deadline.signal
  try {
    return await operation(signal)
  } catch (error) {
    if (callerSignal?.aborted) throw failure('CANCELLED')
    if (deadline.signal.aborted) throw failure('MODEL_PROVIDER_TIMEOUT')
    throw error
  } finally {
    clearTimeout(timer)
  }
}
```

- [ ] **Step 4: 让 deadline 覆盖 fetch 与响应正文读取**

把 `generateImage` 的外层改为以下结构；原有请求 JSON、输出映射和 usage 映射逐行保持
不变，只把两处 `parsedRequest.signal` 替换为内部 `signal`：

```ts
async generateImage(request: ModelImageRequest): Promise<ModelImageResult> {
  const parsedRequest = parsedImageRequest(request)
  return withImageRequestDeadline(parsedRequest.signal, async (signal) => {
    const response = await this.authenticatedFetch(
      IMAGE_ENDPOINT,
      'image',
      signal,
      () => {
        const inputReferences = wireReferences(parsedRequest.references)
        return {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: parsedRequest.model,
            prompt: parsedRequest.prompt,
            n: 1,
            ...(parsedRequest.parameterSupport.resolution
              ? { resolution: parsedRequest.options.resolution }
              : {}),
            ...(parsedRequest.parameterSupport.aspectRatio && parsedRequest.options.aspectRatio !== 'auto'
              ? { aspect_ratio: parsedRequest.options.aspectRatio }
              : {}),
            ...(parsedRequest.parameterSupport.outputFormat
              ? { output_format: parsedRequest.options.format }
              : {}),
            ...(inputReferences.length ? { input_references: inputReferences } : {}),
          }),
        }
      },
      { retry: 'never' },
    )
    const parsed = imageResponseSchema.safeParse(
      await this.boundedJson(response, MAX_MEDIA_JSON_BODY, signal),
    )
    if (!parsed.success) throw failure('MODEL_PROVIDER_REQUEST_FAILED')
    const outputs: ModelImageResult['outputs'] = parsed.data.data.map((output) => {
      if (output.b64_json !== undefined) {
        return {
          type: 'base64',
          dataBase64: output.b64_json,
          ...(output.media_type === undefined ? {} : { mimeType: output.media_type }),
        }
      }
      return { type: 'url', url: canonicalHttpsUrl(output.url!) }
    })
    const inputTokens = safeTokenCount(parsed.data.usage?.prompt_tokens)
    const outputTokens = safeTokenCount(parsed.data.usage?.completion_tokens)
    const usage = parsed.data.usage
      ? {
          ...(inputTokens === undefined ? {} : { inputTokens }),
          ...(outputTokens === undefined ? {} : { outputTokens }),
          ...(parsed.data.usage.cost === undefined
            ? {}
            : { costUsd: String(parsed.data.usage.cost) }),
        }
      : undefined
    return { outputs, ...(usage && Object.keys(usage).length ? { usage } : {}) }
  })
}
```

- [ ] **Step 5: 运行 Provider 测试确认 GREEN**

Run:

```bash
cd apps/desktop
node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts electron/main/chat/openrouter-provider.test.ts
```

Expected: 全部 OpenRouter Provider 测试通过；新测试确认只发送一个 POST。

- [ ] **Step 6: 提交图片 deadline**

```bash
git add apps/desktop/electron/main/chat/openrouter-provider.ts apps/desktop/electron/main/chat/openrouter-provider.test.ts
git commit -m "fix: bound OpenRouter image requests"
```

### Task 4: 修正泛化 HTTP 400 的用户文案

**Files:**
- Modify: `apps/desktop/src/services/desktop-api.ts:25-38`
- Modify: `apps/desktop/tests/components/chat.test.ts:764-786`

**Interfaces:**
- Consumes: 现有 `MODEL_PROVIDER_INVALID_REQUEST` 错误码。
- Produces: 固定中文文案“供应商拒绝了当前请求，请调整生成设置或稍后重试”。

- [ ] **Step 1: 先修改组件测试期望**

将参数表中的一行改为：

```ts
['MODEL_PROVIDER_INVALID_REQUEST', '供应商拒绝了当前请求，请调整生成设置或稍后重试'],
```

- [ ] **Step 2: 运行测试确认 RED**

Run:

```bash
cd apps/desktop
node scripts/run-vitest-electron.mjs run --config vitest.config.ts tests/components/chat.test.ts -t "maps MODEL_PROVIDER_INVALID_REQUEST"
```

Expected: FAIL，实际仍为旧的“模型参数”文案。

- [ ] **Step 3: 更新唯一 Renderer 映射**

在 `desktop-api.ts` 改为：

```ts
MODEL_PROVIDER_INVALID_REQUEST: '供应商拒绝了当前请求，请调整生成设置或稍后重试',
```

- [ ] **Step 4: 运行组件测试确认 GREEN**

Run:

```bash
cd apps/desktop
node scripts/run-vitest-electron.mjs run --config vitest.config.ts tests/components/chat.test.ts
```

Expected: 全部聊天组件测试通过。

- [ ] **Step 5: 提交文案修复**

```bash
git add apps/desktop/src/services/desktop-api.ts apps/desktop/tests/components/chat.test.ts
git commit -m "fix: clarify rejected provider requests"
```

### Task 5: 全量验证与安全检查

**Files:**
- Verify only: all files changed in Tasks 1–4

**Interfaces:**
- Consumes: 所有前述实现。
- Produces: 可交付的测试、类型和敏感信息检查证据。

- [ ] **Step 1: 运行聚焦测试**

```bash
cd apps/desktop
node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts electron/main/chat/provider-diagnostic-log.test.ts electron/main/chat/openrouter-provider.test.ts electron/main/application.test.ts
node scripts/run-vitest-electron.mjs run --config vitest.config.ts tests/components/chat.test.ts
```

Expected: 四个测试文件全部通过。

- [ ] **Step 2: 运行类型检查**

```bash
pnpm typecheck
```

Expected: 所有 workspace 类型检查退出码为 0。

- [ ] **Step 3: 运行完整测试**

```bash
pnpm test
```

Expected: 完整测试退出码为 0；不会触发真实网络图片生成。

- [ ] **Step 4: 检查脱敏边界和临时诊断残留**

```bash
rg -n "RAW_PROVIDER|must-not-be-written|seedream-live-diagnostic|\[DEBUG-" apps/desktop/electron/main apps/desktop/src
git diff --check e7ead41..HEAD
git status --short
```

Expected:

- `rg` 只命中测试 fixture，不命中生产日志字段或临时诊断脚本；
- `git diff --check` 无输出；
- `git status --short` 只显示用户原有品牌资源改动，没有本任务遗漏的未提交文件。

- [ ] **Step 5: 记录验证结果**

不创建额外空提交。最终回复必须分别报告：聚焦测试、类型检查、完整测试、敏感信息扫描，
并明确区分任何与本任务无关的既有失败。
