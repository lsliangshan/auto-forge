# Conversation Context Compression Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every text chat use ordered history from its conversation and incrementally compress old history into a Main-only rolling summary when the selected model's input budget is exceeded.

**Architecture:** Add deterministic per-conversation message ordinals and an internal summary checkpoint to SQLite. A focused Main-process `ConversationContextManager` serializes safe historical blocks, estimates the request budget, calls the same selected provider for incremental summaries, and returns a history prefix to `AgentOrchestrator`; Renderer, Preload, and IPC chat shapes stay unchanged.

**Tech Stack:** Electron 43, TypeScript 6, better-sqlite3 12, Zod 4, Vitest 4, Vue 3, OpenAI-compatible OpenRouter/DeepSeek streaming

## Global Constraints

- Conversation isolation is exactly `conversation_id`; a new conversation inherits nothing.
- Summaries stay Main-only and never appear in Renderer state, Preload, IPC payloads, message rows, chat blocks, events, diagnostics, or logs.
- The transcript remains complete and unchanged in the chat UI.
- Historical attachments use safe metadata markers only; never reload bytes, Base64, absolute paths, or URLs.
- Only current-message attachments may enter `modelContent`.
- The selected catalog `contextLength` is authoritative when positive; otherwise use exactly `32,000` tokens.
- Final chat input budget is exactly `floor(contextLength * 0.60)`.
- Summary input budget is at most `floor(contextLength * 0.90)` and summary output is `min(2048, floor(contextLength * 0.10))` tokens.
- Initially protect the latest four complete turns, shrink from the oldest message only when required, never split a persisted message, and never silently drop unsummarized history.
- Use the same provider and selected model for compression; do not add another credential or model setting.
- Same-conversation concurrent agent runs return `CONFLICT` before writing a second user message; different conversations remain independent.
- Context overflow uses `CONTEXT_LIMIT_EXCEEDED` and exact Chinese copy `当前输入和会话上下文超出模型限制，请缩短输入或新建会话`.
- No new runtime dependency is allowed; token estimation is deterministic and local.
- Preserve the existing Main-only credential boundary and provider diagnostic redaction.
- Preserve the user's unrelated uncommitted `CHAT.md` change; every `git add` command names only task files.

---

### Task 1: Carry model limits and safe context errors through existing contracts

**Files:**
- Modify: `packages/shared/src/errors.ts`
- Modify: `packages/shared/src/contracts.test.ts`
- Modify: `apps/desktop/electron/main/chat/model-provider.ts`
- Modify: `apps/desktop/electron/main/chat/multimodal-router.ts`
- Modify: `apps/desktop/electron/main/chat/multimodal-router.test.ts`
- Modify: `apps/desktop/electron/main/chat/openrouter-provider.test.ts`
- Modify: `apps/desktop/src/services/desktop-api.ts`
- Modify: `apps/desktop/tests/components/chat.test.ts`

**Interfaces:**
- Produces: `AppErrorCode` member `CONTEXT_LIMIT_EXCEEDED`.
- Produces: `ResolvedChatRoute.contextLength?: number` copied from the selected `ModelInfo`.
- Produces: `ModelStreamRequest.maxOutputTokens?: number`, serialized as `max_tokens` only when defined.
- Consumes: existing `ModelInfo.contextLength?: number` and existing safe-error display path.

- [ ] **Step 1: Write failing contract, route, wire-body, and localized-error tests**

Add these assertions to the existing focused tests:

```ts
// packages/shared/src/contracts.test.ts
expect(appErrorCodeSchema.parse('CONTEXT_LIMIT_EXCEEDED'))
  .toBe('CONTEXT_LIMIT_EXCEEDED')

// apps/desktop/electron/main/chat/multimodal-router.test.ts
const resolved = resolveChatRoute(input({
  models: [model({ id: 'bounded/model', contextLength: 131_072 })],
  requestedModel: 'bounded/model',
  requestedOutput: 'text',
}))
expect(resolved).toMatchObject({
  model: 'bounded/model',
  contextLength: 131_072,
})

// apps/desktop/electron/main/chat/openrouter-provider.test.ts
await collect(provider.stream({
  model: 'summary-model',
  messages: [{ role: 'user', content: 'compress' }],
  maxOutputTokens: 512,
}))
expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toMatchObject({
  max_tokens: 512,
})

// apps/desktop/tests/components/chat.test.ts
expect(displayError({ code: 'CONTEXT_LIMIT_EXCEEDED', message: 'unsafe' }))
  .toBe('当前输入和会话上下文超出模型限制，请缩短输入或新建会话')
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
pnpm test -- packages/shared/src/contracts.test.ts apps/desktop/electron/main/chat/multimodal-router.test.ts apps/desktop/electron/main/chat/openrouter-provider.test.ts apps/desktop/tests/components/chat.test.ts
```

Expected: failures show that `CONTEXT_LIMIT_EXCEEDED`, route `contextLength`, request `maxOutputTokens`, and localized copy are absent.

- [ ] **Step 3: Add the minimal contract and wire implementation**

Add the error code and safe English message:

```ts
// packages/shared/src/errors.ts
'CONTEXT_LIMIT_EXCEEDED',

CONTEXT_LIMIT_EXCEEDED: 'The conversation context exceeds the selected model limit.',
```

Extend the internal request and route interfaces:

```ts
// apps/desktop/electron/main/chat/model-provider.ts
export interface ModelStreamRequest {
  model: string
  messages: ModelMessage[]
  tools?: ModelTool[]
  output?: { type: 'text' } | { type: 'audio'; voice?: string; format: string }
  maxOutputTokens?: number
  signal?: AbortSignal
}

// inside the OpenAI-compatible JSON body
...(request.maxOutputTokens === undefined
  ? {}
  : { max_tokens: request.maxOutputTokens }),
```

