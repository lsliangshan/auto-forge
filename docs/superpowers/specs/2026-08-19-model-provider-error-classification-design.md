# 模型供应商错误分类设计

日期：2026-08-19

## 背景与事实

聊天页使用 `bytedance-seed/seedream-4.5` 生成图片时，多次以
`MODEL_PROVIDER_REQUEST_FAILED` 结束。已确认：

- 同一模型曾成功生成并记录 `$0.04` 费用，后续失败均在一秒内结束，且没有
  generation ID 或费用记录。
- OpenRouter 账户和当前 API Key 均有可用额度，Key 未过期且没有独立消费上限。
- 请求使用的 `1K`、`16:9` 均在 Seedream 4.5 当前能力目录内。
- AutoForge 配置的 HTTP 代理当前能访问 OpenRouter 图片模型目录。
- OpenRouter Provider 会安全读取 HTTP 状态、错误码和 `error_type`，但生产路径只把
  401、403 分类，其余非成功响应最终都变成 `MODEL_PROVIDER_REQUEST_FAILED`。

历史失败响应正文已被安全排空且没有持久化，因此不能事后证明这些失败具体属于参数
错误、限流、超时还是供应商不可用。当前可修复且已证实的根因是错误分类在 Provider
边界丢失，导致聊天页无法给出可操作信息。

## 目标

对非流式模型供应商请求保留安全、稳定的失败类别，使聊天页可以区分：

- 供应商不接受当前请求；
- 账户或 API Key 额度不足；
- 请求被限流；
- 供应商响应超时；
- 供应商或模型暂时不可用。

成功标准：

1. 图片请求收到 402、429、408/504、502/503 时分别返回明确 AppError。
2. 已知 `error_type` 能在 HTTP 状态不足以区分时提供更精确分类。
3. 401、403 和取消行为保持原语义。
4. 聊天媒体失败块显示对应的安全中文提示。
5. 供应商原始消息、请求正文、API Key 和未经约束的元数据不进入 Renderer、数据库或
   日志。
6. 图片 POST 仍只执行一次，不因本次改动自动重试。

## 非目标

- 不改变 Seedream 或其他模型的请求参数。
- 不新增付费请求、自动重放或“重试生成”按钮。
- 不改变现有流式文本请求的重试状态机。
- 不持久化供应商原始响应。
- 不修改数据库 Schema、代理配置、模型目录或媒体存储。

## 接口契约

### 调用方

`OpenRouterProvider.generateImage`、视频和 generation 查询通过
`OpenAiCompatibleProvider.authenticatedFetch` 发起非流式供应商请求。

### 输入

分类器只接收已经位于 Main 进程内的安全输入：

- HTTP status；
- 经过长度和字符集约束的 `error.code`；
- 经过长度和字符集约束的 `error_type`。

原始 `message`、provider payload 和任意 metadata 不属于分类器输入，也不会向下游
传递。

### 输出

共享 AppError 契约新增：

- `MODEL_PROVIDER_INVALID_REQUEST`
- `MODEL_PROVIDER_PAYMENT_REQUIRED`
- `MODEL_PROVIDER_RATE_LIMITED`
- `MODEL_PROVIDER_TIMEOUT`
- `MODEL_PROVIDER_UNAVAILABLE`

返回结构仍为严格的 `{ code, message }`，其中 `message` 由 Main 进程的固定安全文案
生成。Renderer 只根据 `code` 选择本地化文案。

### 分类优先级

明确的 `error_type` 优先于一般 HTTP fallback：

- `authentication` → `CREDENTIAL_INVALID`
- `permission_denied`、`content_policy_violation`、`refusal`
  → `MODEL_PROVIDER_ACCESS_DENIED`
- `payment_required` → `MODEL_PROVIDER_PAYMENT_REQUIRED`
- `rate_limit_exceeded` → `MODEL_PROVIDER_RATE_LIMITED`
- `timeout` → `MODEL_PROVIDER_TIMEOUT`
- `provider_overloaded`、`provider_unavailable`、`server`、`unmapped`
  → `MODEL_PROVIDER_UNAVAILABLE`
- `context_length_exceeded`、`max_tokens_exceeded`、`token_limit_exceeded`、
  `string_too_long`、`invalid_request`、`invalid_prompt`、`not_found`、
  `precondition_failed`、`payload_too_large`、`unprocessable`、`invalid_image`、
  `image_too_large`、`image_too_small`、`unsupported_image_format`、
  `image_not_found`、`image_download_failed` → `MODEL_PROVIDER_INVALID_REQUEST`

未匹配 `error_type` 时按 HTTP status 分类：

- 400、404、409、412、413、422 → `MODEL_PROVIDER_INVALID_REQUEST`
- 401 → `CREDENTIAL_INVALID`
- 402 → `MODEL_PROVIDER_PAYMENT_REQUIRED`
- 403 → `MODEL_PROVIDER_ACCESS_DENIED`
- 408、504 → `MODEL_PROVIDER_TIMEOUT`
- 429 → `MODEL_PROVIDER_RATE_LIMITED`
- 500、502、503 → `MODEL_PROVIDER_UNAVAILABLE`
- 其他状态 → 保留 `MODEL_PROVIDER_REQUEST_FAILED`

本地 AbortSignal 仍优先返回 `CANCELLED`。

## 数据流与职责

1. `authenticatedFetch` 收到非成功响应。
2. Main 进程以现有有界读取方式排空响应，只提取安全 `code` 和 `error_type`。
3. 分类器根据上述优先级生成 AppError code。
4. 媒体生成编排继续把 AppError code 写入既有 chat run 和失败媒体块。
5. Renderer 的 `displayError` 把 code 映射为固定中文提示。

Provider 负责协议分类，共享包负责 AppError 白名单和安全英文消息，Renderer 负责中文
展示。没有跨边界 DTO 复用或新数据库字段。

## 重试与计费语义

图片生成继续使用 `retry: "never"`。429、5xx 的新分类只改变最终错误身份，不改变尝试
次数。已有幂等查询可以保留现有重试次数，但最后一次失败应返回具体类别。这样既提高
可诊断性，又不引入重复图片计费风险。

## 用户文案

- 请求不兼容：`供应商不接受当前模型参数，请刷新模型列表或调整生成设置`
- 额度不足：`供应商账户或 API Key 额度不足，请充值或检查限额`
- 限流：`供应商请求过于频繁，请稍后重试`
- 超时：`供应商响应超时，请稍后重试`
- 不可用：`供应商或所选模型暂时不可用，请稍后重试`

现有访问拒绝文案继续覆盖权限、Guardrail 和内容策略。

## 测试设计

按 TDD 顺序：

1. 共享契约测试先声明五个新错误码和固定安全消息。
2. OpenRouter Provider 参数化测试覆盖 HTTP fallback，并断言图片 POST 仍只有一次。
3. Provider 测试覆盖 `error_type` 优先级，确认原始错误消息不会出现在 AppError 或诊断
   元数据中。
4. 组件测试覆盖五条中文文案及失败媒体块展示。
5. 运行共享契约、OpenRouter Provider、聊天组件聚焦测试，再运行类型检查和完整测试。

真实付费图片请求不属于自动验证；如需重新调用 Seedream，必须另行明确授权。

## 备选方案

仅写开发日志改动更小，但普通用户仍无法采取行动；自动重试可能重复计费。选择安全
错误分类，因为它解决已证实的信息丢失，同时保持非幂等付费请求的现有边界。
