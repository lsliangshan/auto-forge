# OpenRouter Per-User Billing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Use `superpowers:test-driven-development` for every behavior change, `superpowers:verification-before-completion` before claiming success, and `superpowers:requesting-code-review` after all focused tests pass.

**Goal:** 在多个本地登录用户共用同一 OpenRouter API Key 时，将每个 App 发起的 OpenRouter 上游操作按发起用户精确记账，并在“用量与消费”页面展示可与 OpenRouter 同一 generation 集合对账的美元消费。

**Architecture:** `chat_runs` 继续保存每次聊天运行的 Token 汇总，并增加 `user_id/provider` 归属；新增独立的 `provider_usage_events` 费用流水，按本地 `operation_key` 和 OpenRouter `generation_id` 双重幂等。编排器在上游费用出现后立即写账，不等待本地媒体或工具链完成；独立回查器仅对同一 API Key 指纹下的 unknown generation 做有限回查。设置应用服务捕获当前会话用户，并在同一个 `now` 下合并 Token 与费用快照。

**Tech Stack:** Electron Main、TypeScript、better-sqlite3、Zod、Vue 3、Pinia、Vitest、pnpm。

**Approved design:** [`docs/superpowers/specs/2026-08-18-openrouter-per-user-billing-design.md`](../specs/2026-08-18-openrouter-per-user-billing-design.md)

**Billing research:** [`docs/superpowers/specs/2026-08-18-openrouter-usage-cost-research.md`](../specs/2026-08-18-openrouter-usage-cost-research.md)

## 执行边界与成功标准

- 只修改 Desktop Main 的数据库、Provider、编排、认证应用服务，以及共享契约和现有设置页；不改会话可见性或管理员能力。
- Renderer 不新增 `userId` 参数。用户归属只能来自 Main 中的 `auth.requireSession()`。
- OpenRouter 美元消费只来自一条费用流水中的 `usage.cost`，或缺失时同一 generation 回查得到的 `total_cost`；两者不相加。
- `cost = 0` 是已确认费用；`undefined/null` 是 unknown。
- 费用使用规范十进制字符串和 `BigInt` 对齐相加，不使用 `Number`、SQLite `SUM(cost_usd)` 或当前模型价格重算。
- 删除会话或清除 conversations 不删除费用流水。
- 旧 `chat_runs` 不回填用户，个人统计只读取新归属数据。
- 自动化测试不发真实付费请求；最终人工验收使用用户下一次正常请求和同一 generation 对账。

## 模块契约

| 模块 | 输入 | 输出/写入 | 不能做的事 |
| --- | --- | --- | --- |
| Application | 当前认证 session、路由 Provider、请求 ID | 将不可伪造的 `userId`、Provider、Key 指纹传给编排器 | 接受 Renderer 指定账单用户 |
| Provider | 模型请求、可选 `endUserId` | generation、Token、实际 `costUsd`、generation 回查结果 | 汇总周期账单 |
| Orchestrator | 已捕获的用户/请求/Provider/Key 指纹 | 每个上游操作 start/bind/report/unknown | 等本地后处理成功才记费 |
| ProviderUsageRepository | 幂等状态转换、查询周期 | `provider_usage_events` | 发网络请求、存 API Key 明文 |
| Reconciler | unknown generation、当前 Key | 固定 endpoint 的 `total_cost` 回填 | 用新 Key 回查旧 generation、无限重试 |
| Token usage service | 同一用户、同一 `now` 下的两类稀疏汇总 | 完整共享快照 | 浮点估算或跨用户汇总 |
| Renderer | 已验证快照 | 当前用户的 Token、费用、unknown 提示 | 查询或切换目标用户 |

---

## Task 1: 建立精确美元十进制基元

**Files:**

- Create: `apps/desktop/electron/main/billing/decimal-usd.ts`
- Create: `apps/desktop/electron/main/billing/decimal-usd.test.ts`

**Produces:**

```ts
export function normalizeUsd(value: string | number): string
export function addUsd(values: Iterable<string>): string
```

输入只接受非负有限普通十进制或科学计数法；输出必须是普通十进制、无多余前导零/尾随零，并至少保留整数位。

### Step 1: 写失败测试

覆盖以下表格，不把非法值静默转成零：

```ts
describe('normalizeUsd', () => {
  it.each([
    ['0', '0'],
    ['0.00000012', '0.00000012'],
    ['001.2300', '1.23'],
    ['1e-7', '0.0000001'],
    ['1.25E+3', '1250'],
    [0, '0'],
  ])('normalizes %p', (input, expected) => {
    expect(normalizeUsd(input)).toBe(expected)
  })

  it.each(['', ' 1', '+1', '-1', 'NaN', 'Infinity', '1.2.3'])('rejects %p', (input) => {
    expect(() => normalizeUsd(input)).toThrow()
  })
})

it('adds without binary floating-point loss', () => {
  expect(addUsd(['0.1', '0.2', '1e-7', '999999999999999999.9']))
    .toBe('1000000000000000000.2000001')
})
```

### Step 2: 运行测试，确认 RED

Run:

```bash
pnpm --filter @autoforge/desktop exec node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts electron/main/billing/decimal-usd.test.ts
```

Expected: FAIL，因为模块尚不存在。

