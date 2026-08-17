# Token 用量账单模块 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在设置页新增本月与累计 Token 账单，展示所有模型的输入、输出、总 Token 明细和全部模型汇总。

**Architecture:** SQLite Repository 直接聚合现有 `chat_runs`，应用服务计算本地自然月起点，并通过受认证的 `settings:get-token-usage` IPC 返回严格验证的快照。Settings Store 独立管理账单加载与错误，新的 `BillingUsagePanel.vue` 负责页签、汇总和模型表格，不修改 Provider、计费数据或数据库 Schema。

**Tech Stack:** TypeScript 6、Zod 4、better-sqlite3、Electron IPC/Preload、Vue 3、Pinia 4、Element Plus 2.14、Vitest、Vue Test Utils。

## Global Constraints

- 统计当前自然月和本机仍保留数据的累计用量。
- 覆盖所有供应商，按模型 ID 聚合，不推断或补写供应商。
- 有输入或输出 Token 的完成、失败、取消调用均计入；双侧都缺失时不计入。
- 单侧缺失按 `0` 处理，`totalTokens` 必须严格等于输入与输出之和。
- 首版只展示 Token，不展示美元费用、图表、日期筛选或导出。
- 不新增数据库表、迁移、Provider 网络请求、定时任务或轮询。
- 账单错误独立显示，不能影响其他设置功能。
- 清除会话或全部本地数据后刷新账单；只清除执行记录时不刷新账单。
- 只修改与本功能直接相关的文件，不做无关重构或格式化。

---

## File Structure

- Modify: `apps/desktop/electron/main/database/repositories.ts` — 定义并执行 Token 聚合查询。
- Modify: `apps/desktop/electron/main/database/database.test.ts` — 验证聚合口径、月初边界、排序和删除后结果。
- Modify: `packages/shared/src/desktop-api.ts` — 定义 Token 用量 Schema、类型、IPC channel 和 DesktopAPI 方法。
- Modify: `packages/shared/src/contracts.test.ts` — 验证共享契约和 IPC 声明。
- Modify: `apps/desktop/electron/main/application.ts` — 计算本地月初并装配 Repository 结果。
- Modify: `apps/desktop/electron/main/application.test.ts` — 验证应用服务月初与响应快照。
- Modify: `apps/desktop/electron/main/ipc/register-ipc.ts` — 注册受认证账单查询。
- Modify: `apps/desktop/electron/main/ipc/register-ipc.test.ts` — 验证路由、认证和输出校验。
- Modify: `apps/desktop/electron/preload/bridge.ts` — 暴露固定账单 IPC 方法。
- Modify: `apps/desktop/electron/preload/bridge.test.ts` — 验证 Preload 映射。
- Modify: `apps/desktop/src/stores/settings.ts` — 管理账单快照、加载、错误、竞态和清理后刷新。
- Create: `apps/desktop/src/components/settings/BillingUsagePanel.vue` — 渲染账单模块。
- Modify: `apps/desktop/src/views/SettingsView.vue` — 装配账单组件并在每次进入页面时加载。
- Modify: `apps/desktop/tests/components/workbench.test.ts` — 提供 DesktopAPI mock，并验证 Store 与界面行为。

### Task 1: 聚合现有 chat_runs Token 用量

**Files:**
- Modify: `apps/desktop/electron/main/database/repositories.ts:42-60,400-415,430-470,1439-1560`
- Test: `apps/desktop/electron/main/database/database.test.ts`

**Interfaces:**
- Consumes: `chat_runs.model`、`input_tokens`、`output_tokens`、`started_at`。
- Produces: `TokenUsageSnapshotRecord` 和 `chatRuns.summarizeTokenUsage(monthStartedAt: number): TokenUsageSnapshotRecord`。

- [ ] **Step 1: 写入 Repository 失败测试**

在 `database.test.ts` 新增用例。使用同一会话插入月初前、月初边界及月内记录，覆盖失败、取消、单侧缺失、双侧缺失和零 Token：

