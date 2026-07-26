# Chat Response Loader Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show an AutoForge loader immediately after a valid chat submission and remove it when the first real response arrives or the request terminates.

**Architecture:** The Pinia chat store owns a conversation-scoped `awaitingResponseByConversation` marker because it already owns pending, active, cancellation, and terminal request state. `ChatView` reads a selected-conversation getter and renders one transient assistant-style loader without inserting a fake message or changing IPC. Existing message-version scrolling covers both optimistic submission and the first real response.

**Tech Stack:** Vue 3, Pinia, TypeScript, Element Plus, Vitest, Vue Test Utils, Electron

## Global Constraints

- Display the loader immediately after a valid local submission, before Main returns a `requestId`.
- Display the exact text `正在生成回复…` with the existing Element Plus spinning `Loading` icon.
- Present it as an `AutoForge` assistant message directly below the submitted user message.
- Remove it on the first assistant `block` or `block_update`, bridge rejection, `completed`, `cancelled`, or `failed`.
- Keep the state isolated by conversation and clear it on reset or successful conversation deletion.
- Do not persist the loader, create a synthetic `UiChatMessage`, add a new component, or change desktop IPC/Main chat events.
- Preserve the existing `取消发送` behavior, optimistic rollback, terminal-before-return guard, and unconditional scroll-to-latest behavior.

## File Structure

- Modify `apps/desktop/src/stores/chat.ts`: own the conversation-scoped awaiting-response lifecycle and expose the selected-conversation getter.
- Modify `apps/desktop/src/views/ChatView.vue`: render and style the transient assistant loader.
- Modify `apps/desktop/tests/components/chat.test.ts`: add store lifecycle, view rendering, replacement, isolation, cleanup, and scroll regressions.

---

### Task 1: Own the Awaiting-Response Lifecycle in the Chat Store

**Files:**
- Modify: `apps/desktop/src/stores/chat.ts:185-242`
- Modify: `apps/desktop/src/stores/chat.ts:313-331`
- Modify: `apps/desktop/src/stores/chat.ts:574-709`
- Test: `apps/desktop/tests/components/chat.test.ts`

**Interfaces:**
- Produces: public Pinia state `awaitingResponseByConversation: Record<string, true>`.
- Produces: getter `isAwaitingResponse: boolean` for the currently selected conversation.
- Consumes: existing `pendingRequestByConversation`, `activeRequestByConversation`, `send()`, `applyChatEvent()`, `resetLocalData()`, and `deleteConversation()`.

- [ ] **Step 1: Write failing store lifecycle tests**

Add focused tests near the existing pending-send tests:

