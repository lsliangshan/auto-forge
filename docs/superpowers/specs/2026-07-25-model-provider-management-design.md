# AutoForge 大模型供应商管理设计

## 目标

在设置页增加“大模型供应商”管理，首期固定支持 `deepseek` 与 `openrouter`。用户可以切换当前供应商、分别保存和清除两套 API Key、分别选择默认模型；模型列表与聊天请求必须实际使用当前供应商，不允许静默回退到另一供应商。

## 范围

本期包含：

- `deepseek`、`openrouter` 两个固定供应商。
- 每个供应商独立的 API Key、凭证状态、模型列表与默认模型。
- 设置页供应商选择、凭证管理、模型刷新和默认模型修改。
- Main 进程内的供应商选择、模型请求、流式聊天与工具调用。
- 现有 OpenRouter 设置和密钥的兼容迁移。
- 供应商中立的错误、脱敏诊断和自动化回归测试。

本期不包含：

- 用户自定义供应商、Base URL 或请求头。
- 供应商插件安装、远程供应商目录或动态发现。
- 自动跨供应商回退。
- 云端同步 API Key 或设置。

## 方案选择

采用共享的 OpenAI 兼容协议核心和两个固定供应商适配器。

OpenRouter 与 DeepSeek 共享流式响应解析、工具调用聚合、取消、重试、限流和安全错误映射。适配器只提供固定端点、凭证读取端口和模型列表转换。相比复制两个完整 Provider，这避免协议行为逐渐分叉；相比插件框架，它只引入当前需求所需的抽象。

## 设置数据

共享契约新增：

```ts
type ModelProviderId = 'deepseek' | 'openrouter'

interface ProviderDefaultModels {
  deepseek: string
  openrouter: string
}

interface AppSettings {
  activeProvider: ModelProviderId
  defaultModels: ProviderDefaultModels
  // 其余现有字段保持不变
}
```

新安装的默认值为：

```ts
{
  activeProvider: 'openrouter',
  defaultModels: {
    openrouter: 'openai/gpt-4.1-mini',
    deepseek: 'deepseek-v4-flash',
  },
}
```

`defaultModels` 中的值均可由用户修改。DeepSeek 的初始值依据 2026-07-25 官方接口文档；实际下拉列表始终来自供应商模型接口，不硬编码为仅允许初始模型。

### 兼容迁移

设置服务读取旧数据时执行一次确定性归一化：

- 没有 `activeProvider` 时使用 `openrouter`。
- 没有 `defaultModels.openrouter` 时，优先使用旧 `defaultModel`，否则使用新安装默认值。
- 没有 `defaultModels.deepseek` 时使用 `deepseek-v4-flash`。
- 返回 Renderer 的新 `AppSettings` 不再包含旧 `defaultModel`。
- 写回设置时只持久化新结构，完成惰性迁移。

现有 OpenRouter 密钥继续使用 `openrouter_api_key`，无需解密后重存。DeepSeek 密钥使用 `deepseek_api_key`。

## 凭证契约与安全边界

凭证仅由 Electron Main 通过 `safeStorage` 读写。Preload 和 Renderer 永远不能读取、回显或枚举密钥内容。

凭证状态使用显式供应商和验证结果：

```ts
interface ProviderCredentialStatus {
  provider: ModelProviderId
  configured: boolean
  validation: 'unchecked' | 'valid' | 'invalid' | 'unavailable'
  message?: string
  checkedAt?: string
}
```

`validating` 是 Renderer 发起验证期间的本地加载状态，不从 Main 伪造返回。Main 的凭证接口均显式接收 `provider`：

```ts
saveProviderApiKey(provider: ModelProviderId, apiKey: string): Promise<ProviderCredentialStatus>
clearProviderApiKey(provider: ModelProviderId): Promise<void>
validateProviderCredential(provider: ModelProviderId): Promise<ProviderCredentialStatus>
listProviderModels(provider: ModelProviderId): Promise<ModelInfo[]>
```

