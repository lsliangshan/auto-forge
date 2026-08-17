# 聊天页智能滚动跟随 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用户距离聊天列表底部超过 20px 时，AI 新内容不再抢夺滚动位置，同时保留主动发送、切换会话和回到底部后的自动跟随。

**Architecture:** `ChatView.vue` 在视图本地维护一个布尔跟随状态，由消息容器原生 `scroll` 事件根据 DOM 距离更新。AI 消息版本变化只在跟随状态开启时滚到底部；主动发送和切换会话使用强制滚动路径，不修改 Pinia Store 或消息事件协议。

**Tech Stack:** Vue 3 Composition API、Pinia 4、Element Plus、Vitest 4、Vue Test Utils、TypeScript 6。

## Global Constraints

- 底部距离公式固定为 `scrollHeight - scrollTop - clientHeight`。
- 距离小于或等于 `20px` 时自动跟随；只有大于 `20px` 才停止跟随。
- AI 新增消息和同一回复的流式更新都遵循跟随状态。
- 用户主动发送消息和切换会话始终恢复跟随并滚到底部。
- 用户手动滚回 20px 范围内后，后续 AI 内容恢复自动跟随。
- 不保存会话滚动位置，不新增底部按钮、未读计数、虚拟列表或新依赖。
- 不修改 Store、IPC、数据库、消息事件或模型调用逻辑。
- 只修改 `ChatView.vue` 和现有聊天组件测试，不做无关重构或格式化。

---

## File Structure

- Modify: `apps/desktop/src/views/ChatView.vue` — 读取消息容器滚动距离并控制自动跟随。
- Modify: `apps/desktop/tests/components/chat.test.ts` — 验证 20px 边界、AI 流式更新、主动发送和会话切换。

### Task 1: 用 20px 阈值控制聊天自动滚动

**Files:**
- Modify: `apps/desktop/src/views/ChatView.vue:25-33,94-114,137-142`
- Test: `apps/desktop/tests/components/chat.test.ts:164-242`

**Interfaces:**
- Consumes: 消息容器 `scrollHeight`、`scrollTop`、`clientHeight`，以及 `chat.messageVersion`、`chat.selectedConversationId`。
- Produces: `updateScrollFollowing(): void` 和 `scrollToLatest(force?: boolean): Promise<void>`；不暴露跨组件 API。

- [ ] **Step 1: 用可复用测试装配替换重复滚动测试设置**

在 `createEventApi()` 之后、`describe('chat interactions')` 之前新增：

```ts
function mountScrollableChat() {
  const { api, emitChat } = createEventApi()
  Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
  const chat = useChatStore()
  chat.conversations = [
    {
      id: 'conversation_1',
      title: '会话一',
      createdAt: '2026-07-25T00:00:00.000Z',
      updatedAt: '2026-07-25T00:00:00.000Z',
    },
    {
      id: 'conversation_2',
      title: '会话二',
      createdAt: '2026-07-25T00:00:00.000Z',
      updatedAt: '2026-07-25T00:00:00.000Z',
    },
  ]
  chat.selectedConversationId = 'conversation_1'
  chat.preferencesByConversation.conversation_1 = generationPreferences({
    outputType: 'text',
    models: { text: 'text/default' },
  })
  chat.preferencesByConversation.conversation_2 = generationPreferences({
    outputType: 'text',
    models: { text: 'text/default' },
  })
  const settings = useSettingsStore()
  settings.settings = {
    theme: 'system',
    language: 'zh-CN',
    dataDirectory: '/data',
    logDirectory: '/logs',
    activeProvider: 'openrouter',
    defaultModels: {
      deepseek: { text: 'deepseek-chat' },
      openrouter: { text: 'text/default' },
    },
    showCosts: false,
    developerMode: false,
    permissionDefault: 'ask',
    proxy: { enabled: false, bypassDomains: [] },
  }
  expect(() => appSettingsSchema.parse(settings.settings)).not.toThrow()
  settings.providerModels.openrouter = [modelInfo('text/default', ['text'])]
  const wrapper = mount(ChatView, { global: { plugins: [ElementPlus] } })
  const messages = wrapper.get('.messages').element as HTMLElement
  Object.defineProperty(messages, 'scrollHeight', { configurable: true, value: 900 })
  Object.defineProperty(messages, 'clientHeight', { configurable: true, value: 400 })
  return { chat, emitChat, messages, wrapper }
}
```

- [ ] **Step 2: 写入 AI 滚动阈值失败测试**

保留现有 `scrolls to the latest local and incoming chat content after rendering`，在它之后新增：

```ts
it('preserves manual scroll during AI updates and resumes within 20px of bottom', async () => {
  const { emitChat, messages, wrapper } = mountScrollableChat()
  const emitText = (text: string) => emitChat({
    type: 'block',
    conversationId: 'conversation_1',
    messageId: 'assistant_1',
    block: { type: 'text', text },
  })

  messages.scrollTop = 400
  await wrapper.get('.messages').trigger('scroll')
  emitText('第一段')
  await vi.waitFor(() => expect(wrapper.text()).toContain('第一段'))
  expect(messages.scrollTop).toBe(400)

  emitText('第二段')
  await vi.waitFor(() => expect(wrapper.text()).toContain('第一段第二段'))
  expect(messages.scrollTop).toBe(400)

  messages.scrollTop = 480
  await wrapper.get('.messages').trigger('scroll')
  emitText('第三段')
  await vi.waitFor(() => expect(messages.scrollTop).toBe(900))

  messages.scrollTop = 481
  await wrapper.get('.messages').trigger('scroll')
  emitText('第四段')
  await vi.waitFor(() => expect(messages.scrollTop).toBe(900))
})
```