### Step 3: 实现最小解析与相加

实现时先把 number 转成 `String(value)`，用一个严格正则拆分整数、小数、指数；拒绝负号、正号、空白和非有限 number。用“数字串 + 小数位数”表示定点数：

```ts
interface FixedDecimal {
  digits: bigint
  scale: number
}

function parseFixed(value: string | number): FixedDecimal {
  if (typeof value === 'number' && (!Number.isFinite(value) || value < 0)) {
    throw new TypeError('USD cost must be a non-negative finite decimal')
  }
  const source = typeof value === 'number' ? String(value) : value
  const match = /^(\d+)(?:\.(\d+))?(?:[eE](-?\d+))?$/.exec(source)
  if (!match) throw new TypeError('USD cost must be a non-negative finite decimal')
  const fraction = match[2] ?? ''
  const exponent = Number(match[3] ?? '0')
  if (!Number.isSafeInteger(exponent)) throw new TypeError('USD exponent is out of range')
  const scale = fraction.length - exponent
  const rawDigits = BigInt(`${match[1]}${fraction}`)
  return scale < 0
    ? { digits: rawDigits * 10n ** BigInt(-scale), scale: 0 }
    : { digits: rawDigits, scale }
}
```

`addUsd()` 先找最大 scale，再以 `10n ** BigInt(maxScale - scale)` 对齐后相加；格式化时补零、插入小数点，并去掉小数尾零。不要限制小数位，不要转回 `Number`。

### Step 4: 运行测试，确认 GREEN

Run 同 Step 2。

Expected: PASS。

### Step 5: 提交

```bash
git add apps/desktop/electron/main/billing/decimal-usd.ts apps/desktop/electron/main/billing/decimal-usd.test.ts
git commit -m "feat: add exact OpenRouter cost decimals"
```

---

## Task 2: 迁移费用流水并实现 Repository 状态机

**Files:**

- Create: `apps/desktop/resources/migrations/0005_provider_usage.sql`
- Modify: `apps/desktop/electron/main/database/schema.ts`
- Modify: `apps/desktop/electron/main/database/repositories.ts`
- Modify: `apps/desktop/electron/main/database/database.test.ts`

**Consumes:** `normalizeUsd()`、`addUsd()`。

**Produces:**

```ts
export type ProviderUsageStatus = 'pending' | 'reported' | 'unknown'
export type ProviderUsageModality = 'text' | 'image' | 'audio' | 'video'

export interface ProviderUsageStart {
  id: string
  operationKey: string
  userId: string
  provider: ModelProviderId
  apiKeyFingerprint?: string
  requestId: string
  chatRunId?: string
  model: string
  modality: ProviderUsageModality
  startedAt: number
}

export interface ProviderUsageIdentity {
  generationId?: string
  providerJobId?: string
}

export interface ProviderUsageReport extends ProviderUsageIdentity {
  inputTokens?: number
  outputTokens?: number
  costUsd: string | number
  endedAt: number
}

export interface ProviderUsageQueryRecord {
  userId: string
  yesterdayStartedAt: number
  todayStartedAt: number
  weekStartedAt: number
  monthStartedAt: number
  endedAt: number
}
```

`AppRepositories` 增加 `providerUsage`，方法严格匹配设计规格：`start`、`bindIdentity`、`report`、`markUnknown`、`recoverPending`、`listReconcilable`、`recordReconcileFailure`、`summarize`。

### Step 1: 写迁移与约束失败测试

在 `database.test.ts` 增加：

- 新建数据库的 schema version 从 4 变成 5；v4 fixture 升级后 `chat_runs.user_id/provider` 为 null。
- `provider_usage_events` 的 operation key 全局唯一，非空 generation ID 唯一。
- reported 必须有 `cost_usd`；pending/unknown 不得有 cost；零费用允许。
- 非法 modality/status、负 Token 被拒绝。
- Alice/Bob 同一 fingerprint 的事件按 `userId` 汇总时完全隔离。
- 删除 conversation、`clearConversations()` 和当前 `clearAllLocalData()` 后费用事件仍在。
- `start/bindIdentity/report/markUnknown` 重复同值成功，冲突值抛一致性错误且保留原值。
- `recoverPending(now)` 只将 pending 变为 unknown，不改变 reported。

测试数据必须先插入 `local_users`，以验证真实 FK；金额包含 `0`、`1e-7` 和不同小数位。

### Step 2: 运行数据库测试，确认 RED

```bash
pnpm --filter @autoforge/desktop exec node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts electron/main/database/database.test.ts
```

Expected: FAIL，版本仍是 4 且 Repository 不存在。

### Step 3: 添加 v5 SQL

`0005_provider_usage.sql` 使用以下结构；索引和 CHECK 不得后置到应用代码：