保存流程为先加密持久化，再验证当前供应商。明确的 401/403 返回 `invalid`；网络、限流或上游故障返回 `unavailable`。验证失败不自动删除已保存密钥，用户可以替换或清除。安全存储写入失败时保存操作失败，Renderer 保留输入值。

所有 IPC 请求继续使用严格 schema、固定 channel、发送方校验和安全错误序列化。日志、诊断和响应不得包含 API Key、密文或未经约束的上游响应正文。

## Provider 架构

Main 进程创建固定 `ModelProviderRegistry`，注册 `openrouter` 和 `deepseek`。注册表只按严格的 `ModelProviderId` 解析 Provider，不接受任意 URL 或 Renderer 提供的 Provider 对象。

Provider 统一实现：

```ts
interface ModelProvider {
  listModels(signal?: AbortSignal): Promise<ModelInfo[]>
  validateCredential(signal?: AbortSignal): Promise<{ valid: boolean }>
  stream(request: ModelStreamRequest): AsyncGenerator<ModelStreamEvent>
}
```

共享协议核心保留现有 OpenRouter 实现中已经验证的行为：

- Bearer 认证。
- Server-Sent Events 增量解析。
- 文本、工具调用、结束原因和用量事件。
- 工具参数 JSON 解析与上层 schema 校验。
- 取消、429/5xx 重试和有界 `Retry-After`。
- 有界、脱敏的失败诊断。

供应商配置：

| 供应商 | Chat Endpoint | Models Endpoint | 密钥 |
| --- | --- | --- | --- |
| `openrouter` | `https://openrouter.ai/api/v1/chat/completions` | `https://openrouter.ai/api/v1/models?supported_parameters=tools` | `openrouter_api_key` |
| `deepseek` | `https://api.deepseek.com/chat/completions` | `https://api.deepseek.com/models` | `deepseek_api_key` |

OpenRouter 保留现有的文本输出与工具调用模型过滤、名称、上下文长度和价格转换。DeepSeek 接受官方 `/models` 返回的模型，将 `id` 同时作为显示名称回退；没有价格数据时不伪造成本。共享流解析允许 DeepSeek 增量中的 `usage: null` 和 `reasoning_content`，当前产品只展示最终文本，不把思考内容作为普通回复泄露。

## 聊天数据流

新聊天请求进入 Main 时读取一次设置快照：

```ts
const settingsSnapshot = settings.get()
const providerId = settingsSnapshot.activeProvider
const model = input.model ?? settingsSnapshot.defaultModels[providerId]
const provider = providerRegistry.get(providerId)
```

供应商、模型和 Provider 实例成为该次 Agent 运行的固定上下文。第一次模型请求、工具执行后的后续模型请求和最终回复都复用同一上下文。用户在运行期间切换设置只影响随后创建的新请求。

发送前验证当前供应商存在非空密钥。缺少密钥时返回可操作的凭证未配置错误；不得尝试另一供应商。Renderer 不能通过伪造 Provider ID 绕过设置，因为实际供应商由 Main 的设置快照决定。

## 设置页交互

设置侧栏中的“OpenRouter 凭证”改为“大模型供应商”。

供应商区域包含：

- `DeepSeek`、`OpenRouter` 选择器。
- 当前供应商的凭证状态。
- 当前供应商的密码输入框。
- 保存或替换凭证按钮。
- 仅在已配置时显示的清除按钮。

切换供应商时：

1. 保存新的 `activeProvider`。
2. 清空未提交的 API Key 输入。
3. 显示该供应商已保存的默认模型。
4. 加载该供应商的凭证状态。
5. 仅在已配置时加载模型列表。

如果供应商设置保存失败，选择器恢复原值。清除凭证前的确认文案必须包含供应商名称；清除只影响当前供应商，并清空该供应商的内存模型列表。