```ts
it('summarizes retained token usage by model for the current month and all time', () => {
  const database = openTestDatabase()
  database.conversations.insert({ id: 'conversation_usage', title: 'Usage' })
  const insert = (
    id: string,
    model: string,
    status: 'completed' | 'failed' | 'cancelled',
    startedAt: number,
    inputTokens?: number,
    outputTokens?: number,
  ) => database.chatRuns.insert({
    id,
    conversationId: 'conversation_usage',
    requestId: `request_${id}`,
    model,
    status,
    startedAt,
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
  })

  insert('before_alpha', 'alpha/model', 'completed', 99, 10, 5)
  insert('month_alpha', 'alpha/model', 'failed', 100, 7)
  insert('month_beta', 'beta/model', 'cancelled', 101, undefined, 9)
  insert('month_zero', 'zero/model', 'completed', 102, 0, 0)
  insert('ignored', 'ignored/model', 'completed', 103)

  expect(database.chatRuns.summarizeTokenUsage(100)).toEqual({
    month: {
      inputTokens: 7,
      outputTokens: 9,
      totalTokens: 16,
      models: [
        { model: 'beta/model', inputTokens: 0, outputTokens: 9, totalTokens: 9 },
        { model: 'alpha/model', inputTokens: 7, outputTokens: 0, totalTokens: 7 },
        { model: 'zero/model', inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      ],
    },
    allTime: {
      inputTokens: 17,
      outputTokens: 14,
      totalTokens: 31,
      models: [
        { model: 'alpha/model', inputTokens: 17, outputTokens: 5, totalTokens: 22 },
        { model: 'beta/model', inputTokens: 0, outputTokens: 9, totalTokens: 9 },
        { model: 'zero/model', inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      ],
    },
  })

  database.clearLocalData('conversations')
  expect(database.chatRuns.summarizeTokenUsage(100)).toEqual({
    month: { inputTokens: 0, outputTokens: 0, totalTokens: 0, models: [] },
    allTime: { inputTokens: 0, outputTokens: 0, totalTokens: 0, models: [] },
  })
})
```

- [ ] **Step 2: 运行聚焦测试并验证 RED**

从 `apps/desktop` 目录运行：

```bash
node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts electron/main/database/database.test.ts -t "summarizes retained token usage"
```

Expected: FAIL，`summarizeTokenUsage` 尚不存在。

- [ ] **Step 3: 定义 Repository 返回类型和接口**

在 `repositories.ts` 的 `ChatRun` 后新增：

```ts
export interface ModelTokenUsageRecord {
  model: string
  inputTokens: number
  outputTokens: number
  totalTokens: number
}

export interface TokenUsagePeriodRecord {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  models: ModelTokenUsageRecord[]
}

export interface TokenUsageSnapshotRecord {
  month: TokenUsagePeriodRecord
  allTime: TokenUsagePeriodRecord
}
```

在 `AppRepositories.chatRuns` 加入：

```ts
summarizeTokenUsage(monthStartedAt: number): TokenUsageSnapshotRecord
```

- [ ] **Step 4: 实现安全聚合转换**

在列常量附近新增：

```ts
interface TokenUsageRow {
  model: string
  allTimeInputTokens: number
  allTimeOutputTokens: number
  monthInputTokens: number
  monthOutputTokens: number
  monthRows: number
}

function safeTokenCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error('Token usage exceeded the supported range')
  }
  return value
}

function tokenUsagePeriod(
  rows: TokenUsageRow[],
  period: 'month' | 'allTime',
): TokenUsagePeriodRecord {
  const models = rows
    .filter((row) => period === 'allTime' || safeTokenCount(row.monthRows) > 0)
    .map((row): ModelTokenUsageRecord => {
      const inputTokens = safeTokenCount(
        period === 'month' ? row.monthInputTokens : row.allTimeInputTokens,
      )
      const outputTokens = safeTokenCount(
        period === 'month' ? row.monthOutputTokens : row.allTimeOutputTokens,
      )
      const totalTokens = safeTokenCount(inputTokens + outputTokens)
      return { model: row.model, inputTokens, outputTokens, totalTokens }
    })
    .sort((left, right) => right.totalTokens - left.totalTokens
      || (left.model < right.model ? -1 : left.model > right.model ? 1 : 0))
  const inputTokens = safeTokenCount(models.reduce((sum, model) => sum + model.inputTokens, 0))
  const outputTokens = safeTokenCount(models.reduce((sum, model) => sum + model.outputTokens, 0))
  return {
    inputTokens,
    outputTokens,
    totalTokens: safeTokenCount(inputTokens + outputTokens),
    models,
  }
}
```

- [ ] **Step 5: 实现单次同步 SQL 聚合**

在 `chatRuns` Repository 对象中加入：

```ts
summarizeTokenUsage(monthStartedAt) {
  const start = safeTokenCount(monthStartedAt)
  const rows = many<TokenUsageRow>(database, `
    SELECT
      model,
      SUM(COALESCE(input_tokens, 0)) AS allTimeInputTokens,
      SUM(COALESCE(output_tokens, 0)) AS allTimeOutputTokens,
      SUM(CASE WHEN started_at >= @monthStartedAt THEN COALESCE(input_tokens, 0) ELSE 0 END) AS monthInputTokens,
      SUM(CASE WHEN started_at >= @monthStartedAt THEN COALESCE(output_tokens, 0) ELSE 0 END) AS monthOutputTokens,
      SUM(CASE WHEN started_at >= @monthStartedAt THEN 1 ELSE 0 END) AS monthRows
    FROM chat_runs
    WHERE input_tokens IS NOT NULL OR output_tokens IS NOT NULL
    GROUP BY model
  `, { monthStartedAt: start })
  return {
    month: tokenUsagePeriod(rows, 'month'),
    allTime: tokenUsagePeriod(rows, 'allTime'),
  }
},
```

