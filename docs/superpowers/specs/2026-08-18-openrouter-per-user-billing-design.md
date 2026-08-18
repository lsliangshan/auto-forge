# OpenRouter 分用户费用账本设计

## 目标

在多个本地登录用户共用同一个 OpenRouter API Key 时，按当前登录用户准确展示由本 App 发起的 OpenRouter inference credits 消费，并使同一批 OpenRouter 调用的金额合计能够与 OpenRouter 官网 Activity/Generation 数据对账。

本功能同时修正现有 Token 统计的用户边界：当前用户不能看到或累计其他登录用户的 Token 与费用。

## 成功标准

- 每次 OpenRouter 上游调用返回的 `usage.cost` 只计入一次。
- 同一 API Key 下，不同本地用户的用量和费用完全隔离。
- Agent 工具调用产生的多个 generation 分别记账，并能逐笔审计。
- 图片保存失败、视频下载失败或 Agent 后续步骤失败时，已经产生的上游费用仍然保留。
- `cost = 0` 与费用未知严格区分。
- 删除会话不删除费用流水。
- 新调用的 Token 统计只归属于发起用户；旧 `chat_runs` 保持“历史未归属”，不进入任何用户的个人统计。
- 页面显示当前用户在今日、昨日、本周、本月和累计周期内的 OpenRouter 已知消费及待确认笔数。
- 自动化验证覆盖数据库、Provider、Agent/媒体编排、聚合、IPC 和 UI；真实上游验收不自动产生付费调用。

## 范围

### 包含

- OpenRouter text、当前 Chat 音频输出、专用 Image API 和专用 Video API 的费用记录。
- 当前用户的 Token 与费用聚合。
- OpenRouter Chat 请求的终端用户标识。
- 缺失费用但具有 generation ID 时的有限次数回查。
- 设置页当前“Token 账单”模块的消费展示。

### 不包含

- 管理员查看全部用户或指定其他用户。
- 将历史 `chat_runs` 猜测归属到现有用户。
- OpenRouter 充值手续费。
- BYOK 上游 Provider 的实际账单聚合。
- 使用当前模型目录价格重算历史费用。
- 自动发起真实付费请求作为测试。
- 与费用功能无关的会话所有权或历史会话可见性重构。

## 计费口径

### OpenRouter 消费真值

每个唯一上游操作的费用按以下优先级确定：

1. 响应或最终 SSE usage 中的 `usage.cost`；
2. `usage.cost` 缺失且具有 generation ID 时，`GET /api/v1/generation` 返回的 `total_cost`；
3. 两者均不可得时，费用状态为 unknown。

`usage.cost` 和 generation `total_cost` 是同一调用的两种费用来源，不能相加。`cost_details.upstream_inference_cost` 不计入非 BYOK 用户的 OpenRouter credits 消费。

页面金额定义为同一用户、同一周期内，`provider = openrouter` 且费用状态为 reported 的费用流水十进制合计。unknown 流水以待确认笔数单独展示，不能按零计入。

### 与官网对账的边界

“与官网统一”指相同 API Key、相同调用集合和相同时间边界下的 inference credits 消费一致，不指信用点充值现金支出。

App 全部用户的已知 OpenRouter 费用合计，可以与该 API Key 在官网对应调用集合的 Spend 对账。若同一 Key 还被其他应用使用，官网 Key 总额会包含外部调用，不能直接等同于本 App 合计。

OpenRouter Chat 支持 `user` 参数，本 App 使用 `autoforge:<local-user-id>` 形式的稳定匿名标识。专用 Image/Video API 当前官方请求契约没有列出 `user`，因此不发送未声明字段；这两类调用使用 generation/job ID、API Key 指纹和时间范围对账。

## 架构选择

### 采用独立 Provider 费用流水

新增独立费用流水，而不是只扩展 `chat_runs.cost_usd`。原因如下：

- 一个 Agent `chat_run` 可能包含多个上游 generation；官网按 generation 记录，逐笔流水才能可靠去重和回查。
- 图片或视频已经计费后，本地媒体处理仍可能失败；费用生命周期与聊天运行终态不同。
- 删除会话会级联删除 `chat_runs`，但官网历史消费不会消失。
- 视频费用在异步终态出现，需要跨重启保留发起用户和回查状态。

`chat_runs` 继续负责聊天运行状态和 Token 汇总，同时新增用户与 Provider 归属。费用流水是美元消费的唯一聚合来源；不再从 `chat_runs.cost_usd` 生成个人费用合计。

### 组件职责