```sql
ALTER TABLE chat_runs ADD COLUMN user_id TEXT REFERENCES local_users(id);
ALTER TABLE chat_runs ADD COLUMN provider TEXT CHECK (provider IS NULL OR provider IN ('deepseek', 'openrouter'));

CREATE INDEX idx_chat_runs_user_started_at
  ON chat_runs(user_id, started_at);

CREATE TABLE provider_usage_events (
  id TEXT PRIMARY KEY,
  operation_key TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES local_users(id),
  provider TEXT NOT NULL CHECK (provider IN ('deepseek', 'openrouter')),
  api_key_fingerprint TEXT,
  request_id TEXT NOT NULL,
  chat_run_id TEXT,
  generation_id TEXT,
  provider_job_id TEXT,
  model TEXT NOT NULL,
  modality TEXT NOT NULL CHECK (modality IN ('text', 'image', 'audio', 'video')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'reported', 'unknown')),
  input_tokens INTEGER CHECK (input_tokens IS NULL OR input_tokens >= 0),
  output_tokens INTEGER CHECK (output_tokens IS NULL OR output_tokens >= 0),
  cost_usd TEXT,
  reconcile_attempts INTEGER NOT NULL DEFAULT 0 CHECK (reconcile_attempts >= 0),
  next_reconcile_at INTEGER,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  CHECK (
    (status = 'reported' AND cost_usd IS NOT NULL)
    OR (status IN ('pending', 'unknown') AND cost_usd IS NULL)
  )
);

CREATE UNIQUE INDEX idx_provider_usage_generation_unique
  ON provider_usage_events(generation_id)
  WHERE generation_id IS NOT NULL;
CREATE INDEX idx_provider_usage_user_provider_started
  ON provider_usage_events(user_id, provider, started_at);
CREATE INDEX idx_provider_usage_reconcile
  ON provider_usage_events(status, next_reconcile_at);
```

不要给 `chat_run_id` 建级联 FK；这是保留费用流水的关键约束。

### Step 4: 更新 schema 与 Repository

- `schema.ts` 的最新 schema 必须和迁移后结果一致。
- `start()` 用 `INSERT ... ON CONFLICT(operation_key) DO NOTHING`，随后读取并逐字段比较归属字段；不同则抛错。
- `bindIdentity()` 在事务中只填空值；已有相同值是成功，不同值抛错。
- `report()` 先 `normalizeUsd(report.costUsd)`；首次将状态改为 reported，重复时 generation、Token、cost 必须完全一致。
- `markUnknown()` 只允许 pending/unknown；reported 保持 reported，不清除已知费用。OpenRouter 且已有 generation ID 时，把首次 `next_reconcile_at` 设为 `endedAt + 1_000`，没有 generation 时保持 null。
- `listReconcilable(now)` 只返回 `provider='openrouter' AND status='unknown' AND generation_id IS NOT NULL AND reconcile_attempts < 3 AND next_reconcile_at <= now`。
- `summarize()` 只读取 `user_id=@userId AND provider='openrouter' AND started_at < @endedAt`，在 TypeScript 中用 `addUsd()` 聚合，不使用 SQL `SUM(cost_usd)`。
- 费用模型维度按 `provider + model` 返回；known 统计 reported 行，unknown 统计 unknown/pending 行。

建议 Repository 稀疏汇总形状：

```ts
export interface ProviderCostPeriodRecord {
  openRouterCostUsd: string
  openRouterKnownCostCount: number
  openRouterUnknownCostCount: number
  models: Array<{
    provider: ModelProviderId
    model: string
    openRouterCostUsd: string
    openRouterKnownCostCount: number
    openRouterUnknownCostCount: number
  }>
}
```

### Step 5: 运行测试，确认 GREEN

Run 同 Step 2。

### Step 6: 提交

```bash
git add apps/desktop/resources/migrations/0005_provider_usage.sql apps/desktop/electron/main/database/schema.ts apps/desktop/electron/main/database/repositories.ts apps/desktop/electron/main/database/database.test.ts
git commit -m "feat: add provider usage ledger"
```

---

## Task 3: 为 chat run 增加用户/Provider 归属并隔离 Token 查询

**Files:**

- Modify: `apps/desktop/electron/main/database/repositories.ts`
- Modify: `apps/desktop/electron/main/database/database.test.ts`

**Interface change:**

```ts
export interface ChatRun {
  id: string
  conversationId: string
  requestId: string
  model: string
  status: string
  generationId?: string
  inputTokens?: number
  outputTokens?: number
  costUsd?: string
  errorCode?: string
  startedAt: number
  endedAt?: number
  userId?: string
  provider?: ModelProviderId
}

export interface TokenUsageQueryRecord {
  userId: string
  yesterdayStartedAt: number
  todayStartedAt: number
  weekStartedAt: number
  monthStartedAt: number
  endedAt: number
}

export interface ModelTokenUsageRecord {
  provider: ModelProviderId
  model: string
  inputTokens: number
  outputTokens: number
  totalTokens: number
}
```

### Step 1: 写失败测试

- 新 chat run 的 `userId/provider` 可读回。
- Alice、Bob、null 历史各有 Token；Alice 查询只得到 Alice，Bob 同理，null 不进入任何个人统计。
- 同一 model 在 DeepSeek/OpenRouter 下产生两个 model rows，不能合并。
- 所有 period 和 trend 继续只包含已完成且 Token 合法的运行。

### Step 2: 运行数据库测试，确认 RED

Run Task 2 的数据库命令。

### Step 3: 最小实现