```ts
it('awaits the first assistant block from the moment a valid send starts', async () => {
  const { api, emitChat } = createEventApi()
  let resolveSend!: (value: { requestId: string }) => void
  vi.mocked(api.chat.send).mockReturnValue(new Promise((resolve) => { resolveSend = resolve }))
  Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
  const store = useChatStore()
  store.selectedConversationId = 'conv_1'
  store.ensureSubscriptions()

  const sending = store.send({
    content: '立即显示 Loader',
    assetIds: [],
    outputType: 'text',
    generation: generationPreferences().generation,
  })

  expect(store.isAwaitingResponse).toBe(true)
  emitChat({
    type: 'status',
    conversationId: 'conv_1',
    requestId: 'req_loader',
    status: 'running',
  })
  expect(store.isAwaitingResponse).toBe(true)

  emitChat({
    type: 'block',
    conversationId: 'conv_1',
    messageId: 'assistant_loader',
    block: { type: 'text', text: '第一段回复' },
  })
  expect(store.isAwaitingResponse).toBe(false)

  emitChat({
    type: 'status',
    conversationId: 'conv_1',
    requestId: 'req_loader',
    status: 'completed',
  })
  resolveSend({ requestId: 'req_loader' })
  await sending
})

it.each(['completed', 'cancelled', 'failed'] as const)(
  'clears awaiting response on content-free %s before send returns',
  async (status) => {
    const { api, emitChat } = createEventApi()
    let resolveSend!: (value: { requestId: string }) => void
    vi.mocked(api.chat.send).mockReturnValue(new Promise((resolve) => { resolveSend = resolve }))
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const store = useChatStore()
    store.selectedConversationId = 'conv_1'
    store.ensureSubscriptions()

    const sending = store.send({
      content: '无内容终止',
      assetIds: [],
      outputType: 'text',
      generation: generationPreferences().generation,
    })
    expect(store.isAwaitingResponse).toBe(true)

    emitChat({
      type: 'status',
      conversationId: 'conv_1',
      requestId: `req_${status}`,
      status,
    })
    expect(store.isAwaitingResponse).toBe(false)

    resolveSend({ requestId: `req_${status}` })
    await sending
  },
)

it('clears awaiting response when the first event is a block update', () => {
  const { api, emitChat } = createEventApi()
  Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
  const store = useChatStore()
  store.selectedConversationId = 'conv_1'
  store.awaitingResponseByConversation.conv_1 = true
  store.ensureSubscriptions()

  emitChat({
    type: 'block_update',
    conversationId: 'conv_1',
    messageId: 'assistant_media',
    blockId: 'media_1',
    block: {
      type: 'media_generation',
      blockId: 'media_1',
      jobId: 'job_1',
      kind: 'image',
      status: 'in_progress',
    },
  })

  expect(store.isAwaitingResponse).toBe(false)
})

it('keeps awaiting-response state isolated and clears it on local reset', () => {
  const store = useChatStore()
  store.awaitingResponseByConversation.conversation_a = true
  store.selectedConversationId = 'conversation_a'
  expect(store.isAwaitingResponse).toBe(true)

  store.selectedConversationId = 'conversation_b'
  expect(store.isAwaitingResponse).toBe(false)

  store.resetLocalData()
  expect(store.awaitingResponseByConversation).toEqual({})
})
```

Extend the existing bridge-rejection test with:

```ts
expect(store.isAwaitingResponse).toBe(true)
rejectSend(new Error('rejected'))
expect(await sending).toBe(false)
expect(store.isAwaitingResponse).toBe(false)
```

In `closes media admission and joins a suspended import before deleting its
conversation`, add this line after assigning `store.conversations`:

```ts
store.awaitingResponseByConversation.conversation_1 = true
```

Add this assertion after the existing `expect(store.draftsByConversation.conversation_1).toBeUndefined()`:

```ts
expect(store.awaitingResponseByConversation.conversation_1).toBeUndefined()
```

- [ ] **Step 2: Run the focused tests and verify the RED state**

Run:

```bash
pnpm vitest run apps/desktop/tests/components/chat.test.ts -t "awaits the first assistant|content-free|first event is a block update|awaiting-response state|pending request and cancellation intent|closes media admission"
```

Expected: FAIL because `awaitingResponseByConversation` and `isAwaitingResponse` do not exist and no event path clears the marker.

- [ ] **Step 3: Add the minimal conversation-scoped state and lifecycle**

In `state`, place the new record beside the pending and active request records:

```ts
pendingRequestByConversation: {} as Record<string, true>,
activeRequestByConversation: {} as Record<string, string>,
awaitingResponseByConversation: {} as Record<string, true>,
```

Add the selected-conversation getter:

```ts
isAwaitingResponse(state): boolean {
  return Boolean(state.awaitingResponseByConversation[state.selectedConversationId])
},
```

Clear the full record in `resetLocalData()`:

```ts
this.awaitingResponseByConversation = {}
```

Clear a successfully deleted conversation's marker beside its other
conversation-scoped state:

```ts
delete this.awaitingResponseByConversation[id]
```

Set the marker synchronously in `send()` immediately after the pending marker:

```ts
this.pendingRequestByConversation[conversationId] = true
this.awaitingResponseByConversation[conversationId] = true
```

Clear it in the bridge-rejection path before rolling back the local user
message:

```ts
delete this.pendingRequestByConversation[conversationId]
delete this.awaitingResponseByConversation[conversationId]
delete this._cancelRequestedByConversation[conversationId]
```

In `applyChatEvent()`, preserve the marker for `running`, but clear it for every
terminal status:

```ts
if (event.status === 'running') {
  if (!this._terminalRequests[event.requestId]) {
    this.activeRequestByConversation[event.conversationId] = event.requestId
  }
} else {
  delete this.awaitingResponseByConversation[event.conversationId]
  const matchedActive = this.activeRequestByConversation[event.conversationId] === event.requestId
  if (matchedActive) delete this.activeRequestByConversation[event.conversationId]
  if (this.pendingRequestByConversation[event.conversationId] || !matchedActive) {
    this._terminalRequests[event.requestId] = true
    const terminalRequestIds = Object.keys(this._terminalRequests)
    if (terminalRequestIds.length > 100) delete this._terminalRequests[terminalRequestIds[0]!]
  }
}
```

Clear it before applying either non-status event:

```ts
delete this.awaitingResponseByConversation[event.conversationId]
this._messageVersions[event.conversationId] = (this._messageVersions[event.conversationId] ?? 0) + 1
```

- [ ] **Step 4: Run the complete chat test file**

Run:

```bash
pnpm vitest run apps/desktop/tests/components/chat.test.ts
```

Expected: all chat interaction tests PASS, including existing cancellation and terminal-event race tests.

- [ ] **Step 5: Commit the store lifecycle**

```bash
git add apps/desktop/src/stores/chat.ts apps/desktop/tests/components/chat.test.ts
git commit -m "feat: track pending chat response loader"
```

---

### Task 2: Render and Replace the Assistant Loader

**Files:**
- Modify: `apps/desktop/src/views/ChatView.vue:27-59`
- Modify: `apps/desktop/src/views/ChatView.vue:136-143`
- Test: `apps/desktop/tests/components/chat.test.ts`

**Interfaces:**
- Consumes: `chat.isAwaitingResponse: boolean` from Task 1.
- Consumes: existing `chat.messageVersion` scroll trigger.
- Produces: `[data-testid="response-loader"]` transient assistant article containing exact text `正在生成回复…`.

- [ ] **Step 1: Extend the existing auto-scroll test with failing loader assertions**

In `scrolls to the latest local and incoming chat content after rendering`,
assert the loader after `chat.send()` and its removal after the first block:

```ts
const sending = chat.send({
  content: '本地消息',
  assetIds: [],
  outputType: 'text',
  generation: generationPreferences().generation,
  model: 'text/default',
})

await vi.waitFor(() => {
  const loader = wrapper.get('[data-testid="response-loader"]')
  expect(loader.get('.message-role').text()).toBe('AutoForge')
  expect(loader.text()).toContain('正在生成回复…')
  expect(loader.find('.is-loading').exists()).toBe(true)
  expect(messages.scrollTop).toBe(900)
})

messages.scrollTop = 0
emitChat({
  type: 'block',
  conversationId: 'conversation_1',
  messageId: 'assistant_1',
  block: { type: 'text', text: '第一段' },
})
await vi.waitFor(() => {
  expect(wrapper.find('[data-testid="response-loader"]').exists()).toBe(false)
  expect(wrapper.text()).toContain('第一段')
  expect(messages.scrollTop).toBe(900)
})
```

Keep the second streamed block check to prove scrolling continues after the
loader has been replaced:

```ts
messages.scrollTop = 0
emitChat({
  type: 'block',
  conversationId: 'conversation_1',
  messageId: 'assistant_1',
  block: { type: 'text', text: '第二段' },
})
await vi.waitFor(() => expect(messages.scrollTop).toBe(900))
```

