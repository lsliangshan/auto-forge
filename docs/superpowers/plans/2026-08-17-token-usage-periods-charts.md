# Token 用量多周期与图表 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将设置页 Token 账单扩展为默认今日、支持昨日/本周/本月/累计切换，并加入时间趋势折线图和按模型堆叠柱状图。

**Architecture:** Main 进程为每次请求捕获一个本机时间快照，SQLite Repository 在同一只读事务中聚合五个周期的模型用量和稀疏趋势，独立时间 helper 补齐连续小时/日/月桶后通过现有受认证 IPC 返回严格验证的完整快照。Renderer 保留一份快照并在本地切换周期，两个窄 ECharts 组件分别负责折线图和柱状图生命周期，现有表格继续提供精确数值与无障碍替代。

**Tech Stack:** TypeScript 6、Zod 4、better-sqlite3 12、Electron 43 IPC/Preload、Vue 3、Pinia 4、Element Plus 2.14、ECharts 6.1.0（按需引入）、Vitest 4、Vue Test Utils。

## Global Constraints

- 周期固定为今日、昨日、本周、本月、累计，默认今日；本周从本机时区周一 00:00 开始。
- 今日/昨日趋势按小时，本周/本月按自然日，累计按自然月；缺失桶补零。
- 折线图固定显示输入、输出、总 Token 三条线；柱状图固定按模型堆叠输入与输出。
- 五个周期均显示起止时间；昨日使用排他结束边界存储、以当日 23:59 展示。
- 一次 `settings.getTokenUsage()` 返回五周期完整快照；页签切换不得发 IPC。
- 有任一 Token 字段的完成、失败、取消调用均计入；单侧缺失按零、双侧缺失不计入。
- 模型、趋势、周期的输入/输出/总量必须三层一致，所有 Token 必须是非负安全整数。
- 图表使用 ECharts 6.1.0 模块化引入，不引入全量 bundle 或第二个图表库。
- 不新增数据库迁移、计数表、缓存、定时轮询、Provider 请求、费用换算、日期筛选或导出。
- 账单错误保持模块隔离，并保留上一次成功快照和刷新入口。
- 只修改 Token 契约、聚合、应用服务、账单 UI、相关测试和桌面依赖，不重构其他设置模块。

---

## File Structure

- Modify: `packages/shared/src/desktop-api.ts` — 定义五周期快照、趋势点和一致性 Schema。
- Modify: `packages/shared/src/contracts.test.ts` — 锁定范围、趋势排序和三层总和契约。
- Modify: `apps/desktop/electron/main/database/repositories.ts` — 在只读事务中聚合五周期模型和稀疏趋势。
- Modify: `apps/desktop/electron/main/database/database.test.ts` — 验证周期边界、粒度、状态和删除语义。
- Create: `apps/desktop/electron/main/token-usage.ts` — 计算本地周期边界并补齐连续趋势桶。
- Create: `apps/desktop/electron/main/token-usage.test.ts` — 验证周一/月初/昨日/累计和 DST 桶。
- Modify: `apps/desktop/electron/main/application.ts` — 使用 token-usage helper 装配设置服务。
- Modify: `apps/desktop/electron/main/application.test.ts` — 验证真实数据库到五周期快照。
- Modify: `apps/desktop/electron/main/ipc/register-ipc.test.ts` — 更新有效/非法响应 fixture；channel 本身不变。
- Modify: `apps/desktop/tests/components/workbench.test.ts` — 更新 DesktopAPI fixture 和账单交互测试。
- Modify: `apps/desktop/package.json`、`pnpm-lock.yaml` — 精确加入 `echarts@6.1.0`。
- Create: `apps/desktop/src/components/settings/token-usage-chart.ts` — 注册所需 ECharts 模块并封装实例生命周期。
- Create: `apps/desktop/src/components/settings/token-usage-chart-options.ts` — 纯函数生成折线/柱状图配置。
- Create: `apps/desktop/src/components/settings/TokenUsageLineChart.vue` — 渲染趋势折线图。
- Create: `apps/desktop/src/components/settings/TokenUsageBarChart.vue` — 渲染模型堆叠柱状图。
- Create: `apps/desktop/tests/components/token-usage-charts.test.ts` — 验证 option 与 ECharts 生命周期。
- Modify: `apps/desktop/src/components/settings/BillingUsagePanel.vue` — 五页签、范围、汇总、图表与表格布局。

`apps/desktop/electron/preload/bridge.ts`、`apps/desktop/electron/main/ipc/register-ipc.ts` 和 `apps/desktop/src/stores/settings.ts` 的方法与状态结构无需改动；类型升级会由共享契约传播。若实现时这些文件出现非类型性修改需求，先回到规格核对边界，不能顺手扩展接口。

---

### Task 1: 升级共享 Token 用量契约

**Files:**
- Modify: `packages/shared/src/desktop-api.ts`
- Test: `packages/shared/src/contracts.test.ts`

**Interfaces:**
- Consumes: 现有 `timestampSchema`、`modelTokenUsageSchema` 和 `DesktopAPI.settings.getTokenUsage()`。
- Produces: `TokenUsagePeriodKey`、`TokenUsageTrendPoint`、新版 `TokenUsagePeriod`、新版 `TokenUsageSnapshot`；现有 IPC channel 与方法签名名称保持不变。

- [ ] **Step 1: 用五周期有效快照替换契约测试 fixture**

在 `contracts.test.ts` 的 Token 用量用例附近定义完整 fixture：

```ts
const period = (
  startedAt: string,
  endedAt: string,
  inputTokens: number,
  outputTokens: number,
  model = 'alpha/model',
) => ({
  startedAt,
  endedAt,
  inputTokens,
  outputTokens,
  totalTokens: inputTokens + outputTokens,
  models: inputTokens + outputTokens === 0
    ? []
    : [{ model, inputTokens, outputTokens, totalTokens: inputTokens + outputTokens }],
  trend: inputTokens + outputTokens === 0
    ? []
    : [{ startedAt, inputTokens, outputTokens, totalTokens: inputTokens + outputTokens }],
})

const snapshot = {
  generatedAt: '2026-08-17T04:30:00.000Z',
  today: period('2026-08-16T16:00:00.000Z', '2026-08-17T04:30:00.000Z', 7, 3),
  yesterday: period('2026-08-15T16:00:00.000Z', '2026-08-16T16:00:00.000Z', 2, 1),
  week: period('2026-08-16T16:00:00.000Z', '2026-08-17T04:30:00.000Z', 7, 3),
  month: period('2026-07-31T16:00:00.000Z', '2026-08-17T04:30:00.000Z', 9, 4),
  allTime: period('2026-07-01T01:00:00.000Z', '2026-08-17T04:30:00.000Z', 12, 6),
}

expect(tokenUsageSnapshotSchema.parse(snapshot)).toEqual(snapshot)
```

- [ ] **Step 2: 增加范围、趋势顺序和三层总和失败测试**

```ts
expect(() => tokenUsageSnapshotSchema.parse({
  ...snapshot,
  today: { ...snapshot.today, startedAt: '2026-08-18T00:00:00.000Z' },
})).toThrow()

expect(() => tokenUsageSnapshotSchema.parse({
  ...snapshot,
  today: {
    ...snapshot.today,
    trend: [
      { startedAt: '2026-08-17T03:00:00.000Z', inputTokens: 4, outputTokens: 1, totalTokens: 5 },
      { startedAt: '2026-08-17T02:00:00.000Z', inputTokens: 3, outputTokens: 2, totalTokens: 5 },
    ],
  },
})).toThrow()

expect(() => tokenUsageSnapshotSchema.parse({
  ...snapshot,
  today: {
    ...snapshot.today,
    trend: [{ ...snapshot.today.trend[0], totalTokens: 9 }],
  },
})).toThrow()

expect(() => tokenUsageSnapshotSchema.parse({
  ...snapshot,
  today: { ...snapshot.today, inputTokens: 8, totalTokens: 11 },
})).toThrow()

expect(() => tokenUsageSnapshotSchema.parse({
  ...snapshot,
  today: {
    ...snapshot.today,
    trend: [{ ...snapshot.today.trend[0], startedAt: snapshot.today.endedAt }],
  },
})).toThrow()

expect(() => tokenUsageSnapshotSchema.parse({
  ...snapshot,
  yesterday: { ...snapshot.yesterday, endedAt: '2026-08-16T15:59:59.999Z' },
})).toThrow()
```

- [ ] **Step 3: 运行聚焦测试并验证 RED**

Run:

```bash
pnpm exec vitest run packages/shared/src/contracts.test.ts
```