```ts
// apps/desktop/electron/main/chat/multimodal-router.ts
export interface ResolvedChatRoute {
  provider: ModelProviderId
  model: string
  contextLength?: number
  // existing fields remain unchanged
}

// route(...)
...(model.contextLength === undefined
  ? {}
  : { contextLength: model.contextLength }),
```

Add the exact Chinese mapping in `apps/desktop/src/services/desktop-api.ts`.

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run the Step 2 command again.

Expected: all selected contract, router, provider, and Renderer tests pass.

- [ ] **Step 5: Commit the contract slice**

```bash
git add packages/shared/src/errors.ts packages/shared/src/contracts.test.ts apps/desktop/electron/main/chat/model-provider.ts apps/desktop/electron/main/chat/multimodal-router.ts apps/desktop/electron/main/chat/multimodal-router.test.ts apps/desktop/electron/main/chat/openrouter-provider.test.ts apps/desktop/src/services/desktop-api.ts apps/desktop/tests/components/chat.test.ts
git commit -m "feat: expose chat context limits internally"
```

---

### Task 2: Persist deterministic message order and rolling-summary checkpoints

**Files:**
- Create: `apps/desktop/resources/migrations/0003_conversation_context.sql`
- Modify: `apps/desktop/electron/main/database/repositories.ts`
- Modify: `apps/desktop/electron/main/database/database.test.ts`

**Interfaces:**
- Produces: `Message.ordinal: number`; `MessageInput` continues to omit storage-assigned ordinal.
- Produces: `ConversationContextRecord` and `ConversationContextAdvanceInput`.
- Produces: `AppRepositories.conversationContexts.get(conversationId)` and `.advance(input)`.
- Produces: `messages.listBeforeOrdinal(conversationId, beforeOrdinal)`.
- Consumes: existing `messages` insert paths, including media-generation transactions.

- [ ] **Step 1: Write failing migration, ordering, and checkpoint tests**

Extend `database.test.ts` with timestamp-tie and checkpoint coverage:

```ts
it('backfills insertion order and allocates independent conversation ordinals', () => {
  const database = openTestDatabase()
  database.conversations.insert({ id: 'c1', title: 'One' })
  database.conversations.insert({ id: 'c2', title: 'Two' })
  database.messages.insert({
    id: 'z-user', conversationId: 'c1', role: 'user',
    blocks: [{ type: 'text', text: 'first' }], createdAt: 10,
  })
  database.messages.insert({
    id: 'a-assistant', conversationId: 'c1', role: 'assistant',
    blocks: [{ type: 'text', text: 'second' }], createdAt: 10,
  })
  database.messages.insert({
    id: 'other', conversationId: 'c2', role: 'user',
    blocks: [{ type: 'text', text: 'independent' }], createdAt: 10,
  })

  expect(database.messages.listForConversation('c1').map(({ id, ordinal }) => ({ id, ordinal })))
    .toEqual([{ id: 'z-user', ordinal: 1 }, { id: 'a-assistant', ordinal: 2 }])
  expect(database.messages.get('other')?.ordinal).toBe(1)
})

it('advances a summary atomically from the expected checkpoint', () => {
  const database = openTestDatabase()
  database.conversations.insert({ id: 'context-c', title: 'Context' })

  expect(database.conversationContexts.get('context-c')).toBeUndefined()
  expect(database.conversationContexts.advance({
    conversationId: 'context-c', expectedThroughOrdinal: 0,
    summaryText: 'Known fact', throughOrdinal: 2,
    estimatedTokens: 4, updatedAt: 20,
  })).toMatchObject({ summaryText: 'Known fact', throughOrdinal: 2 })
  expect(() => database.conversationContexts.advance({
    conversationId: 'context-c', expectedThroughOrdinal: 0,
    summaryText: 'stale', throughOrdinal: 3,
    estimatedTokens: 2, updatedAt: 21,
  })).toThrow('Conversation context checkpoint changed')

  database.conversations.delete('context-c')
  expect(database.conversationContexts.get('context-c')).toBeUndefined()
})
```

Also update the populated-v1 upgrade fixture to assert `schemaVersion() === 3` and `message_v1.ordinal === 1`.

- [ ] **Step 2: Run the database test and verify RED**

Run:

```bash
pnpm test -- apps/desktop/electron/main/database/database.test.ts
```

Expected: the database remains at migration 2 and repository values do not have `ordinal` or `conversationContexts`.

- [ ] **Step 3: Add migration 0003**

Create the migration with deterministic backfill and cascade storage:

```sql
ALTER TABLE messages ADD COLUMN ordinal INTEGER;

WITH ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY conversation_id
      ORDER BY created_at, rowid
    ) AS ordinal
  FROM messages
)
UPDATE messages
SET ordinal = (SELECT ranked.ordinal FROM ranked WHERE ranked.id = messages.id);

CREATE UNIQUE INDEX messages_conversation_ordinal_idx
  ON messages(conversation_id, ordinal);

CREATE TABLE conversation_contexts (
  conversation_id TEXT PRIMARY KEY
    REFERENCES conversations(id) ON DELETE CASCADE,
  summary_text TEXT NOT NULL,
  through_ordinal INTEGER NOT NULL CHECK (through_ordinal >= 0),
  estimated_tokens INTEGER NOT NULL CHECK (estimated_tokens >= 0),
  updated_at INTEGER NOT NULL
);
```