- [ ] **Step 6: 验证 GREEN 并提交**

```bash
node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts electron/main/database/database.test.ts
git add electron/main/database/repositories.ts electron/main/database/database.test.ts
git commit -m "feat: aggregate token usage by model"
```

Expected: `database.test.ts` 全部通过，提交只包含 Repository 与数据库测试。

### Task 2: 定义契约并贯通 IPC、Preload 与应用服务

**Files:**
- Modify: `packages/shared/src/desktop-api.ts`
- Test: `packages/shared/src/contracts.test.ts`
- Modify: `apps/desktop/electron/main/application.ts`
- Test: `apps/desktop/electron/main/application.test.ts`
- Modify: `apps/desktop/electron/main/ipc/register-ipc.ts`
- Test: `apps/desktop/electron/main/ipc/register-ipc.test.ts`
- Modify: `apps/desktop/electron/preload/bridge.ts`
- Test: `apps/desktop/electron/preload/bridge.test.ts`
- Modify: `apps/desktop/tests/components/workbench.test.ts:36-78` — 仅补齐新 DesktopAPI mock，保持类型检查可用。

**Interfaces:**
- Consumes: `chatRuns.summarizeTokenUsage(monthStartedAt)` from Task 1。
- Produces: `TokenUsageSnapshot`、`ipcChannels.settingsGetTokenUsage` 和 `DesktopAPI.settings.getTokenUsage()`。

- [ ] **Step 1: 写入共享契约失败测试**

在 `contracts.test.ts` 导入 `tokenUsageSnapshotSchema`，新增：

```ts
it('requires internally consistent token usage snapshots', () => {
  const snapshot = {
    monthStartedAt: '2026-08-01T00:00:00.000Z',
    month: {
      inputTokens: 7, outputTokens: 3, totalTokens: 10,
      models: [{ model: 'alpha/model', inputTokens: 7, outputTokens: 3, totalTokens: 10 }],
    },
    allTime: {
      inputTokens: 9, outputTokens: 6, totalTokens: 15,
      models: [
        { model: 'alpha/model', inputTokens: 7, outputTokens: 3, totalTokens: 10 },
        { model: 'beta/model', inputTokens: 2, outputTokens: 3, totalTokens: 5 },
      ],
    },
  }

  expect(tokenUsageSnapshotSchema.parse(snapshot)).toEqual(snapshot)
  expect(() => tokenUsageSnapshotSchema.parse({
    ...snapshot,
    month: { ...snapshot.month, totalTokens: 9 },
  })).toThrow()
  expect(() => tokenUsageSnapshotSchema.parse({
    ...snapshot,
    allTime: {
      ...snapshot.allTime,
      models: [...snapshot.allTime.models, snapshot.allTime.models[0]],
    },
  })).toThrow()
  expect(() => tokenUsageSnapshotSchema.parse({
    ...snapshot,
    month: { ...snapshot.month, inputTokens: Number.MAX_SAFE_INTEGER + 1 },
  })).toThrow()
  expect(() => tokenUsageSnapshotSchema.parse({
    ...snapshot,
    monthStartedAt: 'not-a-timestamp',
  })).toThrow()
  for (const inputTokens of [-1, 1.5]) {
    expect(() => tokenUsageSnapshotSchema.parse({
      ...snapshot,
      month: { ...snapshot.month, inputTokens },
    })).toThrow()
  }
  expect(ipcChannels.settingsGetTokenUsage).toBe('settings:get-token-usage')
  expect(ipcRequestSchemas[ipcChannels.settingsGetTokenUsage].parse(undefined)).toBeUndefined()
  expect(ipcResponseSchemas[ipcChannels.settingsGetTokenUsage].parse(snapshot)).toEqual(snapshot)
})
```

- [ ] **Step 2: 运行共享测试并验证 RED**

```bash
pnpm exec vitest run packages/shared/src/contracts.test.ts
```

Expected: FAIL，Schema 和 channel 尚不存在。

- [ ] **Step 3: 实现共享 Schema、类型和 DesktopAPI 方法**

在 `desktop-api.ts` 的 Provider 类型附近新增：