Expected: FAIL，旧 `tokenUsageSnapshotSchema` 仍要求 `monthStartedAt/month/allTime`，尚不接受 `generatedAt/today/yesterday/week/month/allTime`。

- [ ] **Step 4: 实现趋势点、周期和快照 Schema**

在 `desktop-api.ts` 中用以下结构替换旧 Token 用量周期与快照定义；保留现有 `modelTokenUsageSchema`：

```ts
export const tokenUsagePeriodKeys = ['today', 'yesterday', 'week', 'month', 'allTime'] as const
export type TokenUsagePeriodKey = (typeof tokenUsagePeriodKeys)[number]

export const tokenUsageTrendPointSchema = z.object({
  startedAt: timestampSchema,
  ...tokenUsageShape,
}).strict().superRefine((point, context) => {
  const total = point.inputTokens + point.outputTokens
  if (!Number.isSafeInteger(total) || point.totalTokens !== total) {
    context.addIssue({
      code: 'custom',
      path: ['totalTokens'],
      message: 'Trend total must equal input plus output',
    })
  }
})

export const tokenUsagePeriodSchema = z.object({
  startedAt: timestampSchema,
  endedAt: timestampSchema,
  ...tokenUsageShape,
  models: z.array(modelTokenUsageSchema),
  trend: z.array(tokenUsageTrendPointSchema),
}).strict().superRefine((usage, context) => {
  const startedAt = Date.parse(usage.startedAt)
  const endedAt = Date.parse(usage.endedAt)
  if (startedAt > endedAt) {
    context.addIssue({ code: 'custom', path: ['endedAt'], message: 'Period end must not precede start' })
  }

  const modelIds = new Set<string>()
  let modelInput = 0
  let modelOutput = 0
  for (const model of usage.models) {
    if (modelIds.has(model.model)) {
      context.addIssue({ code: 'custom', path: ['models'], message: 'Token usage models must be unique' })
    }
    modelIds.add(model.model)
    modelInput += model.inputTokens
    modelOutput += model.outputTokens
  }

  let trendInput = 0
  let trendOutput = 0
  let previousStartedAt = -1
  for (const point of usage.trend) {
    const pointStartedAt = Date.parse(point.startedAt)
    if (pointStartedAt < startedAt || pointStartedAt >= endedAt || pointStartedAt <= previousStartedAt) {
      context.addIssue({
        code: 'custom',
        path: ['trend'],
        message: 'Trend points must be unique, ordered and inside the period',
      })
    }
    previousStartedAt = pointStartedAt
    trendInput += point.inputTokens
    trendOutput += point.outputTokens
  }

  const totals = [
    modelInput,
    modelOutput,
    modelInput + modelOutput,
    trendInput,
    trendOutput,
    trendInput + trendOutput,
  ]
  if (totals.some((value) => !Number.isSafeInteger(value))
    || usage.inputTokens !== modelInput
    || usage.outputTokens !== modelOutput
    || usage.totalTokens !== modelInput + modelOutput
    || usage.inputTokens !== trendInput
    || usage.outputTokens !== trendOutput
    || usage.totalTokens !== trendInput + trendOutput) {
    context.addIssue({ code: 'custom', message: 'Period, model and trend totals must match' })
  }
})

export const tokenUsageSnapshotSchema = z.object({
  generatedAt: timestampSchema,
  today: tokenUsagePeriodSchema,
  yesterday: tokenUsagePeriodSchema,
  week: tokenUsagePeriodSchema,
  month: tokenUsagePeriodSchema,
  allTime: tokenUsagePeriodSchema,
}).strict().superRefine((snapshot, context) => {
  const generatedAt = Date.parse(snapshot.generatedAt)
  for (const key of ['today', 'week', 'month', 'allTime'] as const) {
    if (Date.parse(snapshot[key].endedAt) !== generatedAt) {
      context.addIssue({ code: 'custom', path: [key, 'endedAt'], message: 'Active period must end at generation time' })
    }
  }
  if (Date.parse(snapshot.yesterday.endedAt) !== Date.parse(snapshot.today.startedAt)) {
    context.addIssue({ code: 'custom', path: ['yesterday', 'endedAt'], message: 'Yesterday must end when today starts' })
  }
})

export type TokenUsageTrendPoint = z.infer<typeof tokenUsageTrendPointSchema>
export type TokenUsagePeriod = z.infer<typeof tokenUsagePeriodSchema>
export type TokenUsageSnapshot = z.infer<typeof tokenUsageSnapshotSchema>
```

- [ ] **Step 5: 运行共享契约测试并验证 GREEN**

Run:

```bash
pnpm exec vitest run packages/shared/src/contracts.test.ts
```

Expected: PASS，Token 用量合法与非法 fixture 均被正确分类。

- [ ] **Step 6: 提交共享契约**

```bash
git add packages/shared/src/desktop-api.ts packages/shared/src/contracts.test.ts
git commit -m "feat: define token usage period trends"
```

---

### Task 2: 在 SQLite Repository 聚合五周期稀疏数据

**Files:**
- Modify: `apps/desktop/electron/main/database/repositories.ts`
- Test: `apps/desktop/electron/main/database/database.test.ts`

**Interfaces:**
- Consumes: `TokenUsageQueryRecord`，包含同一请求的 `endedAt`、今日/昨日/本周/本月起点。
- Produces: `chatRuns.summarizeTokenUsage(input: TokenUsageQueryRecord): TokenUsageSnapshotRecord`；每周期含模型总量和按 `hour/day/month` 分组的稀疏趋势。

- [ ] **Step 1: 把 Repository 测试改为五周期查询**

在现有 `summarizes retained token usage by model...` 用例中使用以下查询边界，并插入每个边界前后记录：

```ts
const query = {
  yesterdayStartedAt: 100,
  todayStartedAt: 200,
  weekStartedAt: 180,
  monthStartedAt: 50,
  endedAt: 300,
}

insert('before_month', 'alpha/model', 'completed', 49, 10, 5)
insert('yesterday', 'alpha/model', 'failed', 100, 7)
insert('today', 'beta/model', 'cancelled', 200, undefined, 9)
insert('today_zero', 'zero/model', 'completed', 201, 0, 0)
insert('at_end', 'ignored/model', 'completed', 300, 99, 99)
insert('no_usage', 'ignored/model', 'completed', 250)

const usage = database.chatRuns.summarizeTokenUsage(query)
expect(usage.allTimeStartedAt).toBe(49)
expect(usage.today.models).toEqual([
  { model: 'beta/model', inputTokens: 0, outputTokens: 9, totalTokens: 9 },
  { model: 'zero/model', inputTokens: 0, outputTokens: 0, totalTokens: 0 },
])
expect(usage.yesterday.models).toEqual([
  { model: 'alpha/model', inputTokens: 7, outputTokens: 0, totalTokens: 7 },
])
expect(usage.week.models).toEqual(usage.today.models)
expect(usage.month.models).toEqual([
  { model: 'beta/model', inputTokens: 0, outputTokens: 9, totalTokens: 9 },
  { model: 'alpha/model', inputTokens: 7, outputTokens: 0, totalTokens: 7 },
  { model: 'zero/model', inputTokens: 0, outputTokens: 0, totalTokens: 0 },
])
expect(usage.allTime.models[0]).toEqual({
  model: 'alpha/model', inputTokens: 17, outputTokens: 5, totalTokens: 22,
})
expect(usage.allTime.models.some(({ model }) => model === 'ignored/model')).toBe(false)
```

- [ ] **Step 2: 增加小时、日、月分组和结束点排他测试**

使用真实毫秒时间戳，断言同小时合并、相邻自然日和自然月拆分：

```ts
const local = (year: number, month: number, day: number, hour = 0) => (
  new Date(year, month, day, hour).getTime()
)
const query = {
  yesterdayStartedAt: local(2025, 11, 31),
  todayStartedAt: local(2026, 0, 1),
  weekStartedAt: local(2025, 11, 29),
  monthStartedAt: local(2026, 0, 1),
  endedAt: local(2026, 0, 2),
}

insert('hour_a', 'alpha/model', 'completed', local(2026, 0, 1, 8), 2, 1)
insert('hour_b', 'alpha/model', 'completed', local(2026, 0, 1, 8) + 1_000, 3, 4)
insert('at_end', 'alpha/model', 'completed', query.endedAt, 50, 50)

const usage = database.chatRuns.summarizeTokenUsage(query)
expect(usage.today.trend).toEqual([
  { bucket: '8', inputTokens: 5, outputTokens: 5, totalTokens: 10 },
])
expect(usage.week.trend).toEqual([
  { bucket: '2026-01-01', inputTokens: 5, outputTokens: 5, totalTokens: 10 },
])
expect(usage.allTime.trend).toEqual([
  { bucket: '2026-01', inputTokens: 5, outputTokens: 5, totalTokens: 10 },
])
```