- 修改 `chatRunColumns`、row mapper、insert/update 返回类型。
- 所有 Token SQL 增加 `user_id = @userId`。
- 模型 SQL `GROUP BY provider, model`，并拒绝新归属行的 provider 为空；旧 null 行因 user filter 自动排除。
- 不修改 conversation 删除逻辑；费用保留已经由 Task 2 验证。

### Step 4: 运行测试，确认 GREEN

Run 同 Step 2。

### Step 5: 提交

```bash
git add apps/desktop/electron/main/database/repositories.ts apps/desktop/electron/main/database/database.test.ts
git commit -m "feat: scope token usage by local user"
```

---

## Task 4: 扩展 OpenRouter Provider 的用户标识和 generation 回查

**Files:**

- Modify: `apps/desktop/electron/main/chat/model-provider.ts`
- Modify: `apps/desktop/electron/main/chat/openrouter-provider.ts`
- Modify: `apps/desktop/electron/main/chat/openrouter-provider.test.ts`
- Modify: `apps/desktop/electron/main/chat/deepseek-provider.test.ts`

**Contract:**

```ts
export interface ModelStreamRequest {
  model: string
  messages: ModelMessage[]
  tools?: ModelTool[]
  output?: { type: 'text' } | { type: 'audio'; voice?: string; format: string }
  maxOutputTokens?: number
  signal?: AbortSignal
  endUserId?: string
}

export interface ModelGenerationUsage {
  generationId: string
  costUsd?: string
}

export interface GenerationUsageProviderPort {
  getGenerationUsage(generationId: string, signal?: AbortSignal): Promise<ModelGenerationUsage>
}
```

将 `GenerationUsageProviderPort['getGenerationUsage']` 作为可选成员加到现有 `ModelProvider`；OpenRouter 实现它，DeepSeek 保持 undefined。

`getGenerationUsage()` 只由 OpenRouter 实现，URL 固定为构造器配置的 OpenRouter generation endpoint；调用方不能传任意 URL。

### Step 1: 写失败测试

- Chat body 在 `endUserId='user-1'` 时准确包含 `user: 'autoforge:user-1'`。
- 无 endUserId 时不出现 `user`。
- DeepSeek 请求即使内部传了 endUserId 也不出现 `user`。
- OpenRouter Image/Video body 不出现 `user`。
- generation 查询发送 `GET /api/v1/generation?id=${encodeURIComponent(generationId)}` 和 Bearer 凭证。
- `{ data: { id, total_cost: 0 } }` 返回 `costUsd: '0'`；普通/科学计数法经 `normalizeUsd()` 处理；null 保持 undefined。
- generation ID 不匹配、非法 cost、非 2xx、错误 JSON 使用现有 AppError 规范失败。

### Step 2: 运行 Provider 测试，确认 RED

```bash
pnpm --filter @autoforge/desktop exec node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts electron/main/chat/openrouter-provider.test.ts electron/main/chat/deepseek-provider.test.ts
```

### Step 3: 实现请求序列化与固定查询

在 OpenAI-compatible chat body 组装处只为 OpenRouter 配置启用用户序列化，避免 DeepSeek 继承：

```ts
const endUser = request.endUserId === undefined
  ? undefined
  : `autoforge:${request.endUserId}`
```

推荐在 provider config 增加 `serializeEndUser?: (id: string) => string`；OpenRouter 提供上面的函数，DeepSeek 不配置。不要把 Renderer 输入直接写入 body。

generation 响应使用本地 Zod schema 只接受：

```ts
const generationUsageSchema = z.object({
  data: z.object({
    id: z.string().min(1),
    total_cost: z.union([z.string(), z.number()]).nullish(),
  }),
})
```

读取后验证 `data.id === generationId`，并对非空 cost 调 `normalizeUsd()`。

### Step 4: 运行测试，确认 GREEN

Run 同 Step 2。

### Step 5: 提交

```bash
git add apps/desktop/electron/main/chat/model-provider.ts apps/desktop/electron/main/chat/openrouter-provider.ts apps/desktop/electron/main/chat/openrouter-provider.test.ts apps/desktop/electron/main/chat/deepseek-provider.test.ts
git commit -m "feat: track OpenRouter users and generation costs"
```

---

## Task 5: 实现 Key 指纹和有限回查器

**Files:**

- Create: `apps/desktop/electron/main/billing/provider-usage-reconciler.ts`
- Create: `apps/desktop/electron/main/billing/provider-usage-reconciler.test.ts`

**Produces:**

```ts
export function fingerprintApiKey(apiKey: string): string

export class ProviderUsageReconciler {
  recoverInterrupted(now?: number): Promise<void>
  reconcileDue(now?: number): Promise<void>
}
```

构造依赖只包含 Repository 的相关方法、OpenRouter provider、credential getter、`now()` 和可注入的 sleep/scheduler。指纹为 UTF-8 API Key 的 SHA-256 小写十六进制；不得记录或返回明文。

### Step 1: 写失败测试

- 固定输入得到稳定 64 位 SHA-256 hex，且不包含原 Key。
- `recoverInterrupted()` 先将 pending 转 unknown，再处理可回查项。
- reported 不查询 generation。
- unknown + generation + 相同 fingerprint：查询并用 `total_cost` report。
- cost `0` 也 report，不当成缺失。
- 指纹不同、无凭证、无 generation 时不发请求且保持 unknown。
- 首次查询在 unknown 后 1s；404/网络/暂时性失败后分别将下一次查询排到 5s、30s，总查询次数达到 3 后不再排程。
- 重复调用不会对已 reported generation 二次计费。

