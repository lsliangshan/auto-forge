# Sora 2 Pro Reference Image Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 OpenAI: Sora 2 Pro 接受一张图片附件，并通过 OpenRouter `input_references` 真正提交图生视频请求。

**Architecture:** 在共享模型能力中增加可选的参考图数量上限；OpenRouter 目录解析仅为精确模型 ID `openai/sora-2-pro` 补充该能力。路由据此选择 `input_references` 模式，视频任务把模式传给 Provider，前端使用同一能力限制发送状态；已有 `frame_images` 路径保持不变。

**Tech Stack:** TypeScript、Zod、Vue 3、Pinia、Vitest、Vue Test Utils、Electron

## Global Constraints

- Sora 2 Pro 最多接受 1 张参考图。
- Sora 图片必须写入 OpenRouter `input_references`，不得伪造为 `frame_images`。
- `supported_frame_images: null` 仍解析为 `frameImages: []`。
- 只为精确模型 ID `openai/sora-2-pro` 增加已知参考图能力，不推断其他模型。
- 不向 OpenRouter 发起真实付费生成请求。
- 不改变已有首帧、尾帧和双帧视频模型行为。
- `maxReferenceImages` 缺省等同于 `0`，保持现有模型对象兼容。

---

### Task 1: 增加共享参考图能力并正确解析 Sora

**Files:**
- Modify: `packages/shared/src/desktop-api.ts:403-414`
- Test: `packages/shared/src/contracts.test.ts:271-312`
- Modify: `apps/desktop/electron/main/chat/model-provider.ts:594-641`
- Test: `apps/desktop/electron/main/chat/openrouter-provider.test.ts:1077-1110`

**Interfaces:**
- Consumes: OpenRouter 视频目录记录的 `id` 与 `supported_frame_images`。
- Produces: `ModelInfo['generation']['video']['maxReferenceImages']?: number`；Sora 解析结果为 `inputModalities: ['text', 'image']`、`frameImages: []`、`maxReferenceImages: 1`。

- [ ] **Step 1: 写共享契约和目录解析失败测试**

在 `packages/shared/src/contracts.test.ts` 的视频模型夹具加入字段并断言边界：

```ts
video: {
  resolutions: ['1080p'],
  aspectRatios: ['16:9'],
  durations: [4, 8],
  supportsAudio: true,
  frameImages: ['first_frame', 'last_frame'],
  maxReferenceImages: 1,
},
```

```ts
expect(video.generation.video?.maxReferenceImages).toBe(1)
expect(() => modelInfoSchema.parse({
  ...video,
  generation: {
    video: { ...video.generation.video!, maxReferenceImages: 0 },
  },
})).toThrow()
```

把 `apps/desktop/electron/main/chat/openrouter-provider.test.ts` 中 Sora 断言改为：

```ts
expect(models.find(({ id }) => id === 'openai/sora-2-pro')).toMatchObject({
  inputModalities: ['text', 'image'],
  outputModalities: ['video'],
  generation: {
    video: {
      supportsAudio: true,
      frameImages: [],
      maxReferenceImages: 1,
    },
  },
})
```

- [ ] **Step 2: 运行测试并确认 RED**

Run:

```bash
pnpm test -- packages/shared/src/contracts.test.ts -t "requires capability-rich model metadata"
pnpm --filter @autoforge/desktop exec node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts electron/main/chat/openrouter-provider.test.ts -t "parses nullable live video catalog fields"
```

Expected: 共享契约因严格 schema 不接受 `maxReferenceImages` 而失败；目录测试得到 Sora `inputModalities: ['text']` 且缺少 `maxReferenceImages`。

- [ ] **Step 3: 扩展共享模型 schema**

在 `packages/shared/src/desktop-api.ts` 的视频生成能力中加入：

```ts
maxReferenceImages: z.number().int().positive().optional(),
```

- [ ] **Step 4: 为精确 Sora ID 补充已知参考图能力**

在 `parseOpenRouterVideoModels()` 前增加：

```ts
const OPENROUTER_VIDEO_REFERENCE_IMAGE_LIMITS = new Map<string, number>([
  ['openai/sora-2-pro', 1],
])
```

解析单条模型时计算并写入能力：

```ts
const frameImages = videoFrameTypes(model.supported_frame_images ?? undefined)
const maxReferenceImages = OPENROUTER_VIDEO_REFERENCE_IMAGE_LIMITS.get(model.id)
const supportsImageInput = frameImages.length > 0 || maxReferenceImages !== undefined

const candidate: ModelInfo = {
  id: model.id,
  name: model.name,
  inputModalities: supportsImageInput ? ['text', 'image'] : ['text'],
  outputModalities: ['video'],
  supportsTools: false,
  generation: {
    video: {
      resolutions: sortedUniqueStrings(model.supported_resolutions ?? undefined),
      aspectRatios: sortedUniqueStrings(model.supported_aspect_ratios ?? undefined),
      durations: sortedUniquePositiveIntegers(model.supported_durations),
      supportsAudio: model.generate_audio === true,
      frameImages,
      ...(maxReferenceImages === undefined ? {} : { maxReferenceImages }),
    },
  },
}
```