小时 `bucket` 是从对应周期 `startedAt` 起算的零基索引，避免半小时时区和夏令时重复小时发生键冲突；日/月 bucket 使用本机日历键。

- [ ] **Step 3: 运行 Repository 聚焦测试并验证 RED**

Run:

```bash
cd apps/desktop
node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts electron/main/database/database.test.ts -t "summarizes retained token usage|groups token usage trends"
```

Expected: FAIL，旧 `summarizeTokenUsage(number)` 不接受五周期查询，也不返回 `today/yesterday/week/trend`。

- [ ] **Step 4: 定义 Repository 查询与返回类型**

在 `repositories.ts` 中用以下类型替换旧 `TokenUsageSnapshotRecord`：

```ts
export type TokenUsageGranularityRecord = 'hour' | 'day' | 'month'

export interface TokenUsageQueryRecord {
  yesterdayStartedAt: number
  todayStartedAt: number
  weekStartedAt: number
  monthStartedAt: number
  endedAt: number
}

export interface TokenUsageTrendRecord {
  bucket: string
  inputTokens: number
  outputTokens: number
  totalTokens: number
}

export interface TokenUsagePeriodRecord {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  models: ModelTokenUsageRecord[]
  trend: TokenUsageTrendRecord[]
}

export interface TokenUsageSnapshotRecord {
  allTimeStartedAt?: number
  today: TokenUsagePeriodRecord
  yesterday: TokenUsagePeriodRecord
  week: TokenUsagePeriodRecord
  month: TokenUsagePeriodRecord
  allTime: TokenUsagePeriodRecord
}
```

把 Repository 接口改为：

```ts
summarizeTokenUsage(input: TokenUsageQueryRecord): TokenUsageSnapshotRecord
```

- [ ] **Step 5: 实现单周期模型与趋势聚合 helper**

加入固定 bucket 表达式和聚合函数；granularity 只能来自代码内枚举，不能接收 SQL 字符串输入：

```ts
interface TokenUsageRow {
  model: string
  inputTokens: number
  outputTokens: number
}

interface SparseTokenUsageRow {
  bucket: string | number
  inputTokens: number
  outputTokens: number
}

function trendBucketSql(granularity: TokenUsageGranularityRecord): string {
  if (granularity === 'hour') {
    return 'CAST((started_at - @startedAt) / 3600000 AS INTEGER)'
  }
  if (granularity === 'day') {
    return "strftime('%Y-%m-%d', started_at / 1000, 'unixepoch', 'localtime')"
  }
  return "strftime('%Y-%m', started_at / 1000, 'unixepoch', 'localtime')"
}

function summarizeTokenUsagePeriod(
  database: SqliteDatabase,
  startedAt: number,
  endedAt: number,
  granularity: TokenUsageGranularityRecord,
): TokenUsagePeriodRecord {
  const parameters = {
    startedAt: safeTokenCount(startedAt),
    endedAt: safeTokenCount(endedAt),
  }
  const models = many<TokenUsageRow>(database, `
    SELECT
      model,
      SUM(COALESCE(input_tokens, 0)) AS inputTokens,
      SUM(COALESCE(output_tokens, 0)) AS outputTokens
    FROM chat_runs
    WHERE (input_tokens IS NOT NULL OR output_tokens IS NOT NULL)
      AND started_at >= @startedAt
      AND started_at < @endedAt
    GROUP BY model
  `, parameters).map((row): ModelTokenUsageRecord => {
    const inputTokens = safeTokenCount(row.inputTokens)
    const outputTokens = safeTokenCount(row.outputTokens)
    return {
      model: row.model,
      inputTokens,
      outputTokens,
      totalTokens: safeTokenCount(inputTokens + outputTokens),
    }
  }).sort((left, right) => right.totalTokens - left.totalTokens
    || (left.model < right.model ? -1 : left.model > right.model ? 1 : 0))

  const bucket = trendBucketSql(granularity)
  const trend = many<SparseTokenUsageRow>(database, `
    SELECT
      ${bucket} AS bucket,
      SUM(COALESCE(input_tokens, 0)) AS inputTokens,
      SUM(COALESCE(output_tokens, 0)) AS outputTokens
    FROM chat_runs
    WHERE (input_tokens IS NOT NULL OR output_tokens IS NOT NULL)
      AND started_at >= @startedAt
      AND started_at < @endedAt
    GROUP BY ${bucket}
    ORDER BY MIN(started_at)
  `, parameters).map((row): TokenUsageTrendRecord => {
    const inputTokens = safeTokenCount(row.inputTokens)
    const outputTokens = safeTokenCount(row.outputTokens)
    return {
      bucket: String(row.bucket),
      inputTokens,
      outputTokens,
      totalTokens: safeTokenCount(inputTokens + outputTokens),
    }
  })

  const inputTokens = safeTokenCount(models.reduce((sum, model) => sum + model.inputTokens, 0))
  const outputTokens = safeTokenCount(models.reduce((sum, model) => sum + model.outputTokens, 0))
  const trendInput = safeTokenCount(trend.reduce((sum, point) => sum + point.inputTokens, 0))
  const trendOutput = safeTokenCount(trend.reduce((sum, point) => sum + point.outputTokens, 0))
  if (inputTokens !== trendInput || outputTokens !== trendOutput) {
    throw new Error('Token usage aggregates are inconsistent')
  }
  return {
    inputTokens,
    outputTokens,
    totalTokens: safeTokenCount(inputTokens + outputTokens),
    models,
    trend,
  }
}
```

- [ ] **Step 6: 在单个只读事务中组装五周期结果**

将旧方法替换为：

```ts
summarizeTokenUsage(input) {
  const query = {
    yesterdayStartedAt: safeTokenCount(input.yesterdayStartedAt),
    todayStartedAt: safeTokenCount(input.todayStartedAt),
    weekStartedAt: safeTokenCount(input.weekStartedAt),
    monthStartedAt: safeTokenCount(input.monthStartedAt),
    endedAt: safeTokenCount(input.endedAt),
  }
  return database.transaction((): TokenUsageSnapshotRecord => {
    const first = one<{ startedAt: number | null }>(database, `
      SELECT MIN(started_at) AS startedAt
      FROM chat_runs
      WHERE (input_tokens IS NOT NULL OR output_tokens IS NOT NULL)
        AND started_at < @endedAt
    `, { endedAt: query.endedAt })
    const allTimeStartedAt = first?.startedAt === null || first?.startedAt === undefined
      ? undefined
      : safeTokenCount(first.startedAt)
    const allTimeStart = allTimeStartedAt ?? query.endedAt
    return {
      ...(allTimeStartedAt === undefined ? {} : { allTimeStartedAt }),
      today: summarizeTokenUsagePeriod(database, query.todayStartedAt, query.endedAt, 'hour'),
      yesterday: summarizeTokenUsagePeriod(database, query.yesterdayStartedAt, query.todayStartedAt, 'hour'),
      week: summarizeTokenUsagePeriod(database, query.weekStartedAt, query.endedAt, 'day'),
      month: summarizeTokenUsagePeriod(database, query.monthStartedAt, query.endedAt, 'day'),
      allTime: summarizeTokenUsagePeriod(database, allTimeStart, query.endedAt, 'month'),
    }
  })()
},
```

- [ ] **Step 7: 运行数据库测试并验证 GREEN**

Run:

```bash
cd apps/desktop
node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts electron/main/database/database.test.ts
```

Expected: PASS，Repository 测试全部通过。

- [ ] **Step 8: 提交 Repository 聚合**

```bash
git add apps/desktop/electron/main/database/repositories.ts apps/desktop/electron/main/database/database.test.ts
git commit -m "feat: aggregate token usage across periods"
```

---

### Task 3: 计算本地边界并补齐连续趋势桶

**Files:**
- Create: `apps/desktop/electron/main/token-usage.ts`
- Test: `apps/desktop/electron/main/token-usage.test.ts`

**Interfaces:**
- Consumes: `summarize(input: TokenUsageQueryRecord): TokenUsageSnapshotRecord`。
- Produces: `createTokenUsageSnapshot(now: Date, summarize): TokenUsageSnapshot`，供 `application.ts` 直接调用。

- [ ] **Step 1: 写本机周期边界失败测试**