- [ ] **Step 4: Implement ordinal allocation and checkpoint compare-and-swap**

Add exact internal types:

```ts
export interface Message {
  id: string
  conversationId: string
  role: string
  blocks: unknown[]
  ordinal: number
  executionId?: string
  createdAt: number
}

export type MessageInput = Omit<Message, 'ordinal' | 'executionId'> & {
  executionId?: string
}

export interface ConversationContextRecord {
  conversationId: string
  summaryText: string
  throughOrdinal: number
  estimatedTokens: number
  updatedAt: number
}

export interface ConversationContextAdvanceInput
  extends ConversationContextRecord {
  expectedThroughOrdinal: number
}
```

Use one helper from every plain and media insert path:

```ts
function nextMessageOrdinal(database: SqliteDatabase, conversationId: string): number {
  const row = one<{ ordinal: number }>(database, `
    SELECT COALESCE(MAX(ordinal), 0) + 1 AS ordinal
    FROM messages
    WHERE conversation_id = @conversationId
  `, { conversationId })
  if (!row || !Number.isSafeInteger(row.ordinal) || row.ordinal < 1) {
    throw new Error('Message ordinal is invalid')
  }
  return row.ordinal
}
```

Include `ordinal` in `messageColumns`, validate it in `messageFromRow`, insert it
in `messages.insert`, `insertMessageWithAssets`, `startMediaGeneration`, and the
video-generation transaction paths, and order `listForConversation` by
`ordinal`. Implement:

```ts
listBeforeOrdinal: (conversationId, beforeOrdinal) => many<Query>(database, `
  SELECT ${messageColumns}
  FROM messages
  WHERE conversation_id = @conversationId AND ordinal < @beforeOrdinal
  ORDER BY ordinal
`, { conversationId, beforeOrdinal }).map(messageFromRow)
```

Implement `conversationContexts.advance` as a single transaction. Insert only
when `expectedThroughOrdinal === 0`; otherwise update only where
`through_ordinal = @expectedThroughOrdinal`. Require exactly one changed row and
then re-read the stored record.

- [ ] **Step 5: Run the database test and verify GREEN**

Run the Step 2 command again.

Expected: migration, backfill, new inserts, checkpoint conflict, and cascade tests pass.

- [ ] **Step 6: Commit the persistence slice**

```bash
git add apps/desktop/resources/migrations/0003_conversation_context.sql apps/desktop/electron/main/database/repositories.ts apps/desktop/electron/main/database/database.test.ts
git commit -m "feat: persist ordered conversation context"
```

---

### Task 3: Serialize safe history and estimate model input deterministically

**Files:**
- Create: `apps/desktop/electron/main/chat/conversation-context.ts`
- Create: `apps/desktop/electron/main/chat/conversation-context.test.ts`

**Interfaces:**
- Consumes: `Message`, `ChatBlock`, `ModelMessage`, `ModelTool`, and current media metadata.
- Produces: `serializeHistoricalMessage(message): ModelMessage | undefined`.
- Produces: `estimateTextTokens(text): number`.
- Produces: `estimateRequestTokens(input): number` and `currentMediaTokenReserve(media): number`.

- [ ] **Step 1: Write failing serializer tests**

Create `conversation-context.test.ts` with real block values:

```ts
it('serializes text, workflows, failures, and attachment metadata without payloads or paths', () => {
  const message: Message = {
    id: 'm1', conversationId: 'c1', role: 'assistant', ordinal: 1, createdAt: 1,
    blocks: [
      { type: 'text', text: '结果如下' },
      { type: 'workflow_proposal', workflowId: 'browser.search.baidu', workflowName: '百度搜索', args: { keyword: '天气' } },
      { type: 'execution_result', executionId: 'e1', summary: 'Workflow completed.' },
      { type: 'media', blockId: 'b1', assetId: 'a1', kind: 'image', purpose: 'output', name: 'weather.png', mimeType: 'image/png', byteSize: 2048 },
    ],
  }

  const serialized = serializeHistoricalMessage(message)
  expect(serialized).toEqual({
    role: 'assistant',
    content: expect.stringContaining('weather.png'),
  })
  expect(JSON.stringify(serialized)).toContain('browser.search.baidu')
  expect(JSON.stringify(serialized)).not.toMatch(/base64|\/Users\/|file:\/\/|https?:\/\//i)
})

it('omits transient-only history and rejects unknown roles', () => {
  expect(serializeHistoricalMessage({
    id: 'm2', conversationId: 'c1', role: 'assistant', ordinal: 2, createdAt: 2,
    blocks: [{ type: 'reasoning_status', label: '思考中' }],
  })).toBeUndefined()
  expect(() => serializeHistoricalMessage({
    id: 'm3', conversationId: 'c1', role: 'system', ordinal: 3,
    createdAt: 3, blocks: [],
  })).toThrow('Historical message role is invalid')
})
```

- [ ] **Step 2: Write failing estimator and media-reserve tests**

```ts
it('uses deterministic CJK, JSON, protocol, and tool overhead', () => {
  const short = estimateRequestTokens({
    messages: [{ role: 'user', content: 'hello 你好' }],
    tools: [],
    currentMedia: [],
  })
  const withTool = estimateRequestTokens({
    messages: [{ role: 'user', content: 'hello 你好' }],
    tools: [{ type: 'function', function: { name: 'search', description: '搜索', parameters: { type: 'object' } } }],
    currentMedia: [],
  })
  expect(short).toBeGreaterThan(2)
  expect(withTool).toBeGreaterThan(short)
})

it('reserves exact media budgets', () => {
  expect(currentMediaTokenReserve({ kind: 'image' })).toBe(2_048)
  expect(currentMediaTokenReserve({ kind: 'audio', durationMs: 10_000 })).toBe(2_048)
  expect(currentMediaTokenReserve({ kind: 'audio' })).toBe(8_192)
  expect(currentMediaTokenReserve({ kind: 'video', durationMs: 60_000 })).toBe(7_680)
  expect(currentMediaTokenReserve({ kind: 'video' })).toBe(16_384)
})
```