默认模型区域只展示当前供应商的模型。选择后更新 `defaultModels` 中对应字段，不修改另一供应商的值。刷新模型列表不会自动覆盖默认模型；如果已保存模型暂未出现在接口结果中，下拉框仍保留一个“已保存模型”选项，由用户明确决定是否更换。

未配置当前供应商凭证时，模型下拉和刷新按钮禁用，并显示配置引导。保存并验证凭证后自动刷新模型列表。

## 错误处理

供应商公共路径使用中立的 `MODEL_PROVIDER_REQUEST_FAILED`，避免 DeepSeek 请求失败时显示 OpenRouter 文案。历史 `OPENROUTER_REQUEST_FAILED` 错误码继续保留在反序列化契约中，保证旧执行记录可读取，但新请求不再产生该错误码。

错误映射：

- 没有当前供应商密钥：`CREDENTIAL_UNAVAILABLE`。
- 401/403：`CREDENTIAL_INVALID`。
- 取消：`CANCELLED`。
- 网络、429、5xx、流式格式错误或重试耗尽：`MODEL_PROVIDER_REQUEST_FAILED`。

凭证状态接口把网络类失败表示为 `unavailable`，不误报为密钥无效。面向 Renderer 的错误只包含固定安全文案；供应商、操作、状态码和受限错误元数据可以进入脱敏诊断。

## 测试

### 共享契约

- 只接受 `deepseek`、`openrouter`。
- 新设置结构要求两个独立默认模型。
- 所有凭证和模型 IPC 请求要求显式 `provider`。
- API Key 不出现在任何响应 schema 中。
- 历史 `OPENROUTER_REQUEST_FAILED` 记录仍可解析。

### 设置与迁移

- 旧 `defaultModel` 迁移到 `defaultModels.openrouter`。
- 旧 `openrouter_api_key` 保持可读。
- DeepSeek 使用独立密钥且不能读取 OpenRouter 密钥。
- 更新一个默认模型不会覆盖另一个。

### Provider

- OpenRouter 现有模型过滤、流式解析、工具调用、重试和诊断测试保持通过。
- DeepSeek 请求访问固定官方端点并使用 DeepSeek 密钥。
- DeepSeek 模型列表转换、文本流、`usage: null`、工具调用、结束原因和用量得到覆盖。
- 401/403、429、5xx、取消和格式错误得到供应商中立的安全错误。

### 运行时

- 当前供应商决定模型列表和聊天 Provider。
- 显式聊天模型覆盖只作用于已快照的当前供应商。
- 运行中切换设置不改变该次运行及工具调用后的后续请求。
- 当前供应商缺少密钥时不回退。

### Renderer

- 切换供应商清空未提交密钥并加载正确状态。
- 保存失败保留输入，成功后清空输入并刷新模型。
- 两套默认模型分别修改并恢复。
- 刷新列表不覆盖已保存模型。
- 清除只影响当前供应商。

### 完成验证

完成前运行完整测试、类型检查、生产构建、Lint 和 `git diff --check`。如果环境没有用户提供的有效 DeepSeek 与 OpenRouter 密钥，只报告自动化契约验证，不把 Mock 请求称为真实上游验证；真实联网聊天和模型列表列为待验证项。

## 验收标准

- 用户可在设置页切换 `deepseek` 与 `openrouter`。
- 两个供应商的 API Key 可独立保存、验证、替换和清除，且从不暴露给 Renderer。
- 模型列表来自当前供应商，默认模型可分别修改并在切换后恢复。
- 新聊天及其完整工具调用链使用发送时快照的供应商和模型。
- 不存在隐式跨供应商回退。
- 现有 OpenRouter 密钥和默认模型升级后保持有效。
- 自动化回归、类型检查、构建、Lint 和 diff 检查通过；真实联网验证状态如实报告。

## 参考

- DeepSeek API 入门：<https://api-docs.deepseek.com/>
- DeepSeek 模型列表：<https://api-docs.deepseek.com/api/list-models>
- DeepSeek Chat Completion：<https://api-docs.deepseek.com/api/create-chat-completion>