合并重复视频记录时保留最大参考图上限：

```ts
const mergedMaxReferenceImages = Math.max(
  existingVideo.maxReferenceImages ?? 0,
  candidateVideo.maxReferenceImages ?? 0,
)
```

并在合并后的 `video` 对象中加入：

```ts
...(mergedMaxReferenceImages === 0
  ? {}
  : { maxReferenceImages: mergedMaxReferenceImages }),
```

- [ ] **Step 5: 运行 Task 1 测试并确认 GREEN**

Run:

```bash
pnpm test -- packages/shared/src/contracts.test.ts -t "requires capability-rich model metadata"
pnpm --filter @autoforge/desktop exec node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts electron/main/chat/openrouter-provider.test.ts -t "parses nullable live video catalog fields"
```

Expected: 两条命令均 PASS。

- [ ] **Step 6: 提交 Task 1**

```bash
git add packages/shared/src/desktop-api.ts packages/shared/src/contracts.test.ts apps/desktop/electron/main/chat/model-provider.ts apps/desktop/electron/main/chat/openrouter-provider.test.ts
git commit -m "feat: model Sora reference image capability"
```

---

### Task 2: 路由一张 Sora 参考图并拒绝超额附件

**Files:**
- Modify: `apps/desktop/electron/main/chat/multimodal-router.ts:30-41,89-113,167-180,315-332`
- Test: `apps/desktop/electron/main/chat/multimodal-router.test.ts:289-323`

**Interfaces:**
- Consumes: Task 1 的 `maxReferenceImages?: number`。
- Produces: `ResolvedChatRoute.videoUsesInputReferences?: boolean`；一张 Sora 图片路由成功并设置为 `true`，两张图片抛出 `MODEL_MODALITY_UNSUPPORTED`。

- [ ] **Step 1: 写路由失败测试**

在现有视频帧能力测试之后加入：

```ts
it('routes one reference image for Sora and rejects excess references', () => {
  const sora = model({
    id: 'openai/sora-2-pro',
    inputModalities: ['text', 'image'],
    outputModalities: ['video'],
    generation: {
      video: {
        resolutions: ['1080p'],
        aspectRatios: ['16:9'],
        durations: [8],
        supportsAudio: true,
        frameImages: [],
        maxReferenceImages: 1,
      },
    },
  })

  expect(resolveChatRoute(input({
    requestedModel: sora.id,
    requestedOutput: 'video',
    models: [sora],
    assets: [asset('image')],
  }))).toMatchObject({
    model: 'openai/sora-2-pro',
    videoFrameImages: [],
    videoUsesInputReferences: true,
  })

  expect(() => resolveChatRoute(input({
    requestedModel: sora.id,
    requestedOutput: 'video',
    models: [sora],
    assets: [asset('image', { id: 'first' }), asset('image', { id: 'second' })],
  }))).toThrow(expect.objectContaining({ code: 'MODEL_MODALITY_UNSUPPORTED' }))
})
```

- [ ] **Step 2: 运行路由测试并确认 RED**

Run:

```bash
pnpm --filter @autoforge/desktop exec node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts electron/main/chat/multimodal-router.test.ts -t "routes one reference image for Sora"
```

Expected: FAIL，当前 `supportsRequest()` 使用 `frameImages.length === 0` 拒绝 Sora 图片。

- [ ] **Step 3: 校验可选参考图能力并计算视频图片容量**

在 `isModel()` 的视频能力校验中加入：

```ts
&& (
  video.maxReferenceImages === undefined
  || (
    typeof video.maxReferenceImages === 'number'
    && Number.isSafeInteger(video.maxReferenceImages)
    && video.maxReferenceImages > 0
  )
)
```

增加辅助函数：

```ts
function videoImageCapacity(model: ModelInfo): number {
  const video = model.generation.video
  if (!video) return 0
  return Math.max(video.frameImages.length, video.maxReferenceImages ?? 0)
}
```

把 `supportsRequest()` 的视频数量判断改为：

```ts
if (output === 'video' && assets.length > videoImageCapacity(model)) return false
```

- [ ] **Step 4: 在路由结果中标记参考图线协议**

扩展接口：

```ts
videoUsesInputReferences?: boolean
```

在 `route()` 的视频字段中加入：

```ts
...(output === 'video' ? {
  videoFrameImages: model.generation.video!.frameImages.slice(),
  ...(input.assets.length > model.generation.video!.frameImages.length
    ? { videoUsesInputReferences: true }
    : {}),
} : {}),
```