- Provider/编排器：只识别一次上游操作的 generation、Token 和实际 cost，并调用费用写入端口；不负责周期汇总或 UI 文案。
- `ProviderUsageRepository`：维护费用事件状态机、唯一约束、用户查询和稀疏聚合；不发网络请求。
- `ProviderUsageReconciler`：读取可回查事件，校验 API Key 指纹，调用固定 OpenRouter generation endpoint，并按有限退避更新 Repository；不直接操作 Renderer 状态。
- Token Usage 应用服务：捕获当前认证用户与一次 `now`，组合 Token Repository 和费用 Repository 的同周期快照。
- Renderer：只展示已验证的共享快照，不估算费用、不选择用户、不访问 Provider。

## 数据模型

### `chat_runs` 扩展

新增可空字段：

```text
user_id TEXT REFERENCES local_users(id)
provider TEXT
```

迁移不回填旧记录。新运行必须由 Main 进程写入当前用户 ID 和实际路由 Provider。Repository 的个人 Token 查询只读取 `user_id = currentUserId` 的记录，因此旧记录和其他用户记录均不进入当前用户统计。

### `provider_usage_events`

新增表：

```text
id TEXT PRIMARY KEY
operation_key TEXT NOT NULL UNIQUE
user_id TEXT NOT NULL REFERENCES local_users(id)
provider TEXT NOT NULL
api_key_fingerprint TEXT
request_id TEXT NOT NULL
chat_run_id TEXT
generation_id TEXT
provider_job_id TEXT
model TEXT NOT NULL
modality TEXT NOT NULL
status TEXT NOT NULL
input_tokens INTEGER
output_tokens INTEGER
cost_usd TEXT
reconcile_attempts INTEGER NOT NULL DEFAULT 0
next_reconcile_at INTEGER
started_at INTEGER NOT NULL
ended_at INTEGER
```

约束和索引：

- `operation_key` 全局唯一，用于本地幂等。
- `generation_id` 非空时唯一，防止同一 generation 被两个事件重复计费。
- `status` 仅允许 `pending`、`reported`、`unknown`。
- `modality` 仅允许 `text`、`image`、`audio`、`video`。
- `provider` 使用现有 Provider ID 契约。
- Token 必须是非负安全整数。
- `cost_usd` 为空表示未知；非空时必须是规范化非负十进制字符串。
- `status = reported` 时 `cost_usd` 必须非空；`pending` 或 `unknown` 时必须为空。
- `api_key_fingerprint` 是 API Key 的 SHA-256 十六进制摘要，不保存凭证明文。
- 表不对 conversations 或 chat_runs 建立级联删除外键；删除会话不得删除费用流水。
- 按 `user_id, provider, started_at` 建立聚合索引。
- 按 `status, next_reconcile_at` 建立回查索引。

`chat_run_id` 和 `request_id` 用于本地审计，不承担生命周期级联。

## 接口契约

### 发起调用

Main 应用服务在开始聊天发送时调用 `auth.requireSession()`，捕获一次当前用户 ID。该 ID 作为只读内部参数传给：

- `AgentRunInput`
- `MediaGenerationRunInput`
- `SubmitVideoInput`

Renderer 的 chat send 契约不增加 `user_id`，避免客户端伪造归属。

Provider 请求增加内部终端用户字段：

```ts
interface ModelStreamRequest {
  // existing fields
  endUserId?: string
}
```

OpenRouter Provider 将其序列化为：

```json
{ "user": "autoforge:<local-user-id>" }
```

DeepSeek 不发送该字段。专用 Image/Video 请求也不发送该字段，直至官方端点契约明确支持。

### 费用写入端口

费用写入由 Main 内部端口完成，不暴露给 Renderer：

```ts
interface ProviderUsageRepository {
  start(event: ProviderUsageStart): ProviderUsageEvent
  bindIdentity(operationKey: string, identity: ProviderUsageIdentity): ProviderUsageEvent
  report(operationKey: string, report: ProviderUsageReport): ProviderUsageEvent
  markUnknown(operationKey: string, endedAt: number): ProviderUsageEvent
  listReconcilable(now: number): ProviderUsageEvent[]
  recordReconcileFailure(operationKey: string, nextReconcileAt?: number): ProviderUsageEvent
  summarize(input: ProviderUsageQuery): ProviderUsageSummary
}
```

`start`、`bindIdentity`、`report` 和 `markUnknown` 必须幂等。`bindIdentity` 用于在流式 generation 事件或视频提交成功时持久化 generation/job ID，使后续失败仍可回查。重复 `report` 只能接受与已保存 generation 和费用完全相同的值；冲突值视为内部一致性错误，不能覆盖。

### 费用统计响应

