# Chat Pending State and Auto-Scroll Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a valid chat submission immediately expose a clickable `取消发送` action, preserve cancellation intent until Main returns a request ID, and keep the selected chat scrolled to its newest local or incoming content.

**Architecture:** Keep request admission and cancellation lifecycle state in the Pinia chat store, scoped by conversation and layered over the existing active request ID map. Reuse the existing per-conversation message revision as the only scroll signal; `ChatView` watches the selected conversation and revision, waits for Vue's DOM update, then scrolls its existing message viewport to `scrollHeight`.

**Tech Stack:** Vue 3.5, Pinia 4, TypeScript 6, Element Plus, Vue Test Utils, Vitest 4, Electron 43.

## Global Constraints

- The running button label must be exactly `取消发送`.
- A cancellation requested before Main returns a `requestId` must call the existing `chat.cancel(requestId)` bridge as soon as that ID arrives.
- Request lifecycle state must remain isolated by conversation.
- Local user insertion, new assistant content, block updates, and streaming text deltas must scroll the selected viewport to the latest content.
- Scrolling is unconditional, including after the user has manually scrolled upward.
- Preserve the existing optimistic rollback, draft restoration, terminal-before-return guard, IME behavior, attachment behavior, and IPC contracts.
- Do not modify Main, Preload, or shared bridge types.

---

### Task 1: Pending admission and immediate cancellation state

**Files:**
- Modify: `apps/desktop/src/stores/chat.ts:185-230, 300-334, 558-628`
- Modify: `apps/desktop/src/components/chat/ChatComposer.vue:298-306`
- Test: `apps/desktop/tests/components/chat.test.ts`

**Interfaces:**
- Consumes: Existing `chat.send(input): Promise<{ requestId: string }>`, `chat.cancel(requestId): Promise<void>`, `activeRequestByConversation`, `_terminalRequests`, and `ChatComposer`'s `running` prop plus `cancel` event.
- Produces: `pendingRequestByConversation: Record<string, true>`, `_cancelRequestedByConversation: Record<string, true>`, and an `isRunning` getter that covers both pending admission and active request states.

- [ ] **Step 1: Add failing store tests for pending state, deferred cancellation, rejection cleanup, and terminal races**

Add the following tests to `apps/desktop/tests/components/chat.test.ts` beside the existing request race tests:

```ts
it('enters running state before Main accepts and cancels as soon as the request ID arrives', async () => {
  const { api, emitChat } = createEventApi()
  let resolveSend!: (value: { requestId: string }) => void
  vi.mocked(api.chat.send).mockReturnValue(new Promise((resolve) => { resolveSend = resolve }))
  Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
  const store = useChatStore()
  store.selectedConversationId = 'conv_1'
  store.ensureSubscriptions()

  const sending = store.send({
    content: '立即显示取消',
    assetIds: [],
    outputType: 'text',
    generation: generationPreferences().generation,
  })

  expect(store.isRunning).toBe(true)
  await store.cancelCurrent()
  expect(api.chat.cancel).not.toHaveBeenCalled()

  resolveSend({ requestId: 'req_pending' })
  await sending

  expect(api.chat.cancel).toHaveBeenCalledWith('req_pending')
  expect(store.isRunning).toBe(true)
  emitChat({
    type: 'status',
    conversationId: 'conv_1',
    requestId: 'req_pending',
    status: 'cancelled',
  })
  expect(store.isRunning).toBe(false)
})

it('clears pending request and cancellation intent when Main rejects', async () => {
  const { api } = createEventApi()
  let rejectSend!: (error: Error) => void
  vi.mocked(api.chat.send).mockReturnValue(new Promise((_resolve, reject) => { rejectSend = reject }))
  Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
  const store = useChatStore()
  store.selectedConversationId = 'conv_1'

  const sending = store.send({
    content: '会被拒绝',
    assetIds: [],
    outputType: 'text',
    generation: generationPreferences().generation,
  })
  await store.cancelCurrent()
  expect(store.isRunning).toBe(true)

  rejectSend(new Error('rejected'))
  expect(await sending).toBe(false)

  expect(store.isRunning).toBe(false)
  expect(store.pendingRequestByConversation.conv_1).toBeUndefined()
  expect(store._cancelRequestedByConversation.conv_1).toBeUndefined()
  expect(api.chat.cancel).not.toHaveBeenCalled()
})
```

