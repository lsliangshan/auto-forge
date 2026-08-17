# Token 用量账单模块设计

## 目标

在设置页新增“Token 账单”模块，展示当前自然月与本机保留历史中的模型 Token 用量。每个统计周期分别显示输入、输出和总 Token，并按模型列出明细与全部模型汇总。

首版只统计 Token，不展示美元费用。统计覆盖所有模型供应商，不尝试从模型 ID 推断 OpenRouter 或 DeepSeek。

## 现有事实与边界

每次模型调用已经持久化到 SQLite `chat_runs`，其中包含 `model`、`input_tokens`、`output_tokens`、`status` 和时间字段，因此历史数据无需迁移即可聚合。

`chat_runs` 没有供应商字段，也没有用户字段。当前会话和调用数据本身不按本地登录账号隔离，所以本模块展示的是本机当前仍保留的全部调用用量，不宣称是按账号隔离的云端账单。清除会话会级联删除相应 `chat_runs`，统计结果随之减少。

图片、视频等模型可能按图片、秒或请求计费，且部分调用只有费用而没有 Token。首版只统计实际持久化的 Token 字段；没有输入和输出 Token 的调用不计入 Token 账单。

## 统计口径

- 同时提供“本月”和“累计”两个周期。
- 本月起点由 Main 进程按本机时区计算为当前自然月第一天零点。
- 累计范围为本机当前保留的所有 `chat_runs`。
- 只要输入或输出 Token 至少有一个实际值，就纳入统计，不限制 `completed`、`failed` 或 `cancelled` 状态。
- 单侧 Token 缺失时按 `0` 统计。
- `totalTokens` 始终由 `inputTokens + outputTokens` 计算，不另存第三份数据。
- 模型明细按 `totalTokens` 降序排列，同量时按模型 ID 升序排列，保证结果稳定。
- 空数据返回零汇总和空模型数组，不使用伪造示例数据。

## 数据契约

共享契约新增以下响应结构：

```ts
interface ModelTokenUsage {
  model: string
  inputTokens: number
  outputTokens: number
  totalTokens: number
}

interface TokenUsagePeriod {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  models: ModelTokenUsage[]
}

interface TokenUsageSnapshot {
  monthStartedAt: string
  month: TokenUsagePeriod
  allTime: TokenUsagePeriod
}
```

所有 Token 字段必须是非负安全整数，每个 `totalTokens` 必须等于对应输入与输出之和。`monthStartedAt` 使用 ISO 时间字符串，表示 Main 进程计算出的本地月初时刻。

新增受认证保护的 IPC：

```ts
settings.getTokenUsage(): Promise<TokenUsageSnapshot>
```

请求体为 `undefined`。返回值必须通过共享 Zod Schema 验证，不允许 Renderer 接收未验证的数据库结果。

## 数据访问与应用服务

`AppRepositories.chatRuns` 新增窄接口：

```ts
summarizeTokenUsage(monthStartedAt: number): TokenUsageSnapshotRecord
```

Repository 只负责基于传入毫秒时间戳聚合数据，不负责决定时区或当前时间。SQL 直接从 `chat_runs` 按模型聚合累计值，并使用 `started_at >= monthStartedAt` 聚合本月值；两个周期在同一同步数据库调用中读取，形成一致快照。

应用服务负责：

1. 使用当前本机时间计算自然月起点。
2. 调用 Repository 聚合接口。
3. 将月初毫秒时间戳转换为 ISO 字符串。
4. 通过 `settings:get-token-usage` 返回共享契约数据。

不新增计数表、数据库迁移、定时任务或 Provider 网络请求。

## Renderer 状态与加载

Settings Store 新增独立状态：

- `tokenUsage?: TokenUsageSnapshot`
- `tokenUsageLoading: boolean`
- `tokenUsageError: string`
- 独立请求版本号，防止较旧响应覆盖新刷新结果。

`loadTokenUsage()` 只更新账单状态，失败时不写入设置页全局 `error`，避免账单查询失败阻断供应商、默认模型、代理等其他设置。

加载时机：

- 每次进入设置页时加载一次，即使基础设置已经存在于 Store。
- 点击账单模块“刷新”按钮时重新加载。
- 成功清除“会话”或“全部”本地数据后立即重新加载。

不做定时轮询。设置页保持打开且后台调用完成时，用户可点击刷新获取最新结果。

## 设置页界面

在“默认模型”和“VPN 代理”之间插入“Token 账单”区块。使用独立 `BillingUsagePanel.vue` 展示组件，使 `SettingsView.vue` 只负责装配 Store 状态与刷新事件。

模块包含：

- 标题“Token 账单”。
- 说明当前统计来自本机保留的调用记录。
- 右侧“刷新”按钮及加载状态。
- “本月”和“累计”两个页签。
- 每个页签顶部显示输入 Token、输出 Token、总 Token 三个汇总值。
- 下方表格显示模型 ID、输入 Token、输出 Token、总 Token。
- Token 数字使用千位分隔。
- 无数据时显示“暂无 Token 用量记录”。
- 查询失败时只在模块内显示安全错误信息，并保留刷新入口。

“本月”页签可根据 `monthStartedAt` 显示统计起点。模型 ID 允许换行，数字列右对齐；不加入图表、费用换算、日期筛选或导出功能。

## 错误处理与一致性

- 数据库聚合结果若不是非负安全整数，Repository 抛出内部错误，不进行静默截断。
- IPC 输出验证失败时沿用现有安全 `INTERNAL_ERROR` 映射，不暴露 SQL 或本地路径。
- 较旧的 Renderer 请求成功或失败后，均不能覆盖较新的账单状态。
- 清除数据失败时保持原统计，不伪造零值。
- 模型调用正在进行且尚未持久化最终 Token 时不纳入统计；后续刷新后自然进入结果。

## 测试与验证

### 共享契约

- 接受本月与累计的有效零值和多模型快照。
- 拒绝负数、非整数、非安全整数、错误总和和非法时间戳。
- 声明新的 IPC channel、请求和响应 Schema。

### Repository

- 按模型聚合输入、输出和总 Token。
- 单侧缺失按零处理，双侧缺失不计入。
- 有用量的失败和取消记录计入。
- 正确区分月初边界前后的记录。
- 空数据返回零汇总与空模型数组。
- 排序稳定，并在清除会话后反映删除结果。

### IPC、Preload 与应用服务

- 受认证 IPC 路由到 `settings.getTokenUsage()`。
- Preload 只暴露类型化方法。
- 应用服务使用本地自然月起点并转换为 ISO 时间。
- 非法输出被契约拦截。

### Store 与组件

- 每次进入设置页加载账单，刷新按钮重新加载。
- 较旧响应不覆盖新结果。
- 账单错误与设置全局错误隔离。
- 清除会话或全部数据后刷新账单；清除执行记录不刷新。
- 本月与累计页签分别显示正确汇总和模型明细。
- Token 格式、空状态、错误状态和 DeepSeek/OpenRouter 无关性正确。

完成前运行聚焦测试、完整测试、类型检查、Lint、构建和 `git diff --check`。若遇到与本改动无关的旧失败，必须单独记录并复现，不修改无关代码掩盖失败。

## 成功标准

- 设置页可查看本月和累计的输入、输出、总 Token。
- 每个周期可查看按模型汇总的 Token 明细与全部模型总量。
- 有实际 Token 的失败或取消调用被统计，无 Token 的调用不计入。
- 统计来源、清除数据后的变化和本机范围对用户保持真实。
- 账单加载失败不影响其他设置功能。
- 不新增数据库迁移、静态价格或后台轮询。
