# Sora 2 Pro 参考图支持

## 背景

聊天页选择“视频 / OpenAI: Sora 2 Pro”并添加图片后，模型保持不变，但页面显示“当前模型不支持已添加的附件”且无法发送。

OpenAI 官方模型说明将 Sora 2 Pro 标为支持图片输入，OpenRouter 的模型页和视频生成公告也声明支持 image-to-video。然而，OpenRouter 实时 `/api/v1/videos/models` 目录对 `openai/sora-2-pro` 返回 `supported_frame_images: null`。当前应用把该字段直接解释为不支持任何图片，造成能力误判。

参考资料：

- https://developers.openai.com/api/docs/models/sora-2-pro
- https://platform.openai.com/docs/api-reference/videos
- https://openrouter.ai/openai/sora-2-pro/api
- https://openrouter.ai/docs/cookbook/video-generation/reference-to-video

## 目标

- Sora 2 Pro 添加一张图片后仍保持选中。
- 页面不显示附件不兼容提示，填写提示词后可以发送。
- 图片通过 OpenRouter 视频 API 的 `input_references` 字段提交，真正参与图生视频。
- Sora 2 Pro 最多接受一张参考图；超过能力时仍在发送前阻止请求。
- 不改变已有 `frame_images` 模型的首帧、尾帧和双帧行为。

## 非目标

- 不向 OpenRouter 发起真实付费生成以验证输出质量。
- 不根据模型描述文本动态推断能力。
- 不为其他 `supported_frame_images: null` 的视频模型自动开放图片附件。
- 不增加参考图用途选择、排序或多图 UI。

## 能力契约

在 `ModelInfo.generation.video` 增加可选字段：

```ts
maxReferenceImages?: number
```

字段缺省等同于 `0`，表示不支持 `input_references`。使用可选字段可以保持已有模型对象和测试夹具兼容。

OpenRouter 专用目录解析维护一个按精确模型 ID 匹配的已知参考图能力表：

```ts
openai/sora-2-pro -> 1
```

Sora 的 `supported_frame_images` 仍保持为空，不伪造首帧或尾帧能力。解析后的 Sora 模型同时声明 `inputModalities` 包含 `image`，并设置 `maxReferenceImages: 1`。

## 路由

视频请求的图片数量上限取以下两类能力中较大的一个：

- `frameImages.length`
- `maxReferenceImages ?? 0`

路由根据实际附件和模型能力选择唯一模式：

- 有图片且 `frameImages.length` 足以容纳附件时，沿用 `frame_images`。
- 否则，有图片且 `maxReferenceImages` 足以容纳附件时，选择 `input_references`。
- 两种能力都不足时返回 `MODEL_MODALITY_UNSUPPORTED`。
- 无图片时不设置图片输入模式。

解析结果增加可选布尔字段 `videoUsesInputReferences`，供视频任务执行器传递给 Provider。它只描述本次请求的线协议选择，不修改会话偏好或持久化生成参数。

## Provider 请求

`ModelVideoRequest` 增加可选布尔字段 `useInputReferences`。

OpenRouter Provider 的请求构造规则：

- `useInputReferences === true`：把图片编码为现有 `image_url` 数据结构，写入 `input_references`，不写 `frame_images`。
- 其他情况：保持现有 `wireFrameImages()` 和 `frame_images` 行为。
- 参考图数量在路由层受模型能力限制；Provider 仍通过请求 schema 和已有输入大小约束做结构校验。

## 前端行为

`ChatComposer.vue` 的当前请求兼容性检查加入视频图片数量判断：允许的图片数取 `frameImages.length` 与 `maxReferenceImages ?? 0` 的较大值。

因此：

- Sora 2 Pro 加一张图片：模型保持 Sora，无不兼容提示，可发送。
- Sora 2 Pro 加两张图片：模型仍保持 Sora，显示不兼容提示并禁用发送。
- 用户可移除多余附件或手动切换到兼容模型。

## 测试

采用测试优先方式覆盖四个真实边界：

1. 目录解析：实时形状中 `supported_frame_images: null` 的 Sora 仍解析为图片输入、`frameImages: []`、`maxReferenceImages: 1`。
2. 路由：Sora 接受一张图片并设置 `videoUsesInputReferences: true`；两张图片被拒绝。
3. Provider：参考图请求 JSON 含 `input_references` 且不含 `frame_images`；原有 frame 测试保持通过。
4. 组件：选择 Sora 后添加一张图片不再出现不兼容提示，发送按钮保持可用；两张图片仍不可发送。

先逐项运行新增测试并确认在当前实现上失败，再实施最小代码修改。完成后运行相关单元测试、组件测试、桌面端类型检查和项目完整测试套件。

## 风险与控制

OpenRouter 当前结构化视频目录未提供统一的参考图能力字段，因此 Sora 能力必须通过精确 ID 的已知表补足。该表只包含有官方资料佐证的 `openai/sora-2-pro`，避免把能力错误扩散到其他模型。若 OpenRouter 后续增加结构化参考图字段，应优先迁移到上游字段并删除该覆盖。
