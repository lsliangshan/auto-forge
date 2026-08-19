# OpenRouter 图片请求韧性设计

日期：2026-08-19

## 背景与已证实事实

AutoForge 通过 OpenRouter 专用图片接口调用
`bytedance-seed/seedream-4.5`。历史记录显示同一模型曾成功生成并记录 `$0.04`
费用，随后多次在约 `0.3–0.5` 秒内失败。现有错误分类将明确的
`invalid_request`，以及没有更具体元数据的 HTTP 400，统一映射为
`MODEL_PROVIDER_INVALID_REQUEST`，Renderer 再显示“供应商不接受当前模型参数”。

OpenRouter 当前实时能力目录明确声明 Seedream 4.5 支持：

- `resolution`: `1K`、`2K`、`4K`；
- `aspect_ratio`: 包含 `16:9`；
- `n`: `1–10`。

获得用户授权后，以与失败场景一致的 `1K / 16:9 / n=1` 发起了一次真实请求。
该请求没有在约 0.3 秒内被拒绝，而是进入处理后超过 150 秒仍未返回；本地等待随后
被终止，且没有重发。由此可以排除“这些参数稳定不受支持”，但不能排除 Seed 或
OpenRouter 的瞬态失败、请求挂起或内部能力不一致。

## 目标

1. 图片请求在供应商长期不返回时，于 120 秒内以稳定的超时错误结束。
2. 用户主动取消继续返回 `CANCELLED`，不能被内部超时覆盖。
3. 没有明确错误类型的 HTTP 400 不再被中文文案断言为参数错误。
4. Main 进程留下可定位、可持久化、严格脱敏的供应商诊断。
5. 每次用户操作最多发送一个付费图片 POST，不新增自动重试。
6. 保留用户选择的 `resolution` 和 `aspect_ratio`，不做 Seedream 特例降级。

## 非目标

- 不自动重试图片生成。
- 不删除 `resolution`、`aspect_ratio` 或 `n`。
- 不切换到 Chat Completions、其他模型或其他供应商。
- 不保存供应商原始消息、响应正文、提示词、请求正文、API Key 或任意媒体内容。
- 不修改数据库 Schema、聊天消息结构、计费账本或视频请求策略。
- 不在自动测试中发起真实付费请求。

## 方案

### 1. 图片请求硬超时

`OpenRouterProvider.generateImage` 为一次图片生成建立 120 秒内部 deadline，并将其与
调用方的 `AbortSignal` 合并。deadline 覆盖：

1. HTTP 连接和响应头等待；
2. 响应正文读取；
3. 图片响应结构解析。

异常优先级固定为：

1. 调用方信号已取消 → `CANCELLED`；
2. 内部 deadline 已触发 → `MODEL_PROVIDER_TIMEOUT`；
3. 其他异常 → 保留现有分类。

无论成功或失败都清理 timer。超时不触发第二次 POST。

120 秒高于本次诊断前观察到的正常约 11 秒耗时，并覆盖 OpenRouter 模型页展示的大部分
高延迟请求；同时避免请求无限挂起。

### 2. 错误文案去除过度归因

保留共享错误码 `MODEL_PROVIDER_INVALID_REQUEST` 及现有分类规则，不扩大 IPC 或数据库
错误契约。本次只把 Renderer 中文文案改为：

> 供应商拒绝了当前请求，请调整生成设置或稍后重试

明确的额度、限流、超时、不可用、权限错误继续使用各自文案。这样既能覆盖真实参数
错误，也不会在只有 HTTP 400 时错误断言参数一定非法。

### 3. 脱敏诊断日志

新增 Main 进程供应商诊断日志模块，并将现有 `OpenAiCompatibleProvider` 的
`diagnostic` 回调接入生产 `OpenRouterProvider`。日志记录仅允许以下字段：