```ts
const safeTokenCountSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const tokenUsageShape = {
  inputTokens: safeTokenCountSchema,
  outputTokens: safeTokenCountSchema,
  totalTokens: safeTokenCountSchema,
}

export const modelTokenUsageSchema = z.object({
  model: nonEmptyStringSchema,
  ...tokenUsageShape,
}).strict().superRefine((usage, context) => {
  const total = usage.inputTokens + usage.outputTokens
  if (!Number.isSafeInteger(total) || usage.totalTokens !== total) {
    context.addIssue({ code: 'custom', path: ['totalTokens'], message: 'Token total must equal input plus output' })
  }
})

export const tokenUsagePeriodSchema = z.object({
  ...tokenUsageShape,
  models: z.array(modelTokenUsageSchema),
}).strict().superRefine((usage, context) => {
  const ids = new Set<string>()
  let inputTokens = 0
  let outputTokens = 0
  for (const model of usage.models) {
    if (ids.has(model.model)) {
      context.addIssue({ code: 'custom', path: ['models'], message: 'Token usage models must be unique' })
    }
    ids.add(model.model)
    inputTokens += model.inputTokens
    outputTokens += model.outputTokens
  }
  const totalTokens = inputTokens + outputTokens
  if (!Number.isSafeInteger(inputTokens)
    || !Number.isSafeInteger(outputTokens)
    || !Number.isSafeInteger(totalTokens)
    || usage.inputTokens !== inputTokens
    || usage.outputTokens !== outputTokens
    || usage.totalTokens !== totalTokens) {
    context.addIssue({ code: 'custom', message: 'Period totals must equal model totals' })
  }
})

export const tokenUsageSnapshotSchema = z.object({
  monthStartedAt: timestampSchema,
  month: tokenUsagePeriodSchema,
  allTime: tokenUsagePeriodSchema,
}).strict()

export type ModelTokenUsage = z.infer<typeof modelTokenUsageSchema>
export type TokenUsagePeriod = z.infer<typeof tokenUsagePeriodSchema>
export type TokenUsageSnapshot = z.infer<typeof tokenUsageSnapshotSchema>
```

同时增加：

```ts
settingsGetTokenUsage: 'settings:get-token-usage',
```

并把 channel 接入：

```ts
[ipcChannels.settingsGetTokenUsage]: z.undefined(),
// response map
[ipcChannels.settingsGetTokenUsage]: tokenUsageSnapshotSchema,
// DesktopAPI.settings
getTokenUsage(): Promise<TokenUsageSnapshot>
```

- [ ] **Step 4: 写入 Preload 与 IPC 失败测试**

在 `bridge.test.ts` 的 provider channel 用例中调用并断言：

```ts
await app.api.settings.getTokenUsage()
expect(app.ipcRenderer.invoke).toHaveBeenCalledWith(
  ipcChannels.settingsGetTokenUsage,
  undefined,
)
```

在 `register-ipc.test.ts` 的 `services().settings` mock 增加有效快照，并新增：

```ts
it('returns authenticated token usage through the fixed settings channel', async () => {
  const app = harness()
  await expect(app.invoke(ipcChannels.settingsGetTokenUsage)).resolves.toMatchObject({
    month: { totalTokens: 0 },
    allTime: { totalTokens: 0 },
  })
  expect(app.dependencies.auth.requireSession).toHaveBeenCalled()
  expect(app.dependencies.settings.getTokenUsage).toHaveBeenCalled()
})

it('rejects invalid token usage service output', async () => {
  const app = harness()
  vi.mocked(app.dependencies.settings.getTokenUsage).mockResolvedValueOnce({
    monthStartedAt: '2026-08-01T00:00:00.000Z',
    month: { inputTokens: 0, outputTokens: 0, totalTokens: 1, models: [] },
    allTime: { inputTokens: 0, outputTokens: 0, totalTokens: 0, models: [] },
  } as never)

  await expect(app.invoke(ipcChannels.settingsGetTokenUsage))
    .rejects.toMatchObject({ code: 'INTERNAL_ERROR' })
})
```

- [ ] **Step 5: 实现 Preload 与 IPC 固定映射**

在 `bridge.ts` 的 `settings` 对象加入：

```ts
getTokenUsage: () => invoke(ipcRenderer, ipcChannels.settingsGetTokenUsage),
```

在 `register-ipc.ts` 加入：

```ts
register(ipcChannels.settingsGetTokenUsage, () => options.services.settings.getTokenUsage())
```

- [ ] **Step 6: 写入应用服务失败测试**

在 `application.test.ts` 新增用例，先写入历史调用，再固定本机时间：