Extend `does not resurrect a request that completed before send returned` with these assertions:

```ts
expect(store.isRunning).toBe(true)
await store.cancelCurrent()
expect(api.chat.cancel).not.toHaveBeenCalled()

emitChat({ type: 'status', conversationId: 'conv_1', requestId: 'req_fast', status: 'completed' })
resolveSend({ requestId: 'req_fast' })
await sending

expect(api.chat.cancel).not.toHaveBeenCalled()
expect(store.isRunning).toBe(false)
```

The existing emit, resolve, await, and final assertion in that test must be replaced by the block above so the terminal event is emitted only once.

Add a second race regression beside it:

```ts
it('does not resurrect a pending request cancelled after its running event', async () => {
  const { api, emitChat } = createEventApi()
  let resolveSend!: (value: { requestId: string }) => void
  vi.mocked(api.chat.send).mockReturnValue(new Promise((resolve) => { resolveSend = resolve }))
  Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
  const store = useChatStore()
  store.selectedConversationId = 'conv_1'
  store.ensureSubscriptions()

  const sending = store.send({
    content: '运行后取消',
    assetIds: [],
    outputType: 'text',
    generation: generationPreferences().generation,
  })
  emitChat({ type: 'status', conversationId: 'conv_1', requestId: 'req_race', status: 'running' })
  await store.cancelCurrent()
  expect(api.chat.cancel).toHaveBeenCalledWith('req_race')
  emitChat({ type: 'status', conversationId: 'conv_1', requestId: 'req_race', status: 'cancelled' })

  resolveSend({ requestId: 'req_race' })
  await sending

  expect(store.isRunning).toBe(false)
})
```

- [ ] **Step 2: Add a failing component assertion for the exact cancellation label**

Add this focused test beside other `ChatComposer` tests:

```ts
it('labels the running action as cancel send', () => {
  const wrapper = mount(ChatComposer, {
    props: {
      disabled: false,
      running: true,
      models: [modelInfo('text/model', ['text'])],
      defaultModel: 'text/model',
    },
    global: { plugins: [ElementPlus] },
  })

  expect(wrapper.get('[data-testid="cancel-send"]').text()).toBe('取消发送')
})
```

- [ ] **Step 3: Run the focused tests and verify the expected failures**

Run:

```bash
pnpm --dir apps/desktop exec vitest run --config vitest.config.ts tests/components/chat.test.ts
```

Expected: FAIL because `isRunning` is still false during the unresolved send, pending state fields do not exist, cancellation is not deferred, and `[data-testid="cancel-send"]` is absent.

- [ ] **Step 4: Add conversation-scoped pending lifecycle state**

In `apps/desktop/src/stores/chat.ts`, add the two records next to `activeRequestByConversation`:

```ts
pendingRequestByConversation: {} as Record<string, true>,
activeRequestByConversation: {} as Record<string, string>,
_cancelRequestedByConversation: {} as Record<string, true>,
```

Replace `isRunning` with:

```ts
isRunning(state): boolean {
  const conversationId = state.selectedConversationId
  return Boolean(
    state.pendingRequestByConversation[conversationId]
      || state.activeRequestByConversation[conversationId],
  )
},
```

Clear both records in `resetLocalData()`:

```ts
this.pendingRequestByConversation = {}
this.activeRequestByConversation = {}
this._cancelRequestedByConversation = {}
```

After successful conversation deletion, clear all request lifecycle state for that exact conversation:

```ts
delete this.pendingRequestByConversation[id]
delete this.activeRequestByConversation[id]
delete this._cancelRequestedByConversation[id]
```

