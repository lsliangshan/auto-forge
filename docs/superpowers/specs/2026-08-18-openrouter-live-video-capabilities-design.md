# OpenRouter 实时视频能力与尾帧映射设计

## 目标

在聊天区切换 OpenRouter 模型时强制刷新模型目录，并使用最新能力控制视频时长、分辨率、画幅和伴随音频控件。视频模型同时支持首帧和尾帧且用户只上传一张图片时，只把该图片作为尾帧发送。

## 范围与职责

- Shared：定义刷新参数和视频帧能力契约。
- Main：按需绕过模型目录缓存，解析并保留 OpenRouter 的帧能力。
- 路由与视频任务：校验图片数量并把模型帧能力传给供应商适配器。
- Renderer：模型变化时请求刷新，用最新能力归一化参数并隐藏不支持的控件。
- 不修改数据库结构、视频任务持久化格式或下载流程。

## 接口契约

### 模型目录

调用方是 Renderer 的 settings store。

```ts
listProviderModels(provider: ModelProviderId, refresh?: boolean): Promise<ModelInfo[]>
```

- `provider` 必填。
- `refresh` 可选，默认 `false`。
- `false`：复用 Main 中已有的同供应商模型目录 Promise。
- `true`：创建新的供应商目录请求并替换缓存；ChatComposer 仅在当前供应商为 OpenRouter 且模型 ID 发生变化时使用。
- 返回完整 `ModelInfo[]`，不是单模型局部响应，因为 OpenRouter 的通用、图片和视频目录需要按模型 ID 合并。
- 凭证不足、权限不足、网络失败和响应非法继续使用现有安全 AppError。
- 刷新失败不清空 Renderer 已有目录。

### 视频帧能力

Shared 增加：

```ts
type VideoFrameType = 'first_frame' | 'last_frame'

generation.video.frameImages: VideoFrameType[]
```

`parseOpenRouterVideoModels` 只保留这两个已知值，去重后按 `first_frame`、`last_frame` 的稳定顺序输出。通用模型合并时取能力并集。

## 数据流

### 切换模型

1. 用户在 ChatComposer 选择与当前不同的模型。
2. ChatView 调用 settings store 的强制刷新动作。
3. Preload 通过带 `refresh: true` 的既有模型列表 IPC 请求 Main。
4. Main 请求 OpenRouter 最新模型目录，合并能力并原子替换该供应商缓存。
5. Renderer 用返回目录重新寻找目标模型；目标模型已下架或不再兼容时，回退到第一个兼容模型。
6. 用最新能力归一化当前生成参数后，只持久化一次模型与参数偏好。

刷新期间禁用模型选择和生成参数控件，避免并发切换。刷新成功后：

- `durations` 为空时不显示时长选择。
- `resolutions` 为空时不显示分辨率选择。
- `aspectRatios` 为空时不显示画幅选择。
- `supportsAudio` 为 `false` 时不显示伴随音频，并把已保存值归一化为 `false`。
- 当前值不在最新数组中时选择数组第一项。

### 刷新失败

- settings store 保留旧的 `providerModels`。
- ChatComposer 使用旧目录完成本次模型选择和参数归一化。
- ChatView 显示 settings store 已有的“模型列表加载失败”安全错误。
- 用户仍可使用缓存能力继续发送。

## 帧映射规则

模型路由根据 `generation.video.frameImages` 校验图片数量，超过模型可表达的帧数时判定模型不兼容。

OpenRouter 请求映射如下：

| 模型能力 | 图片数量 | 请求结果 |
| --- | ---: | --- |
| `first_frame` + `last_frame` | 1 | 该图仅作为 `last_frame` |
| `first_frame` + `last_frame` | 2 | 第一张为 `first_frame`，第二张为 `last_frame` |
| 仅 `first_frame` | 1 | 该图为 `first_frame` |
| 仅 `last_frame` | 1 | 该图为 `last_frame` |
| 任意能力 | 0 | 不发送 `frame_images` |
| 能力为空或图片数超限 | 大于 0 | 发送供应商请求前拒绝 |

不发送 `input_references`，也不按 Veo 或其他模型 ID 写特判。

## 缓存并发

强制刷新创建新的缓存 Promise。旧请求后续失败时，只有它仍是当前缓存值才允许删除缓存，避免旧失败清掉新目录。聊天发送继续读取同一缓存，因此刷新成功后的 UI 能力和 Main 路由能力一致。

## 预计改动

- `packages/shared/src/desktop-api.ts` 与契约测试。
- `apps/desktop/electron/preload/bridge.ts` 与桥接测试。
- `apps/desktop/electron/main/ipc/register-ipc.ts` 与 IPC 测试。
- `apps/desktop/electron/main/application.ts` 与应用测试。
- `apps/desktop/electron/main/chat/model-provider.ts`、`multimodal-router.ts`、`video-job-runner.ts`、`openrouter-provider.ts` 及对应测试。
- `apps/desktop/src/stores/settings.ts`、`views/ChatView.vue`、`components/chat/ChatComposer.vue` 及组件测试。

## 验证

1. TDD 验证单图双帧能力只产生尾帧，两图产生首尾帧。
2. 验证精确帧能力从 OpenRouter 目录传到最终请求，图片超限在网络请求前失败。
3. 验证模型切换触发一次强制刷新，刷新后控件选项和偏好被归一化。
4. 验证刷新失败保留旧目录、显示错误且仍可选择模型。
5. 运行相关定向测试、Desktop 类型检查和完整测试套件。

## 风险控制

- 初始加载和聊天发送仍可复用缓存，不增加每次发送的目录请求。
- 仅模型 ID 真正变化时刷新，避免同值选择造成网络调用。
- 不记录或展示 OpenRouter 原始响应体。
- 所有新增 IPC 输入继续经过严格 Zod 校验。