```ts
it('returns a local-calendar-month token usage snapshot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'autoforge-application-token-usage-'))
  directories.push(root)
  const path = join(root, 'autoforge.sqlite')
  const database = openAppDatabase(path)
  database.conversations.insert({ id: 'usage_conversation', title: 'Usage' })
  database.chatRuns.insert({
    id: 'usage_run', conversationId: 'usage_conversation', requestId: 'usage_request',
    model: 'alpha/model', status: 'failed', startedAt: new Date(2026, 7, 1).getTime(),
    inputTokens: 4, outputTokens: 6,
  })
  database.close()

  vi.useFakeTimers()
  vi.setSystemTime(new Date(2026, 7, 17, 12))
  try {
    const runtime = createApplicationRuntime(options(root))
    await expect(runtime.services.settings.getTokenUsage()).resolves.toEqual({
      monthStartedAt: new Date(2026, 7, 1).toISOString(),
      month: {
        inputTokens: 4, outputTokens: 6, totalTokens: 10,
        models: [{ model: 'alpha/model', inputTokens: 4, outputTokens: 6, totalTokens: 10 }],
      },
      allTime: {
        inputTokens: 4, outputTokens: 6, totalTokens: 10,
        models: [{ model: 'alpha/model', inputTokens: 4, outputTokens: 6, totalTokens: 10 }],
      },
    })
    await runtime.close()
  } finally {
    vi.useRealTimers()
  }
})
```

- [ ] **Step 7: 实现应用服务并补齐严格 mock**

在 `application.ts` 的 `services.settings` 加入：

```ts
getTokenUsage: async () => {
  const current = new Date()
  const monthStartedAt = new Date(current.getFullYear(), current.getMonth(), 1).getTime()
  return {
    monthStartedAt: new Date(monthStartedAt).toISOString(),
    ...database.chatRuns.summarizeTokenUsage(monthStartedAt),
  }
},
```

在 `workbench.test.ts` 的 `createApi().settings` 加入零快照 mock，使新的 `DesktopAPI` 契约在后续任务前保持完整：

```ts
getTokenUsage: vi.fn().mockResolvedValue({
  monthStartedAt: '2026-08-01T00:00:00.000Z',
  month: { inputTokens: 0, outputTokens: 0, totalTokens: 0, models: [] },
  allTime: { inputTokens: 0, outputTokens: 0, totalTokens: 0, models: [] },
}),
```

`register-ipc.test.ts` 的 settings mock 使用同一结构。

- [ ] **Step 8: 验证传输链路并提交**

```bash
pnpm exec vitest run packages/shared/src/contracts.test.ts
cd apps/desktop
node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts electron/preload/bridge.test.ts electron/main/ipc/register-ipc.test.ts electron/main/application.test.ts
cd ../..
pnpm --filter @autoforge/desktop typecheck
git add packages/shared/src/desktop-api.ts packages/shared/src/contracts.test.ts apps/desktop/electron/main/application.ts apps/desktop/electron/main/application.test.ts apps/desktop/electron/main/ipc/register-ipc.ts apps/desktop/electron/main/ipc/register-ipc.test.ts apps/desktop/electron/preload/bridge.ts apps/desktop/electron/preload/bridge.test.ts apps/desktop/tests/components/workbench.test.ts
git commit -m "feat: expose token usage through settings API"
```

Expected: 共享契约、应用、IPC、Preload 测试和 Desktop 类型检查通过。

### Task 3: 在 Settings Store 管理账单状态

**Files:**
- Modify: `apps/desktop/src/stores/settings.ts`
- Test: `apps/desktop/tests/components/workbench.test.ts`

**Interfaces:**
- Consumes: `DesktopAPI.settings.getTokenUsage(): Promise<TokenUsageSnapshot>`。
- Produces: `tokenUsage`、`tokenUsageLoading`、`tokenUsageError` 和 `loadTokenUsage()`。

- [ ] **Step 1: 写入 Store 竞态与错误隔离失败测试**

在 `workbench.test.ts` 导入 `TokenUsageSnapshot`，新增辅助函数和用例：

```ts
function usageSnapshot(totalTokens: number, model = 'alpha/model'): TokenUsageSnapshot {
  return {
    monthStartedAt: '2026-08-01T00:00:00.000Z',
    month: {
      inputTokens: totalTokens, outputTokens: 0, totalTokens,
      models: totalTokens === 0 ? [] : [{ model, inputTokens: totalTokens, outputTokens: 0, totalTokens }],
    },
    allTime: {
      inputTokens: totalTokens, outputTokens: 0, totalTokens,
      models: totalTokens === 0 ? [] : [{ model, inputTokens: totalTokens, outputTokens: 0, totalTokens }],
    },
  }
}

it('keeps only the newest token usage response and isolates billing errors', async () => {
  const api = createApi()
  let resolveFirst!: (value: TokenUsageSnapshot) => void
  vi.mocked(api.settings.getTokenUsage)
    .mockReturnValueOnce(new Promise((resolve) => { resolveFirst = resolve }))
    .mockResolvedValueOnce(usageSnapshot(20, 'new/model'))
    .mockRejectedValueOnce(new Error('billing unavailable'))
  Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
  const store = useSettingsStore()

  const first = store.loadTokenUsage()
  await store.loadTokenUsage()
  resolveFirst(usageSnapshot(10, 'old/model'))
  await first
  expect(store.tokenUsage?.allTime.models[0]?.model).toBe('new/model')

  await store.loadTokenUsage()
  expect(store.tokenUsageError).toBe('Token 用量加载失败')
  expect(store.error).toBe('')
  expect(store.tokenUsage?.allTime.totalTokens).toBe(20)
})
```