- [ ] **Step 3: Run the new test and verify RED**

Run:

```bash
pnpm test -- apps/desktop/electron/main/chat/conversation-context.test.ts
```

Expected: module exports are missing.

- [ ] **Step 4: Implement exhaustive safe serialization**

Implement an exhaustive `switch` over parsed `ChatBlock` values. Use only fields
declared by `chatBlockSchema`; never stringify the whole message or asset:

```ts
function safeJson(value: unknown): string {
  return JSON.stringify(value) ?? 'null'
}

function serializeBlock(block: ChatBlock): string[] {
  switch (block.type) {
    case 'text':
      return block.text ? [block.text] : []
    case 'reasoning_status':
      return []
    case 'media':
      return [`[历史附件: ${block.kind}; 名称: ${block.name}; MIME: ${block.mimeType}; 大小: ${block.byteSize} bytes]`]
    case 'workflow_proposal':
      return [`[工作流提议: ${block.workflowName} (${block.workflowId}); 参数: ${safeJson(block.args)}]`]
    case 'approval':
      return [`[工作流等待权限审批: ${block.workflowId}@${block.workflowVersion}; 能力: ${block.capability}]`]
    case 'workflow_execution':
      return [`[工作流执行: ${block.executionId}]`]
    case 'execution_result':
      return [`[工作流结果: ${block.executionId}; ${block.summary}]`]
    case 'error':
      return [`[请求失败: ${block.code}; ${block.message}]`]
    case 'media_generation':
      return [`[${block.kind} 生成状态: ${block.status}${block.errorCode ? `; ${block.errorCode}` : ''}]`]
  }
}
```

Use this signature and role guard:

```ts
export function serializeHistoricalMessage(message: Message): ModelMessage | undefined {
  if (message.role !== 'user' && message.role !== 'assistant') {
    throw new Error('Historical message role is invalid')
  }
  const content = chatBlockSchema.array().parse(message.blocks)
    .flatMap(serializeBlock)
    .filter((part) => part.length > 0)
    .join('\n')
    .trim()
  return content ? { role: message.role, content } : undefined
}
```

For workflow arguments, use `JSON.stringify(block.args)` only after the strict
block parse, and cap neither text nor JSON here; the budget manager decides fit
without silently truncating.

- [ ] **Step 5: Implement estimator and media reserves**

Use constants rather than a tokenizer dependency:

```ts
const REQUEST_OVERHEAD = 12
const MESSAGE_OVERHEAD = 8
const TOOL_OVERHEAD = 12

export function estimateTextTokens(text: string): number {
  let cjk = 0
  let other = 0
  for (const character of text) {
    if (/\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u.test(character)) cjk += 1
    else other += Buffer.byteLength(character, 'utf8')
  }
  return cjk + Math.ceil(other / 3)
}
```

Add message/tool JSON estimates and the exact media rules from the design:
image `2_048`; audio `max(2_048, ceil(seconds) * 64)` with unknown `8_192`;
video `max(4_096, ceil(seconds) * 128)` with unknown `16_384`; audio/video cap
`16_384`.

- [ ] **Step 6: Run the context primitive test and verify GREEN**

Run the Step 3 command again.

Expected: serialization, non-leakage, estimator, and media reserve tests pass.

- [ ] **Step 7: Commit the context primitives**

```bash
git add apps/desktop/electron/main/chat/conversation-context.ts apps/desktop/electron/main/chat/conversation-context.test.ts
git commit -m "feat: serialize and budget chat history"
```

---

### Task 4: Build incremental rolling-summary preparation

**Files:**
- Modify: `apps/desktop/electron/main/chat/conversation-context.ts`
- Modify: `apps/desktop/electron/main/chat/conversation-context.test.ts`

**Interfaces:**
- Consumes: `AppRepositories.messages.listBeforeOrdinal`, `conversationContexts`, a structural `ConversationContextProviderPort`, current `ModelMessage`, tools, model ID, context length, media metadata, and `AbortSignal`.
- Produces: `ConversationHistoryPort.prepare(input): Promise<ModelMessage[]>`.
- Produces: `createConversationContextManager(repositories): ConversationHistoryPort`.
- The returned array contains only the system summary and raw historical messages; the orchestrator appends the current user message.

- [ ] **Step 1: Add concrete test fixtures for ordered history and provider events**

Start the Task 4 test section with reusable real-value helpers:

```ts
function historical(role: 'user' | 'assistant', ordinal: number, text: string): Message {
  return {
    id: `message_${ordinal}`,
    conversationId: 'c1',
    role,
    ordinal,
    blocks: [{ type: 'text', text }],
    createdAt: ordinal,
  }
}

const user = (ordinal: number, text: string) => historical('user', ordinal, text)
const assistant = (ordinal: number, text: string) => historical('assistant', ordinal, text)

function prepareInput(
  overrides: Partial<PrepareConversationContextInput> = {},
): PrepareConversationContextInput {
  return {
    conversationId: 'c1',
    beforeOrdinal: 11,
    provider: overrides.provider ?? { stream: vi.fn(async function* () {}) },
    model: 'tiny-model',
    contextLength: 2_000,
    currentMessage: { role: 'user', content: 'current' },
    tools: [],
    currentMedia: [],
    signal: new AbortController().signal,
    ...overrides,
  }
}

function contextHarness(options: {
  messages?: Message[]
  context?: ConversationContextRecord
  events?: ModelStreamEvent[]
  forceOverflow?: boolean
} = {}) {
  let context = options.context
  const advance = vi.fn((input: ConversationContextAdvanceInput) => {
    if ((context?.throughOrdinal ?? 0) !== input.expectedThroughOrdinal) {
      throw new Error('Conversation context checkpoint changed')
    }
    context = input
    return input
  })
  const provider = {
    stream: vi.fn(async function* () {
      for (const event of options.events ?? [
        { type: 'text_delta' as const, choiceIndex: 0, text: '用户目标：保留早期事实' },
        { type: 'finish' as const, choiceIndex: 0, reason: 'stop' },
      ]) yield event
    }),
  }
  const repositories = {
    messages: {
      listBeforeOrdinal: vi.fn(() => options.messages ?? (
        options.forceOverflow
          ? Array.from({ length: 10 }, (_, index) => historical(index % 2 ? 'assistant' : 'user', index + 1, '很长的历史内容'.repeat(20)))
          : []
      )),
    },
    conversationContexts: {
      get: vi.fn(() => context),
      advance,
    },
  }
  return {
    manager: createConversationContextManager(repositories),
    provider,
    store: repositories.conversationContexts,
  }
}
```

- [ ] **Step 2: Write a below-budget failing test**

```ts
it('returns ordered raw history without calling the provider below budget', async () => {
  const { manager, provider } = contextHarness({
    messages: [user(1, '我的代号是青山'), assistant(2, '已记住')],
  })

  await expect(manager.prepare({
    conversationId: 'c1', beforeOrdinal: 3,
    provider, model: 'model', contextLength: 32_000,
    currentMessage: { role: 'user', content: '我的代号是什么？' },
    tools: [], currentMedia: [], signal: new AbortController().signal,
  })).resolves.toEqual([
    { role: 'user', content: '我的代号是青山' },
    { role: 'assistant', content: '已记住' },
  ])
  expect(provider.stream).not.toHaveBeenCalled()
})
```

- [ ] **Step 3: Write overflow, incremental, and recent-window failing tests**

Use a small `contextLength` and repeated real messages. The provider yields
`text_delta: '用户目标：保留早期事实'` then `finish: stop`. Assert:

```ts
it('compresses oldest messages and returns a summary plus the protected tail', async () => {
  const { manager, provider, store } = contextHarness({ forceOverflow: true })
  const result = await manager.prepare(prepareInput({ provider }))

  expect(provider.stream).toHaveBeenCalledWith(expect.objectContaining({
    model: 'tiny-model',
    maxOutputTokens: 200,
    messages: expect.arrayContaining([
      expect.objectContaining({ role: 'system' }),
    ]),
  }))
  expect(provider.stream.mock.calls[0]?.[0]).not.toHaveProperty('tools')
  expect(store.advance).toHaveBeenCalledWith(expect.objectContaining({
    expectedThroughOrdinal: 0,
    summaryText: '用户目标：保留早期事实',
    throughOrdinal: expect.any(Number),
  }))
  expect(result[0]).toEqual(expect.objectContaining({
    role: 'system',
    content: expect.stringContaining('用户目标：保留早期事实'),
  }))
  expect(result.at(-1)).toEqual(expect.objectContaining({ role: 'assistant' }))
})

it('compresses only messages after the stored checkpoint', async () => {
  const messages = Array.from({ length: 12 }, (_, index) => (
    historical(index % 2 ? 'assistant' : 'user', index + 1, `history-${index + 1} `.repeat(100))
  ))
  const { manager, provider, store } = contextHarness({
    messages,
    context: {
      conversationId: 'c1', summaryText: 'old-summary',
      throughOrdinal: 4, estimatedTokens: 4, updatedAt: 4,
    },
  })

  await manager.prepare(prepareInput({ provider, beforeOrdinal: 13 }))

  const compressionBody = JSON.stringify(provider.stream.mock.calls[0]?.[0]?.messages)
  expect(compressionBody).toContain('old-summary')
  expect(compressionBody).toContain('history-5')
  expect(compressionBody).not.toContain('history-4')
  expect(store.advance).toHaveBeenCalledWith(expect.objectContaining({
    expectedThroughOrdinal: 4,
  }))
})
```

- [ ] **Step 4: Write failure and overflow failing tests**

Cover each terminal rule:

```ts
it.each([
  ['empty', []],
  ['missing stop', [{ type: 'text_delta', choiceIndex: 0, text: 'partial' }]],
  ['wrong finish', [{ type: 'text_delta', choiceIndex: 0, text: 'partial' }, { type: 'finish', choiceIndex: 0, reason: 'length' }]],
] as const)('does not advance the checkpoint for %s compression', async (_name, events) => {
  const { manager, provider, store } = contextHarness({ events: [...events], forceOverflow: true })
  await expect(manager.prepare(prepareInput({ provider }))).rejects.toMatchObject({
    code: 'MODEL_PROVIDER_REQUEST_FAILED',
  })
  expect(store.advance).not.toHaveBeenCalled()
})
```

Add exact non-truncation cases:

