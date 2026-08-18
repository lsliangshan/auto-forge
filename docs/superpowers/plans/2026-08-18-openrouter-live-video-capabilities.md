# OpenRouter Live Video Capabilities Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refresh OpenRouter model capabilities when the user changes models, hide unsupported video options, and map a single image to only the last frame when the model supports both frame types.

**Architecture:** Preserve exact frame support in `ModelInfo`, carry it through route resolution into the OpenRouter wire adapter, and add an explicit cache-bypassing flag to the existing provider-model IPC. The renderer refreshes only on an actual OpenRouter model change, retains cached models on failure, and normalizes preferences from the returned capability snapshot.

**Tech Stack:** TypeScript 6, Vue 3, Pinia, Zod, Electron IPC, Vitest.

## Global Constraints

- Do not add model-ID-specific behavior.
- Do not modify database schemas, persisted video job parameters, polling, or download behavior.
- Initial model loading and chat submission continue to reuse the Main-process cache.
- Only an actual OpenRouter model change sends `refresh: true`.
- A failed refresh retains cached models and parameters and surfaces the existing safe “模型列表加载失败” message.
- Raw OpenRouter response bodies must not reach Renderer state or logs.

---

### Task 1: Preserve exact OpenRouter video frame capabilities

**Files:**
- Modify: `packages/shared/src/desktop-api.ts:50-70,380-415`
- Test: `packages/shared/src/contracts.test.ts:270-300`
- Modify: `apps/desktop/electron/main/chat/model-provider.ts:205-215,584-630`
- Test: `apps/desktop/electron/main/chat/openrouter-provider.test.ts:1010-1140`
- Modify fixture defaults where `ModelInfo.generation.video` is constructed: `apps/desktop/electron/main/application.test.ts`, `apps/desktop/electron/main/chat/multimodal-router.test.ts`, `apps/desktop/src/stores/settings.ts`, `apps/desktop/tests/components/chat.test.ts`, `apps/desktop/tests/components/workbench.test.ts`

**Interfaces:**
- Produces: `VideoFrameType = 'first_frame' | 'last_frame'`.
- Produces: `ModelInfo['generation']['video']['frameImages']: VideoFrameType[]`.
- Consumes: OpenRouter `supported_frame_images` values.

- [ ] **Step 1: Add failing shared-contract and parser tests**

Add a video capability assertion to `contracts.test.ts`:

```ts
const video = modelInfoSchema.parse({
  id: 'openrouter/video-model',
  name: 'Video model',
  inputModalities: ['text', 'image'],
  outputModalities: ['video'],
  supportsTools: false,
  generation: {
    video: {
      resolutions: ['1080p'],
      aspectRatios: ['16:9'],
      durations: [4, 8],
      supportsAudio: true,
      frameImages: ['first_frame', 'last_frame'],
    },
  },
})
expect(video.generation.video?.frameImages).toEqual(['first_frame', 'last_frame'])
```

Update the parser filter test to expect:

```ts
frameImages: ['first_frame'],
```

and include unknown, duplicated, and reversed frame values in `supported_frame_images`. Update the duplicate-model test so the merged result contains both frame types in canonical order.

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
pnpm exec node apps/desktop/scripts/run-vitest-electron.mjs run packages/shared/src/contracts.test.ts --reporter=verbose
pnpm --filter @autoforge/desktop exec node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts electron/main/chat/openrouter-provider.test.ts -t 'video capability|video IDs' --reporter=verbose
```

Expected: FAIL because `frameImages` is rejected by the shared schema and omitted by the parser.

- [ ] **Step 3: Add the shared frame capability**

In `packages/shared/src/desktop-api.ts` add:

```ts
export const videoFrameTypeSchema = z.enum(['first_frame', 'last_frame'])
export type VideoFrameType = z.infer<typeof videoFrameTypeSchema>
```

and extend the video generation capability:

```ts
video: z.object({
  resolutions: z.array(z.string()),
  aspectRatios: z.array(z.string()),
  durations: z.array(z.number().int().positive()),
  supportsAudio: z.boolean(),
  frameImages: z.array(videoFrameTypeSchema),
}).strict().optional(),
```

- [ ] **Step 4: Parse and merge only known frame types**

In `model-provider.ts`, add:

```ts
const VIDEO_FRAME_TYPES = ['first_frame', 'last_frame'] as const