测试注入 fake clock，不进行真实 sleep，不访问网络。

### Step 2: 运行测试，确认 RED

```bash
pnpm --filter @autoforge/desktop exec node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts electron/main/billing/provider-usage-reconciler.test.ts
```

### Step 3: 实现有限状态流程

固定查询时点：

```ts
const retryDelaysMs = [1_000, 5_000, 30_000] as const
```

其中 `markUnknown()`/启动恢复负责安排首次 `+1_000`；第一次查询失败安排 `+5_000`，第二次失败安排 `+30_000`，第三次失败只把 attempts 记为 3，不再设置 `nextReconcileAt`。这样是三个查询时点，不会误发第四次请求。

每次 `reconcileDue(now)`：

1. 读取当前 OpenRouter credential；缺失则返回。
2. 计算一次 fingerprint。
3. 遍历 `listReconcilable(now)`；仅处理指纹相同者。
4. 调 `getGenerationUsage(generationId)`；有 `costUsd` 立即 `report()`。
5. 无 cost 或可重试错误调用 `recordReconcileFailure()`；查询后的 attempts 为 1 时下一次 `now + 5_000`，为 2 时 `now + 30_000`，为 3 时 next 为 null。
6. attempts 达到 3 后不再由 `listReconcilable()` 返回；保持 unknown。
7. 不在设置读取路径调用该类。

### Step 4: 运行测试，确认 GREEN

Run 同 Step 2。

### Step 5: 提交

```bash
git add apps/desktop/electron/main/billing/provider-usage-reconciler.ts apps/desktop/electron/main/billing/provider-usage-reconciler.test.ts
git commit -m "feat: reconcile missing OpenRouter costs"
```

---

## Task 6: 在 Agent、图片、音频、视频调用边界逐笔记账

**Files:**

- Modify: `apps/desktop/electron/main/agent/agent-orchestrator.ts`
- Modify: `apps/desktop/electron/main/agent/agent-orchestrator.test.ts`
- Modify: `apps/desktop/electron/main/chat/media-generation-orchestrator.ts`
- Modify: `apps/desktop/electron/main/chat/media-generation-orchestrator.test.ts`
- Modify: `apps/desktop/electron/main/chat/video-job-runner.ts`
- Modify: `apps/desktop/electron/main/chat/video-job-runner.test.ts`

**Input additions:**

```ts
interface UsageAttribution {
  userId: string
  apiKeyFingerprint?: string
}

export interface AgentRunInput extends UsageAttribution {
  conversationId: string
  content: string
  userBlocks: ChatBlock[]
  modelContent: string | ModelContentPart[]
  assetIds: string[]
  contextLength?: number
  currentMedia: CurrentMediaMetadata[]
  allowTools: boolean
  provider: ModelProviderId
  model: string
  requestId?: string
}

export interface MediaGenerationRunInput extends UsageAttribution {
  requestId: string
  conversationId: string
  prompt: string
  userBlocks: ChatBlock[]
  assetIds: string[]
  route: ResolvedChatRoute
}

export interface SubmitVideoInput extends UsageAttribution {
  requestId: string
  conversationId: string
  prompt: string
  userBlocks: ChatBlock[]
  assetIds: string[]
  route: ResolvedChatRoute & { outputType: 'video' }
}
```

三个编排器构造依赖增加 `providerUsage` 端口，直接使用 Task 2 的 Repository 子集；不为单一调用方再建通用 service。

### Step 1: 写 Agent 失败测试

- 每次 `provider.stream()` 前 start，operation key 为 `agent:<requestId>:turn:<zeroBasedIndex>`。
- 请求携带 `endUserId`。
- generation event 立即 `bindIdentity()`。
- usage cost 立即 `report()`；后续工具执行失败仍保留 report。
- usage 无 cost 时，在该 stream 结束后 `markUnknown()`；有 generation 可供回查。
- 两轮工具调用产生两个 operation key 和两条费用，不能把 active run 的累计 cost 重复写到每轮。
- DeepSeek 仍写 chat run Token，但不创建 OpenRouter 费用事件。

### Step 2: 运行 Agent 测试，确认 RED

```bash
pnpm --filter @autoforge/desktop exec node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts electron/main/agent/agent-orchestrator.test.ts
```

### Step 3: 实现 Agent 单轮生命周期

在进入每个 stream 前创建 `operationKey` 并 start；流事件处理遵循：

```ts
if (event.type === 'generation') {
  providerUsage.bindIdentity(operationKey, { generationId: event.id })
}
if (event.type === 'usage' && event.costUsd !== undefined) {
  providerUsage.report(operationKey, {
    generationId,
    inputTokens: event.inputTokens,
    outputTokens: event.outputTokens,
    costUsd: event.costUsd,
    endedAt: now(),
  })
  costReported = true
}
```

`finally` 中仅在未 report 时 markUnknown。现有 `chat_runs.costUsd` 可继续做运行级兼容记录，但个人费用汇总绝不能读取它。

### Step 4: 写并运行媒体失败测试

