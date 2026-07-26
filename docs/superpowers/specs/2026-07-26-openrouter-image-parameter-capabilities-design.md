# OpenRouter 图片参数能力修复设计

日期：2026-07-26

## 背景与根因

一次真实图片生成使用 `black-forest-labs/flux.2-flex`，本地运行记录以
`MODEL_PROVIDER_REQUEST_FAILED` 结束，没有 `generation_id`、token 或费用记录。

OpenRouter 图片模型目录显示，FLUX.2 Flex 支持：

- `aspect_ratio`
- `output_format`
- `n`
- `input_references`
- `seed`

其端点没有声明 `resolution`。OpenRouter 的能力契约规定，未声明的请求参数表示端点
不支持。当前 AutoForge 虽然把缺失的 `resolution` 解析为空能力数组，但路由仍保留
用户默认值 `1K`，OpenRouter Provider 又无条件把它序列化成
`resolution: "1K"`。因此请求体超出了所选模型声明的参数集合。

## 目标

图片生成请求只向 OpenRouter 发送所选模型明确支持的可选字段，同时保留现有 UI
偏好、模型选择、安全边界和一次性付费请求语义。

成功标准：

1. FLUX.2 Flex 请求不包含 `resolution`。
2. FLUX.2 Flex 请求仍包含受支持的 `aspect_ratio` 和 `output_format`。
3. 声明支持 `resolution` 的模型仍能收到用户选择的分辨率。
4. 未声明 `output_format` 的模型不再收到该字段。
5. 图片 POST 仍严格执行一次，不因失败自动重试。

## 方案

### 路由层

`resolveChatRoute` 在选定图片模型时，从该模型的 `generation.image` 能力生成明确的
图片参数支持信息：

```ts
{
  resolution: boolean
  aspectRatio: boolean
  outputFormat: boolean
}
```

判断规则只依赖目录中的非空能力数组。路由继续保留完整的用户生成偏好；支持信息只
决定哪些字段可以进入供应商请求，不改变设置页面或会话偏好的持久化格式。

### 编排层

`MediaGenerationOrchestrator` 将路由提供的图片参数支持信息与已规范化的图片选项一起
传给 `ModelProvider.generateImage`。该信息是显式参数，不依赖 Provider 曾经调用过
`listModels`，避免隐藏缓存和调用顺序耦合。

### OpenRouter Provider

Provider 始终发送必需字段：

- `model`
- `prompt`
- `n: 1`

可选字段按能力发送：

- 支持 `resolution` 时发送 `resolution`
- 支持 `aspect_ratio` 且值不是 `auto` 时发送 `aspect_ratio`
- 支持 `output_format` 时发送 `output_format`
- 有参考图时继续发送 `input_references`

图片生成 POST 的 `retry: "never"` 保持不变。

## 错误与安全边界

- API Key 继续只存在 Electron Main 的 `SecretStore`/`safeStorage` 中。
- Renderer 不接收 API Key、请求体或供应商原始错误正文。
- 本修复不放宽模型能力校验，不新增前端兜底模型。
- 本修复不自动重新执行已经失败的真实请求。

## 测试设计

按 TDD 顺序添加回归：

1. 路由测试：FLUX 风格能力得到
   `resolution: false`、`aspectRatio: true`、`outputFormat: true`。
2. Provider 测试：FLUX 请求体没有 `resolution`，但保留
   `aspect_ratio` 和 `output_format`；旧实现应在此失败。
3. Provider 测试：Nano Banana 风格能力保留 `resolution`，并省略未声明的
   `output_format`。
4. 编排测试：路由能力信息原样传递给 Provider。
5. 运行图片 Provider、路由、编排聚焦测试，再运行完整测试、类型检查和构建。

真实付费请求不属于自动测试；如需修复后再次调用 FLUX，必须获得新的明确授权。

## 非目标

- 不修改音频或视频参数协议。
- 不硬编码 FLUX 模型 ID。
- 不增加 Provider 内模型目录缓存。
- 不改变设置页面布局、默认模型或本地数据库 Schema。
- 不把供应商原始响应正文显示给 Renderer。