```ts
import { describe, expect, it, vi } from 'vitest'
import { createTokenUsageSnapshot } from './token-usage.js'

describe('createTokenUsageSnapshot', () => {
  it('uses one local time snapshot for today, yesterday, Monday week and month', () => {
    const now = new Date(2026, 7, 19, 12, 30)
    const summarize = vi.fn(() => ({
      today: zeroRecord(), yesterday: zeroRecord(), week: zeroRecord(),
      month: zeroRecord(), allTime: zeroRecord(),
    }))

    const snapshot = createTokenUsageSnapshot(now, summarize)

    expect(summarize).toHaveBeenCalledWith({
      yesterdayStartedAt: new Date(2026, 7, 18).getTime(),
      todayStartedAt: new Date(2026, 7, 19).getTime(),
      weekStartedAt: new Date(2026, 7, 17).getTime(),
      monthStartedAt: new Date(2026, 7, 1).getTime(),
      endedAt: now.getTime(),
    })
    expect(snapshot.generatedAt).toBe(now.toISOString())
    expect(snapshot.yesterday.endedAt).toBe(new Date(2026, 7, 19).toISOString())
    expect(snapshot.allTime.startedAt).toBe(now.toISOString())
  })
})
```

在测试文件中定义：

```ts
const zeroRecord = () => ({
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  models: [],
  trend: [],
})
```

- [ ] **Step 2: 写连续桶和累计首月失败测试**

```ts
it('fills missing hour buckets and keeps the all-time first point inside its range', () => {
  const now = new Date(2026, 7, 17, 2, 30)
  const todayStartedAt = new Date(2026, 7, 17).getTime()
  const allTimeStartedAt = new Date(2026, 6, 15, 8).getTime()
  const snapshot = createTokenUsageSnapshot(now, () => ({
    allTimeStartedAt,
    today: {
      inputTokens: 2, outputTokens: 3, totalTokens: 5, models: [
        { model: 'alpha/model', inputTokens: 2, outputTokens: 3, totalTokens: 5 },
      ],
      trend: [{ bucket: '1', inputTokens: 2, outputTokens: 3, totalTokens: 5 }],
    },
    yesterday: zeroRecord(),
    week: zeroRecord(),
    month: zeroRecord(),
    allTime: {
      inputTokens: 2, outputTokens: 3, totalTokens: 5, models: [
        { model: 'alpha/model', inputTokens: 2, outputTokens: 3, totalTokens: 5 },
      ],
      trend: [{ bucket: '2026-07', inputTokens: 2, outputTokens: 3, totalTokens: 5 }],
    },
  }))

  expect(snapshot.today.trend).toEqual([
    { startedAt: new Date(todayStartedAt).toISOString(), inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    { startedAt: new Date(todayStartedAt + 3_600_000).toISOString(), inputTokens: 2, outputTokens: 3, totalTokens: 5 },
    { startedAt: new Date(todayStartedAt + 7_200_000).toISOString(), inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  ])
  expect(snapshot.allTime.trend[0]?.startedAt).toBe(new Date(allTimeStartedAt).toISOString())
  expect(Date.parse(snapshot.allTime.trend[0]!.startedAt))
    .toBeGreaterThanOrEqual(Date.parse(snapshot.allTime.startedAt))
})
```

- [ ] **Step 3: 写 DST 自然日小时数失败测试**

在该用例中临时使用 `America/New_York`，验证春季跳时日为 23 桶；测试结束恢复环境：

```ts
it('uses elapsed hourly buckets across a daylight-saving transition', () => {
  const previous = process.env.TZ
  process.env.TZ = 'America/New_York'
  try {
    const todayStartedAt = new Date(2026, 2, 8).getTime()
    const endedAt = new Date(2026, 2, 9).getTime()
    const snapshot = createTokenUsageSnapshot(new Date(endedAt), () => ({
      today: zeroRecord(),
      yesterday: zeroRecord(),
      week: zeroRecord(),
      month: zeroRecord(),
      allTime: zeroRecord(),
    }))
    expect(snapshot.yesterday.trend).toHaveLength(23)
  } finally {
    if (previous === undefined) delete process.env.TZ
    else process.env.TZ = previous
  }
})
```

- [ ] **Step 4: 运行 helper 测试并验证 RED**

Run:

```bash
cd apps/desktop
node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts electron/main/token-usage.test.ts
```

Expected: FAIL，`token-usage.ts` 尚不存在。

- [ ] **Step 5: 实现本机边界、bucket key 和稠密趋势**

创建 `token-usage.ts`：

```ts
import type { TokenUsagePeriod, TokenUsageSnapshot, TokenUsageTrendPoint } from '@autoforge/shared'
import type {
  TokenUsageGranularityRecord,
  TokenUsagePeriodRecord,
  TokenUsageQueryRecord,
  TokenUsageSnapshotRecord,
} from './database/repositories.js'

type Summarize = (input: TokenUsageQueryRecord) => TokenUsageSnapshotRecord

const hourMs = 3_600_000
const pad = (value: number) => String(value).padStart(2, '0')

function dayStart(value: Date): Date {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate())
}

function localKey(value: Date, granularity: Exclude<TokenUsageGranularityRecord, 'hour'>): string {
  const year = value.getFullYear()
  const month = pad(value.getMonth() + 1)
  return granularity === 'month' ? `${year}-${month}` : `${year}-${month}-${pad(value.getDate())}`
}

function denseTrend(
  record: TokenUsagePeriodRecord,
  startedAt: number,
  endedAt: number,
  granularity: TokenUsageGranularityRecord,
): TokenUsageTrendPoint[] {
  const sparse = new Map(record.trend.map((point) => [point.bucket, point]))
  const output: TokenUsageTrendPoint[] = []
  if (granularity === 'hour') {
    for (let index = 0, cursor = startedAt; cursor < endedAt; index += 1, cursor += hourMs) {
      const point = sparse.get(String(index))
      output.push({
        startedAt: new Date(cursor).toISOString(),
        inputTokens: point?.inputTokens ?? 0,
        outputTokens: point?.outputTokens ?? 0,
        totalTokens: point?.totalTokens ?? 0,
      })
    }
    return output
  }

  let cursor = granularity === 'month'
    ? new Date(new Date(startedAt).getFullYear(), new Date(startedAt).getMonth(), 1)
    : dayStart(new Date(startedAt))
  while (cursor.getTime() < endedAt) {
    const point = sparse.get(localKey(cursor, granularity))
    output.push({
      startedAt: new Date(Math.max(cursor.getTime(), startedAt)).toISOString(),
      inputTokens: point?.inputTokens ?? 0,
      outputTokens: point?.outputTokens ?? 0,
      totalTokens: point?.totalTokens ?? 0,
    })
    cursor = granularity === 'month'
      ? new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1)
      : new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + 1)
  }
  return output
}

function period(
  record: TokenUsagePeriodRecord,
  startedAt: number,
  endedAt: number,
  granularity: TokenUsageGranularityRecord,
): TokenUsagePeriod {
  return {
    startedAt: new Date(startedAt).toISOString(),
    endedAt: new Date(endedAt).toISOString(),
    inputTokens: record.inputTokens,
    outputTokens: record.outputTokens,
    totalTokens: record.totalTokens,
    models: record.models,
    trend: denseTrend(record, startedAt, endedAt, granularity),
  }
}

export function createTokenUsageSnapshot(now: Date, summarize: Summarize): TokenUsageSnapshot {
  const endedAt = now.getTime()
  const today = dayStart(now)
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1)
  const mondayOffset = (today.getDay() + 6) % 7
  const week = new Date(today.getFullYear(), today.getMonth(), today.getDate() - mondayOffset)
  const month = new Date(today.getFullYear(), today.getMonth(), 1)
  const query: TokenUsageQueryRecord = {
    yesterdayStartedAt: yesterday.getTime(),
    todayStartedAt: today.getTime(),
    weekStartedAt: week.getTime(),
    monthStartedAt: month.getTime(),
    endedAt,
  }
  const usage = summarize(query)
  const allTimeStartedAt = usage.allTimeStartedAt ?? endedAt
  return {
    generatedAt: now.toISOString(),
    today: period(usage.today, query.todayStartedAt, endedAt, 'hour'),
    yesterday: period(usage.yesterday, query.yesterdayStartedAt, query.todayStartedAt, 'hour'),
    week: period(usage.week, query.weekStartedAt, endedAt, 'day'),
    month: period(usage.month, query.monthStartedAt, endedAt, 'day'),
    allTime: period(usage.allTime, allTimeStartedAt, endedAt, 'month'),
  }
}
```

- [ ] **Step 6: 修正零数据周期趋势测试 fixture**

`denseTrend` 会为固定周期补零，因此 Step 1/3 的断言必须明确验证固定周期趋势长度，而不是期待空数组：