function videoFrameTypes(values: readonly unknown[] | undefined): VideoFrameType[] {
  const present = new Set(values?.filter(
    (value): value is VideoFrameType => VIDEO_FRAME_TYPES.includes(value as VideoFrameType),
  ))
  return VIDEO_FRAME_TYPES.filter((value) => present.has(value))
}
```

Set parser and merge outputs to:

```ts
frameImages: videoFrameTypes(model.supported_frame_images ?? undefined),
```

```ts
frameImages: videoFrameTypes([...existingVideo.frameImages, ...candidateVideo.frameImages]),
```

Derive `inputModalities` from `frameImages.length` as before.

- [ ] **Step 5: Update all typed video capability fixtures**

Every literal with `supportsAudio` must add either the capability under test or the safe default:

```ts
frameImages: [],
```

Test helpers that construct video models should default to:

```ts
video: {
  resolutions: ['720p'],
  aspectRatios: ['auto', '16:9'],
  durations: [5, 10],
  supportsAudio: true,
  frameImages: ['first_frame', 'last_frame'],
},
```

- [ ] **Step 6: Verify Task 1 GREEN and commit**

Run:

```bash
pnpm exec node apps/desktop/scripts/run-vitest-electron.mjs run packages/shared/src/contracts.test.ts --reporter=dot
pnpm --filter @autoforge/desktop exec node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts electron/main/chat/openrouter-provider.test.ts --reporter=dot
pnpm --filter @autoforge/desktop typecheck
```

Expected: all commands exit 0.

Commit:

```bash
git add packages/shared/src/desktop-api.ts packages/shared/src/contracts.test.ts apps/desktop/electron/main/chat/model-provider.ts apps/desktop/electron/main/chat/openrouter-provider.test.ts apps/desktop/electron/main/application.test.ts apps/desktop/electron/main/chat/multimodal-router.test.ts apps/desktop/src/stores/settings.ts apps/desktop/tests/components/chat.test.ts apps/desktop/tests/components/workbench.test.ts docs/superpowers/plans/2026-08-18-openrouter-live-video-capabilities.md
git commit -m "feat: preserve video frame capabilities"
```

---

### Task 2: Enforce frame counts and map single images to the last frame

**Files:**
- Modify: `apps/desktop/electron/main/chat/multimodal-router.ts:15-40,155-175,300-330`
- Test: `apps/desktop/electron/main/chat/multimodal-router.test.ts`
- Modify: `apps/desktop/electron/main/chat/model-provider.ts:75-90`
- Modify: `apps/desktop/electron/main/chat/video-job-runner.ts:325-345`
- Test: `apps/desktop/electron/main/chat/video-job-runner.test.ts:620-680`
- Modify: `apps/desktop/electron/main/chat/openrouter-provider.ts:105-125,215-240,330-365`
- Test: `apps/desktop/electron/main/chat/openrouter-provider.test.ts:475-570`

**Interfaces:**
- Consumes: `ModelInfo.generation.video.frameImages` from Task 1.
- Produces: `ResolvedChatRoute.videoFrameImages?: VideoFrameType[]`.
- Produces: `ModelVideoRequest.frameImages: VideoFrameType[]`.

- [ ] **Step 1: Write failing route and wire-format tests**

Add route tests proving that a model with two frame types accepts two image assets and a first-frame-only model rejects two. Assert the resolved route carries:

```ts
videoFrameImages: ['first_frame', 'last_frame'],
```

Change the existing single-frame provider assertion to expect only:

```ts
frame_images: [{
  type: 'image_url',
  image_url: { url: 'data:image/webp;base64,AQID' },
  frame_type: 'last_frame',
}],
```

Keep the two-image assertion as first then last. Add first-only and last-only single-image cases.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
pnpm --filter @autoforge/desktop exec node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts electron/main/chat/multimodal-router.test.ts electron/main/chat/openrouter-provider.test.ts -t 'frame' --reporter=verbose
```

Expected: FAIL because the route drops frame capabilities and a single image is still sent as `first_frame`.

- [ ] **Step 3: Carry capabilities through route and job submission**

Extend `ResolvedChatRoute`:

```ts
videoFrameImages?: VideoFrameType[]
```

For video requests, reject excessive image attachments in `supportsRequest`:

```ts
if (output === 'video' && assets.length > (model.generation.video?.frameImages.length ?? 0)) {
  return false
}
```

Copy the selected capability in `route`:

```ts
...(output === 'video' ? {
  videoFrameImages: model.generation.video!.frameImages.slice(),
} : {}),
```

Extend `ModelVideoRequest` with:

```ts
frameImages: VideoFrameType[]
```

and pass it from `VideoJobRunner`:

```ts
frameImages: input.route.videoFrameImages ?? [],
```

Update every existing `submitVideo` request fixture in `openrouter-provider.test.ts` to include the exact capability used by that case. Text-to-video fixtures use `frameImages: []`; single- or two-frame fixtures use the corresponding supported frame types.

- [ ] **Step 4: Implement capability-aware OpenRouter frame wiring**

Extend `videoRequestSchema`:

```ts
frameImages: z.array(z.enum(['first_frame', 'last_frame'])).max(2),
```

Replace the index-only mapper with:

```ts
function wireFrameImages(
  references: Array<{ mimeType: string; dataBase64: string }>,
  frameImages: VideoFrameType[],
) {
  if (references.length === 0) return []
  if (references.length > frameImages.length) throw failure('MODEL_MODALITY_UNSUPPORTED')
  const types = references.length === 1
    ? [frameImages.includes('last_frame') ? 'last_frame' : frameImages[0]!]
    : ['first_frame', 'last_frame'] as const
  if (types.some((type) => !frameImages.includes(type))) {
    throw failure('MODEL_MODALITY_UNSUPPORTED')
  }
  return wireReferences(references).map((reference, index) => ({
    ...reference,
    frame_type: types[index]!,
  }))
}
```

Call it with `parsedRequest.frameImages` and keep omitting `frame_images` for text-to-video.

- [ ] **Step 5: Verify Task 2 GREEN and commit**

Run:

```bash
pnpm --filter @autoforge/desktop exec node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts electron/main/chat/multimodal-router.test.ts electron/main/chat/video-job-runner.test.ts electron/main/chat/openrouter-provider.test.ts --reporter=dot
pnpm --filter @autoforge/desktop typecheck
```

Expected: all commands exit 0.

Commit:

```bash
git add apps/desktop/electron/main/chat/multimodal-router.ts apps/desktop/electron/main/chat/multimodal-router.test.ts apps/desktop/electron/main/chat/model-provider.ts apps/desktop/electron/main/chat/video-job-runner.ts apps/desktop/electron/main/chat/video-job-runner.test.ts apps/desktop/electron/main/chat/openrouter-provider.ts apps/desktop/electron/main/chat/openrouter-provider.test.ts
git commit -m "fix: map single video images to last frames"
```

---

### Task 3: Add explicit fresh model-directory requests

**Files:**
- Modify: `packages/shared/src/desktop-api.ts:640-645,700-712,835-842`
- Test: `packages/shared/src/contracts.test.ts`
- Modify: `apps/desktop/electron/preload/bridge.ts:115-125`
- Test: `apps/desktop/electron/preload/bridge.test.ts:45-70`
- Modify: `apps/desktop/electron/main/ipc/register-ipc.ts:180-190`
- Test: `apps/desktop/electron/main/ipc/register-ipc.test.ts:220-250`
- Modify: `apps/desktop/electron/main/application.ts:280-300,840-850`
- Test: `apps/desktop/electron/main/application.test.ts:630-690`

**Interfaces:**
- Produces: `DesktopAPI.settings.listProviderModels(provider, refresh?: boolean): Promise<ModelInfo[]>`.
- Consumes: existing provider `listModels()` methods.

- [ ] **Step 1: Write failing contract, bridge, IPC, and cache tests**

Add strict request-schema assertions:

```ts
expect(listProviderModelsRequestSchema.parse({ provider: 'openrouter' }))
  .toEqual({ provider: 'openrouter', refresh: false })
expect(listProviderModelsRequestSchema.parse({ provider: 'openrouter', refresh: true }))
  .toEqual({ provider: 'openrouter', refresh: true })
expect(() => listProviderModelsRequestSchema.parse({ provider: 'openrouter', refresh: 'yes' })).toThrow()
```

Bridge tests must assert:

```ts
await app.api.settings.listProviderModels('openrouter', true)
expect(app.ipcRenderer.invoke).toHaveBeenCalledWith(
  ipcChannels.settingsListProviderModels,
  { provider: 'openrouter', refresh: true },
)
```