在现有 media/video test 中增加：

- Image operation key `image:<requestId>`；Provider 成功返回 usage 后、资产下载/保存前 report。模拟本地保存失败，report 仍发生。
- Chat audio operation key `audio:<requestId>`；传 endUserId，最终 usage cost report；本地音频提交失败不回滚。
- Image/Video Provider 请求不携带 end user 未支持字段。
- Video 提交前 start，提交成功立即 bind provider job ID。
- 首次 completed 后先 bind generation/report，再 download；模拟 download 失败，费用仍 reported。
- 视频 runner 重建恢复后仍使用已持久化 userId/fingerprint，不读取当前登录用户。
- 终态缺 cost + 有 generation 时 unknown；缺 generation 也 unknown 但不可回查。

Run:

```bash
pnpm --filter @autoforge/desktop exec node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts electron/main/chat/media-generation-orchestrator.test.ts electron/main/chat/video-job-runner.test.ts
```

Expected: RED 后按上述顺序实现，再次运行至 GREEN。

### Step 5: 运行三组聚焦测试

```bash
pnpm --filter @autoforge/desktop exec node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts electron/main/agent/agent-orchestrator.test.ts electron/main/chat/media-generation-orchestrator.test.ts electron/main/chat/video-job-runner.test.ts
```

### Step 6: 提交

```bash
git add apps/desktop/electron/main/agent/agent-orchestrator.ts apps/desktop/electron/main/agent/agent-orchestrator.test.ts apps/desktop/electron/main/chat/media-generation-orchestrator.ts apps/desktop/electron/main/chat/media-generation-orchestrator.test.ts apps/desktop/electron/main/chat/video-job-runner.ts apps/desktop/electron/main/chat/video-job-runner.test.ts
git commit -m "feat: record OpenRouter usage at call boundaries"
```

---

## Task 7: 在 Application 捕获认证用户并装配记账/恢复

**Files:**

- Modify: `apps/desktop/electron/main/application.ts`
- Modify: `apps/desktop/electron/main/application.test.ts`
- Modify: `apps/desktop/electron/main/ipc/register-ipc.test.ts`

**Data flow:**

```text
Renderer send/getTokenUsage
  -> Main auth.requireSession()
  -> captured session.user.id
  -> chat run + orchestrator input / user-scoped snapshot
```

### Step 1: 写失败测试

- `send()` 在异步任务开始前捕获 session；随后切换 mock session，账本和 chat run 仍使用原 userId。
- OpenRouter 新 chat run 持久化 `provider='openrouter'`；DeepSeek 同理。
- OpenRouter 调用读取一次当前凭证并只传 fingerprint，不传明文给 Repository。
- 没有 credential 时保持现有 credential error，不创建虚假已知费用。
- 应用启动调用 `recoverInterrupted()`；异步回查失败不阻止 Application 构造或设置页读取。
- `settings.getTokenUsage()` 自己调用 `auth.requireSession()`，接口无用户参数。
- IPC 共享接口仍是零参数；未认证时返回现有未认证错误。

### Step 2: 运行 Application/IPC 测试，确认 RED

```bash
pnpm --filter @autoforge/desktop exec node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts electron/main/application.test.ts electron/main/ipc/register-ipc.test.ts
```

### Step 3: 最小装配

- 创建三个编排器时注入 `database.providerUsage`。
- 在实际 route 已确定、发起运行前调用 `const session = await auth.requireSession()`。
- 对 OpenRouter 从 `secretStore.get(credentialKeyForProvider('openrouter'))` 取得明文后只计算 fingerprint；Repository 中永不接收明文。
- 创建 chat run 时写 `userId: session.user.id` 和实际 `provider`。
- 传给 Agent/Media/Video 的 userId 固定为捕获值。
- 构造 `ProviderUsageReconciler`；启动时以 fire-and-observe 方式恢复，错误写现有 Main 日志，不向 Renderer 泄露 Key。
- 每次请求结束可触发一次 `reconcileDue()`，但不能 await 阻塞结果或无限调度。
- `getTokenUsage()` 捕获一次 `now` 和当前 session，再调用 Task 8 的组合服务。

### Step 4: 运行测试，确认 GREEN

Run 同 Step 2。

### Step 5: 提交

```bash
git add apps/desktop/electron/main/application.ts apps/desktop/electron/main/application.test.ts apps/desktop/electron/main/ipc/register-ipc.test.ts
git commit -m "feat: attribute provider usage to authenticated users"
```

---

## Task 8: 合并用户级 Token/费用快照并收紧共享契约

**Files:**

- Modify: `packages/shared/src/desktop-api.ts`
- Modify: `packages/shared/src/contracts.test.ts`
- Modify: `apps/desktop/electron/main/token-usage.ts`
- Modify: `apps/desktop/electron/main/token-usage.test.ts`
- Modify: `apps/desktop/electron/main/application.ts`
- Modify: `apps/desktop/electron/main/application.test.ts`

**Shared output:**