```ts
expect(snapshot.today.trend.length).toBeGreaterThan(0)
expect(snapshot.today.trend.every(({ totalTokens }) => totalTokens === 0)).toBe(true)
expect(snapshot.allTime.trend).toEqual([])
```

- [ ] **Step 7: 运行 helper 测试并验证 GREEN**

Run:

```bash
cd apps/desktop
node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts electron/main/token-usage.test.ts
```

Expected: PASS，包括周一边界、稠密桶、累计首月和 DST 用例。

- [ ] **Step 8: 提交周期装配 helper**

```bash
git add apps/desktop/electron/main/token-usage.ts apps/desktop/electron/main/token-usage.test.ts
git commit -m "feat: build local token usage periods"
```

---

### Task 4: 贯通应用服务、IPC 校验与测试 fixtures

**Files:**
- Modify: `apps/desktop/electron/main/application.ts`
- Test: `apps/desktop/electron/main/application.test.ts`
- Test: `apps/desktop/electron/main/ipc/register-ipc.test.ts`
- Test: `apps/desktop/tests/components/workbench.test.ts`（仅先更新默认 API fixture，UI 断言在 Task 6 完成）

**Interfaces:**
- Consumes: `createTokenUsageSnapshot(now, database.chatRuns.summarizeTokenUsage)`。
- Produces: 现有 `services.settings.getTokenUsage()` 返回新版 `TokenUsageSnapshot`；现有 IPC/Preload channel 不变。

- [ ] **Step 1: 把 application 集成测试改为五周期快照**

把该测试原有 `usage_run.startedAt` 改为当天 10:00，确保同时进入今日/本周/本月/累计，然后设置系统时间并断言：

```ts
database.conversations.insert({ id: 'usage_conversation', title: 'Usage' })
database.chatRuns.insert({
  id: 'usage_run',
  conversationId: 'usage_conversation',
  requestId: 'usage_request',
  model: 'alpha/model',
  status: 'failed',
  startedAt: new Date(2026, 7, 17, 10).getTime(),
  inputTokens: 4,
  outputTokens: 6,
})
database.close()

vi.useFakeTimers()
vi.setSystemTime(new Date(2026, 7, 17, 12))
const runtime = createApplicationRuntime(options(root))
const usage = await runtime.services.settings.getTokenUsage()

expect(usage.generatedAt).toBe(new Date(2026, 7, 17, 12).toISOString())
expect(usage.today).toMatchObject({
  startedAt: new Date(2026, 7, 17).toISOString(),
  inputTokens: 4,
  outputTokens: 6,
  totalTokens: 10,
  models: [{ model: 'alpha/model', inputTokens: 4, outputTokens: 6, totalTokens: 10 }],
})
expect(usage.today.trend.reduce((sum, point) => sum + point.totalTokens, 0)).toBe(10)
expect(usage.yesterday.totalTokens).toBe(0)
expect(usage.week.totalTokens).toBe(10)
expect(usage.month.totalTokens).toBe(10)
expect(usage.allTime.totalTokens).toBe(10)
```

- [ ] **Step 2: 运行 application 测试并验证 RED**

Run:

```bash
cd apps/desktop
node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts electron/main/application.test.ts -t "token usage snapshot"
```

Expected: FAIL，应用服务仍返回旧 `monthStartedAt/month/allTime` 结构。

- [ ] **Step 3: 在应用服务使用周期装配 helper**

在 `application.ts` 导入：

```ts
import { createTokenUsageSnapshot } from './token-usage.js'
```

把设置服务方法替换为：

```ts
getTokenUsage: async () => createTokenUsageSnapshot(
  new Date(),
  (query) => database.chatRuns.summarizeTokenUsage(query),
),
```

- [ ] **Step 4: 更新 IPC harness 的有效与非法响应**

在 `register-ipc.test.ts` 增加局部 fixture helper：

```ts
const emptyUsagePeriod = (startedAt: string, endedAt: string) => ({
  startedAt,
  endedAt,
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  models: [],
  trend: [],
})

const emptyUsageSnapshot = () => {
  const generatedAt = '2026-08-17T04:00:00.000Z'
  const todayStartedAt = '2026-08-16T16:00:00.000Z'
  return {
    generatedAt,
    today: emptyUsagePeriod(todayStartedAt, generatedAt),
    yesterday: emptyUsagePeriod('2026-08-15T16:00:00.000Z', todayStartedAt),
    week: emptyUsagePeriod(todayStartedAt, generatedAt),
    month: emptyUsagePeriod('2026-07-31T16:00:00.000Z', generatedAt),
    allTime: emptyUsagePeriod(generatedAt, generatedAt),
  }
}
```

默认 mock 返回 `emptyUsageSnapshot()`；非法输出用例改为：

```ts
vi.mocked(app.dependencies.settings.getTokenUsage).mockResolvedValueOnce({
  ...emptyUsageSnapshot(),
  today: { ...emptyUsageSnapshot().today, totalTokens: 1 },
} as never)

await expect(app.invoke(ipcChannels.settingsGetTokenUsage))
  .rejects.toMatchObject({ code: 'INTERNAL_ERROR' })
```

- [ ] **Step 5: 更新 Renderer 默认 DesktopAPI fixture**

在 `workbench.test.ts` 用同样的五周期结构替换 `createApi()` 中旧默认账单返回。为后续 UI 测试保留可复用 helper：

```ts
function usagePeriod(
  startedAt: string,
  endedAt: string,
  totalTokens: number,
  model = 'alpha/model',
) {
  return {
    startedAt,
    endedAt,
    inputTokens: totalTokens,
    outputTokens: 0,
    totalTokens,
    models: totalTokens === 0
      ? []
      : [{ model, inputTokens: totalTokens, outputTokens: 0, totalTokens }],
    trend: totalTokens === 0
      ? []
      : [{ startedAt, inputTokens: totalTokens, outputTokens: 0, totalTokens }],
  }
}

function usageSnapshot(totalTokens: number, model = 'alpha/model'): TokenUsageSnapshot {
  const generatedAt = '2026-08-17T04:00:00.000Z'
  const todayStartedAt = '2026-08-16T16:00:00.000Z'
  return {
    generatedAt,
    today: usagePeriod(todayStartedAt, generatedAt, totalTokens, model),
    yesterday: usagePeriod('2026-08-15T16:00:00.000Z', todayStartedAt, totalTokens, model),
    week: usagePeriod(todayStartedAt, generatedAt, totalTokens, model),
    month: usagePeriod('2026-07-31T16:00:00.000Z', generatedAt, totalTokens, model),
    allTime: usagePeriod('2026-07-01T00:00:00.000Z', generatedAt, totalTokens, model),
  }
}
```

- [ ] **Step 6: 运行 Main 与 IPC 测试并验证 GREEN**

Run:

```bash
cd apps/desktop
node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts \
  electron/main/token-usage.test.ts \
  electron/main/application.test.ts \
  electron/main/ipc/register-ipc.test.ts \
  electron/preload/bridge.test.ts
```

Expected: PASS；Preload 测试继续证明固定 channel 未变化。

- [ ] **Step 7: 提交端到端契约贯通**

```bash
git add \
  apps/desktop/electron/main/application.ts \
  apps/desktop/electron/main/application.test.ts \
  apps/desktop/electron/main/ipc/register-ipc.test.ts \
  apps/desktop/tests/components/workbench.test.ts
git commit -m "feat: expose token usage period snapshot"
```

---

### Task 5: 加入 ECharts 并实现两个独立图表组件

**Files:**
- Modify: `apps/desktop/package.json`
- Modify: `pnpm-lock.yaml`
- Create: `apps/desktop/src/components/settings/token-usage-chart.ts`
- Create: `apps/desktop/src/components/settings/token-usage-chart-options.ts`
- Create: `apps/desktop/src/components/settings/TokenUsageLineChart.vue`
- Create: `apps/desktop/src/components/settings/TokenUsageBarChart.vue`
- Test: `apps/desktop/tests/components/token-usage-charts.test.ts`

**Interfaces:**
- Consumes: `TokenUsagePeriod`、`TokenUsagePeriodKey`、`ModelTokenUsage[]`。
- Produces: `<TokenUsageLineChart :period :period-key>` 与 `<TokenUsageBarChart :models>`；两个组件不读取 Store 或调用 IPC。

- [ ] **Step 1: 精确安装 ECharts 6.1.0**

Run:

```bash
pnpm --filter @autoforge/desktop add echarts@6.1.0 --save-exact
```

Expected: `apps/desktop/package.json` 新增 `"echarts": "6.1.0"`，`pnpm-lock.yaml` 只增加对应解析。

- [ ] **Step 2: 写 option 失败测试**