IPC tests must verify `listProviderModels('openrouter', true)` is forwarded. Application tests must call cached, cached, refreshed and expect provider `listModels` call counts `1`, `1`, `2` and different returned snapshots.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
pnpm exec node apps/desktop/scripts/run-vitest-electron.mjs run packages/shared/src/contracts.test.ts --reporter=verbose
pnpm --filter @autoforge/desktop exec node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts electron/preload/bridge.test.ts electron/main/ipc/register-ipc.test.ts electron/main/application.test.ts -t 'provider model|model catalog' --reporter=verbose
```

Expected: FAIL because `refresh` is not accepted or forwarded and Main reuses the same Promise.

- [ ] **Step 3: Extend the strict IPC and preload contract**

Add:

```ts
export const listProviderModelsRequestSchema = providerRequestSchema.extend({
  refresh: z.boolean().optional().default(false),
}).strict()
```

Use it for `settingsListProviderModels`, update the Desktop API signature, and forward from Preload:

```ts
listProviderModels: (provider, refresh = false) => invoke(
  ipcRenderer,
  ipcChannels.settingsListProviderModels,
  { provider, ...(refresh ? { refresh: true } : {}) },
),
```

IPC forwards `input.refresh` to the service.

- [ ] **Step 4: Make cache replacement race-safe**

Change Main to:

```ts
const getModelCatalog = (provider: ModelProviderId, refresh = false) => {
  if (refresh) modelCatalog.delete(provider)
  let catalog = modelCatalog.get(provider)
  if (!catalog) {
    let current!: Promise<ModelInfo[]>
    current = providerRegistry.get(provider).listModels().catch((error) => {
      if (modelCatalog.get(provider) === current) modelCatalog.delete(provider)
      throw error
    })
    catalog = current
    modelCatalog.set(provider, catalog)
  }
  return catalog
}
```

and expose:

```ts
listProviderModels: (provider, refresh = false) => getModelCatalog(provider, refresh),
```

- [ ] **Step 5: Verify Task 3 GREEN and commit**

Run:

```bash
pnpm exec node apps/desktop/scripts/run-vitest-electron.mjs run packages/shared/src/contracts.test.ts --reporter=dot
pnpm --filter @autoforge/desktop exec node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts electron/preload/bridge.test.ts electron/main/ipc/register-ipc.test.ts electron/main/application.test.ts --reporter=dot
pnpm --filter @autoforge/desktop typecheck
```

Expected: all commands exit 0.

Commit:

```bash
git add packages/shared/src/desktop-api.ts packages/shared/src/contracts.test.ts apps/desktop/electron/preload/bridge.ts apps/desktop/electron/preload/bridge.test.ts apps/desktop/electron/main/ipc/register-ipc.ts apps/desktop/electron/main/ipc/register-ipc.test.ts apps/desktop/electron/main/application.ts apps/desktop/electron/main/application.test.ts
git commit -m "feat: refresh provider model catalogs on demand"
```

---

### Task 4: Refresh capabilities when ChatComposer changes models

**Files:**
- Modify: `apps/desktop/src/stores/settings.ts:230-252`
- Modify: `apps/desktop/src/views/ChatView.vue:1-95,130-190`
- Modify: `apps/desktop/src/components/chat/ChatComposer.vue:45-260,315-520`
- Test: `apps/desktop/tests/components/chat.test.ts:1540-1620`

**Interfaces:**
- Consumes: `listProviderModels(provider, true)` from Task 3.
- Produces: `settings.loadModels(provider?, refresh?): Promise<ModelInfo[] | undefined>`.
- Produces ChatComposer props: `modelsLoading: boolean` and `refreshModels?: () => Promise<ModelInfo[] | undefined>`.

- [ ] **Step 1: Write failing component tests for success and failure**

Mount `ChatView` with OpenRouter active and two video models. For a successful switch, mock the fresh response with target capabilities:

```ts
video: {
  resolutions: ['4K'],
  aspectRatios: ['9:16'],
  durations: [4, 8],
  supportsAudio: false,
  frameImages: ['first_frame', 'last_frame'],
}
```

After changing the model, assert:

```ts
expect(api.settings.listProviderModels).toHaveBeenCalledWith('openrouter', true)
expect(wrapper.findAll('[data-testid="video-duration"] option').map((option) => option.text()))
  .toEqual(['4 秒', '8 秒'])
expect(wrapper.findAll('[data-testid="video-resolution"] option').map((option) => option.text()))
  .toEqual(['4K'])
expect(wrapper.findAll('[data-testid="video-aspect-ratio"] option').map((option) => option.text()))
  .toEqual(['9:16'])