- [ ] **Step 5: Preserve pending cancellation intent across Main admission**

In `send()`, set the pending marker immediately after capturing the selected conversation:

```ts
const conversationId = this.selectedConversationId
const epoch = this._stateEpoch
this.pendingRequestByConversation[conversationId] = true
```

Replace the bridge call and its acceptance handling with:

```ts
try {
  const api = getDesktopApi()
  const result = await api.chat.send({
    conversationId,
    content: clean,
    assetIds: [...input.assetIds],
    outputType: input.outputType,
    generation: copyGenerationOptions(input.generation),
    ...(input.model ? { model: input.model } : {}),
  })
  delete this.pendingRequestByConversation[conversationId]
  const sentIds = new Set(input.assetIds)
  this.draftsByConversation[conversationId] = (this.draftsByConversation[conversationId] ?? [])
    .filter(({ id }) => !sentIds.has(id))
  const alreadyTerminal = Boolean(this._terminalRequests[result.requestId])
  if (alreadyTerminal) delete this._terminalRequests[result.requestId]
  else this.activeRequestByConversation[conversationId] = result.requestId

  const cancellationRequested = Boolean(this._cancelRequestedByConversation[conversationId])
  delete this._cancelRequestedByConversation[conversationId]
  if (cancellationRequested && !alreadyTerminal) {
    try {
      await api.chat.cancel(result.requestId)
    } catch (error) {
      this.reportConversationError(
        conversationId,
        epoch,
        displayError(error, '取消生成失败'),
      )
    }
  }
  return true
} catch (error) {
  delete this.pendingRequestByConversation[conversationId]
  delete this._cancelRequestedByConversation[conversationId]
  this.messagesByConversation[conversationId] = (this.messagesByConversation[conversationId] ?? [])
    .filter(({ id }) => id !== localId)
  this._messageVersions[conversationId] = (this._messageVersions[conversationId] ?? 0) + 1
  this.reportConversationError(conversationId, epoch, displayError(error, '消息发送失败'))
  return false
}
```

The nested cancellation failure reports the existing localized error without converting an accepted send into `false`. The `alreadyTerminal` branch consumes the intent without cancelling a request that has already completed or failed.

Replace `cancelCurrent()` with:

```ts
async cancelCurrent() {
  const conversationId = this.selectedConversationId
  const requestId = this.activeRequestByConversation[conversationId]
  if (!requestId) {
    if (this.pendingRequestByConversation[conversationId]) {
      this._cancelRequestedByConversation[conversationId] = true
    }
    return
  }
  try { await getDesktopApi().chat.cancel(requestId) }
  catch (error) { this.error = displayError(error, '取消生成失败') }
},
```

- [ ] **Step 6: Keep terminal-before-return protection when a running event arrived first**

In `applyChatEvent()`, replace the terminal status branch with:

```ts
} else {
  const matchedActive = this.activeRequestByConversation[event.conversationId] === event.requestId
  if (matchedActive) delete this.activeRequestByConversation[event.conversationId]
  if (this.pendingRequestByConversation[event.conversationId] || !matchedActive) {
    this._terminalRequests[event.requestId] = true
    const terminalRequestIds = Object.keys(this._terminalRequests)
    if (terminalRequestIds.length > 100) delete this._terminalRequests[terminalRequestIds[0]!]
  }
}
```

This retains a terminal marker while the matching admission is unresolved, even if a preceding `running` event had temporarily populated the active request map. Once `send()` returns, its existing `alreadyTerminal` branch consumes that marker without resurrecting the request.

- [ ] **Step 7: Change the running button to the exact requested UI state**

In `apps/desktop/src/components/chat/ChatComposer.vue`, keep the existing `running` branch and `cancel` event, add a stable test selector, and replace its text:

```vue
<el-button
  v-if="running"
  type="danger"
  plain
  data-testid="cancel-send"
  :disabled="disabled"
  @click="$emit('cancel')"
>
  取消发送
</el-button>
```

