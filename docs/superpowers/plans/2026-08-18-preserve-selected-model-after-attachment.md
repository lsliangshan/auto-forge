# Preserve Selected Model After Attachment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 添加附件后保留用户明确选择的模型；当前模型与附件不兼容时提示并阻止发送，直到用户手动切换模型或移除附件。

**Architecture:** 在 `ChatComposer.vue` 内拆分“模型支持输出类型”和“模型支持当前请求”两个判断。前者决定模型列表及选中值，后者结合草稿附件决定提示和发送可用性，从而消除附件变化引发的隐式模型回退。

**Tech Stack:** Vue 3 Composition API、Pinia、TypeScript、Vitest、Vue Test Utils

## Global Constraints

- 不修改附件导入流程、模型偏好存储、主进程路由或能力目录解析。
- 当前模型不兼容附件时，文案固定为“当前模型不支持已添加的附件”。
- 只修改 `apps/desktop/src/components/chat/ChatComposer.vue` 和 `apps/desktop/tests/components/chat.test.ts`。
- 保留现有“当前供应商没有兼容此输出类型的模型”提示语义。

---

### Task 1: 保留模型选择并独立校验附件兼容性

**Files:**
- Modify: `apps/desktop/src/components/chat/ChatComposer.vue:79-97,373-428`
- Test: `apps/desktop/tests/components/chat.test.ts:2057-2110`

**Interfaces:**
- Consumes: `ModelInfo.inputModalities`、`ModelInfo.outputModalities`、`ModelInfo.generation`、`chat.drafts`、`chat.preferences.outputType`。
- Produces: `modelSupportsOutput(model, output): boolean` 只判断输出能力；`modelSupportsRequest(model, output): boolean` 判断输出能力和当前附件；`selectedModelSupportsRequest` 控制提示及发送状态。

- [ ] **Step 1: 写精确复现自动切换的失败测试**

在 `disables unsupported outputs and cannot send without a compatible model` 测试之前加入：

```ts
it('keeps the selected video model after adding an incompatible attachment', async () => {
  const { api } = createEventApi()
  Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
  const store = useChatStore()
  store.selectedConversationId = 'conversation_1'
  store.preferencesByConversation.conversation_1 = generationPreferences({
    outputType: 'video',
    models: { video: 'openai/sora-2-pro' },
  })
  const happyHorse = modelInfo('alibaba/happyhorse-1.1', ['video'])
  const sora = modelInfo('openai/sora-2-pro', ['video'])
  sora.inputModalities = ['text']
  const wrapper = mount(ChatComposer, {
    props: {
      disabled: false,
      running: false,
      models: [happyHorse, sora],
      defaultModel: 'alibaba/happyhorse-1.1',
    },
    global: { plugins: [ElementPlus] },
  })

  await wrapper.get('textarea').setValue('生成视频')
  expect(wrapper.get('[data-testid="model-select"]').element).toHaveProperty(
    'value',
    'openai/sora-2-pro',
  )

  store.draftsByConversation.conversation_1 = [mediaAsset('reference')]
  await wrapper.vm.$nextTick()

  expect(wrapper.get('[data-testid="model-select"]').element).toHaveProperty(
    'value',
    'openai/sora-2-pro',
  )
  expect(wrapper.get('[data-testid="model-attachment-incompatible"]').text())
    .toContain('当前模型不支持已添加的附件')
  expect(wrapper.get('[data-testid="send-message"]').attributes('disabled')).toBeDefined()

  await wrapper.get('[data-testid="model-select"]').setValue('alibaba/happyhorse-1.1')
  await vi.waitFor(() => expect(store.preferences.models.video).toBe('alibaba/happyhorse-1.1'))
  expect(wrapper.find('[data-testid="model-attachment-incompatible"]').exists()).toBe(false)
  expect(wrapper.get('[data-testid="send-message"]').attributes('disabled')).toBeUndefined()
})
```

- [ ] **Step 2: 运行测试并确认因当前自动回退而失败**

Run:

```bash
pnpm --filter @autoforge/desktop exec node scripts/run-vitest-electron.mjs run --config vitest.config.ts tests/components/chat.test.ts -t "keeps the selected video model after adding an incompatible attachment"
```

Expected: FAIL；添加附件后的模型值实际为 `alibaba/happyhorse-1.1`，而期望值为 `openai/sora-2-pro`。

- [ ] **Step 3: 将输出能力与当前请求兼容性拆开**

把现有 `modelSupportsOutput` 改为只判断输出能力，并新增当前请求判断：

```ts
function modelSupportsOutput(model: ModelInfo, output: ConcreteOutput): boolean {
  return model.outputModalities.includes(output)
    && model.inputModalities.includes('text')
    && (output === 'text' || Boolean(model.generation[output]))
}

function modelSupportsRequest(model: ModelInfo, output: ConcreteOutput): boolean {
  if (!modelSupportsOutput(model, output)) return false
  if ((output === 'image' || output === 'video')
    && chat.drafts.some(({ kind }) => kind !== 'image')) return false
  return chat.drafts.every(({ kind }) => model.inputModalities.includes(kind))
}
```

保留 `modelsForOutput()` 的现有结构，使其调用只判断输出能力的 `modelSupportsOutput()`。随后新增：

```ts
const selectedModelSupportsRequest = computed(() => {
  if (!selectedModel.value) return false
  const output = chat.preferences.outputType
  if (output !== 'auto') return modelSupportsRequest(selectedModel.value, output)
  return selectedModel.value.outputModalities
    .some((candidate) => modelSupportsRequest(selectedModel.value!, candidate))
})
```

将 `autoChoiceRequired` 内的过滤调用改为 `modelSupportsRequest(selectedModel.value!, output)`，并在 `canSubmit` 的提前返回条件中加入：

```ts
|| !selectedModelSupportsRequest.value
```

- [ ] **Step 4: 显示当前模型的附件不兼容状态**

在现有 `no-compatible-model` 提示之后加入：

```vue
<div
  v-else-if="!selectedModelSupportsRequest"
  class="choice-required"
  data-testid="model-attachment-incompatible"
  role="alert"
>
  当前模型不支持已添加的附件。
</div>
```

- [ ] **Step 5: 运行定向测试并确认通过**

Run:

```bash
pnpm --filter @autoforge/desktop exec node scripts/run-vitest-electron.mjs run --config vitest.config.ts tests/components/chat.test.ts -t "keeps the selected video model after adding an incompatible attachment"
```

Expected: PASS；测试输出无错误或警告。

- [ ] **Step 6: 运行聊天组件测试回归**

Run:

```bash
pnpm --filter @autoforge/desktop exec node scripts/run-vitest-electron.mjs run --config vitest.config.ts tests/components/chat.test.ts
```

Expected: `apps/desktop/tests/components/chat.test.ts` 全部 PASS。

- [ ] **Step 7: 运行桌面端类型检查**

Run:

```bash
pnpm --filter @autoforge/desktop typecheck
```

Expected: 命令退出码为 0，无 TypeScript 或 Vue 类型错误。

- [ ] **Step 8: 检查改动范围并提交**

Run:

```bash
git diff --check
git status --short
git diff -- apps/desktop/src/components/chat/ChatComposer.vue apps/desktop/tests/components/chat.test.ts
```

Expected: 无空白错误；除用户已有未跟踪文件外，仅出现本任务的两个代码文件修改。

Commit:

```bash
git add apps/desktop/src/components/chat/ChatComposer.vue apps/desktop/tests/components/chat.test.ts
git commit -m "fix: preserve selected model after attachments"
```