expect(wrapper.find('[data-testid="video-generate-audio"]').exists()).toBe(false)
```

For a rejected refresh, assert cached options remain, `store.preferences.models.video` changes to the requested cached model, and the rendered alert contains `模型列表加载失败`.

- [ ] **Step 2: Run component tests and verify RED**

Run:

```bash
pnpm --filter @autoforge/desktop exec node scripts/run-vitest-electron.mjs run --config vitest.config.ts tests/components/chat.test.ts -t 'refreshes OpenRouter model capabilities|keeps cached model capabilities' --reporter=verbose
```

Expected: FAIL because model changes currently make no list call and ChatView does not render settings errors.

- [ ] **Step 3: Return model snapshots from the settings store**

Change the action signature to:

```ts
async loadModels(provider?: ModelProviderId, refresh = false): Promise<ModelInfo[] | undefined> {
```

Call:

```ts
const models = await getDesktopApi().settings.listProviderModels(target, refresh)
if (version !== this._modelVersions[target]) return undefined
this.providerModels[target] = models
return models
```

On failure keep `providerModels[target]` untouched, set the existing safe error, and return `undefined`.

- [ ] **Step 4: Connect ChatView refresh and error state**

Pass into ChatComposer:

```vue
:models-loading="settings.modelsLoading"
:refresh-models="refreshModels"
```

Render the settings error near the existing chat error:

```vue
<div v-if="settings.error" class="af-error" role="alert">
  {{ settings.error }}
</div>
```

Add:

```ts
async function refreshModels(): Promise<ModelInfo[] | undefined> {
  if (settings.activeProvider !== 'openrouter') return settings.models
  return settings.loadModels('openrouter', true)
}
```

- [ ] **Step 5: Make model changes await the fresh snapshot**

Add props with defaults:

```ts
modelsLoading?: boolean
refreshModels?: () => Promise<ModelInfo[] | undefined>
```

Include `modelsLoading` in model and generation-control disabled expressions. Refactor model filtering to accept an explicit snapshot:

```ts
function modelsForOutput(output: OutputType, models = props.models): ModelInfo[] {
  // existing compatibility filter applied to models
}
```

Make `changeModel` async:

```ts
async function changeModel(event: unknown) {
  if (props.disabled || props.running || props.modelsLoading) return
  const requested = eventValue(event)
  const output = chat.preferences.outputType
  if (!requested || output === 'auto' || requested === selectedModelId.value) return
  const refreshed = await props.refreshModels?.()
  const candidates = modelsForOutput(output, refreshed ?? props.models)
  const selected = candidates.find(({ id }) => id === requested) ?? candidates[0]
  if (!selected) return
  savePreferences({
    ...chat.preferences,
    models: { ...chat.preferences.models, [output]: selected.id },
    generation: normalizeGeneration(chat.preferences.generation, selected, output),
  })
}
```

- [ ] **Step 6: Verify Task 4 GREEN and commit**

Run:

```bash
pnpm --filter @autoforge/desktop exec node scripts/run-vitest-electron.mjs run --config vitest.config.ts tests/components/chat.test.ts --reporter=dot
pnpm --filter @autoforge/desktop typecheck
```

Expected: all commands exit 0.

Commit:

```bash
git add apps/desktop/src/stores/settings.ts apps/desktop/src/views/ChatView.vue apps/desktop/src/components/chat/ChatComposer.vue apps/desktop/tests/components/chat.test.ts
git commit -m "feat: refresh capabilities on model changes"
```

---

### Task 5: Complete regression verification

**Files:**
- Verify only; no planned production changes.

**Interfaces:**
- Verifies all interfaces produced by Tasks 1-4.

- [ ] **Step 1: Run repository quality gates**

```bash
pnpm typecheck
pnpm test
pnpm lint
git diff --check
```

Expected: every command exits 0; the complete test output reports zero failures.

- [ ] **Step 2: Inspect the final diff and capability chain**

```bash
git status --short
git log -6 --oneline --decorate
rg -n 'frameImages|refreshModels|listProviderModels\(' packages/shared/src apps/desktop/src apps/desktop/electron/main apps/desktop/electron/preload
```

Confirm the chain is exactly:

```text
OpenRouter supported_frame_images
→ ModelInfo.generation.video.frameImages
→ ResolvedChatRoute.videoFrameImages
→ ModelVideoRequest.frameImages
→ frame_images wire request
```

and:

```text
ChatComposer model change
→ settings.loadModels(openrouter, true)
→ strict IPC refresh flag
→ Main cache replacement
→ normalized visible options
```

- [ ] **Step 3: Commit any test-only verification adjustment if required**

If no adjustment is required, do not create an empty commit. If verification exposes a directly related failure, return to the corresponding task's RED-GREEN cycle, modify only the named production or test files from that task, rerun its focused checks, and commit the correction with that task rather than creating a catch-all verification commit.
