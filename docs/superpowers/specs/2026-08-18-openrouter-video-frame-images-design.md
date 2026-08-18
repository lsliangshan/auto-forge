# OpenRouter 图片转视频首帧契约修复设计

## 目标

修复 OpenRouter 视频请求把图片附件错误序列化为 `input_references` 的问题，使图片转视频按 OpenRouter 当前契约使用 `frame_images`。

## 已确认的数据流

- 视频模型目录只有在 `supported_frame_images` 非空时，才把 `image` 标记为该模型的输入模态。
- `VideoJobRunner` 将已验证的图片附件按用户顺序传给 `ModelVideoRequest.references`。
- 因此该接口中的视频图片不是风格参考图，而是有顺序的帧图片。

## 请求契约

- 无图片：不发送 `frame_images`，文本生成视频行为不变。
- 一张图片：发送为 `frame_type: "first_frame"`。
- 两张图片：第一张发送为 `first_frame`，第二张发送为 `last_frame`。
- 超过两张图片：在读取凭证和发送请求前以 `INVALID_INPUT` 拒绝，避免构造重复或含糊的帧类型。
- 视频请求不再发送 `input_references`。
- 图片仍使用已校验的 Data URL，不改变 MIME、Base64、认证、轮询或下载逻辑。

## 改动范围

- 修改 `apps/desktop/electron/main/chat/openrouter-provider.ts` 的视频请求校验和序列化。
- 修改 `apps/desktop/electron/main/chat/openrouter-provider.test.ts` 的请求体断言，并覆盖双帧和超限输入。
- 不修改 UI、路由、持久化、轮询、下载或供应商错误展示。

## 验证

1. 回归测试先断言单图使用 `frame_images` 并观察旧实现失败。
2. 实现最小序列化改动后，单图、双图和超限测试通过。
3. 运行 OpenRouter provider 测试文件和 Desktop Node TypeScript 类型检查。

## 风险控制

- 文本生成视频请求体保持不变。
- 限制两张图片与 OpenRouter 的 `first_frame` / `last_frame` 模型一致。
- 不引入模型 ID 特判，避免把 Veo 供应商规则泄漏到通用请求路径。