- [ ] **Step 2: Run the view regression and verify the RED state**

Run:

```bash
pnpm vitest run apps/desktop/tests/components/chat.test.ts -t "scrolls to the latest local and incoming chat content"
```

Expected: FAIL because `[data-testid="response-loader"]` is not rendered.

- [ ] **Step 3: Render the transient assistant-style loader**

Prevent the empty panel from competing with the loader:

```vue
<div
  v-if="!chat.messages.length && !chat.isAwaitingResponse"
  class="chat-empty"
>
```

After the real message `v-for`, add:

```vue
<article
  v-if="chat.isAwaitingResponse"
  class="message assistant"
  data-testid="response-loader"
>
  <span class="message-role">AutoForge</span>
  <div class="message-body">
    <div
      class="response-loader"
      role="status"
    >
      <el-icon class="is-loading">
        <Loading />
      </el-icon>
      <span>正在生成回复…</span>
    </div>
  </div>
</article>
```

Add only the loader-specific layout styling:

```css
.response-loader { display: flex; align-items: center; gap: 7px; color: var(--af-text-muted); font-size: 12px; }
```

Do not change the current message-version watcher. The synchronous optimistic
message insertion and first real block already trigger its post-render scroll.

- [ ] **Step 4: Run focused and Renderer tests**

Run:

```bash
pnpm vitest run apps/desktop/tests/components/chat.test.ts
pnpm --filter @autoforge/desktop exec vitest run --config vitest.config.ts
```

Expected: the complete chat test file and desktop Renderer suite PASS.

- [ ] **Step 5: Commit the Loader presentation**

```bash
git add apps/desktop/src/views/ChatView.vue apps/desktop/tests/components/chat.test.ts
git commit -m "feat: show loader before chat response"
```

---

### Task 3: Verify the Complete Change

**Files:**
- Verify only: no source changes expected.

**Interfaces:**
- Consumes: completed Store and `ChatView` behavior from Tasks 1 and 2.
- Produces: automated and real-Electron evidence that the exact Loader lifecycle works.

- [ ] **Step 1: Run static and build verification**

Run:

```bash
pnpm typecheck
pnpm lint
pnpm build
```

Expected: typecheck and build exit 0; lint exits 0 with no new errors. Existing baseline warnings must be reported as existing rather than silently called clean.

- [ ] **Step 2: Run the full repository test suite**

Run:

```bash
pnpm test
```

Expected: all repository tests PASS. This command prepares `better-sqlite3` for
the local Node ABI before Vitest runs.

- [ ] **Step 3: Restore the Electron native ABI**

Run:

```bash
pnpm --filter @autoforge/desktop prepare:native-electron
```

Expected: `better-sqlite3` is rebuilt for the installed Electron runtime so the
real desktop application can continue to start.

- [ ] **Step 4: Verify the real Electron interaction**

Use the running development app if it is healthy; otherwise start it with:

```bash
pnpm dev
```

In the real Electron window:

1. Open an existing configured chat conversation.
2. Enter a unique message such as `loader-runtime-check-20260726` and send it.
3. Immediately verify the input clears, the button reads `取消发送`, an
   `AutoForge` row below the user message shows the spinning icon and exact text
   `正在生成回复…`, and the viewport is at the latest content.
4. When the first model text or media-generation block appears, verify the
   Loader is gone, the real assistant content occupies its place, and the
   viewport remains at the latest content.
5. Send a second unique message and click `取消发送` before reply content;
   verify the Loader disappears when the cancellation status arrives.

If provider availability prevents first-content verification, report the
runtime check as partial and name the exact blocked boundary. Do not substitute
a mounted-component test for real Electron evidence.

- [ ] **Step 5: Confirm repository state**

Run:

```bash
git status --short
git log -4 --oneline
```

Expected: no uncommitted implementation changes remain, and the two feature
commits from Tasks 1 and 2 are present.
