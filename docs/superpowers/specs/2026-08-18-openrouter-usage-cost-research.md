# OpenRouter 用量与消费核算研究

## 研究范围与结论

本文只核对 OpenRouter 官方文档、官方 API 参考和官方 OpenAPI schema，回答两个问题：

1. 能否根据 App 记录的用量计算用户通过 OpenRouter 产生的总消费；
2. 文本、图片、音频、视频模型的计费口径是否一致。

结论：**可以精确累计，但前提是 App 持久化每次 OpenRouter 请求最终返回的实际费用字段。只保存输入、输出 Token 和模型 ID，无法普遍、精确地还原历史消费。**

- Chat/Responses/Image/STT 等响应中的 `usage.cost` 是该次请求实际计入 OpenRouter 账户的费用；OpenRouter 的基础币种是美元，站点和 API 价格均以美元表示。非流式响应直接读取；流式响应只在最后一个 SSE 消息中读取一次。[Usage Accounting](https://openrouter.ai/docs/cookbook/administration/usage-accounting)；[OpenRouter FAQ](https://openrouter.ai/docs/faq)
- 若 App 保存了 OpenRouter generation id 而没有保存费用，可调用 `GET /api/v1/generation?id=...` 回查。该接口给出 `total_cost`（USD）、`usage`（USD）、实际 `provider_name`、Token 和媒体计数等元数据。[Get a Generation](https://openrouter.ai/docs/api/api-reference/generations/get-generation)
- 因而，本地“某用户的 OpenRouter 推理消费”应按请求去重后计算：`sum(actual_cost)`。`actual_cost` 优先取该请求响应的 `usage.cost`；若缺失但有 generation id，则回查该 generation 的 `total_cost`。不能同时把 `usage.cost`、`total_cost`、`usage` 相加，它们是在不同响应形态中表达同一次 generation 的费用，不是三个附加收费项。[Usage Accounting](https://openrouter.ai/docs/cookbook/administration/usage-accounting)；[Get a Generation](https://openrouter.ai/docs/api/api-reference/generations/get-generation)
- **仅有 `prompt_tokens`、`completion_tokens` 和模型 ID 时，最多做估算。** OpenRouter 明确存在按请求、图片、推理 Token、缓存、音频、Web 搜索等计费项；同一模型还可能路由到不同 provider endpoint，并应用长上下文或时段价格覆盖。[OpenRouter FAQ](https://openrouter.ai/docs/faq)；[Provider Routing](https://openrouter.ai/docs/guides/routing/provider-selection)；[官方 OpenAPI schema](https://openrouter.ai/openapi.json)

这里的“推理消费”不等于用户实际充值现金支出：购买 OpenRouter credits 另有充值手续费；BYOK 还会在上游 provider 账户产生账单，详见“BYOK 与展示口径”。[OpenRouter FAQ](https://openrouter.ai/docs/faq)

## 一、字段之间的准确关系

### `usage.cost`：优先持久化的最终费用

OpenRouter 的 Usage Accounting 文档将 `usage.cost` 定义为“向账户收取的总金额”，并说明每个响应会自动包含 usage；流式请求只在最后一个 SSE chunk 返回最终 usage。该费用已经过 OpenRouter 实际路由和计费，不需要 App 再用 Token 乘价格。[Usage Accounting](https://openrouter.ai/docs/cookbook/administration/usage-accounting)

官方 schema 允许部分接口的 `cost` 为 `null`，所以 App 不应把缺失费用静默当作 `0`。缺失时应保存 generation id，稍后用 generation API 回查；仍无法获得时应标记“费用未知”，否则累计值会被低估。[官方 OpenAPI schema：`ChatUsage`、`Usage`、`ImageGenerationUsage`](https://openrouter.ai/openapi.json)；[Get a Generation](https://openrouter.ai/docs/api/api-reference/generations/get-generation)

### `usage.cost_details`：上游成本，不是各模态消费明细

当前 Chat schema 的 `cost_details` 包含：

- `upstream_inference_cost`：上游 provider 的总推理成本，可为 `null`；
- `upstream_inference_prompt_cost`：上游输入成本；
- `upstream_inference_completions_cost`：上游输出成本。

Responses 风格 schema 使用对应的 `upstream_inference_input_cost` 与 `upstream_inference_output_cost`。官方 Usage Accounting 也明确把它描述为 upstream provider cost。因此：

- 用户在 OpenRouter credits 上实际被扣多少，以 `usage.cost` 为准；
- `cost_details` 可用于解释上游成本或 BYOK，但不能当成另一个费用再加到非 BYOK 的 `usage.cost` 上；
- 它也不是图片、音频、视频、缓存、工具调用等所有收费项的完整拆分。

[Usage Accounting](https://openrouter.ai/docs/cookbook/administration/usage-accounting)；[官方 OpenAPI schema：`CostDetails`、`Usage`](https://openrouter.ai/openapi.json)

### Prompt、completion 与模态 Token

Chat Completions 的标准字段是：

- `prompt_tokens`：总输入 Token；
- `completion_tokens`：总输出 Token；
- `total_tokens`：输入与输出合计；
- `prompt_tokens_details.cached_tokens`：缓存命中的输入 Token；
- `prompt_tokens_details.cache_write_tokens`：写入缓存的 Token；
- `prompt_tokens_details.audio_tokens`：输入音频 Token；
- `prompt_tokens_details.video_tokens`：输入视频 Token；
- `completion_tokens_details.reasoning_tokens`：推理 Token；
- `completion_tokens_details.audio_tokens`：输出音频 Token。

这些 detail 字段通常是 prompt/completion 总量中的细分，不能在 `total_tokens` 之外再次相加。OpenRouter 的 Activity 文档明确说明 reasoning tokens 已包含在 completion tokens 中用于计费。[官方 OpenAPI schema：`ChatUsage`](https://openrouter.ai/openapi.json)；[Activity Export](https://openrouter.ai/docs/cookbook/administration/activity-export)

Generation API 还提供：

- `native_tokens_prompt`、`native_tokens_completion`、`native_tokens_reasoning`、`native_tokens_cached`：上游 provider/native tokenizer 报告的 Token；
- `native_tokens_completion_images`：输出图片 Token；
- `num_input_audio_prompt`：输入音频项数量；
- `num_media_prompt`、`num_media_completion`：输入/输出媒体项数量。

其中 `num_*` 是媒体数量元数据，不等于价格单位；不能看到一张图片或一段音频就默认乘固定价格。具体计费单位必须以该次 endpoint 的定价或最终 `cost` 为准。[Get a Generation](https://openrouter.ai/docs/api/api-reference/generations/get-generation)；[官方 OpenAPI schema：`GenerationResponse`](https://openrouter.ai/openapi.json)

## 二、不同模态的计费方式

### 文本与一般 Chat Completions

纯文本模型通常分别按输入和输出 Token 计费。模型目录的 `pricing.prompt` 与 `pricing.completion` 是**每 Token美元价**，不是每百万 Token 价；UI 常将它乘以一百万后显示为 `$/M tokens`。[List Models](https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties)；[官方 OpenAPI schema：`PublicPricing`](https://openrouter.ai/openapi.json)

在没有缓存、推理特殊价、请求费、工具费、价格覆盖，且能确定实际 provider endpoint 和请求时价格时，纯文本估算才可简化为：

```text
estimated_cost = prompt_tokens * prompt_price_per_token
               + completion_tokens * completion_price_per_token
```

一旦存在缓存读写、单独 reasoning 价格、长上下文阶梯价、时段价、每请求收费或 Web 搜索，上述式子不再完整。官方 `PublicPricing` 还定义了 `input_cache_read`、`input_cache_write`、`input_cache_write_1h`、`internal_reasoning`、`request`、`web_search`，并允许 `overrides` 根据 prompt 长度或 UTC 时段改价。[官方 OpenAPI schema：`PublicPricing`、`PricingOverride`](https://openrouter.ai/openapi.json)

### 图片输入与图片生成

图片没有统一的“每张固定价”：

- 多模态图片输入可能按图片计费，也可能被转换成输入 Token；通用模型 pricing 中的 `image` 表示每张输入图片美元价，`image_token` 表示每图片 Token 美元价。[Multimodal Overview](https://openrouter.ai/docs/guides/overview/multimodal/overview)；[官方 OpenAPI schema：`PublicPricing`](https://openrouter.ai/openapi.json)
- 专用 Image API 的 provider endpoint 定价由多条 pricing line 表达。`billable` 可为 `output_image`、`input_image`、`input_reference`、`input_text` 等；`unit` 可为 `image`、`megapixel` 或 `token`，还可能带分辨率 variant。因此图片数量、像素、参考图和分辨率都会改变费用。[Image Generation](https://openrouter.ai/docs/guides/overview/multimodal/image-generation)
- Image API 响应可能返回 `prompt_tokens`、`completion_tokens`、`completion_tokens_details.image_tokens` 和 `cost`，但文档只承诺“when available”。精确累计仍应使用 `usage.cost`，而不是假设所有图片模型都按 completion Token 结算。[Image Generation](https://openrouter.ai/docs/guides/overview/multimodal/image-generation)；[官方 OpenAPI schema：`ImageGenerationUsage`](https://openrouter.ai/openapi.json)

### 音频输入、STT、音频输出与 TTS

音频至少有三种不同计费路径：

- Chat Completions 音频输入/输出：usage 可在 prompt/completion details 中给出 `audio_tokens`；模型 pricing 的 `audio` 是每输入音频 Token 美元价，`audio_output` 是每输出音频 Token 美元价，缓存音频还有 `input_audio_cache`。[Audio](https://openrouter.ai/docs/guides/overview/multimodal/audio)；[官方 OpenAPI schema：`ChatUsage`、`PublicPricing`](https://openrouter.ai/openapi.json)
- Speech-to-Text：provider 可能按音频秒数，也可能按输入/输出 Token。STT 响应同时提供 `seconds`、`input_tokens`、`output_tokens`、`total_tokens` 和实际 `cost`。[Speech-to-Text](https://openrouter.ai/docs/guides/overview/multimodal/stt)
- Text-to-Speech：官方文档说明按输入文本字符数计费，费率随模型/provider 变化。TTS 正文响应是原始音频流，不带 JSON usage，但响应头包含 `X-Generation-Id`，可用于 generation API 回查费用。[Text-to-Speech](https://openrouter.ai/docs/guides/overview/multimodal/tts)；[Get a Generation](https://openrouter.ai/docs/api/api-reference/generations/get-generation)

因此只保存“音频模型的 input/output Token”不足以覆盖按秒和按字符的调用，也不能从音频文件数量推出费用。

### 视频输入与视频生成

视频理解和视频生成是两类不同计费路径：

- Chat Completions 的视频输入通常基于时长和分辨率转换为输入 Token，usage schema 可在 `prompt_tokens_details.video_tokens` 中给出视频输入 Token。[Multimodal Overview](https://openrouter.ai/docs/guides/overview/multimodal/overview)；[官方 OpenAPI schema：`ChatUsage`](https://openrouter.ai/openapi.json)
- 专用 Video Generation API 是异步任务。模型目录提供 `pricing_skus`，官方示例包含 `per-video-second` 与 `per-video-second-1080p`，说明时长、分辨率以及是否生成伴随音频都可能影响费用；SKU 是开放字符串映射，不能假定所有视频模型共享一个公式。[Video Generation](https://openrouter.ai/docs/guides/overview/multimodal/video-generation)；[官方 OpenAPI schema：`VideoModel`](https://openrouter.ai/openapi.json)
- 视频任务提交时只有 job id；任务完成后的轮询结果或 webhook 才有 `usage.cost` 与 `is_byok`。因此 App 应在终态更新费用，不能在提交成功时仅凭 prompt Token 记账。[Video Generation](https://openrouter.ai/docs/guides/overview/multimodal/video-generation)；[官方 OpenAPI schema：`VideoGenerationUsage`](https://openrouter.ai/openapi.json)

## 三、为什么用“当前模型价格 × 历史 Token”不能精确还原

### 实际 provider endpoint 会变化

同一个模型可由多个 provider endpoint 提供。OpenRouter 默认在健康 provider 中优先低价候选并按价格加权，同时允许 fallback；用户也可按价格、吞吐、延迟或指定 provider 改变路由。Generation API 的 `provider_name` 才是实际承载方。[Provider Routing](https://openrouter.ai/docs/guides/routing/provider-selection)；[Get a Generation](https://openrouter.ai/docs/api/api-reference/generations/get-generation)

图片 API 更明确说明每个模型可由多个 provider 提供，并要求查询 per-endpoint records 才能获得最终能力和价格。由此可知，仅保存模型 ID 不足以确定某次请求应用了哪个 endpoint 的价格。[Image Generation](https://openrouter.ai/docs/guides/overview/multimodal/image-generation)

### 当前目录不是历史价格表

模型和 endpoint API 返回当前可用模型、当前 endpoint 与当前 pricing；schema 没有“该价格的历史生效区间”或按请求时间查询历史价格的参数。**这是由官方 API 契约得出的推论**：事后用今天的 `/models` 或 `/endpoints` 响应重算旧请求，无法证明与请求发生时价格一致。[List Models](https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties)；[List Endpoints](https://openrouter.ai/docs/api/api-reference/endpoints/list-endpoints)；[官方 OpenAPI schema](https://openrouter.ai/openapi.json)

### 计费组件不止 prompt/completion

缓存读写、内部 reasoning、图片/音频、按请求、Web 搜索、PDF/OCR、长上下文或时段覆盖都可能改变最终费用。即使总 Token 相同，不同 Token 组成和附加服务也可能产生不同费用。[官方 OpenAPI schema：`PublicPricing`、`PricingOverride`](https://openrouter.ai/openapi.json)；[Prompt Caching](https://openrouter.ai/docs/guides/best-practices/prompt-caching)；[OpenRouter FAQ](https://openrouter.ai/docs/faq)

## 四、BYOK 与“总消费”展示口径

OpenRouter 的 `usage.is_byok` 标识是否使用用户自带 provider key。BYOK 时存在两部分经济成本：

1. OpenRouter credits 的平台费用，以响应 `usage.cost` 为准；
2. 上游 provider 直接向用户结算的推理费用，可参考 `cost_details.upstream_inference_cost`，但最终应以上游 provider 账单为准。

OpenRouter Activity 对 BYOK spend 的说明明确称其为按 provider 市场价估算，可能不包含用户与 provider 的折扣。因此产品应至少分开展示：

- `OpenRouter credits 消费`：所有请求的 `usage.cost` 之和；
- `BYOK 上游费用`：标记为估算，或接入上游账单后再称“实际”；
- `推理经济总成本`：非 BYOK 的 OpenRouter credits 费用，加 BYOK 平台费，再加 BYOK 上游实际/估算费用；不得把非 BYOK 的 upstream cost 再次相加。

[Activity Export](https://openrouter.ai/docs/cookbook/administration/activity-export)；[OpenRouter FAQ](https://openrouter.ai/docs/faq)

## 五、建议的 App 持久化与聚合口径

### 每次 OpenRouter 请求至少保存

| 字段 | 用途 |
| --- | --- |
| 本地用户 ID | 将调用归属到 App 用户；不要只依赖本机全局聚合 |
| OpenRouter generation id / video job id | 去重、回查、审计 |
| 请求时间、终态 | 期间统计；异步视频在终态补齐费用 |
| 请求模型 ID、实际 provider name | 解释路由与价格差异 |
| `is_byok` | 区分 OpenRouter credits 和 BYOK 上游成本 |
| `usage.cost` / generation `total_cost` | 用户 OpenRouter credits 实际消费；缺失应为 unknown，不是 0 |
| `cost_details.upstream_inference_cost` | BYOK/成本分析；非 BYOK 不叠加到用户消费 |
| prompt/completion/total Token 及 details | 用量解释、图表和成本归因，不作为最终费用真值 |
| 媒体数量、秒数、分辨率/variant/SKU | 解释图片、音频、视频账单 |

OpenRouter 还支持在请求中传 `user` 做终端用户跟踪，但本地仍需把 App 用户与 generation id 持久化关联，才能保证本地账单的归属和去重。[Enterprise Quickstart：User Tracking](https://openrouter.ai/docs/cookbook/get-started/enterprise-quickstart)

### 聚合规则

```text
openrouter_credit_spend(user, period)
  = SUM(one actual_cost per unique OpenRouter generation)
```

- 流式响应只处理最后一个带 usage 的 chunk；
- 同一 generation 只计一次；
- 视频等异步任务在 `completed` 后读取 `usage.cost`；失败任务若 generation API 返回非零费用，也应按实际费用计入，而不是只按成功状态过滤；
- `cost = null/undefined` 代表未知，不能转成 `0`；
- 金额存储建议使用十进制定点或最小精度整数，不使用二进制浮点直接做长期累计；
- 可用 OpenRouter Activity 的 Spend 或 `GET /api/v1/credits` 返回的累计 `total_usage` 做账户级对账，但账户级数值可能包含该 API key/App 之外的调用，不能直接替代 App 用户分摊。[Activity Export](https://openrouter.ai/docs/cookbook/administration/activity-export)；[Get Remaining Credits](https://openrouter.ai/docs/api/api-reference/credits/get-credits)

## 六、对当前问题的最小可验证结论

1. **如果 App 目前只记录 `input_tokens`、`output_tokens` 和 `model`：不能精确计算 OpenRouter 总消费。** 对纯文本、无缓存、无附加项且价格与 endpoint 已知的请求，只能做估算。
2. **如果 App 同时保存每次响应的 `usage.cost`：可以按用户、月份、模型等维度精确汇总 OpenRouter credits 推理消费。**
3. **如果没有 cost、但保存了 generation id：可以通过官方 generation API 补齐。**
4. **text/image/audio/video 的计费方式确实不同，而且同一模态内部也不统一。** 计费单位可能是 Token、请求、图片、兆像素、字符、音频秒、视频秒、分辨率 SKU 或这些项的组合。
5. **产品展示应把“Token 用量”和“美元消费”作为两套指标。** Token 适合容量与使用趋势；实际消费必须来自 OpenRouter 返回的费用字段。

## 官方来源索引

- [Usage Accounting](https://openrouter.ai/docs/cookbook/administration/usage-accounting)
- [Get a Generation](https://openrouter.ai/docs/api/api-reference/generations/get-generation)
- [OpenRouter OpenAPI schema](https://openrouter.ai/openapi.json)
- [Models API](https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties)
- [Provider Routing](https://openrouter.ai/docs/guides/routing/provider-selection)
- [Image Generation](https://openrouter.ai/docs/guides/overview/multimodal/image-generation)
- [Audio](https://openrouter.ai/docs/guides/overview/multimodal/audio)
- [Speech-to-Text](https://openrouter.ai/docs/guides/overview/multimodal/stt)
- [Text-to-Speech](https://openrouter.ai/docs/guides/overview/multimodal/tts)
- [Video Generation](https://openrouter.ai/docs/guides/overview/multimodal/video-generation)
- [Activity Export](https://openrouter.ai/docs/cookbook/administration/activity-export)
- [OpenRouter FAQ](https://openrouter.ai/docs/faq)