```ts
interface TokenUsagePeriod {
  startedAt: string
  endedAt: string
  inputTokens: number
  outputTokens: number
  totalTokens: number
  openRouterCostUsd: string
  openRouterKnownCostCount: number
  openRouterUnknownCostCount: number
  models: ModelUsage[]
  trend: TokenUsageTrendPoint[]
}

interface ModelUsage {
  provider: ModelProviderId
  model: string
  inputTokens: number
  outputTokens: number
  totalTokens: number
  openRouterCostUsd: string
  openRouterKnownCostCount: number
  openRouterUnknownCostCount: number
}
```

### Step 1: 写共享契约失败测试

- 接受规范值 `0`、`0.0000001`、`123456789.123`。
- 拒绝 `01`、`1.0`、`1e-7`、负数、number、空字符串。
- 拒绝负 known/unknown count 和非安全整数。
- model 必须含 provider。
- period 的 model known/unknown/cost 合计必须和 period 一致；若现有 Zod 层不做跨字段 superRefine，则在 `token-usage.ts` 组合层抛一致性错误并测试。

规范金额 schema：

```ts
const usdDecimalSchema = z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d*[1-9])?$/)
```

### Step 2: 运行共享测试，确认 RED

```bash
pnpm exec node apps/desktop/scripts/run-vitest-electron.mjs run packages/shared/src/contracts.test.ts
```

### Step 3: 写快照组合失败测试

修改 `createTokenUsageSnapshot` 签名：

```ts
export function createTokenUsageSnapshot(
  now: Date,
  userId: string,
  summarizeTokens: (input: TokenUsageQueryRecord) => TokenUsageSnapshotRecord,
  summarizeCosts: (input: ProviderUsageQueryRecord) => ProviderCostSnapshotRecord,
): TokenUsageSnapshot
```

覆盖：

- 两个 summarize 收到相同 userId、相同 5 个周期边界和同一 endedAt。
- 同 provider+model 合并 Token/费用；只有 Token 或只有费用的模型也保留。
- DeepSeek 模型 cost 为 `0`、count 为 0，UI 后续显示 `—`。
- allTime startedAt 取 Token/费用最早非空时间；两者都为空时等于 endedAt。
- 重复 model key、越界 trend、period totals 不一致继续抛错。

### Step 4: 运行 token usage 测试，确认 RED

```bash
pnpm --filter @autoforge/desktop exec node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts electron/main/token-usage.test.ts
```

### Step 5: 实现精确合并

- 周期边界只在 `createTokenUsageSnapshot()` 计算一次。
- 费用模型 map key 使用 `${provider}\0${model}`，不可只按 model。
- period cost 使用 Repository 已规范化的字符串；组合校验用 `addUsd(models.map(...))`。
- Token trend 不加美元字段，不混合坐标。
- `application.ts` 传当前 session userId：

```ts
const session = await auth.requireSession()
return createTokenUsageSnapshot(
  new Date(),
  session.user.id,
  query => database.chatRuns.summarizeTokenUsage(query),
  query => database.providerUsage.summarize(query),
)
```

### Step 6: 运行共享、服务、Application 测试

```bash
pnpm exec node apps/desktop/scripts/run-vitest-electron.mjs run packages/shared/src/contracts.test.ts
pnpm --filter @autoforge/desktop exec node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts electron/main/token-usage.test.ts electron/main/application.test.ts
```

Expected: 全部 PASS。

### Step 7: 提交

```bash
git add packages/shared/src/desktop-api.ts packages/shared/src/contracts.test.ts apps/desktop/electron/main/token-usage.ts apps/desktop/electron/main/token-usage.test.ts apps/desktop/electron/main/application.ts apps/desktop/electron/main/application.test.ts
git commit -m "feat: expose per-user OpenRouter cost snapshots"
```

---

## Task 9: 在设置页展示“用量与消费”

**Files:**

- Modify: `apps/desktop/src/components/settings/BillingUsagePanel.vue`
- Modify: `apps/desktop/src/stores/settings.ts`（仅在类型或默认值需要时）
- Modify: `apps/desktop/tests/components/workbench.test.ts`
- Modify: `apps/desktop/tests/components/token-usage-charts.test.ts`（只更新受共享 fixture 影响的字段）

**Layer boundary:** 本任务只改展示层和现有 Store fixture；不在 Renderer 估算费用、不调用 OpenRouter、不增加用户选择器。

### Step 1: 写组件失败测试

fixture 为每个 period/model 加新字段，覆盖：

- 标题为“用量与消费”。
- 当前周期显示 `$0.0000001` 和“已确认 1 笔”。
- unknown > 0 时显示“有 2 笔费用待确认”；为 0 时不显示警示。
- 模型表按 Provider + model 两行展示，列含 Provider、OpenRouter 消费、已确认、待确认。
- OpenRouter 行展示精确字符串；DeepSeek 行展示 `—`。
- 费用字段很大时只添加美元符号和整数千分位，不转 `Number`、不产生科学计数法。
- Token 图表输入仍只使用 Token trend，图表 option 不出现 cost series。
- 空数据的费用是 `$0`，不误判为加载失败。

### Step 2: 运行 Web 测试，确认 RED

```bash
pnpm --filter @autoforge/desktop exec node scripts/run-vitest-electron.mjs run --config vitest.config.ts tests/components/workbench.test.ts tests/components/token-usage-charts.test.ts
```

### Step 3: 实现精确展示

新增纯字符串格式化，不调用 `Number(decimal)`：