- `occurredAt`：ISO 时间；
- `provider`：由构造时绑定的 Provider ID 固定为 `openrouter` 或 `deepseek`；
- `operation`：现有受限枚举；
- `status`：有限 HTTP 状态码；
- `code`：现有经过字符集和长度约束的供应商错误码；
- `error_type`：现有经过字符集和长度约束的供应商错误类型。

诊断模块本身不接收请求对象、提示词、Header、API Key 或响应正文。记录写入现有
`paths.logs` 下的 `model-provider.jsonl`。日志采用单文件上限 `512 KiB`：追加前若当前
文件已达到上限，则以覆盖方式重新开始新文件，不维护多份历史副本。读取、判断大小、
截断或追加失败均静默丢弃诊断，不能影响模型调用。

同一诊断 sink 同时注入 OpenRouter 与 DeepSeek Provider，以保持 Provider 构造方式
一致；`provider` 字段由各自绑定的 sink 固定写入，调用方不能伪造。

## 数据流

1. Renderer 提交图片生成，现有路由选择模型与规范化参数。
2. Main 进程创建 120 秒图片 deadline，并与用户取消信号合并。
3. OpenRouter 返回非成功响应时，Provider 只提取安全 `status/code/error_type`。
4. 安全诊断异步追加到 `model-provider.jsonl`。
5. Provider 返回固定 AppError；Renderer 显示固定中文文案。
6. 超时或失败后不自动重试，由用户决定是否重新生成。

## 模块与责任

- `openrouter-provider.ts`
  - 负责图片 deadline、取消优先级和现有协议分类；
  - 继续负责仅发送模型能力目录声明支持的图片参数。
- `provider-diagnostic-log.ts`
  - 只负责白名单诊断字段的有界持久化；
  - 不理解请求正文或模型业务。
- `application.ts`
  - 创建按 Provider 绑定的诊断 sink 并注入 Provider。
- `desktop-api.ts`
  - 只负责错误码到中文文案的映射。

## 测试设计

按 TDD 顺序：

1. Provider 测试使用可控 fake timer 和挂起 fetch，先证明当前图片请求不会自行结束；
   实现后断言 120 秒时返回 `MODEL_PROVIDER_TIMEOUT`，且 POST 只有一次。
2. Provider 测试在 deadline 前触发调用方取消，断言仍返回 `CANCELLED`。
3. 诊断日志测试传入完整白名单字段，断言 JSONL 只包含允许字段；测试达到 512 KiB 后
   覆盖写入，并确认文件错误不会抛回 Provider。
4. Application 测试断言 OpenRouter 与 DeepSeek 都获得绑定了正确 Provider 名称的 sink。
5. Renderer 测试断言 `MODEL_PROVIDER_INVALID_REQUEST` 显示新文案，其他供应商错误文案
   保持不变。
6. 运行聚焦测试、类型检查和完整测试；不运行真实图片生成。

## 风险与控制

- **供应商可能在本地超时后继续处理并计费。** 因此不自动重试，文案只建议用户稍后
  自主重试。
- **日志包含受限供应商标识。** 只允许既有解析器已约束的字段，禁止原始消息和任意
  metadata。
- **120 秒可能截断极慢但最终成功的请求。** 这是避免无限挂起的明确产品边界；当前
  正常成功样本约 11 秒，而诊断请求超过 150 秒没有响应。
- **日志文件增长。** 单文件上限 512 KiB，达到上限后覆盖，不保留滚动副本。

## 验收标准

1. 挂起的图片请求在 120 秒后返回 `MODEL_PROVIDER_TIMEOUT`。
2. 用户取消始终返回 `CANCELLED`。
3. 一次用户操作只产生一个图片 POST。
4. `1K / 16:9 / n=1` 请求结构保持不变。
5. HTTP 400 对应中文不再断言模型参数非法。
6. 诊断日志不含提示词、请求正文、API Key、原始错误消息或任意非白名单字段。
7. 所有聚焦测试、类型检查和完整测试通过。