保留 `settings.getTokenUsage()` 方法和 IPC channel，扩展现有快照：

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
  provider: 'openrouter' | 'deepseek'
  model: string
  inputTokens: number
  outputTokens: number
  totalTokens: number
  openRouterCostUsd: string
  openRouterKnownCostCount: number
  openRouterUnknownCostCount: number
}
```

金额字段使用规范化十进制字符串。`settings.getTokenUsage()` 在 Main 内部读取当前认证会话，并把用户 ID 传给 Token 与费用 Repository；Renderer 不能指定目标用户。

## 调用数据流

### Text 与当前 Chat 音频

每次 `provider.stream()` 调用创建一条费用事件。Agent 的 operation key 为 `agent:<requestId>:turn:<turnIndex>`；音频生成为 `audio:<requestId>`。

处理顺序：

1. 通过本地请求校验并取得 Provider 凭证。
2. 创建 pending 费用事件。
3. 发出 OpenRouter 请求。
4. 捕获 generation 事件和最终 usage。
5. usage 含 cost 时立即 report；不等待 Agent 后续工具或媒体本地提交完成。
6. 调用结束没有 cost 时 markUnknown；若有 generation ID，则进入回查队列。

Provider 内部重试不会创建新的 operation key。OpenRouter 没有返回 usage 的失败尝试不会伪造费用；若最终没有明确费用，事件保持 unknown。

### Image

operation key 为 `image:<requestId>`。`/images` 成功响应后，先把 usage Token 和 cost report 到费用流水，再下载或持久化图片。媒体保存失败不回滚费用事件。

响应没有 cost 时 markUnknown。当前 Image 响应链路没有可靠 generation ID 时不发起无法定位的回查。

### Video

operation key 为 `video:<requestId>`。提交任务前创建 pending 事件，成功后记录 Provider job ID。事件持久化发起用户，因此退出登录、切换用户或应用重启不会改变归属。

轮询首次返回 completed 时，先 report generation ID 和 cost，再进入下载阶段。视频下载或本地资产提交失败不回滚费用事件。终态缺少 cost 但具有 generation ID 时进入回查队列。

## 回查与恢复

新增 OpenRouter generation usage 查询能力，只接受 generation ID 和当前凭证，不允许 Renderer 指定 URL。

回查条件：

- 事件属于 OpenRouter；
- 状态为 unknown；
- generation ID 非空；
- 当前保存的 OpenRouter API Key 指纹与事件指纹一致；
- 到达 `next_reconcile_at`。

采用固定的有限退避序列：1 秒、5 秒、30 秒，共 3 次。成功取得 `total_cost` 后 report；404、网络失败或暂时性服务错误按退避重试。达到上限、API Key 已更换、认证失败或 generation 无法访问时保持 unknown，不再自动请求。

回查由应用启动恢复和请求完成后的异步任务触发。打开设置页只读取本地快照，不启动无限或同步网络请求。

应用启动时将遗留 pending 事件转为 unknown，再按上述条件安排回查。没有 generation ID 的事件保持 unknown。

## 十进制金额处理

数据库保留 OpenRouter 返回金额的规范化十进制文本。入口允许 OpenRouter JSON number/string 使用普通十进制或科学计数法；规范化层把符号位、系数和指数转换为不含指数的非负十进制字符串。聚合层实现纯十进制字符串加法：

- 接受非负有限普通十进制或科学计数法输入，不接受负数、显式正号、空白、NaN 或 Infinity；
- 对齐小数位后使用 `BigInt` 相加；
- 内部与共享 IPC 输出不含指数、移除多余前导零和尾随零，但至少保留整数部分；
- 不使用 SQLite `SUM()`、JavaScript `Number` 或二进制浮点累计金额。

UI 只在格式化展示时添加美元符号和千位分隔，不改变聚合字符串。

## 删除与保留策略

- 删除单个会话：聊天、消息和 `chat_runs` 按现有规则删除，费用流水保留。
- 清除 conversations：费用流水保留。
- 清除 executions：费用流水不受影响。
- 当前“清除全部本地数据”只清理 conversations 和 executions，因此费用流水仍保留。
- 历史未归属 `chat_runs` 不迁移、不删除，也不进入个人统计。

这样可以保持本地消费历史与 OpenRouter 官网一致，同时不让聊天内容的生命周期控制财务审计数据。

## UI 设计

设置页模块从“Token 账单”改为“用量与消费”。继续使用今日、昨日、本周、本月、累计五个周期。

每个周期显示：

- 输入 Token
- 输出 Token
- 总 Token
- OpenRouter 消费
- 已确认费用笔数
- 待确认费用笔数（仅大于 0 时显示警示）

OpenRouter 消费以 `$<decimal>` 展示。存在 unknown 事件时，紧邻显示“有 N 笔费用待确认”，避免把已知小计称为完整总额。

现有 Token 趋势图保持 Token 坐标，不把美元混到同一图表。模型明细按 `provider + model` 分组并增加 Provider、OpenRouter 消费、已确认和待确认列。DeepSeek 行的 OpenRouter 消费显示 `—`。

页面只读取当前登录用户，不提供用户选择器、全体汇总或管理员入口。

## 错误与边界行为

- `cost = 0`：reported，展示为 `$0`。
- cost 缺失：unknown，不计入金额，增加待确认笔数。
- generation 重复且数据一致：幂等成功。
- generation 或 operation key 重复但数据冲突：内部一致性错误，保留原值。
- 用户在异步任务期间退出或切换：使用任务开始时持久化的用户 ID。
- API Key 更换：不使用新 Key 回查旧 generation；事件保持 unknown。
- OpenRouter credential 缺失：不执行回查。
- DeepSeek 调用：记录 `chat_runs.user_id/provider` 供 Token 隔离，不产生 OpenRouter 消费。
- 旧记录：保持未归属，不显示给任何个人用户。
- 同一 Key 被其他应用使用：App 只能保证自身事件合计；官网 Key 总额可能更大。

## 测试设计

### 数据库与迁移

- 从 schema v4 升级后，旧 `chat_runs.user_id/provider` 为 null。
- 新 `chat_runs` 持久化用户和 Provider。
- provider usage operation key 和非空 generation ID 唯一。
- reported/unknown/zero cost 约束正确。
- 删除会话和清除 conversations 后费用流水仍存在。
- Alice 与 Bob 使用同一 Key 时，按用户查询严格隔离。

### 十进制聚合

- 小数位不同的金额准确相加。
- 极小金额、零、整数和大金额保持精确。
- 能把合法科学计数法输入规范化为普通十进制；拒绝负数、显式正号、空白、NaN、Infinity 和其他非法格式。
- 模型、周期和总计的费用合计一致。

### Provider 与编排器

- OpenRouter Chat 请求包含 `user: autoforge:<id>`。
- DeepSeek、Image 和 Video 请求不携带未支持的 user 字段。
- Agent 多轮调用分别写入费用事件，费用总和正确。
- Agent 后续工具失败不删除已 report 的费用。
- 图片本地保存失败仍保留上游费用。
- 视频 completed 后、下载前写入费用。
- 视频跨重启恢复后仍归属于原用户。
- 相同 operation/generation 的重复事件不重复计费。

### 回查

- `usage.cost` 存在时不调用 generation API。
- 缺 cost 且 generation ID 存在时，用相同 Key 回查 `total_cost`。
- API Key 指纹不同、无 generation ID 或无凭证时不回查。
- 1 秒、5 秒、30 秒退避后停止自动重试。
- 重启时 pending 转 unknown，并恢复可回查事件。

### 应用服务、IPC 与 UI

- `getTokenUsage()` 使用当前认证用户，不接受 Renderer 用户参数。
- Alice 与 Bob 的 Token、费用和 unknown 笔数互不泄露。
- 共享契约拒绝非规范金额和不一致汇总。
- Store 保持旧快照直到新快照成功。
- 页面显示消费卡、待确认警示、Provider 与模型费用列。
- DeepSeek 行显示 `—`，历史未归属不显示。

### 完成验证

实现完成后运行：

1. 数据库、Provider、Agent/媒体、Token 用量和设置组件聚焦测试；
2. Desktop Node/Web TypeScript 类型检查；
3. 完整测试；
4. ESLint；
5. 生产构建；
6. `git diff --check`。

真实官网验收使用用户下一次正常 OpenRouter 调用，不由测试套件自动消费 credits。验收时记录 App 用户、generation/job ID、模型、时间和 App 金额，并与 OpenRouter Activity/Generation 的同一调用核对。若没有可用凭证或用户未执行真实调用，最终报告只声明自动化契约验证，不把 Mock 测试称为真实官网对账。

## 风险

- OpenRouter 专用媒体端点当前不能保证在官网按 `external_user` 过滤；本地用户流水仍是媒体归属真值。
- OpenRouter 响应若不提供 cost 且没有 generation ID，只能保持 unknown。
- 同一 API Key 被 App 外部复用时，官网 Key 总额包含外部消费。
- 当前本地认证尚未隔离会话列表；本设计只保证新 Token/费用统计归属，不扩大为会话权限重构。

这些风险通过明确口径、unknown 状态、API Key 指纹和真实 generation 对账来暴露，而不是用模型当前价格估算或静默填零。