```ts
function formatUsd(decimal: string): string {
  const [integer, fraction] = decimal.split('.')
  const grouped = integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `$${fraction === undefined ? grouped : `${grouped}.${fraction}`}`
}
```

- 周期卡新增 OpenRouter 消费和 known count。
- unknown count 大于 0 时紧邻已知小计显示警示，避免称已知小计为完整总额。
- model table 以共享返回的 provider+model rows 为准；provider label 复用当前设置页映射或最小本地映射。
- `emptyPeriod()` 补 `openRouterCostUsd: '0'`、两个 count 为 0。
- Store 的“失败保留旧快照”行为不变。

### Step 4: 运行测试，确认 GREEN

Run 同 Step 2。

### Step 5: 提交

```bash
git add apps/desktop/src/components/settings/BillingUsagePanel.vue apps/desktop/src/stores/settings.ts apps/desktop/tests/components/workbench.test.ts apps/desktop/tests/components/token-usage-charts.test.ts
git commit -m "feat: show OpenRouter spend in usage settings"
```

---

## Task 10: 全链路回归、审查与官网人工验收准备

**Files:**

- Modify only if a test exposes a defect in files already listed above.
- Do not create a paid smoke-test script.

### Step 1: 运行聚焦 Node 测试

```bash
pnpm --filter @autoforge/desktop exec node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts electron/main/billing/decimal-usd.test.ts electron/main/billing/provider-usage-reconciler.test.ts electron/main/database/database.test.ts electron/main/chat/openrouter-provider.test.ts electron/main/chat/deepseek-provider.test.ts electron/main/agent/agent-orchestrator.test.ts electron/main/chat/media-generation-orchestrator.test.ts electron/main/chat/video-job-runner.test.ts electron/main/token-usage.test.ts electron/main/application.test.ts electron/main/ipc/register-ipc.test.ts
```

Expected: PASS。

### Step 2: 运行聚焦共享/Web 测试

```bash
pnpm exec node apps/desktop/scripts/run-vitest-electron.mjs run packages/shared/src/contracts.test.ts
pnpm --filter @autoforge/desktop exec node scripts/run-vitest-electron.mjs run --config vitest.config.ts tests/components/workbench.test.ts tests/components/token-usage-charts.test.ts
```

Expected: PASS。

### Step 3: 运行类型、完整测试、Lint、构建

按顺序运行，任一失败先定位是否由本次改动引起，不连续猜改：

```bash
pnpm typecheck
pnpm test
pnpm lint
pnpm build
git diff --check
```

Expected: 全部 exit 0，`git diff --check` 无输出。若存在无关旧失败，在最终报告中给出命令、错误和为何与本功能无关，不能把它称为通过。

### Step 4: 请求代码审查

使用 `superpowers:requesting-code-review`，重点审查：

- 是否有任一路径重复叠加 `usage.cost`/`total_cost`。
- 是否有 Renderer 可注入 userId 的路径。
- 是否在本地失败前已持久化上游费用。
- 是否有费用浮点累计、SQL cost SUM、Key 明文落库或日志泄露。
- 是否删除会话会误删费用事件。
- 是否所有 OpenRouter 上游操作都有稳定 operation key。

修复审查发现后，重跑受影响聚焦测试和 Step 3 全量命令。

### Step 5: 提交最终修复（仅有变更时）

提交前用 `git status --short` 明确列出文件，然后对本计划已经列出的、确由审查修复修改的文件逐个执行 `git add`，再运行 `git commit -m "fix: harden OpenRouter usage accounting"`。不要使用 `git add .`，不要添加无关用户改动。

### Step 6: 准备一次不额外付费的人工对账

不主动发起请求。等待用户下一次正常 OpenRouter 调用后记录：

```text
App local user ID
operation key
generation ID / provider job ID
model + modality
started_at / ended_at
App reported cost_usd
OpenRouter Activity/Generation total_cost
```

验收规则：

1. 用同一 generation/job 对比，App `cost_usd` 必须等于官网 `usage.cost/total_cost`。
2. 同一 App 用户、相同时间边界内逐笔相加，必须等于 UI 已知消费。
3. App 全用户合计只与该 Key 的 App 调用集合比较；若 Key 被其他应用复用，不能拿官网 Key 总额直接判失败。
4. unknown 必须继续显示待确认笔数，不能以 0 补齐。
5. 未执行真实调用时，交付结论只能写“自动化契约验证通过，等待真实 generation 人工对账”。

---

## 完成定义

以下条件全部满足才可声明实现完成：

- v5 migration、Repository 状态机、十进制算法和用户隔离测试通过。
- Agent/Image/Audio/Video 的费用均在上游已知后、任何本地后处理前写入。
- 相同 operation/generation 重放不会重复计费，冲突不会覆盖原账。
- settings IPC 无 userId 输入，只展示当前认证用户。
- UI 明确区分已知消费和 unknown 笔数，DeepSeek 不显示 OpenRouter 金额。
- focused tests、typecheck、完整 tests、lint、build、`git diff --check` 均有实际成功证据，或明确报告无关旧失败。
- 代码审查结论已处理。
- 若尚无用户正常产生的新 generation，明确保留“官网人工对账待完成”，不以 mocks 冒充官网一致性证明。