创建 `token-usage-charts.test.ts`，先测试纯函数：

```ts
import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import TokenUsageLineChart from '../../src/components/settings/TokenUsageLineChart.vue'
import { barChartOption, lineChartOption } from '../../src/components/settings/token-usage-chart-options'

const period = {
  startedAt: '2026-08-16T16:00:00.000Z',
  endedAt: '2026-08-17T04:00:00.000Z',
  inputTokens: 7,
  outputTokens: 3,
  totalTokens: 10,
  models: [{ model: 'alpha/model', inputTokens: 7, outputTokens: 3, totalTokens: 10 }],
  trend: [
    { startedAt: '2026-08-16T16:00:00.000Z', inputTokens: 2, outputTokens: 1, totalTokens: 3 },
    { startedAt: '2026-08-16T17:00:00.000Z', inputTokens: 5, outputTokens: 2, totalTokens: 7 },
  ],
}

it('builds three token trend series', () => {
  const option = lineChartOption(period, 'today')
  expect(option.series).toMatchObject([
    { name: '输入 Token', type: 'line', data: [2, 5] },
    { name: '输出 Token', type: 'line', data: [1, 2] },
    { name: '总 Token', type: 'line', data: [3, 7] },
  ])
  const formatter = (option.tooltip as { formatter: (value: unknown) => string }).formatter
  expect(formatter([{ dataIndex: 0, seriesName: '输入 Token', value: 2 }]))
    .toContain('输入 Token: 2')
  const longTrend = Array.from({ length: 13 }, (_, index) => ({
    startedAt: new Date(2025, index, 1).toISOString(),
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  }))
  expect(lineChartOption({ ...period, trend: longTrend }, 'allTime').dataZoom).toHaveLength(2)
})

it('builds stacked model bars and enables zoom after eight models', () => {
  const models = Array.from({ length: 9 }, (_, index) => ({
    model: `model/${index}`,
    inputTokens: index + 1,
    outputTokens: index,
    totalTokens: index * 2 + 1,
  }))
  const option = barChartOption(models)
  expect(option.series).toMatchObject([
    { name: '输入 Token', type: 'bar', stack: 'tokens' },
    { name: '输出 Token', type: 'bar', stack: 'tokens' },
  ])
  expect(option.dataZoom).toHaveLength(2)
  const formatter = (option.tooltip as { formatter: (value: unknown) => string }).formatter
  expect(formatter([{ dataIndex: 0 }])).toContain('model/0')
})
```

- [ ] **Step 3: 运行图表测试并验证 RED**

Run:

```bash
cd apps/desktop
node scripts/run-vitest-electron.mjs run --config vitest.config.ts tests/components/token-usage-charts.test.ts
```

Expected: FAIL，option 文件尚不存在。

- [ ] **Step 4: 实现纯图表配置函数**

创建 `token-usage-chart-options.ts`。使用 `renderMode: 'richText'` 避免把模型 ID 插入 HTML Tooltip：

```ts
import type { TokenUsagePeriod, TokenUsagePeriodKey, ModelTokenUsage } from '@autoforge/shared'
import type { EChartsCoreOption } from 'echarts/core'

export const tokenColors = {
  input: '#3478f6',
  output: '#f79045',
  total: '#344054',
} as const

const tokenFormatter = new Intl.NumberFormat('zh-CN')
const hourFormatter = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' })
const dayFormatter = new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric' })
const monthFormatter = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'short' })
const dateTimeFormatter = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
})

interface TooltipItem {
  dataIndex: number
  seriesName: string
  value: unknown
}

export function lineChartOption(
  period: TokenUsagePeriod,
  periodKey: TokenUsagePeriodKey,
): EChartsCoreOption {
  const zoom = period.trend.length > 12
  const labels = period.trend.map(({ startedAt }) => {
    const value = new Date(startedAt)
    if (periodKey === 'today' || periodKey === 'yesterday') return hourFormatter.format(value)
    if (periodKey === 'allTime') return monthFormatter.format(value)
    return dayFormatter.format(value)
  })
  const rangeLabels = period.trend.map((point, index) => {
    const next = period.trend[index + 1]?.startedAt ?? period.endedAt
    return `${dateTimeFormatter.format(new Date(point.startedAt))} — ${dateTimeFormatter.format(new Date(next))}`
  })
  return {
    color: [tokenColors.input, tokenColors.output, tokenColors.total],
    animationDuration: 220,
    tooltip: {
      trigger: 'axis',
      renderMode: 'richText',
      formatter: (parameters: unknown) => {
        const items = (Array.isArray(parameters) ? parameters : [parameters]) as TooltipItem[]
        const index = items[0]?.dataIndex ?? 0
        return [
          rangeLabels[index] ?? '',
          ...items.map((item) => `${item.seriesName}: ${tokenFormatter.format(Number(item.value))}`),
        ].join('\n')
      },
    },
    legend: { data: ['输入 Token', '输出 Token', '总 Token'] },
    grid: { left: 16, right: 18, top: 48, bottom: zoom ? 76 : 32, containLabel: true },
    xAxis: { type: 'category', boundaryGap: false, data: labels },
    yAxis: { type: 'value', minInterval: 1 },
    dataZoom: zoom
      ? [{ type: 'slider', startValue: 0, endValue: 11 }, { type: 'inside', startValue: 0, endValue: 11 }]
      : [],
    series: [
      { name: '输入 Token', type: 'line', showSymbol: false, data: period.trend.map((point) => point.inputTokens) },
      { name: '输出 Token', type: 'line', showSymbol: false, data: period.trend.map((point) => point.outputTokens) },
      { name: '总 Token', type: 'line', showSymbol: false, data: period.trend.map((point) => point.totalTokens) },
    ],
  }
}

export function barChartOption(models: ModelTokenUsage[]): EChartsCoreOption {
  const zoom = models.length > 8
  return {
    color: [tokenColors.input, tokenColors.output],
    animationDuration: 220,
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      renderMode: 'richText',
      formatter: (parameters: unknown) => {
        const items = (Array.isArray(parameters) ? parameters : [parameters]) as TooltipItem[]
        const model = models[items[0]?.dataIndex ?? 0]
        if (!model) return ''
        return [
          model.model,
          `输入 Token: ${tokenFormatter.format(model.inputTokens)}`,
          `输出 Token: ${tokenFormatter.format(model.outputTokens)}`,
          `总 Token: ${tokenFormatter.format(model.totalTokens)}`,
        ].join('\n')
      },
    },
    legend: { data: ['输入 Token', '输出 Token'] },
    grid: { left: 16, right: 18, top: 48, bottom: zoom ? 76 : 48, containLabel: true },
    xAxis: {
      type: 'category',
      data: models.map(({ model }) => model),
      axisLabel: {
        interval: 0,
        formatter: (value: string) => value.length > 18 ? `${value.slice(0, 17)}…` : value,
      },
    },
    yAxis: { type: 'value', minInterval: 1 },
    dataZoom: zoom
      ? [{ type: 'slider', startValue: 0, endValue: 7 }, { type: 'inside', startValue: 0, endValue: 7 }]
      : [],
    series: [
      { name: '输入 Token', type: 'bar', stack: 'tokens', data: models.map((model) => model.inputTokens) },
      { name: '输出 Token', type: 'bar', stack: 'tokens', data: models.map((model) => model.outputTokens) },
    ],
  }
}
```

- [ ] **Step 5: 写 ECharts 生命周期失败测试**

在同一测试文件顶部 hoist mock：

```ts
const chart = vi.hoisted(() => ({
  setOption: vi.fn(), resize: vi.fn(), dispose: vi.fn(),
}))
const init = vi.hoisted(() => vi.fn(() => chart))

vi.mock('echarts/core', () => ({ use: vi.fn(), init }))
vi.mock('echarts/charts', () => ({ LineChart: {}, BarChart: {} }))
vi.mock('echarts/components', () => ({
  GridComponent: {}, LegendComponent: {}, TooltipComponent: {}, DataZoomComponent: {},
}))
vi.mock('echarts/renderers', () => ({ CanvasRenderer: {} }))
```

在用例中挂载组件并断言：

```ts
it('updates, resizes and disposes a line chart instance', async () => {
  let resizeCallback!: () => void
  const disconnect = vi.fn()
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { resizeCallback = callback }
    observe() {}
    disconnect() { disconnect() }
  })
  const wrapper = mount(TokenUsageLineChart, { props: { period, periodKey: 'today' } })
  expect(init).toHaveBeenCalledTimes(1)
  expect(chart.setOption).toHaveBeenCalledTimes(1)
  resizeCallback()
  expect(chart.resize).toHaveBeenCalledTimes(1)
  await wrapper.setProps({ periodKey: 'month' })
  expect(chart.setOption).toHaveBeenCalledTimes(2)
  wrapper.unmount()
  expect(disconnect).toHaveBeenCalledTimes(1)
  expect(chart.dispose).toHaveBeenCalledTimes(1)
  vi.unstubAllGlobals()
})
```