这里 `900 - 400 - 400 = 100`，属于非底部；`900 - 480 - 400 = 20`，验证等号边界；`900 - 481 - 400 = 19`，验证阈值内。

- [ ] **Step 3: 写入主动发送与切换会话回归测试**

紧接阈值用例新增：

```ts
it('forces the latest position after a local submit or conversation switch', async () => {
  const { chat, messages, wrapper } = mountScrollableChat()
  const acknowledge = vi.fn()

  messages.scrollTop = 400
  await wrapper.get('.messages').trigger('scroll')
  wrapper.getComponent(ChatComposer).vm.$emit('submit', {
    content: '主动发送',
    assetIds: [],
    outputType: 'text',
    generation: generationPreferences().generation,
    model: 'text/default',
  }, acknowledge)
  await vi.waitFor(() => {
    expect(messages.scrollTop).toBe(900)
    expect(acknowledge).toHaveBeenCalledWith(true)
  })

  messages.scrollTop = 400
  await wrapper.get('.messages').trigger('scroll')
  chat.selectedConversationId = 'conversation_2'
  await vi.waitFor(() => expect(messages.scrollTop).toBe(900))
})
```

- [ ] **Step 4: 运行聚焦测试并验证 RED**

从 `apps/desktop` 目录运行：

```bash
node scripts/run-vitest-electron.mjs run --config vitest.config.ts tests/components/chat.test.ts -t "preserves manual scroll|forces the latest position"
```

Expected: 第一项 FAIL，非底部 AI 更新后 `scrollTop` 实际为 `900` 而不是 `400`；第二项可以保持 PASS，因为它保护现有主动发送和切换会话行为。

- [ ] **Step 5: 在消息容器监听原生滚动**

把 `ChatView.vue` 的消息容器改为：

```vue
<div
  ref="messagesRef"
  class="messages af-scrollbar"
  aria-live="polite"
  @scroll="updateScrollFollowing"
>
```

- [ ] **Step 6: 实现视图本地跟随状态和强制滚动入口**

用以下代码替换现有 `scrollToLatest` 和组合 watcher：

```ts
const BOTTOM_FOLLOW_THRESHOLD_PX = 20
const shouldFollowLatest = ref(true)

function updateScrollFollowing() {
  const messages = messagesRef.value
  if (!messages) return
  const distanceFromBottom = messages.scrollHeight - messages.scrollTop - messages.clientHeight
  shouldFollowLatest.value = distanceFromBottom <= BOTTOM_FOLLOW_THRESHOLD_PX
}

async function scrollToLatest(force = false) {
  if (force) shouldFollowLatest.value = true
  await nextTick()
  if (!force && !shouldFollowLatest.value) return
  const messages = messagesRef.value
  if (messages) messages.scrollTop = messages.scrollHeight
}

watch(
  () => chat.selectedConversationId,
  () => { void scrollToLatest(true) },
  { flush: 'post' },
)

watch(
  () => chat.messageVersion,
  () => { void scrollToLatest() },
  { flush: 'post' },
)
```

阈值状态保持在组件内，不写入 Store。非强制滚动在 `nextTick` 后再次读取最新布尔状态，避免用户在渲染间隙滚离底部后仍被拉回。

- [ ] **Step 7: 主动发送时走强制滚动路径**

把 `submit` 改为：

```ts
async function submit(
  input: Omit<ChatSendInput, 'conversationId'>,
  acknowledge: ChatSendAcknowledgement,
) {
  const sending = chat.send(input)
  void scrollToLatest(true)
  acknowledge(await sending)
}
```

`chat.send()` 会同步写入本地用户消息，再等待 Main 响应；紧随其后的强制滚动会在该本地消息渲染完成后定位到底部。

- [ ] **Step 8: 验证 GREEN 和聊天组件回归**

```bash
cd apps/desktop
node scripts/run-vitest-electron.mjs run --config vitest.config.ts tests/components/chat.test.ts -t "preserves manual scroll|forces the latest position"
node scripts/run-vitest-electron.mjs run --config vitest.config.ts tests/components/chat.test.ts
pnpm typecheck
cd ../..
```

Expected: 两个滚动用例通过，`chat.test.ts` 全部通过，Desktop 类型检查退出码为 `0`。

- [ ] **Step 9: 提交交互改动**

```bash
git add apps/desktop/src/views/ChatView.vue apps/desktop/tests/components/chat.test.ts
git commit -m "fix: preserve manual chat scroll position"
```

### Task 2: 完整验证与交付审查

**Files:**
- Verify only: `apps/desktop/src/views/ChatView.vue`
- Verify only: `apps/desktop/tests/components/chat.test.ts`

**Interfaces:**
- Consumes: Task 1 的聊天滚动行为。
- Produces: 可交付验证证据，不新增行为或文件。

- [ ] **Step 1: 运行完整测试**

从仓库根目录运行：

```bash
pnpm test
```

Expected: 47 个测试文件全部通过，测试总数大于当前基线 `1134`。

- [ ] **Step 2: 运行全仓静态检查和生产构建**

```bash
pnpm typecheck
pnpm lint
pnpm build
git diff --check
```

Expected: 所有命令退出码为 `0`。Lint 应保持 `0 errors`，且不得在当前基线 `200 warnings` 之上新增本功能 warning；生产构建可保留现有第三方 `@vueuse/core` Rollup 注释提示。

- [ ] **Step 3: 审查提交范围和工作区**

```bash
git status --short
git log --oneline -5
git diff HEAD~1..HEAD --stat
git diff HEAD~1..HEAD --name-only
```

Expected: 工作区干净；功能提交只修改 `ChatView.vue` 和 `chat.test.ts`，没有 Store、IPC、数据库、依赖或样式改动。