扩展已有 `resets visible stores after a successful all-data clear` 用例：

```ts
expect(api.settings.getTokenUsage).toHaveBeenCalledTimes(1)
```

再新增清除范围测试：

```ts
it('refreshes token usage after clearing conversations but not executions', async () => {
  const api = createApi()
  Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
  const store = useSettingsStore()

  await store.clearLocalData('conversations')
  expect(api.settings.getTokenUsage).toHaveBeenCalledTimes(1)

  vi.mocked(api.settings.getTokenUsage).mockClear()
  await store.clearLocalData('executions')
  expect(api.settings.getTokenUsage).not.toHaveBeenCalled()
})
```

- [ ] **Step 2: 运行 Store 测试并验证 RED**

```bash
cd apps/desktop
node scripts/run-vitest-electron.mjs run --config vitest.config.ts tests/components/workbench.test.ts -t "token usage response|visible stores|refreshes token usage"
```

Expected: FAIL，Store 尚无账单状态和 action。

- [ ] **Step 3: 实现独立账单状态和竞态保护**

在 Store 类型导入中加入 `TokenUsageSnapshot`，state 加入：

```ts
tokenUsage: undefined as TokenUsageSnapshot | undefined,
tokenUsageLoading: false,
tokenUsageError: '',
_tokenUsageVersion: 0,
```

actions 加入：

```ts
async loadTokenUsage() {
  const version = ++this._tokenUsageVersion
  this.tokenUsageLoading = true
  this.tokenUsageError = ''
  try {
    const usage = await getDesktopApi().settings.getTokenUsage()
    if (version === this._tokenUsageVersion) this.tokenUsage = usage
  } catch (error) {
    if (version === this._tokenUsageVersion) {
      this.tokenUsageError = displayError(error, 'Token 用量加载失败')
    }
  } finally {
    if (version === this._tokenUsageVersion) this.tokenUsageLoading = false
  }
},
```

- [ ] **Step 4: 清除会话后刷新账单**

将 `clearLocalData` 成功路径调整为：

```ts
if (scope === 'conversations' || scope === 'all') useChatStore().resetLocalData()
if (scope === 'executions' || scope === 'all') useExecutionStore().resetLocalData()
if (scope === 'all') {
  await Promise.all([useWorkflowStore().load(), this.load(), this.loadTokenUsage()])
} else if (scope === 'conversations') {
  await this.loadTokenUsage()
}
```

失败路径保持原快照，不调用 `loadTokenUsage()`。

- [ ] **Step 5: 验证 Store 并提交**

```bash
cd apps/desktop
node scripts/run-vitest-electron.mjs run --config vitest.config.ts tests/components/workbench.test.ts
cd ../..
git add apps/desktop/src/stores/settings.ts apps/desktop/tests/components/workbench.test.ts
git commit -m "feat: load token usage in settings store"
```

Expected: `workbench.test.ts` 全部通过。

### Task 4: 新增账单组件并装配设置页

**Files:**
- Create: `apps/desktop/src/components/settings/BillingUsagePanel.vue`
- Modify: `apps/desktop/src/views/SettingsView.vue`
- Test: `apps/desktop/tests/components/workbench.test.ts`

**Interfaces:**
- Consumes: `usage?: TokenUsageSnapshot`、`loading: boolean`、`error: string`。
- Produces: `refresh` 事件。

- [ ] **Step 1: 写入设置页账单失败测试**

在 `workbench.test.ts` 新增：