- [ ] **Step 6: 实现模块注册与生命周期 composable**

创建 `token-usage-chart.ts`：

```ts
import { onBeforeUnmount, onMounted, ref, watch, type ComputedRef } from 'vue'
import { init, use, type EChartsCoreOption, type EChartsType } from 'echarts/core'
import { BarChart, LineChart } from 'echarts/charts'
import { DataZoomComponent, GridComponent, LegendComponent, TooltipComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'

use([
  LineChart,
  BarChart,
  GridComponent,
  LegendComponent,
  TooltipComponent,
  DataZoomComponent,
  CanvasRenderer,
])

export function useTokenUsageChart(option: ComputedRef<EChartsCoreOption>) {
  const element = ref<HTMLDivElement>()
  let chart: EChartsType | undefined
  let observer: ResizeObserver | undefined

  onMounted(() => {
    if (!element.value) return
    chart = init(element.value)
    chart.setOption(option.value, { notMerge: true })
    observer = new ResizeObserver(() => chart?.resize())
    observer.observe(element.value)
  })
  watch(option, (value) => chart?.setOption(value, { notMerge: true }))
  onBeforeUnmount(() => {
    observer?.disconnect()
    chart?.dispose()
    observer = undefined
    chart = undefined
  })

  return { element }
}
```

- [ ] **Step 7: 实现折线和柱状图 Vue 组件**

`TokenUsageLineChart.vue`：

```vue
<template><div ref="element" class="token-chart" data-testid="token-usage-line-chart" /></template>

<script setup lang="ts">
import type { TokenUsagePeriod, TokenUsagePeriodKey } from '@autoforge/shared'
import { computed } from 'vue'
import { useTokenUsageChart } from './token-usage-chart'
import { lineChartOption } from './token-usage-chart-options'

const props = defineProps<{ period: TokenUsagePeriod; periodKey: TokenUsagePeriodKey }>()
const option = computed(() => lineChartOption(props.period, props.periodKey))
const { element } = useTokenUsageChart(option)
</script>

<style scoped>.token-chart { width: 100%; height: 280px; }</style>
```

`TokenUsageBarChart.vue`：

```vue
<template><div ref="element" class="token-chart" data-testid="token-usage-bar-chart" /></template>

<script setup lang="ts">
import type { ModelTokenUsage } from '@autoforge/shared'
import { computed } from 'vue'
import { useTokenUsageChart } from './token-usage-chart'
import { barChartOption } from './token-usage-chart-options'

const props = defineProps<{ models: ModelTokenUsage[] }>()
const option = computed(() => barChartOption(props.models))
const { element } = useTokenUsageChart(option)
</script>

<style scoped>.token-chart { width: 100%; height: 300px; }</style>
```

- [ ] **Step 8: 运行图表测试并验证 GREEN**

Run:

```bash
cd apps/desktop
node scripts/run-vitest-electron.mjs run --config vitest.config.ts tests/components/token-usage-charts.test.ts
```

Expected: PASS，option 和 init/update/resize/dispose 测试全部通过。

- [ ] **Step 9: 提交图表基础设施**

```bash
git add \
  apps/desktop/package.json \
  pnpm-lock.yaml \
  apps/desktop/src/components/settings/token-usage-chart.ts \
  apps/desktop/src/components/settings/token-usage-chart-options.ts \
  apps/desktop/src/components/settings/TokenUsageLineChart.vue \
  apps/desktop/src/components/settings/TokenUsageBarChart.vue \
  apps/desktop/tests/components/token-usage-charts.test.ts
git commit -m "feat: add token usage charts"
```

---

### Task 6: 扩展账单面板为五周期分析视图

**Files:**
- Modify: `apps/desktop/src/components/settings/BillingUsagePanel.vue`
- Test: `apps/desktop/tests/components/workbench.test.ts`

**Interfaces:**
- Consumes: 新版 `TokenUsageSnapshot`、`TokenUsagePeriodKey`、两个图表组件。
- Produces: 默认今日的五周期页签、起止时间、数字卡、折线图、柱状图和原模型明细表。

- [ ] **Step 1: 把 UI 测试改为默认今日和五页签**

更新现有账单渲染用例：

```ts
it('defaults to today and switches all token usage periods without refetching', async () => {
  const api = createApi()
  const usage = usageSnapshot(10, 'today/model')
  usage.yesterday = usagePeriod(
    '2026-08-15T16:00:00.000Z',
    '2026-08-16T16:00:00.000Z',
    20,
    'yesterday/model',
  )
  usage.week = usagePeriod(usage.week.startedAt, usage.week.endedAt, 30, 'week/model')
  usage.month = usagePeriod(usage.month.startedAt, usage.month.endedAt, 40, 'month/model')
  usage.allTime = usagePeriod(usage.allTime.startedAt, usage.allTime.endedAt, 50, 'all/model')
  vi.mocked(api.settings.getTokenUsage).mockResolvedValue(usage)

  const { wrapper } = await mountApp('/settings', api)
  await vi.waitFor(() => expect(wrapper.get('[data-testid="billing-summary-total"]').text()).toContain('10'))
  expect(wrapper.get('#tab-today').attributes('aria-selected')).toBe('true')
  expect(wrapper.text()).toContain('today/model')

  for (const [key, expected] of [
    ['yesterday', '20'], ['week', '30'], ['month', '40'], ['allTime', '50'],
  ] as const) {
    await wrapper.get(`#tab-${key}`).trigger('click')
    expect(wrapper.get('[data-testid="billing-summary-total"]').text()).toContain(expected)
  }
  expect(api.settings.getTokenUsage).toHaveBeenCalledTimes(1)
})
```

- [ ] **Step 2: 增加范围、图表、空状态和刷新保持页签测试**

```ts
it('shows the selected range, both charts and keeps the period while refreshing', async () => {
  const api = createApi()
  vi.mocked(api.settings.getTokenUsage).mockResolvedValue(usageSnapshot(10))
  const { wrapper } = await mountApp('/settings', api)
  await wrapper.get('#tab-month').trigger('click')

  expect(wrapper.get('[data-testid="billing-period-range"]').text()).toContain('2026')
  expect(wrapper.find('[data-testid="token-usage-line-chart"]').exists()).toBe(true)
  expect(wrapper.find('[data-testid="token-usage-bar-chart"]').exists()).toBe(true)

  await wrapper.get('[data-testid="billing-refresh"]').trigger('click')
  await vi.waitFor(() => expect(api.settings.getTokenUsage).toHaveBeenCalledTimes(2))
  expect(wrapper.get('#tab-month').attributes('aria-selected')).toBe('true')
})

it('shows zero cards and one empty state instead of charts and table', async () => {
  const api = createApi()
  vi.mocked(api.settings.getTokenUsage).mockResolvedValue(usageSnapshot(0))
  const { wrapper } = await mountApp('/settings', api)
  await vi.waitFor(() => expect(wrapper.text()).toContain('暂无 Token 用量记录'))
  expect(wrapper.get('[data-testid="billing-summary-total"]').text()).toContain('0')
  expect(wrapper.find('[data-testid="token-usage-line-chart"]').exists()).toBe(false)
  expect(wrapper.find('[data-testid="token-usage-bar-chart"]').exists()).toBe(false)
  expect(wrapper.find('.billing-table').exists()).toBe(false)
  await wrapper.get('#tab-allTime').trigger('click')
  expect(wrapper.get('[data-testid="billing-period-range"]').text()).toContain('暂无保留记录')
})
```

在 `mountApp()` 的全局配置中为工作台集成测试 stub 图表，使 ECharts 生命周期只由专用测试覆盖：

```ts
const wrapper = mount(App, {
  global: {
    plugins: [pinia, router, ElementPlus],
    stubs: {
      TokenUsageLineChart: { template: '<div data-testid="token-usage-line-chart" />' },
      TokenUsageBarChart: { template: '<div data-testid="token-usage-bar-chart" />' },
    },
  },
})
```

- [ ] **Step 3: 运行账单 UI 测试并验证 RED**

Run:

```bash
cd apps/desktop
node scripts/run-vitest-electron.mjs run --config vitest.config.ts tests/components/workbench.test.ts -t "token usage|billing"
```

Expected: FAIL，面板仍只有本月/累计页签且没有图表。

- [ ] **Step 4: 实现五周期选择和范围格式化**

在 `BillingUsagePanel.vue` 导入两个图表组件并替换旧 `activePeriod`：

```ts
import type { TokenUsagePeriod, TokenUsagePeriodKey, TokenUsageSnapshot } from '@autoforge/shared'
import TokenUsageBarChart from './TokenUsageBarChart.vue'
import TokenUsageLineChart from './TokenUsageLineChart.vue'