- [ ] **Step 5: 运行路由测试并确认 GREEN**

Run:

```bash
pnpm --filter @autoforge/desktop exec node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts electron/main/chat/multimodal-router.test.ts
```

Expected: 路由测试文件全部 PASS。

- [ ] **Step 6: 提交 Task 2**

```bash
git add apps/desktop/electron/main/chat/multimodal-router.ts apps/desktop/electron/main/chat/multimodal-router.test.ts
git commit -m "feat: route Sora reference images"
```

---

### Task 3: 将参考图模式传递并生成 `input_references`

**Files:**
- Modify: `apps/desktop/electron/main/chat/model-provider.ts:80-87`
- Modify: `apps/desktop/electron/main/chat/video-job-runner.ts:321-339`
- Test: `apps/desktop/electron/main/chat/video-job-runner.test.ts:577-654`
- Modify: `apps/desktop/electron/main/chat/openrouter-provider.ts:111-122,349-376`
- Test: `apps/desktop/electron/main/chat/openrouter-provider.test.ts:478-539`

**Interfaces:**
- Consumes: Task 2 的 `videoUsesInputReferences?: boolean`。
- Produces: `ModelVideoRequest.useInputReferences?: boolean`；为 true 时 Provider 写 `input_references` 且不写 `frame_images`。

- [ ] **Step 1: 写 Provider 请求 JSON 失败测试**

在现有视频帧提交测试之前加入：

```ts
it('submits Sora images as input references instead of frame images', async () => {
  const bodies: string[] = []
  const provider = new OpenRouterProvider({
    credential,
    fetch: vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      bodies.push(String(init?.body))
      return Response.json({ id: 'job_sora', status: 'pending' }, { status: 202 })
    }),
  })

  await provider.submitVideo({
    model: 'openai/sora-2-pro',
    prompt: 'animate the reference',
    options: { durationSeconds: 8, resolution: '1080p', aspectRatio: '16:9', generateAudio: true },
    references: [{ mimeType: 'image/png', dataBase64: 'AQID' }],
    frameImages: [],
    useInputReferences: true,
  })

  expect(JSON.parse(bodies[0]!)).toMatchObject({
    model: 'openai/sora-2-pro',
    input_references: [{
      type: 'image_url',
      image_url: { url: 'data:image/png;base64,AQID' },
    }],
  })
  expect(JSON.parse(bodies[0]!)).not.toHaveProperty('frame_images')
})
```

- [ ] **Step 2: 修改任务执行器测试以要求模式透传**

在 `video-job-runner.test.ts` 的 `referencedRoute` 中加入：

```ts
videoFrameImages: [],
videoUsesInputReferences: true,
```

并把 Provider 调用断言改为：

```ts
expect(harness.provider.submitVideo).toHaveBeenCalledWith(expect.objectContaining({
  references: [{ mimeType: 'image/png', dataBase64: 'iVBORw0KGgo=' }],
  frameImages: [],
  useInputReferences: true,
}))
```

- [ ] **Step 3: 运行两个测试并确认 RED**

Run:

```bash
pnpm --filter @autoforge/desktop exec node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts electron/main/chat/openrouter-provider.test.ts -t "submits Sora images as input references"
pnpm --filter @autoforge/desktop exec node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts electron/main/chat/video-job-runner.test.ts -t "claims exact input assets"
```

Expected: Provider schema 拒绝未知 `useInputReferences`；任务执行器未传递该字段。

- [ ] **Step 4: 扩展内部视频请求接口和严格 schema**

在 `ModelVideoRequest` 加入：

```ts
useInputReferences?: boolean
```

在 `videoRequestSchema` 加入：

```ts
useInputReferences: z.boolean().optional(),
```

- [ ] **Step 5: 从视频任务传递路由模式**

在 `provider.submitVideo()` 参数中加入：

```ts
...(input.route.videoUsesInputReferences ? { useInputReferences: true } : {}),
```

- [ ] **Step 6: 根据模式生成互斥请求字段**

在 OpenRouter `submitVideo()` 请求工厂中替换帧构造：

```ts
const inputReferences = parsedRequest.useInputReferences
  ? wireReferences(parsedRequest.references)
  : []
const frameImages = parsedRequest.useInputReferences
  ? []
  : wireFrameImages(parsedRequest.references, parsedRequest.frameImages)
```

在请求 body 中加入并保留互斥条件：

```ts
...(inputReferences.length ? { input_references: inputReferences } : {}),
...(frameImages.length ? { frame_images: frameImages } : {}),
```

- [ ] **Step 7: 运行 Provider 和任务测试并确认 GREEN**

Run:

```bash
pnpm --filter @autoforge/desktop exec node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts electron/main/chat/openrouter-provider.test.ts
pnpm --filter @autoforge/desktop exec node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts electron/main/chat/video-job-runner.test.ts
```