```ts
it('renders monthly and all-time token usage and refreshes it from settings', async () => {
  const api = createApi()
  vi.mocked(api.settings.getTokenUsage).mockResolvedValue({
    monthStartedAt: '2026-08-01T00:00:00.000Z',
    month: {
      inputTokens: 1_200, outputTokens: 34, totalTokens: 1_234,
      models: [{ model: 'month/model', inputTokens: 1_200, outputTokens: 34, totalTokens: 1_234 }],
    },
    allTime: {
      inputTokens: 50_000, outputTokens: 6_789, totalTokens: 56_789,
      models: [{ model: 'all/model', inputTokens: 50_000, outputTokens: 6_789, totalTokens: 56_789 }],
    },
  })

  const { wrapper } = await mountApp('/settings', api)
  await vi.waitFor(() => expect(wrapper.text()).toContain('Token 账单'))
  expect(api.settings.getTokenUsage).toHaveBeenCalledTimes(1)
  expect(wrapper.get('[data-testid="billing-summary-total"]').text()).toContain('1,234')
  expect(wrapper.text()).toContain('month/model')

  await wrapper.get('#tab-allTime').trigger('click')
  expect(wrapper.get('[data-testid="billing-summary-total"]').text()).toContain('56,789')
  expect(wrapper.text()).toContain('all/model')

  await wrapper.get('[data-testid="billing-refresh"]').trigger('click')
  await vi.waitFor(() => expect(api.settings.getTokenUsage).toHaveBeenCalledTimes(2))
})
```

再新增空数据与失败用例：

```ts
it('shows token usage empty and isolated error states', async () => {
  const emptyApi = createApi()
  vi.mocked(emptyApi.settings.getTokenUsage).mockResolvedValue(usageSnapshot(0))
  const emptyApp = await mountApp('/settings', emptyApi)
  await vi.waitFor(() => expect(emptyApp.wrapper.text()).toContain('暂无 Token 用量记录'))
  emptyApp.wrapper.unmount()

  const failingApi = createApi()
  vi.mocked(failingApi.settings.getTokenUsage).mockRejectedValue(new Error('billing unavailable'))
  const failingApp = await mountApp('/settings', failingApi)
  await vi.waitFor(() => expect(failingApp.wrapper.get('[data-testid="billing-panel"] [role="alert"]').text())
    .toBe('Token 用量加载失败'))
  expect(failingApp.wrapper.text()).toContain('大模型供应商')
})
```

- [ ] **Step 2: 运行界面测试并验证 RED**

```bash
cd apps/desktop
node scripts/run-vitest-electron.mjs run --config vitest.config.ts tests/components/workbench.test.ts -t "token usage|Token 用量"
```

Expected: FAIL，账单模块尚未渲染。

- [ ] **Step 3: 创建 BillingUsagePanel.vue**

创建组件，模板结构固定为：

```vue
<template>
  <section id="billing" class="billing-panel settings-section" data-testid="billing-panel">
    <header class="billing-header">
      <div>
        <h2>Token 账单</h2>
        <p>统计来自本机当前保留的模型调用记录。</p>
      </div>
      <el-button
        :icon="Refresh"
        :loading="loading"
        data-testid="billing-refresh"
        @click="$emit('refresh')"
      >
        刷新
      </el-button>
    </header>
    <div class="billing-body">
      <p v-if="error" class="billing-error" role="alert">{{ error }}</p>
      <p v-if="!usage && loading" class="billing-empty">正在加载 Token 用量…</p>
      <template v-else-if="usage">
        <el-tabs v-model="activePeriod" data-testid="billing-tabs">
          <el-tab-pane label="本月" name="month" />
          <el-tab-pane label="累计" name="allTime" />
        </el-tabs>
        <p v-if="activePeriod === 'month'" class="billing-period">
          统计自 {{ formatMonthStart(usage.monthStartedAt) }}
        </p>
        <dl class="billing-summary">
          <div><dt>输入 Token</dt><dd>{{ formatTokens(activeUsage.inputTokens) }}</dd></div>
          <div><dt>输出 Token</dt><dd>{{ formatTokens(activeUsage.outputTokens) }}</dd></div>
          <div data-testid="billing-summary-total"><dt>总 Token</dt><dd>{{ formatTokens(activeUsage.totalTokens) }}</dd></div>
        </dl>
        <p v-if="!activeUsage.models.length" class="billing-empty">暂无 Token 用量记录</p>
        <div v-else class="billing-table-wrap">
          <table class="billing-table">
            <thead><tr><th>模型</th><th>输入 Token</th><th>输出 Token</th><th>总 Token</th></tr></thead>
            <tbody>
              <tr v-for="model in activeUsage.models" :key="model.model">
                <td>{{ model.model }}</td>
                <td>{{ formatTokens(model.inputTokens) }}</td>
                <td>{{ formatTokens(model.outputTokens) }}</td>
                <td>{{ formatTokens(model.totalTokens) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </template>
    </div>
  </section>
</template>

<script setup lang="ts">
import { Refresh } from '@element-plus/icons-vue'
import type { TokenUsagePeriod, TokenUsageSnapshot } from '@autoforge/shared'
import { computed, ref } from 'vue'

const props = defineProps<{
  usage?: TokenUsageSnapshot
  loading: boolean
  error: string
}>()
defineEmits<{ refresh: [] }>()

const activePeriod = ref<'month' | 'allTime'>('month')
const emptyPeriod: TokenUsagePeriod = {
  inputTokens: 0, outputTokens: 0, totalTokens: 0, models: [],
}
const activeUsage = computed(() => props.usage?.[activePeriod.value] ?? emptyPeriod)
const tokenFormatter = new Intl.NumberFormat('zh-CN')
const monthFormatter = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric', month: 'long', day: 'numeric',
})
const formatTokens = (value: number) => tokenFormatter.format(value)
const formatMonthStart = (value: string) => monthFormatter.format(new Date(value))
</script>

<style scoped>
.billing-panel {
  margin-top: 14px;
  overflow: hidden;
  border: 1px solid var(--af-border);
  border-radius: 14px;
  background: var(--af-surface);
}

.billing-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  padding: 18px 20px;
  border-bottom: 1px solid var(--af-border);
}

.billing-header h2,
.billing-header p,
.billing-period,
.billing-error,
.billing-empty {
  margin: 0;
}

.billing-header p,
.billing-period,
.billing-empty {
  color: var(--af-text-muted);
}

.billing-body {
  padding: 16px 20px 20px;
}

.billing-error {
  margin-bottom: 12px;
  color: var(--af-danger);
}

.billing-period {
  margin-bottom: 14px;
  font-size: 13px;
}

.billing-summary {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
  margin: 0 0 16px;
}

.billing-summary div {
  padding: 14px;
  border: 1px solid var(--af-border);
  border-radius: 10px;
  background: var(--af-surface-muted);
}

.billing-summary dt {
  color: var(--af-text-muted);
  font-size: 12px;
}

.billing-summary dd {
  margin: 6px 0 0;
  font-size: 20px;
  font-weight: 700;
}

.billing-table-wrap {
  overflow-x: auto;
}

.billing-table {
  width: 100%;
  min-width: 620px;
  border-collapse: collapse;
}

.billing-table th,
.billing-table td {
  padding: 10px 12px;
  border-bottom: 1px solid var(--af-border);
  text-align: right;
}

.billing-table th:first-child,
.billing-table td:first-child {
  max-width: 320px;
  overflow-wrap: anywhere;
  text-align: left;
}

@media (max-width: 640px) {
  .billing-header {
    align-items: stretch;
    flex-direction: column;
  }

  .billing-summary {
    grid-template-columns: 1fr;
  }
}
</style>
```

