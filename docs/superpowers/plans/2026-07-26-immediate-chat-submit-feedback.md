# Immediate Chat Submit Feedback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Enter submission clear the chat composer immediately while preserving submitted text for recovery when Main rejects the request.

**Architecture:** Keep the existing Renderer, Preload, IPC, and Main contracts unchanged. Adjust only `ChatComposer`'s acknowledgement boundary: clear the captured conversation draft optimistically before emitting, retain the existing pending guard, and restore the exact submission on rejection without overwriting a newer draft.

**Tech Stack:** Vue 3 Composition API, Pinia, TypeScript, Vitest, Vue Test Utils, Element Plus

## Global Constraints

- Enter must immediately show the existing optimistic user message and clear the submitted text.
- Shift+Enter and IME composition behavior must remain unchanged.
- Duplicate submission must stay blocked until Main acknowledges the request.
- Main rejection must use the existing optimistic-message rollback and localized error flow.
- A newer draft must never be overwritten by restoration of a failed submission.
- Attachments must remain in the existing draft flow until Main accepts them.
- Do not change the Electron IPC contract or Main preflight behavior.

---

## File Structure

- Modify `apps/desktop/tests/components/chat.test.ts`: define the observable immediate-clear and failure-restoration behavior at the real `ChatComposer`/Pinia boundary.
- Modify `apps/desktop/src/components/chat/ChatComposer.vue`: own optimistic text clearing and conversation-scoped restoration while leaving send execution in the store.

### Task 1: Immediate Composer Feedback and Failure Recovery

**Files:**
- Modify: `apps/desktop/tests/components/chat.test.ts:1369-1440`
- Modify: `apps/desktop/src/components/chat/ChatComposer.vue:603-633`

**Interfaces:**
- Consumes: `ChatComposer`'s existing `submit(input, acknowledge)` event, where `acknowledge` has type `(accepted: boolean) => void`.
- Produces: immediate conversation-scoped composer clearing and rejection recovery; no new exported API.

- [ ] **Step 1: Change the existing acceptance regression to require immediate clearing**

Rename the existing test and change its pending-send assertions so the exact
submitted text clears before the unresolved Main promise settles, then returns
when the promise rejects:

```ts
it('clears composer text immediately and restores it when Main rejects', async () => {
  const { api } = createEventApi()
  let rejectFirst!: (error: Error) => void
  vi.mocked(api.chat.send).mockReturnValueOnce(new Promise((_resolve, reject) => { rejectFirst = reject }))
  Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
  const store = useChatStore()
  store.selectedConversationId = 'conversation_1'
  store.draftsByConversation.conversation_1 = [mediaAsset('asset_1')]
  store.preferencesByConversation.conversation_1 = generationPreferences({
    outputType: 'text',
    models: { text: 'text/model' },
  })
  const wrapper = mount(ChatComposer, {
    props: {
      disabled: false,
      running: false,
      models: [modelInfo('text/model', ['text'])],
      defaultModel: 'text/model',
      onSubmit: async (input, acknowledge) => { acknowledge(await store.send(input)) },
    },
    global: { plugins: [ElementPlus] },
  })
  const textarea = wrapper.get('textarea')

  await textarea.setValue('不能丢失')
  await wrapper.get('form').trigger('submit')
  await vi.waitFor(() => expect(api.chat.send).toHaveBeenCalledTimes(1))
  expect((textarea.element as HTMLTextAreaElement).value).toBe('')
  expect(store.messagesByConversation.conversation_1).toHaveLength(1)

  rejectFirst(new Error('rejected'))
  await vi.waitFor(() => expect(store.messagesByConversation.conversation_1).toEqual([]))
  expect((textarea.element as HTMLTextAreaElement).value).toBe('不能丢失')
  expect(store.drafts.map(({ id }) => id)).toEqual(['asset_1'])

  vi.mocked(api.chat.send).mockResolvedValueOnce({ requestId: 'accepted' })
  await wrapper.get('form').trigger('submit')
  await vi.waitFor(() => expect(api.chat.send).toHaveBeenCalledTimes(2))
  expect((textarea.element as HTMLTextAreaElement).value).toBe('')
  expect(store.drafts).toEqual([])
})
```

- [ ] **Step 2: Add a rejection regression for a newer draft**