Expected: 两个测试文件全部 PASS，原有 `frame_images` 断言不变。

- [ ] **Step 8: 提交 Task 3**

```bash
git add apps/desktop/electron/main/chat/model-provider.ts apps/desktop/electron/main/chat/video-job-runner.ts apps/desktop/electron/main/chat/video-job-runner.test.ts apps/desktop/electron/main/chat/openrouter-provider.ts apps/desktop/electron/main/chat/openrouter-provider.test.ts
git commit -m "feat: submit Sora input references"
```

---

### Task 4: 前端允许一张 Sora 参考图并阻止超额附件

**Files:**
- Modify: `apps/desktop/src/components/chat/ChatComposer.vue:379-395`
- Test: `apps/desktop/tests/components/chat.test.ts:2057-2100`

**Interfaces:**
- Consumes: Task 1 的 `maxReferenceImages?: number`。
- Produces: 一张 Sora 图片时无不兼容提示且发送可用；两张时保留模型、显示提示并禁用发送。

- [ ] **Step 1: 把现有 Sora 回归测试改为新期望**

把测试名改为：

```ts
it('keeps Sora selected and allows exactly one reference image', async () => {
```

Sora 能力设置改为：

```ts
sora.inputModalities = ['text', 'image']
sora.generation.video = {
  ...sora.generation.video!,
  frameImages: [],
  maxReferenceImages: 1,
}
```

一张附件后的断言改为：

```ts
expect(wrapper.get('[data-testid="model-select"]').element).toHaveProperty(
  'value',
  'openai/sora-2-pro',
)
expect(wrapper.find('[data-testid="model-attachment-incompatible"]').exists()).toBe(false)
expect(wrapper.get('[data-testid="send-message"]').attributes('disabled')).toBeUndefined()
```

随后加入第二张图片并断言限制：

```ts
store.draftsByConversation.conversation_1 = [
  mediaAsset('reference-one'),
  mediaAsset('reference-two'),
]
await wrapper.vm.$nextTick()

expect(wrapper.get('[data-testid="model-select"]').element).toHaveProperty(
  'value',
  'openai/sora-2-pro',
)
expect(wrapper.get('[data-testid="model-attachment-incompatible"]').text())
  .toContain('当前模型不支持已添加的附件')
expect(wrapper.get('[data-testid="send-message"]').attributes('disabled')).toBeDefined()
```

删除原测试中手动切换 HappyHorse 的断言。

- [ ] **Step 2: 运行组件测试并确认 RED**

Run:

```bash
pnpm --filter @autoforge/desktop exec node scripts/run-vitest-electron.mjs run --config vitest.config.ts tests/components/chat.test.ts -t "keeps Sora selected and allows exactly one reference image"
```

Expected: FAIL；当前组件只检查图片模态，不检查 Sora 的数量上限，因此两张图片仍可发送。

- [ ] **Step 3: 在当前请求兼容性中加入视频图片容量**

在 `modelSupportsRequest()` 的附件种类判断后加入：

```ts
if (output === 'video') {
  const video = model.generation.video
  const imageCapacity = Math.max(
    video?.frameImages.length ?? 0,
    video?.maxReferenceImages ?? 0,
  )
  if (chat.drafts.length > imageCapacity) return false
}
```

- [ ] **Step 4: 运行组件测试并确认 GREEN**

Run:

```bash
pnpm --filter @autoforge/desktop exec node scripts/run-vitest-electron.mjs run --config vitest.config.ts tests/components/chat.test.ts
```

Expected: 聊天组件测试文件全部 PASS。

- [ ] **Step 5: 提交 Task 4**

```bash
git add apps/desktop/src/components/chat/ChatComposer.vue apps/desktop/tests/components/chat.test.ts
git commit -m "fix: allow one Sora reference attachment"
```

---

### Task 5: 完整验证和范围检查

**Files:**
- Verify only: all files modified by Tasks 1-4

**Interfaces:**
- Consumes: Tasks 1-4 的最终提交。
- Produces: 可交付的已验证分支，不新增运行时代码。

- [ ] **Step 1: 运行桌面端类型检查**

```bash
pnpm --filter @autoforge/desktop typecheck
```

Expected: exit code 0，无 TypeScript 或 Vue 类型错误。

- [ ] **Step 2: 运行项目完整测试套件**

```bash
pnpm test
```

Expected: 所有测试文件和测试用例 PASS，0 failures。

- [ ] **Step 3: 检查空白、调试残留和改动范围**

```bash
git diff --check 6547f23..HEAD
rg -n "\[DEBUG-" packages/shared/src apps/desktop/src apps/desktop/electron/main || true
git status --short
git log -5 --oneline
```

Expected: 无空白错误、无调试日志、工作区没有本任务未提交修改。