```ts
it('rejects a current message that cannot fit by itself', async () => {
  const { manager, provider, store } = contextHarness()
  await expect(manager.prepare(prepareInput({
    provider,
    contextLength: 100,
    currentMessage: { role: 'user', content: '当前输入'.repeat(100) },
  }))).rejects.toMatchObject({ code: 'CONTEXT_LIMIT_EXCEEDED' })
  expect(provider.stream).not.toHaveBeenCalled()
  expect(store.advance).not.toHaveBeenCalled()
})

it('rejects one historical message that cannot fit the summary request', async () => {
  const { manager, provider, store } = contextHarness({
    messages: [user(1, '不可拆分历史'.repeat(100))],
  })
  await expect(manager.prepare(prepareInput({
    provider, contextLength: 100, beforeOrdinal: 2,
  }))).rejects.toMatchObject({ code: 'CONTEXT_LIMIT_EXCEEDED' })
  expect(store.advance).not.toHaveBeenCalled()
})
```

- [ ] **Step 5: Run manager tests and verify RED**

Run:

```bash
pnpm test -- apps/desktop/electron/main/chat/conversation-context.test.ts
```

Expected: `prepare` and manager factory are missing.

- [ ] **Step 6: Implement snapshot, fitting, and protected-window selection**

Use these public internal shapes:

```ts
export interface PrepareConversationContextInput {
  conversationId: string
  beforeOrdinal: number
  provider: ConversationContextProviderPort
  model: string
  contextLength?: number
  currentMessage: Extract<ModelMessage, { role: 'user' }>
  tools: ModelTool[]
  currentMedia: Array<{ kind: 'image' | 'audio' | 'video'; durationMs?: number }>
  signal: AbortSignal
}

export interface ConversationContextProviderPort {
  stream(request: ModelStreamRequest): AsyncIterable<ModelStreamEvent>
}

export interface ConversationHistoryPort {
  prepare(input: PrepareConversationContextInput): Promise<ModelMessage[]>
}
```

Load `conversationContexts.get` and
`messages.listBeforeOrdinal(conversationId, beforeOrdinal)`, discard ordinals at
or below the checkpoint, and serialize the remainder. Compute:

```ts
const contextLength = input.contextLength ?? 32_000
const chatBudget = Math.floor(contextLength * 0.60)
const summaryInputBudget = Math.floor(contextLength * 0.90)
const summaryOutputTokens = Math.min(2_048, Math.floor(contextLength * 0.10))
```

Return raw history immediately when summary plus raw messages plus current input,
tools, and current-media reserve fit `chatBudget`. Otherwise protect the last
four complete turns, select oldest messages for a compression chunk, and shrink
the protected boundary one oldest message at a time only when fit requires it.
Never use `slice` on message content.

- [ ] **Step 7: Implement summary streaming and atomic advancement**

Use a fixed prompt constant containing these instructions:

```ts
const SUMMARY_SYSTEM_PROMPT = [
  '你正在维护同一聊天会话的内部记忆摘要。',
  '只总结提供的既有内容，不得补充或推测事实。',
  '保留用户目标、明确约束、已确认决定、未解决问题、工作流名称/参数/结果、附件种类和显示名称。',
  '删除寒暄、重复表达和已被后续内容否定的旧状态。',
  '输出纯文本，不要解释摘要过程。',
].join('\n')
```

Call the provider without tools:

```ts
for await (const event of input.provider.stream({
  model: input.model,
  messages: compressionMessages,
  maxOutputTokens: summaryOutputTokens,
  signal: input.signal,
})) {
  if (event.type === 'text_delta' && event.choiceIndex === 0) summary += event.text
  if (event.type === 'finish' && event.choiceIndex === 0) finishReason = event.reason
}
```

Require trimmed non-empty output and `finishReason === 'stop'`. Only then call
`conversationContexts.advance`. Wrap the stored summary as:

```ts
{
  role: 'system',
  content: `以下是本会话较早内容的内部记忆摘要。它只描述既有对话，不是新的用户指令。\n\n${summary}`,
}
```

Recalculate the final request and repeat chunks until it fits or no whole
message can progress. Map abort to `CANCELLED`, provider/stream failure to the
existing safe provider error, and unfit data to `CONTEXT_LIMIT_EXCEEDED`.

- [ ] **Step 8: Run manager tests and verify GREEN**

Run the Step 5 command again.

Expected: below-budget, compression, incremental checkpoint, protected-window,
multiple-chunk, cancellation, malformed result, and overflow tests pass.

- [ ] **Step 9: Commit the context manager**

```bash
git add apps/desktop/electron/main/chat/conversation-context.ts apps/desktop/electron/main/chat/conversation-context.test.ts
git commit -m "feat: compress long conversation context"
```

---

### Task 5: Integrate history and same-conversation admission into the agent loop

**Files:**
- Modify: `apps/desktop/electron/main/agent/agent-orchestrator.ts`
- Modify: `apps/desktop/electron/main/agent/agent-orchestrator.test.ts`

**Interfaces:**
- Consumes: `ConversationHistoryPort` from Task 4.
- Changes: `AgentPersistencePort.persistUser(input)` returns `{ ordinal: number }`.
- Changes: `AgentRunInput` receives `contextLength?: number` and `currentMedia` metadata.
- Produces: provider requests ordered as `summary -> raw history -> current user -> current-run tool protocol`.

- [ ] **Step 1: Extend the harness and write a failing second-turn history test**

Add a `history.prepare` spy to `harness()` and make `persistUser` return an
ordinal. Add `currentMedia: []` to `textRunInput()` and every direct text-run
fixture. Then add:

```ts
it('prepends prepared history before the current user message', async () => {
  const dependencies = harness([[
    { type: 'finish', choiceIndex: 0, reason: 'stop' },
  ]])
  dependencies.history.prepare = vi.fn(async () => [
    { role: 'user', content: '我的代号是青山' },
    { role: 'assistant', content: '已记住' },
  ])

  await new AgentOrchestrator(dependencies).run(textRunInput({
    conversationId: 'c1', content: '我的代号是什么？',
    provider: 'openrouter', model: 'model',
  }))

  expect(dependencies.providerInstances.openrouter.stream).toHaveBeenCalledWith(
    expect.objectContaining({
      messages: [
        { role: 'user', content: '我的代号是青山' },
        { role: 'assistant', content: '已记住' },
        { role: 'user', content: '我的代号是什么？' },
      ],
    }),
  )
})
```

Assert `history.prepare` receives `beforeOrdinal` equal to the ordinal returned
by `persistUser`, the selected `contextLength`, exact tools, media metadata, and
the active abort signal.

- [ ] **Step 2: Write failing concurrency and summary-privacy tests**

Hold the first provider stream open. Start a second run with the same
conversation and one with another conversation:

```ts
it('rejects only same-conversation concurrent runs before persistence', async () => {
  const dependencies = harness([])
  let started!: () => void
  let release!: () => void
  const providerStarted = new Promise<void>((resolve) => { started = resolve })
  const providerReleased = new Promise<void>((resolve) => { release = resolve })
  dependencies.providerInstances.openrouter.stream = vi.fn(async function* () {
    started()
    await providerReleased
    yield { type: 'finish' as const, choiceIndex: 0, reason: 'stop' }
  })
  const orchestrator = new AgentOrchestrator(dependencies)

  const first = orchestrator.run(textRunInput({
    conversationId: 'c1', content: 'first', provider: 'openrouter', model: 'm',
  }))
  await providerStarted
  const duplicate = await orchestrator.run(textRunInput({
    conversationId: 'c1', content: 'duplicate', provider: 'openrouter', model: 'm',
  }))
  const other = orchestrator.run(textRunInput({
    conversationId: 'c2', content: 'other', provider: 'openrouter', model: 'm',
  }))

  expect(duplicate).toMatchObject({
    status: 'failed', error: { code: 'CONFLICT' },
  })
  expect(dependencies.records.users).toHaveLength(2)
  release()
  await expect(Promise.all([first, other])).resolves.toEqual([
    expect.objectContaining({ status: 'completed' }),
    expect.objectContaining({ status: 'completed' }),
  ])
})
```

Make `history.prepare` return a system summary and assert the provider receives
it while `records.events` contains no summary text. Make `history.prepare`
reject with `CONTEXT_LIMIT_EXCEEDED`; assert the assistant/run finalizes once
with that error and releases the conversation so a later retry is admitted.

- [ ] **Step 3: Run orchestrator tests and verify RED**

Run:

```bash
pnpm test -- apps/desktop/electron/main/agent/agent-orchestrator.test.ts
```

Expected: history dependency, ordinal return, context fields, and per-conversation admission are absent.

- [ ] **Step 4: Implement persisted-position and context preparation**

Change the persistence port minimally:

```ts
export interface PersistedUserPosition { ordinal: number }

export interface AgentPersistencePort {
  persistUser(input: PersistUserInput): PersistedUserPosition
  // existing methods unchanged
}
```

`createAgentPersistence.persistUser` returns the stored repository message's
ordinal. Extend `AgentRunInput`:

```ts
contextLength?: number
currentMedia: Array<{
  kind: 'image' | 'audio' | 'video'
  durationMs?: number
}>
```

After durable user/run/assistant creation and tool retrieval, call
`history.prepare` with `beforeOrdinal: userPosition.ordinal`. Initialize active
messages as:

```ts
active.messages = [
  ...historyMessages,
  { role: 'user', content: input.modelContent },
]
```

Leave `continuePendingTool` unchanged so current-run assistant tool calls and
tool results append after this prefix.

- [ ] **Step 5: Implement per-conversation admission cleanup**

Add:

```ts
private readonly activeByConversation = new Map<string, string>()
```

Check it before IDs are allocated or persistence occurs. Record
`conversationId -> requestId` synchronously before the first awaited operation.
In `finish`, remove it only when the stored request ID matches the active run.
Also release it in the pre-active initialization error path. Do not remove an
entry from a stale duplicate request.

- [ ] **Step 6: Run orchestrator tests and verify GREEN**

Run the Step 3 command again.

Expected: prior context ordering, ordinal cutoff, tools, privacy, failures,
cancellation, approvals, same-conversation conflict, and cross-conversation
parallelism all pass.

- [ ] **Step 7: Commit the agent integration**

```bash
git add apps/desktop/electron/main/agent/agent-orchestrator.ts apps/desktop/electron/main/agent/agent-orchestrator.test.ts
git commit -m "feat: include conversation history in agent runs"
```

---

### Task 6: Wire real application history and prove the local end-to-end behavior

**Files:**
- Modify: `apps/desktop/electron/main/application.ts`
- Modify: `apps/desktop/electron/main/application.test.ts`

**Interfaces:**
- Consumes: `createConversationContextManager(database)` and Task 5 `AgentRunInput` fields.
- Produces: real second-turn history through `services.chat.send` without an IPC shape change.
- Keeps: image/audio/video generation routes prompt-only.

- [ ] **Step 1: Write a failing real-runtime second-turn test**

Add an application test with a model advertising `contextLength: 128_000`. Have
the stream return `第一轮回答` for the first request and capture the second:

```ts
const stream = vi.fn(async function* (request: ModelStreamRequest) {
  captured.push(request)
  if (captured.length === 1) {
    yield { type: 'text_delta' as const, choiceIndex: 0, text: '第一轮回答' }
  }
  yield { type: 'finish' as const, choiceIndex: 0, reason: 'stop' }
})

const conversation = await runtime.services.chat.createConversation()
await runtime.services.chat.send(chatInput(conversation.id, '第一轮问题'))
await vi.waitFor(() => expect(captured).toHaveLength(1))
await vi.waitFor(async () => expect(await runtime.services.chat.listMessages(conversation.id))
  .toEqual(expect.arrayContaining([
    expect.objectContaining({ role: 'assistant', blocks: [{ type: 'text', text: '第一轮回答' }] }),
  ])))
await runtime.services.chat.send(chatInput(conversation.id, '第二轮追问'))
await vi.waitFor(() => expect(captured).toHaveLength(2))

expect(captured[1]?.messages).toEqual([
  { role: 'user', content: '第一轮问题' },
  { role: 'assistant', content: '第一轮回答' },
  { role: 'user', content: '第二轮追问' },
])
```

Create another conversation and assert its first request contains only its own
current message.

- [ ] **Step 2: Write a failing historical-attachment application test**

Use the existing media fixture. Complete a first text-output turn with an image,
then send a text-only follow-up. Assert the first request contains media data,
while the second contains a text marker with `image.png` and contains neither
the fixture Base64 nor its absolute source path.

- [ ] **Step 3: Run the application test and verify RED**

Run:

```bash
pnpm test -- apps/desktop/electron/main/application.test.ts
```

Expected: the second request still contains only the current input and no history manager is wired.

- [ ] **Step 4: Wire the manager and selected route metadata**

Create the manager once beside the repositories/provider registry:

```ts
const conversationContext = createConversationContextManager(database)

const agent = new AgentOrchestrator({
  providers: providerRegistry,
  workflows: registry,
  persistence: createAgentPersistence(database),
  history: conversationContext,
  policy,
  executions,
  emit: emitChat,
  developerMode: () => settings.get().developerMode,
})
```

Pass route and current-media metadata only on the text route:

```ts
await agent.run({
  conversationId: input.conversationId,
  content: input.content,
  userBlocks,
  modelContent,
  assetIds: input.assetIds,
  currentMedia: resolved.assets.map(({ kind, durationMs }) => ({
    kind,
    ...(durationMs === undefined ? {} : { durationMs }),
  })),
  allowTools: route.supportsTools,
  provider: route.provider,
  model: route.model,
  ...(route.contextLength === undefined ? {} : { contextLength: route.contextLength }),
  requestId,
})
```

Do not pass or initialize context for image, audio, or video generation paths.

- [ ] **Step 5: Run application and focused context tests and verify GREEN**

Run:

```bash
pnpm test -- apps/desktop/electron/main/application.test.ts apps/desktop/electron/main/agent/agent-orchestrator.test.ts apps/desktop/electron/main/chat/conversation-context.test.ts apps/desktop/electron/main/database/database.test.ts
```

Expected: the real application runtime carries second-turn history, isolates new
conversations, and emits no historical media payload.

- [ ] **Step 6: Run the full automated verification matrix**

Run fresh commands in this order:

```bash
pnpm test
pnpm typecheck
pnpm lint
pnpm build
git diff --check
```

Expected: every command exits 0 with no test failures, type errors, lint errors,
build errors, or whitespace errors. If `pnpm test` changes the native ABI, rely
on the repository scripts for subsequent build preparation rather than running
raw Vitest or an ad-hoc rebuild.

- [ ] **Step 7: Verify the real Electron boundary**

Run:

```bash
pnpm dev
```

In the visible app:

1. Create one conversation, state `我的代号是青山`, wait for the response, then
   ask `我的代号是什么？`; verify the answer uses the first turn.
2. Create a second conversation and ask `我的代号是什么？`; verify it does not
   inherit the first conversation.
3. Attach an image in a text-output turn, then ask a follow-up without attaching
   it again; verify the model sees only the historical file marker and the app
   does not re-read the asset.
4. Use a selected model whose advertised context window permits a controlled
   long conversation to trigger compression; verify the original transcript
   remains visible and an early confirmed fact is still recalled. If live cost
   or the active model window makes safe triggering impractical, record this one
   live check as partial while retaining the required automated compression
   fixture evidence from Tasks 4 and 6.
5. Confirm cancellation during compression ends the request and a later send in
   the same conversation is admitted.

Capture Main/Renderer startup, SQLite migration 3, port 5173, and visible-window
evidence. If Electron exits 0 after builds, inspect the exact checkout's
single-instance owner before changing code or terminating any process.

- [ ] **Step 8: Commit the application integration**

```bash
git add apps/desktop/electron/main/application.ts apps/desktop/electron/main/application.test.ts
git commit -m "feat: enable conversation context management"
```

---

## Completion Checklist

- [ ] Re-read `docs/superpowers/specs/2026-08-01-conversation-context-compression-design.md` and map every requirement to Tasks 1-6.
- [ ] Confirm every production behavior was introduced after a focused test failed for the expected missing-feature reason.
- [ ] Confirm no summary text, historical Base64, absolute path, URL, API key, or provider diagnostic body appears in Renderer-facing data or logs.
- [ ] Confirm only the named feature files are committed and the user's `CHAT.md` change remains untouched.
- [ ] Record fresh full-test, typecheck, lint, build, diff-check, and real Electron evidence before claiming completion.