- [ ] **Step 8: Run focused tests and inspect the task diff**

Run:

```bash
pnpm --dir apps/desktop exec vitest run --config vitest.config.ts tests/components/chat.test.ts
git diff --check
git diff -- apps/desktop/src/stores/chat.ts apps/desktop/src/components/chat/ChatComposer.vue apps/desktop/tests/components/chat.test.ts
```

Expected: all chat component tests pass; the diff contains only pending lifecycle state, exact button copy, and their regressions.

- [ ] **Step 9: Commit the pending cancellation behavior**

```bash
git add apps/desktop/src/stores/chat.ts apps/desktop/src/components/chat/ChatComposer.vue apps/desktop/tests/components/chat.test.ts
git commit -m "fix: show pending chat cancellation state"
```

---

### Task 2: Scroll the selected conversation to each latest message revision

**Files:**
- Modify: `apps/desktop/src/stores/chat.ts:204-212`
- Modify: `apps/desktop/src/views/ChatView.vue:25-31, 75-119`
- Test: `apps/desktop/tests/components/chat.test.ts`

**Interfaces:**
- Consumes: Existing `_messageVersions: Record<string, number>`, which increments on optimistic insertion, rollback, and every non-status chat event.
- Produces: `messageVersion(state): number` for the selected conversation, `messagesRef: Ref<HTMLElement | undefined>`, and `scrollToLatest(): Promise<void>`.

- [ ] **Step 1: Add a failing integration test for local insertion and incoming stream updates**

Add this test near the existing `ChatView` tests in `apps/desktop/tests/components/chat.test.ts`:

```ts
it('scrolls to the latest local and incoming chat content after rendering', async () => {
  const { api, emitChat } = createEventApi()
  let resolveSend!: (value: { requestId: string }) => void
  vi.mocked(api.chat.send).mockReturnValue(new Promise((resolve) => { resolveSend = resolve }))
  Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
  const chat = useChatStore()
  chat.conversations = [{
    id: 'conversation_1',
    title: '会话',
    createdAt: '2026-07-25T00:00:00.000Z',
    updatedAt: '2026-07-25T00:00:00.000Z',
  }]
  chat.selectedConversationId = 'conversation_1'
  chat.preferencesByConversation.conversation_1 = generationPreferences({
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
  }
  settings.providerModels.openrouter = [modelInfo('text/default', ['text'])]
  const wrapper = mount(ChatView, { global: { plugins: [ElementPlus] } })
  const messages = wrapper.get('.messages').element as HTMLElement
  Object.defineProperty(messages, 'scrollHeight', { configurable: true, value: 900 })

  messages.scrollTop = 0
  const sending = chat.send({
    content: '本地消息',
    assetIds: [],
    outputType: 'text',
    generation: generationPreferences().generation,
    model: 'text/default',
  })
  await vi.waitFor(() => expect(messages.scrollTop).toBe(900))

  messages.scrollTop = 0
  emitChat({
    type: 'block',
    conversationId: 'conversation_1',
    messageId: 'assistant_1',
    block: { type: 'text', text: '第一段' },
  })
  await vi.waitFor(() => expect(messages.scrollTop).toBe(900))

  messages.scrollTop = 0
  emitChat({
    type: 'block',
    conversationId: 'conversation_1',
    messageId: 'assistant_1',
    block: { type: 'text', text: '第二段' },
  })
  await vi.waitFor(() => expect(messages.scrollTop).toBe(900))

  resolveSend({ requestId: 'req_stream' })
  await sending
})
```

This proves both the local optimistic insertion and repeated incoming stream revisions move the actual message element's `scrollTop`; it does not mock the scroll function.

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```bash
pnpm --dir apps/desktop exec vitest run --config vitest.config.ts tests/components/chat.test.ts -t "scrolls to the latest local and incoming chat content after rendering"
```

Expected: FAIL because no watcher changes `.messages.scrollTop`.

- [ ] **Step 3: Expose the selected conversation's existing message revision**