const periodOptions: Array<{ key: TokenUsagePeriodKey; label: string }> = [
  { key: 'today', label: '今日' },
  { key: 'yesterday', label: '昨日' },
  { key: 'week', label: '本周' },
  { key: 'month', label: '本月' },
  { key: 'allTime', label: '累计' },
]
const activePeriod = ref<TokenUsagePeriodKey>('today')
const emptyPeriod: TokenUsagePeriod = {
  startedAt: new Date(0).toISOString(),
  endedAt: new Date(0).toISOString(),
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  models: [],
  trend: [],
}
const activeUsage = computed(() => props.usage?.[activePeriod.value] ?? emptyPeriod)
const hasUsage = computed(() => activeUsage.value.totalTokens > 0)
```

增加范围 formatter：

```ts
const rangeFormatter = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
})
const formatRange = (usage: TokenUsagePeriod, key: TokenUsagePeriodKey) => {
  if (key === 'allTime' && usage.totalTokens === 0 && usage.models.length === 0) {
    return '暂无保留记录'
  }
  const start = rangeFormatter.format(new Date(usage.startedAt))
  const rawEnd = Date.parse(usage.endedAt)
  const end = rangeFormatter.format(new Date(key === 'yesterday' ? rawEnd - 1 : rawEnd))
  return `${start} — ${end}`
}
```

- [ ] **Step 5: 实现上下串联模板**

用循环生成五个 `el-tab-pane`：

```vue
<el-tabs v-model="activePeriod" data-testid="billing-tabs">
  <el-tab-pane
    v-for="option in periodOptions"
    :key="option.key"
    :label="option.label"
    :name="option.key"
  />
</el-tabs>
<p data-testid="billing-period-range" class="billing-period">
  {{ formatRange(activeUsage, activePeriod) }}
</p>
```

保留三张汇总卡，然后在卡片下插入：

```vue
<template v-if="hasUsage">
  <section class="billing-chart-section" aria-labelledby="token-trend-title">
    <h3 id="token-trend-title">Token 趋势</h3>
    <TokenUsageLineChart :period="activeUsage" :period-key="activePeriod" />
  </section>
  <section class="billing-chart-section" aria-labelledby="token-model-title">
    <h3 id="token-model-title">模型用量</h3>
    <TokenUsageBarChart :models="activeUsage.models" />
  </section>
  <div class="billing-table-wrap">
    <table class="billing-table">
      <thead>
        <tr>
          <th scope="col">模型</th>
          <th scope="col">输入 Token</th>
          <th scope="col">输出 Token</th>
          <th scope="col">总 Token</th>
        </tr>
      </thead>
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
<p v-else class="billing-empty">暂无 Token 用量记录</p>
```

- [ ] **Step 6: 增加图表区与小屏样式**

```css
.billing-chart-section {
  margin: 0 0 16px;
  padding: 14px;
  border: 1px solid var(--af-border);
  border-radius: 10px;
  background: var(--af-surface-muted);
}

.billing-chart-section h3 {
  margin: 0 0 8px;
  color: var(--af-graphite);
  font-size: 14px;
}

@media (max-width: 640px) {
  .billing-summary { grid-template-columns: 1fr; }
  .billing-chart-section { padding: 10px; }
}
```

- [ ] **Step 7: 运行 Renderer 测试并验证 GREEN**

Run:

```bash
cd apps/desktop
node scripts/run-vitest-electron.mjs run --config vitest.config.ts \
  tests/components/token-usage-charts.test.ts \
  tests/components/workbench.test.ts
```

Expected: PASS，五周期、默认今日、图表、范围、空状态、错误隔离和刷新竞态全部通过。

- [ ] **Step 8: 提交账单分析界面**

```bash
git add \
  apps/desktop/src/components/settings/BillingUsagePanel.vue \
  apps/desktop/tests/components/workbench.test.ts
git commit -m "feat: show token usage periods and charts"
```

---

### Task 7: 全量验证与 Electron 视觉复验

**Files:**
- Verify only; if a check exposes a task内缺陷，回到对应 task 做最小修复并重新执行该 task 的 RED/GREEN 命令。

**Interfaces:**
- Consumes: Tasks 1–6 的完整实现。
- Produces: 可交付的已验证功能；不新增功能或重构。

- [ ] **Step 1: 检查旧契约残留与临时调试代码**

Run:

```bash
rg -n "monthStartedAt" \
  packages/shared/src \
  apps/desktop/src \
  apps/desktop/tests
rg -n "\[DEBUG-|console\.log" \
  packages/shared/src \
  apps/desktop/electron \
  apps/desktop/src \
  apps/desktop/tests
```

Expected: Renderer/共享响应中 `monthStartedAt` 无命中；Main Repository 内部的 `monthStartedAt` 查询边界是新接口的合法字段，不属于旧响应残留。无本任务新增的 `[DEBUG-...]` 或 `console.log`；若存在预先已有日志，使用 `git blame` 区分，不删除无关代码。

- [ ] **Step 2: 运行差异与静态检查**

Run:

```bash
git diff --check
pnpm lint
pnpm typecheck
```

Expected: 三个命令均 exit 0，无 lint 或类型错误。

- [ ] **Step 3: 运行完整测试**

Run:

```bash
pnpm test
```

Expected: 所有 Vitest suites PASS，0 failed。

- [ ] **Step 4: 运行生产构建**

Run:

```bash
pnpm build
```

Expected: shared packages、Electron main/preload/renderer 和 workflow runner 全部构建成功。

- [ ] **Step 5: 启动带本地 CDP 的 Electron 做原始页面复验**

Run:

```bash
pnpm --filter @autoforge/desktop exec electron-vite --remoteDebuggingPort=9222
```

在另一个终端运行：

```bash
cd apps/desktop
node --input-type=module -e "
import { chromium } from 'playwright-chromium';
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const page = browser.contexts()[0].pages()[0];
await page.evaluate(() => { location.hash = '#/settings' });
await page.waitForURL('**/#/settings');
await page.getByText('Token 账单').waitFor();
await page.waitForFunction(() => !document.body.innerText.includes('正在加载 Token 用量'));
const tabs = await page.locator('[data-testid=billing-tabs] [role=tab]').allTextContents();
if (tabs.join(',') !== '今日,昨日,本周,本月,累计') throw new Error('period tabs mismatch');
if (await page.locator('#tab-today').getAttribute('aria-selected') !== 'true') throw new Error('today is not selected');
if (await page.locator('[data-testid=billing-period-range]').count() !== 1) throw new Error('range missing');
const total = Number((await page.locator('[data-testid=billing-summary-total] dd').innerText()).replaceAll(',', ''));
if (total > 0) {
  if (await page.locator('[data-testid=token-usage-line-chart] canvas').count() !== 1) throw new Error('line chart missing');
  if (await page.locator('[data-testid=token-usage-bar-chart] canvas').count() !== 1) throw new Error('bar chart missing');
}
await page.screenshot({ path: '/tmp/autoforge-token-usage-periods.png', fullPage: true });
await browser.close();
"
```

Expected: 脚本 exit 0；设置页默认今日，五页签顺序正确，范围存在；有数据时两张图各有一个 canvas。人工查看截图，确认上下串联、图例、坐标、模型标签、表格和窄宽度没有遮挡。

- [ ] **Step 6: 关闭调试实例并恢复普通开发启动**

终止 Step 5 的 Electron 进程，再运行：

```bash
pnpm --filter @autoforge/desktop dev
```

Expected: 普通开发实例启动，端口 9222 不再监听。

- [ ] **Step 7: 最终工作区审计**

Run:

```bash
git status --short
git log --oneline -7
```

Expected: 只有计划内实现改动；实现任务的提交边界与 Tasks 1–6 对应。若执行过程中为修复检查失败产生额外提交，在交付说明中列出原因和验证命令。

---

## Expected Commit Sequence

1. `feat: define token usage period trends`
2. `feat: aggregate token usage across periods`
3. `feat: build local token usage periods`
4. `feat: expose token usage period snapshot`
5. `feat: add token usage charts`
6. `feat: show token usage periods and charts`

每个提交都必须在对应聚焦测试为 GREEN 后创建；不得把跨任务修复、格式化或无关清理混入提交。