Add this focused test immediately after the acceptance regression:

```ts
it('restores a rejected submission without overwriting a newer draft', async () => {
  const store = useChatStore()
  store.selectedConversationId = 'conversation_1'
  store.preferencesByConversation.conversation_1 = generationPreferences({ outputType: 'text' })
  const wrapper = mount(ChatComposer, {
    props: {
      disabled: false,
      running: false,
      models: [modelInfo('text/model', ['text'])],
      defaultModel: 'text/model',
    },
    global: { plugins: [ElementPlus] },
  })
  const textarea = wrapper.get('textarea')

  await textarea.setValue('发送失败')
  await wrapper.get('form').trigger('submit')
  const acknowledge = wrapper.emitted('submit')?.[0]?.[1] as ((accepted: boolean) => void)
  expect((textarea.element as HTMLTextAreaElement).value).toBe('')

  await textarea.setValue('新的草稿')
  acknowledge(false)
  await wrapper.vm.$nextTick()

  expect((textarea.element as HTMLTextAreaElement).value).toBe('发送失败\n\n新的草稿')
})
```

The production mutation these tests catch is moving composer clearing back
behind asynchronous Main acknowledgement or restoring a failed submission by
overwriting text typed afterward.

- [ ] **Step 3: Run the focused tests and verify RED**

Run:

```bash
pnpm --dir apps/desktop exec vitest run --config vitest.config.ts tests/components/chat.test.ts
```

Expected: FAIL at the new immediate-clear assertions because current
`ChatComposer` clears only when `accepted === true`; the newer-draft
restoration assertion must also fail because rejection currently performs no
restoration.

- [ ] **Step 4: Implement optimistic clear and rejection restoration**

In `ChatComposer.vue`, replace only the pending acknowledgement portion of
`submit()` with:

```ts
const pendingId = ++pendingSequence
pendingByConversation.value[conversationId] = pendingId
if (contentsByConversation.value[conversationId] === submittedContent) {
  delete contentsByConversation.value[conversationId]
}
let acknowledged = false
emit('submit', payload, (accepted) => {
  if (acknowledged) return
  acknowledged = true
  if (pendingByConversation.value[conversationId] === pendingId) {
    delete pendingByConversation.value[conversationId]
  }
  if (accepted) return
  const newerContent = contentsByConversation.value[conversationId] ?? ''
  contentsByConversation.value[conversationId] = newerContent
    ? `${submittedContent}\n\n${newerContent}`
    : submittedContent
})
```

Do not change `ChatView.submit`, `chat.send`, attachment cleanup, error
mapping, or any Main/Preload file.

- [ ] **Step 5: Run the focused tests and verify GREEN**

Run:

```bash
pnpm --dir apps/desktop exec vitest run --config vitest.config.ts tests/components/chat.test.ts
```

Expected: PASS for the entire chat component test file, including IME,
Shift+Enter, duplicate-send, conversation-isolation, attachment, and rollback
coverage.

- [ ] **Step 6: Run desktop renderer regressions and static checks**

Run:

```bash
pnpm --dir apps/desktop exec vitest run --config vitest.config.ts
pnpm --filter @autoforge/desktop typecheck
pnpm lint
pnpm build
```

Expected: all commands exit with status 0 and no new warnings attributable to
the change.

- [ ] **Step 7: Verify the real Electron interaction**

Start the existing development app with:

```bash
pnpm dev
```

In an existing or newly created chat conversation:

1. Type a text message.
2. Press Enter once.
3. Confirm the user message appears and the composer clears immediately,
   before provider preflight or the assistant response finishes.
4. Confirm the cancel/running state and eventual response still follow the
   existing flow.

If Electron, native ABI preparation, local credentials, or provider access
prevents this check, preserve the passing automated evidence and report real
runtime verification as partial with the exact blocker.

- [ ] **Step 8: Review the surgical diff and commit**

Run:

```bash
git diff --check
git diff -- apps/desktop/tests/components/chat.test.ts apps/desktop/src/components/chat/ChatComposer.vue
git status --short
```

Confirm every production change traces to immediate clear or failure recovery,
then commit:

```bash
git add apps/desktop/tests/components/chat.test.ts apps/desktop/src/components/chat/ChatComposer.vue
git commit -m "fix: clear chat composer on submit"
```