Add this getter in `apps/desktop/src/stores/chat.ts` next to `messages`:

```ts
messageVersion(state): number {
  return state._messageVersions[state.selectedConversationId] ?? 0
},
```

Do not add another counter. `send()` and `applyChatEvent()` already update `_messageVersions` at every required boundary.

- [ ] **Step 4: Watch message revisions and scroll after Vue renders**

In `apps/desktop/src/views/ChatView.vue`, bind the existing scroll container:

```vue
<div
  ref="messagesRef"
  class="messages af-scrollbar"
  aria-live="polite"
>
```

Replace the Vue import with:

```ts
import { computed, nextTick, onMounted, ref, watch } from 'vue'
```

Create the ref and watcher after the stores are initialized:

```ts
const messagesRef = ref<HTMLElement>()

async function scrollToLatest() {
  await nextTick()
  const messages = messagesRef.value
  if (messages) messages.scrollTop = messages.scrollHeight
}

watch(
  () => [chat.selectedConversationId, chat.messageVersion] as const,
  () => { void scrollToLatest() },
  { flush: 'post' },
)
```

Watching the tuple makes conversation selection and message revision independent scroll triggers. `nextTick()` guarantees the new article or streamed text has rendered before `scrollHeight` is read.

- [ ] **Step 5: Run focused and complete Renderer tests**

Run:

```bash
pnpm --dir apps/desktop exec vitest run --config vitest.config.ts tests/components/chat.test.ts
pnpm --dir apps/desktop exec vitest run --config vitest.config.ts
git diff --check
```

Expected: all focused chat tests and the full Renderer suite pass.

- [ ] **Step 6: Commit the automatic scrolling behavior**

```bash
git add apps/desktop/src/stores/chat.ts apps/desktop/src/views/ChatView.vue apps/desktop/tests/components/chat.test.ts
git commit -m "fix: keep chat scrolled to latest message"
```

---

### Task 3: Repository and real Electron verification

**Files:**
- Verify only; no planned source changes.

**Interfaces:**
- Consumes: Task 1's pending request lifecycle and Task 2's selected message revision watcher.
- Produces: Test, static-analysis, build, native ABI restoration, and visible runtime evidence.

- [ ] **Step 1: Run static checks and build**

Run:

```bash
pnpm typecheck
pnpm lint
pnpm build
```

Expected: type checking and build exit 0. Lint exits 0; record any warnings as pre-existing unless the changed lines introduce them.

- [ ] **Step 2: Run the full repository suite**

Run:

```bash
pnpm test
```

Expected: all repository test files pass. This command rebuilds `better-sqlite3` for the local Node ABI through the root `pretest` script.

- [ ] **Step 3: Restore the Electron native ABI**

Run:

```bash
pnpm --filter @autoforge/desktop prepare:native-electron
```

Expected: `better-sqlite3` is rebuilt successfully for Electron 43 after the Node test suite.

- [ ] **Step 4: Verify the real Electron interaction**

With the existing development app running, perform these observable checks in the chat view:

1. Enter a distinct test message and press Enter.
2. Confirm the input clears and the action changes to exactly `取消发送` without waiting for the provider response.
3. Click `取消发送` while the request is pending or active, and confirm the UI leaves the running state after the cancellation event.
4. Confirm the sent user message is visible at the bottom of the message viewport.
5. Send another message without cancelling and confirm each received assistant update remains visible at the bottom as it streams.
6. Confirm the Renderer listener stays at `http://localhost:5173` and inspect the Main/Renderer terminal for uncaught errors.

If the configured provider is unavailable or responds before the pending state can be clicked, retain the automated unresolved-promise regression as the admission-race proof and report the precise live limitation instead of claiming that click path was observed.

- [ ] **Step 5: Confirm the final worktree and commit history**

Run:

```bash
git status --short
git log -5 --oneline
```

Expected: no uncommitted implementation changes remain, and both implementation commits are present after the design and plan commits.