- [ ] **Step 4: 在 SettingsView 装配并每次进入加载**

在默认模型区块之后、VPN 代理之前加入：

```vue
<BillingUsagePanel
  :usage="settings.tokenUsage"
  :loading="settings.tokenUsageLoading"
  :error="settings.tokenUsageError"
  @refresh="settings.loadTokenUsage"
/>
```

导入组件：

```ts
import BillingUsagePanel from '../components/settings/BillingUsagePanel.vue'
```

更新挂载逻辑，账单加载与基础设置加载相互独立：

```ts
onMounted(async () => {
  await Promise.all([
    !settings.settings && !settings.loading ? settings.load() : Promise.resolve(),
    settings.loadTokenUsage(),
  ])
})
```

- [ ] **Step 5: 验证组件、空状态和错误隔离**

```bash
cd apps/desktop
node scripts/run-vitest-electron.mjs run --config vitest.config.ts tests/components/workbench.test.ts
pnpm typecheck
cd ../..
```

Expected: 组件测试和 Desktop 类型检查通过；账单错误不隐藏其他设置区块。

- [ ] **Step 6: 提交 UI**

```bash
git add apps/desktop/src/components/settings/BillingUsagePanel.vue apps/desktop/src/views/SettingsView.vue apps/desktop/tests/components/workbench.test.ts
git commit -m "feat: add token usage billing to settings"
```

### Task 5: 完整验证与交付检查

**Files:**
- Verify only: all modified files from Tasks 1–4。

**Interfaces:**
- Consumes: 完整账单垂直链路。
- Produces: 可交付验证证据，不新增行为。

- [ ] **Step 1: 运行聚焦与完整测试**

从仓库根目录运行：

```bash
pnpm test
```

Expected: 47 个测试文件及新增测试全部通过；测试总数应大于基线 1125。

- [ ] **Step 2: 运行静态检查和构建**

```bash
pnpm typecheck
pnpm lint
pnpm build
git diff --check
```

Expected: 命令退出码均为 `0`。若 Lint 只报告仓库既有 warning，记录 warning 数量和文件，不能把 warning 称为全绿。

- [ ] **Step 3: 审查提交和工作区**

```bash
git status --short
git log --oneline -8
git diff master...HEAD --stat
```

Expected: 工作区干净；功能提交按 Repository、传输、Store、UI 分层；没有数据库迁移、费用展示或无关文件。
