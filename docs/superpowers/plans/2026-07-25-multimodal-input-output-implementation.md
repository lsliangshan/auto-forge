# AutoForge Multimodal Input and Output Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add production-ready image, audio, and video input/output to the existing chat while keeping provider selection, default models, local persistence, and renderer isolation correct.

**Architecture:** Renderer sends asset IDs and generation choices through a fixed typed Preload bridge. Electron Main owns file import, MIME verification, provider request construction, output persistence, custom media delivery, and a restart-safe video job runner. A capability router selects the text, image, audio, or video path from the active provider, chosen model, attachments, and per-conversation preferences.

**Tech Stack:** Electron 43, Vue 3, Pinia, TypeScript, Zod, better-sqlite3/Drizzle schema declarations, Vitest, Node filesystem/crypto/DNS/HTTPS primitives, OpenRouter REST/SSE APIs.

## Global Constraints

- DeepSeek remains text-only; reject unsupported media locally before any provider request.
- OpenRouter owns image, audio, and video input/output.
- Use the existing chat page; do not create a separate creation page or media library.
- Keep API keys in Main through `safeStorage`; never return or echo them through Renderer state or IPC.
- Keep file bytes, Base64, absolute paths, provider raw error bodies, and unvalidated remote URLs out of Renderer state, normal IPC responses, and SQLite message JSON.
- Store managed media under `<dataDirectory>/media/<conversationId>/`; deleting a conversation deletes its assets and unfinished jobs.
- Import at most 5 attachments per message: image 20 MB, audio 50 MB, video 200 MB, and 250 MB total input.
- Reject a generated result above 500 MB.
- Image defaults: 1 image, automatic aspect ratio, 1K, PNG.
- Audio defaults: provider/model default voice, MP3.
- Video defaults: 5 seconds, 720p, automatic aspect ratio, no generated audio.
- Only expose parameters supported by the selected model/endpoint.
- Remember generation choices per conversation, not as new global generation defaults.
- Video jobs survive application restart; manually paused jobs remain paused until resumed.
- Never inline SVG; allow save/reveal only.
- “Clear all local data” removes conversations, media assets, media jobs, and executions while preserving API keys, settings, grants, and installed workflows.
- CI and normal verification use protocol fixtures only. Any paid live image/audio/video request requires fresh user confirmation.
- Existing uncommitted OpenRouter 403/access-denial work is separate. Before implementation, preserve it in its own commit or transplant it into the isolated execution worktree; never mix it into a multimodal task commit.

---

## File and Responsibility Map

### Shared contracts

- `packages/shared/src/events.ts`: media blocks, generation blocks, block-replacement events.
- `packages/shared/src/desktop-api.ts`: modalities, capabilities, generation settings, media IPC schemas, typed API.
- `packages/shared/src/errors.ts`: safe media and modality error codes.
- `packages/shared/src/contracts.test.ts`: strict schema and secret/path/Base64 boundary tests.

### Main persistence and media boundary

- `apps/desktop/resources/migrations/0002_multimodal_media.sql`: conversation preferences, media assets, video jobs.
- `apps/desktop/electron/main/database/schema.ts`: Drizzle declarations for the new persisted structures.
- `apps/desktop/electron/main/database/repositories.ts`: typed media/job operations and atomic message-to-asset claims.
- `apps/desktop/electron/main/database/database.test.ts`: migration, cascades, state transitions, and recovery fixtures.
- `apps/desktop/electron/main/media/media-sniffer.ts`: bounded magic-byte detection and safe extension mapping.
- `apps/desktop/electron/main/media/media-asset-service.ts`: staged import, hashing, limits, output commit, draft cleanup.
- `apps/desktop/electron/main/media/media-lifecycle.ts`: quarantine-based conversation deletion and startup recovery.
- `apps/desktop/electron/main/media/safe-download.ts`: HTTPS-only bounded redirect/download path with DNS/IP checks.
- `apps/desktop/electron/main/media/media-protocol.ts`: asset lookup, sender guard, MIME headers, and Range responses.

### Provider and orchestration

- `apps/desktop/electron/main/chat/model-provider.ts`: normalized multimodal content and audio stream events.
- `apps/desktop/electron/main/chat/openrouter-provider.ts`: capability discovery plus image/audio/video OpenRouter operations.
- `apps/desktop/electron/main/chat/deepseek-provider.ts`: explicit text-only capabilities.
- `apps/desktop/electron/main/chat/multimodal-router.ts`: local compatibility checks and route selection.
- `apps/desktop/electron/main/chat/media-generation-orchestrator.ts`: image/audio generation and persisted message blocks.
- `apps/desktop/electron/main/chat/video-job-runner.ts`: submit, poll, pause/resume, download, restart recovery.
- `apps/desktop/electron/main/agent/agent-orchestrator.ts`: text/understanding turns with normalized media inputs.
- `apps/desktop/electron/main/application.ts`: compose services and preserve maintenance/active-request rules.

### Desktop bridge and system integration

- `apps/desktop/electron/preload/bridge.ts`: fixed media calls; convert dropped `File` objects to paths inside Preload.
- `apps/desktop/electron/preload/index.ts`: inject `webUtils.getPathForFile`.
- `apps/desktop/electron/main/ipc/register-ipc.ts`: fixed media handlers and sender validation.
- `apps/desktop/electron/main/index.ts`: dialog/clipboard/shell ports and privileged local media scheme.
- `apps/desktop/index.html`: allow only `autoforge-media:` for image/media sources.

### Renderer

- `apps/desktop/src/stores/chat.ts`: draft assets, per-conversation preferences, stable block replacement.
- `apps/desktop/src/stores/settings.ts`: per-provider/per-output defaults and capability-filtered model lists.
- `apps/desktop/src/services/desktop-api.ts`: localized safe media errors.
- `apps/desktop/src/components/chat/ChatComposer.vue`: attachment button, drop/paste, adaptive output controls.
- `apps/desktop/src/components/chat/MediaBlock.vue`: image grid item, audio/video controls, save/reveal.
- `apps/desktop/src/components/chat/MediaGenerationBlock.vue`: indeterminate progress, pause/resume, safe failure.
- `apps/desktop/src/components/chat/MessageBlock.vue`: dispatch new block types.
- `apps/desktop/src/views/ChatView.vue`: conversation/model/output coordination.
- `apps/desktop/src/views/SettingsView.vue`: editable default model slots by provider and modality.

---

### Task 1: Define Strict Multimodal Contracts

**Files:**
- Modify: `packages/shared/src/events.ts:17-80`
- Modify: `packages/shared/src/desktop-api.ts:34-40, 240-520`
- Modify: `packages/shared/src/errors.ts:3-62`
- Test: `packages/shared/src/contracts.test.ts`

**Interfaces:**
- Produces: `MediaKind`, `OutputType`, `MediaAsset`, `GenerationOptions`, `ConversationGenerationPreferences`, capability-rich `ModelInfo`, media `ChatBlock` variants, `block_update` events, and fixed media API calls.
- Consumes: existing `ChatBlock`, `ChatEvent`, `DesktopAPI`, `AppSettings`, and `AppError`.

- [ ] **Step 1: Write failing strict-schema tests**

```ts
expect(chatBlockSchema.parse({
  type: 'media',
  blockId: 'block_1',
  assetId: 'asset_1',
  kind: 'image',
  purpose: 'input',
  name: 'photo.png',
  mimeType: 'image/png',
  byteSize: 12,
})).toMatchObject({ assetId: 'asset_1', purpose: 'input' })

expect(chatEventSchema.parse({
  type: 'block_update',
  conversationId: 'conversation_1',
  messageId: 'message_1',
  blockId: 'block_1',
  block: {
    type: 'media_generation',
    blockId: 'block_1',
    jobId: 'job_1',
    kind: 'video',
    status: 'in_progress',
  },
})).toMatchObject({ type: 'block_update', blockId: 'block_1' })

expect(() => chatSendInputSchema.parse({
  conversationId: 'conversation_1',
  content: '',
  assetIds: [],
  outputType: 'text',
})).toThrow()
```

- [ ] **Step 2: Run the contract test and verify it fails**

Run: `pnpm exec vitest run packages/shared/src/contracts.test.ts`

Expected: FAIL because media schemas and `block_update` do not exist.

- [ ] **Step 3: Add the exact shared types and schemas**

```ts
export const mediaKindSchema = z.enum(['image', 'audio', 'video'])
export type MediaKind = z.infer<typeof mediaKindSchema>

export const outputTypeSchema = z.enum(['auto', 'text', 'image', 'audio', 'video'])
export type OutputType = z.infer<typeof outputTypeSchema>

export const generationOptionsSchema = z.object({
  image: z.object({
    count: z.literal(1),
    resolution: z.string().default('1K'),
    aspectRatio: z.string().default('auto'),
    format: z.string().default('png'),
  }).strict(),
  audio: z.object({
    voice: z.string().trim().min(1).optional(),
    format: z.string().default('mp3'),
  }).strict(),
  video: z.object({
    durationSeconds: z.number().int().positive().default(5),
    resolution: z.string().default('720p'),
    aspectRatio: z.string().default('auto'),
    generateAudio: z.boolean().default(false),
  }).strict(),
}).strict()

export const mediaAssetSchema = z.object({
  id: identifierSchema,
  kind: mediaKindSchema,
  mimeType: nonEmptyStringSchema,
  name: nonEmptyStringSchema,
  byteSize: z.number().int().nonnegative(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  durationMs: z.number().int().nonnegative().optional(),
}).strict()

export const mediaImportContextSchema = z.object({
  conversationId: identifierSchema,
  existingAssetIds: z.array(identifierSchema).max(5),
}).strict()

export const conversationGenerationPreferencesSchema = z.object({
  outputType: outputTypeSchema,
  models: z.object({
    text: nonEmptyStringSchema.optional(),
    image: nonEmptyStringSchema.optional(),
    audio: nonEmptyStringSchema.optional(),
    video: nonEmptyStringSchema.optional(),
  }).strict(),
  generation: generationOptionsSchema,
}).strict()
```

Define `ConversationGenerationPreferences` as:

```ts
{
  outputType: OutputType
  models: Partial<Record<'text' | 'image' | 'audio' | 'video', string>>
  generation: GenerationOptions
}
```

Define the send schema so attachment-only understanding is valid but an empty request is not:

```ts
export const chatSendInputSchema = z.object({
  conversationId: identifierSchema,
  content: z.string().trim(),
  assetIds: z.array(identifierSchema).max(5).default([]),
  outputType: outputTypeSchema.default('auto'),
  model: nonEmptyStringSchema.optional(),
  generation: generationOptionsSchema,
}).strict().superRefine(({ content, assetIds, outputType }, context) => {
  if (!content && assetIds.length === 0) {
    context.addIssue({ code: 'custom', message: 'Text or an attachment is required' })
  }
  if (!content && outputType !== 'text' && outputType !== 'auto') {
    context.addIssue({ code: 'custom', message: 'Generation output requires a prompt' })
  }
})
```

Change `ProviderDefaultModels` to:

```ts
{
  deepseek: { text: string }
  openrouter: {
    text?: string
    image?: string
    audio?: string
    video?: string
  }
}
```

Extend `ModelInfo` with:

```ts
inputModalities: Array<'text' | 'image' | 'audio' | 'video'>
outputModalities: Array<'text' | 'image' | 'audio' | 'video'>
supportsTools: boolean
generation: {
  image?: { resolutions: string[]; aspectRatios: string[]; formats: string[]; maxCount: number }
  audio?: { voices: string[]; formats: string[] }
  video?: { resolutions: string[]; aspectRatios: string[]; durations: number[]; supportsAudio: boolean }
}
```

Add exact persisted block schemas:

```ts
export const mediaBlockSchema = z.object({
  type: z.literal('media'),
  blockId: identifierSchema,
  assetId: identifierSchema,
  kind: mediaKindSchema,
  purpose: z.enum(['input', 'output']),
  name: nonEmptyStringSchema,
  mimeType: nonEmptyStringSchema,
  byteSize: z.number().int().nonnegative(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  durationMs: z.number().int().nonnegative().optional(),
}).strict()

export const mediaGenerationBlockSchema = z.object({
  type: z.literal('media_generation'),
  blockId: identifierSchema,
  jobId: identifierSchema,
  kind: mediaKindSchema,
  status: z.enum(['pending', 'in_progress', 'downloading', 'paused', 'failed']),
  errorCode: appErrorCodeSchema.optional(),
}).strict()
```

Add both schemas to `chatBlockSchema`. Add `block_update` to `chatEventSchema`; its replacement `block` accepts only `mediaBlockSchema` or `mediaGenerationBlockSchema` and its `blockId` must equal `block.blockId`.

Add fixed media methods:

```ts
chat: {
  getGenerationPreferences(conversationId: string): Promise<ConversationGenerationPreferences>
  updateGenerationPreferences(
    conversationId: string,
    preferences: ConversationGenerationPreferences,
  ): Promise<ConversationGenerationPreferences>
}
media: {
  pickFiles(context: MediaImportContext): Promise<MediaAsset[]>
  importDroppedFiles(context: MediaImportContext, files: readonly File[]): Promise<MediaAsset[]>
  importClipboardImage(context: MediaImportContext): Promise<MediaAsset[]>
  removeDraft(assetId: string): Promise<void>
  saveCopy(assetId: string): Promise<void>
  reveal(assetId: string): Promise<void>
  pauseVideoJob(jobId: string): Promise<void>
  resumeVideoJob(jobId: string): Promise<void>
}
```

Add safe error codes exactly:

```ts
'MEDIA_TYPE_UNSUPPORTED'
'MEDIA_ATTACHMENT_LIMIT_EXCEEDED'
'MEDIA_SIZE_LIMIT_EXCEEDED'
'MEDIA_MIME_MISMATCH'
'MEDIA_IMPORT_FAILED'
'MEDIA_ASSET_UNAVAILABLE'
'MEDIA_STORAGE_FULL'
'MODEL_MODALITY_UNSUPPORTED'
'MEDIA_GENERATION_FAILED'
'MEDIA_DOWNLOAD_FAILED'
'MEDIA_GENERATION_TIMEOUT'
```

- [ ] **Step 4: Re-run contract tests**

Run: `pnpm exec vitest run packages/shared/src/contracts.test.ts`

Expected: PASS, including rejection of unknown keys, paths, Base64 fields, and an empty text-only send.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/events.ts packages/shared/src/desktop-api.ts packages/shared/src/errors.ts packages/shared/src/contracts.test.ts
git commit -m "feat: define multimodal desktop contracts"
```

### Task 2: Persist Media Assets, Video Jobs, and Conversation Preferences

**Files:**
- Create: `apps/desktop/resources/migrations/0002_multimodal_media.sql`
- Modify: `apps/desktop/electron/main/database/schema.ts:8-40, 145-155`
- Modify: `apps/desktop/electron/main/database/repositories.ts:4-180`
- Modify: `apps/desktop/electron/main/database/client.ts:5-38`
- Test: `apps/desktop/electron/main/database/database.test.ts`

**Interfaces:**
- Consumes: `ConversationGenerationPreferences`, media/job status literals from Task 1.
- Produces: `database.mediaAssets`, `database.mediaGenerationJobs`, atomic `messages.insertWithAssets`, and `conversations.updateGenerationPreferences`.

- [ ] **Step 1: Write migration and repository failure tests**

```ts
const database = openTestDatabase()
expect(database.schemaVersion()).toBe(2)
database.conversations.insert({ id: 'conversation_1', title: 'Media' })
const defaultConversationGenerationPreferences = {
  outputType: 'auto' as const,
  models: {},
  generation: {
    image: { count: 1 as const, resolution: '1K', aspectRatio: 'auto', format: 'png' },
    audio: { format: 'mp3' },
    video: { durationSeconds: 5, resolution: '720p', aspectRatio: 'auto', generateAudio: false },
  },
}
database.mediaAssets.insert({
  id: 'asset_1',
  conversationId: 'conversation_1',
  source: 'upload',
  kind: 'image',
  mimeType: 'image/png',
  originalName: 'photo.png',
  relativePath: 'conversation_1/asset_1.png',
  byteSize: 12,
  sha256: 'a'.repeat(64),
  status: 'ready',
})
database.messages.insertWithAssets({
  id: 'message_1',
  conversationId: 'conversation_1',
  role: 'user',
  blocks: [{ type: 'media', blockId: 'block_1', assetId: 'asset_1', kind: 'image', purpose: 'input', name: 'photo.png', mimeType: 'image/png', byteSize: 12 }],
  createdAt: 1,
}, ['asset_1'])
expect(database.mediaAssets.get('asset_1')?.messageId).toBe('message_1')

const updated = database.conversations.updateGenerationPreferences(
  'conversation_1',
  defaultConversationGenerationPreferences,
)
expect(updated?.generationPreferences.outputType).toBe('auto')
```

Also assert a cross-conversation claim rolls back the message insert, deleting a conversation cascades both new tables, and only `pending | in_progress | downloading` jobs are returned by `listResumable()`.

- [ ] **Step 2: Run the database test and verify it fails**

Run: `pnpm --filter @autoforge/desktop exec vitest run --config vitest.node.config.ts electron/main/database/database.test.ts`

Expected: FAIL with schema version 1 and missing media repositories.

- [ ] **Step 3: Add migration 0002**

```sql
ALTER TABLE conversations ADD COLUMN generation_preferences_json TEXT;

CREATE TABLE media_assets (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  source TEXT NOT NULL CHECK (source IN ('upload', 'generated')),
  kind TEXT NOT NULL CHECK (kind IN ('image', 'audio', 'video')),
  mime_type TEXT,
  original_name TEXT NOT NULL,
  relative_path TEXT,
  byte_size INTEGER,
  width INTEGER,
  height INTEGER,
  duration_ms INTEGER,
  sha256 TEXT,
  provider TEXT,
  model TEXT,
  status TEXT NOT NULL CHECK (status IN ('staging', 'ready', 'failed', 'deleting')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX media_assets_conversation_status_idx
  ON media_assets(conversation_id, status, created_at);
CREATE INDEX media_assets_unclaimed_idx
  ON media_assets(message_id, created_at);

CREATE TABLE media_generation_jobs (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  assistant_message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind = 'video'),
  provider_job_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'in_progress', 'downloading', 'paused', 'completed', 'failed')),
  parameters_json TEXT NOT NULL,
  next_poll_at INTEGER,
  poll_attempts INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  asset_id TEXT REFERENCES media_assets(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  ended_at INTEGER
);

CREATE INDEX media_generation_jobs_resume_idx
  ON media_generation_jobs(status, next_poll_at);
```

`message_id` is the concrete ownership link needed to distinguish an unsubmitted draft from an asset already referenced by a message. It avoids unsafe `blocks_json LIKE ...` reference scans.

- [ ] **Step 4: Add typed repository methods**

```ts
conversations: {
  updateGenerationPreferences(
    id: string,
    preferences: ConversationGenerationPreferences,
  ): Conversation | undefined
}
mediaAssets: {
  insert(value: MediaAssetRecord): MediaAssetRecord
  get(id: string): MediaAssetRecord | undefined
  listForConversation(conversationId: string): MediaAssetRecord[]
  listUnclaimedBefore(timestamp: number): MediaAssetRecord[]
  update(id: string, patch: MediaAssetPatch): MediaAssetRecord | undefined
  delete(id: string): void
}
mediaGenerationJobs: {
  insert(value: MediaGenerationJob): MediaGenerationJob
  get(id: string): MediaGenerationJob | undefined
  listResumable(now: number): MediaGenerationJob[]
  update(id: string, patch: MediaGenerationJobPatch): MediaGenerationJob | undefined
}
messages: {
  insertWithAssets(message: MessageInput, assetIds: string[]): Message
  replaceBlock(messageId: string, blockId: string, replacement: unknown): Message
  failInterruptedMediaGenerations(): number
}
```

Implement every multi-row operation inside one `better-sqlite3` transaction. `insertWithAssets` must verify every asset is `ready`, unclaimed, and owned by the message conversation before inserting the message and assigning `message_id`.

- [ ] **Step 5: Re-run database tests**

Run: `pnpm --filter @autoforge/desktop exec vitest run --config vitest.node.config.ts electron/main/database/database.test.ts`

Expected: PASS with schema version 2, atomic claims, cascades, preference round-trips, and resumable-job queries.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/resources/migrations/0002_multimodal_media.sql apps/desktop/electron/main/database/schema.ts apps/desktop/electron/main/database/repositories.ts apps/desktop/electron/main/database/client.ts apps/desktop/electron/main/database/database.test.ts
git commit -m "feat: persist multimodal assets and jobs"
```

### Task 3: Migrate Provider Defaults to Per-Output Slots

**Files:**
- Modify: `apps/desktop/electron/main/settings/settings-service.ts:4-53`
- Modify: `apps/desktop/electron/main/settings/settings-service.test.ts`
- Modify: `apps/desktop/electron/main/application.ts:204-217`
- Test: `apps/desktop/electron/main/application.test.ts`

**Interfaces:**
- Consumes: nested `ProviderDefaultModels` from Task 1.
- Produces: normalized settings where legacy strings migrate to `text` and media slots remain optional.

- [ ] **Step 1: Add legacy and nested migration tests**

```ts
repository.set('app', {
  activeProvider: 'openrouter',
  defaultModels: { openrouter: 'openai/gpt-4.1-mini', deepseek: 'deepseek-chat' },
})
expect(service.get().defaultModels).toEqual({
  deepseek: { text: 'deepseek-chat' },
  openrouter: { text: 'openai/gpt-4.1-mini' },
})

repository.set('app', {
  defaultModels: {
    deepseek: { text: 'deepseek-chat' },
    openrouter: { text: 'text-model', image: 'image-model', video: 'video-model' },
  },
})
expect(service.get().defaultModels.openrouter.video).toBe('video-model')
```

- [ ] **Step 2: Run settings tests and verify failure**

Run: `pnpm --filter @autoforge/desktop exec vitest run --config vitest.node.config.ts electron/main/settings/settings-service.test.ts`

Expected: FAIL because the current normalizer returns provider strings.

- [ ] **Step 3: Implement one-way normalization**

```ts
function providerTextDefault(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value
  if (typeof value === 'object' && value !== null) {
    const text = (value as { text?: unknown }).text
    if (typeof text === 'string' && text.trim()) return text
  }
  return undefined
}

function openRouterDefaults(value: unknown): ProviderDefaultModels['openrouter'] {
  const record = typeof value === 'object' && value !== null
    ? value as Record<string, unknown>
    : {}
  return Object.fromEntries(
    ['text', 'image', 'audio', 'video']
      .filter((key) => typeof record[key] === 'string' && String(record[key]).trim())
      .map((key) => [key, record[key]]),
  )
}
```

Keep application defaults:

```ts
defaultModels: {
  deepseek: { text: 'deepseek-v4-flash' },
  openrouter: { text: 'openai/gpt-4.1-mini' },
}
```

Do not invent media model IDs; those slots start empty until the user selects compatible models.

- [ ] **Step 4: Run settings and application tests**

Run: `pnpm --filter @autoforge/desktop exec vitest run --config vitest.node.config.ts electron/main/settings/settings-service.test.ts electron/main/application.test.ts`

Expected: PASS; old settings preserve their text defaults and new settings preserve each media slot.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/electron/main/settings/settings-service.ts apps/desktop/electron/main/settings/settings-service.test.ts apps/desktop/electron/main/application.ts apps/desktop/electron/main/application.test.ts
git commit -m "feat: store defaults by output modality"
```

### Task 4: Import and Commit Managed Media Assets

**Files:**
- Create: `apps/desktop/electron/main/media/media-sniffer.ts`
- Create: `apps/desktop/electron/main/media/media-sniffer.test.ts`
- Create: `apps/desktop/electron/main/media/media-asset-service.ts`
- Create: `apps/desktop/electron/main/media/media-asset-service.test.ts`

**Interfaces:**
- Consumes: `database.mediaAssets`, `MediaAsset`, and media error codes.
- Produces: `MediaAssetService.importPaths`, `importClipboardImage`, `commitGeneratedBase64`, `commitGeneratedStream`, `removeDraft`, `resolveReadyAsset`, and `modelInput`.

- [ ] **Step 1: Write failing sniffer and import-boundary tests**

```ts
expect(detectMediaType(Buffer.from('89504e470d0a1a0a', 'hex'))).toMatchObject({
  kind: 'image',
  mimeType: 'image/png',
  extension: 'png',
})

await expect(service.importPaths({
  conversationId: 'conversation_1',
  existingAssetIds: [],
  paths: [oversizedImage],
})).rejects.toMatchObject({ code: 'MEDIA_SIZE_LIMIT_EXCEEDED' })

await expect(service.importPaths({
  conversationId: 'conversation_1',
  existingAssetIds: ['a', 'b', 'c', 'd', 'e'],
  paths: [pngPath],
})).rejects.toMatchObject({ code: 'MEDIA_ATTACHMENT_LIMIT_EXCEEDED' })
```

Include tests for PNG/JPEG/WebP/GIF/AVIF/SVG, MP3/WAV/OGG/FLAC/M4A, MP4/WebM/QuickTime, extension spoofing, symlinks, staging cleanup, exact byte caps, total 250 MB cap, SHA-256, and an ENOSPC mapping.

- [ ] **Step 2: Run the media tests and verify failure**

Run: `pnpm --filter @autoforge/desktop exec vitest run --config vitest.node.config.ts electron/main/media/media-sniffer.test.ts electron/main/media/media-asset-service.test.ts`

Expected: FAIL because the media service does not exist.

- [ ] **Step 3: Implement bounded magic-byte detection**

```ts
export interface DetectedMedia {
  kind: 'image' | 'audio' | 'video'
  mimeType: string
  extension: string
  inlineSafe: boolean
  width?: number
  height?: number
}

export function detectMediaType(prefix: Uint8Array): DetectedMedia | undefined
```

Read at most 64 KiB for sniffing. Detect containers from signatures and container brands, not from the source extension or browser-provided MIME. Mark SVG `inlineSafe: false`; accept it only when the bytes decode to bounded UTF-8 containing an `<svg` root.

- [ ] **Step 4: Implement staged import and generated output commits**

```ts
export const MEDIA_LIMITS = {
  attachments: 5,
  imageBytes: 20 * 1024 * 1024,
  audioBytes: 50 * 1024 * 1024,
  videoBytes: 200 * 1024 * 1024,
  requestBytes: 250 * 1024 * 1024,
  generatedBytes: 500 * 1024 * 1024,
} as const

export interface MediaImportPathsInput {
  conversationId: string
  existingAssetIds: string[]
  paths: string[]
}

export interface MediaImportBytesInput {
  conversationId: string
  existingAssetIds: string[]
  bytes: Uint8Array
  mimeType: 'image/png'
  name: string
}

export interface ResolvedMediaAsset extends MediaAsset {
  conversationId: string
  absolutePath: string
  relativePath: string
  inlineSafe: boolean
}

export interface ModelMediaInput {
  assetId: string
  kind: 'image' | 'audio' | 'video'
  mimeType: string
  dataBase64: string
}

export interface GeneratedWriterInput {
  conversationId: string
  messageId: string
  kind: 'image' | 'audio' | 'video'
  provider: ModelProviderId
  model: string
  name: string
}

export interface GeneratedAssetWriter {
  appendBase64Chunk(chunk: string): Promise<void>
  commit(): Promise<MediaAsset>
  abort(): Promise<void>
}

export interface GeneratedBase64Input extends GeneratedWriterInput {
  dataBase64: string
  declaredMimeType?: string
}

export interface GeneratedStreamInput extends GeneratedWriterInput {
  stream: AsyncIterable<Uint8Array>
  declaredMimeType?: string
}

export interface MediaAssetService {
  importPaths(input: MediaImportPathsInput): Promise<MediaAsset[]>
  importClipboardImage(input: MediaImportBytesInput): Promise<MediaAsset[]>
  removeDraft(assetId: string): Promise<void>
  resolveReadyAsset(assetId: string, conversationId?: string): Promise<ResolvedMediaAsset>
  modelInput(conversationId: string, assetIds: string[]): Promise<ModelMediaInput[]>
  createGeneratedWriter(input: GeneratedWriterInput): Promise<GeneratedAssetWriter>
  commitGeneratedBase64(input: GeneratedBase64Input): Promise<MediaAsset>
  commitGeneratedStream(input: GeneratedStreamInput): Promise<MediaAsset>
  cleanupDrafts(olderThan: number): Promise<void>
}
```

For path imports: `lstat` rejects symlinks, `realpath` is rechecked, the opened handle is `stat`-matched to the pre-open file, copying streams through `.staging`, and the destination extension comes only from `detectMediaType`. Update the database to `ready` only after atomic rename.

For Base64: enforce the encoded-length ceiling before decoding, decode chunks into staging, sniff actual bytes, hash, and atomically commit. `GeneratedAssetWriter` exposes only `appendBase64Chunk`, `commit`, and `abort`, so audio SSE chunks can be persisted without concatenating one large string. Never build a `data:` URL or return bytes from this service.

- [ ] **Step 5: Run media tests**

Run: `pnpm --filter @autoforge/desktop exec vitest run --config vitest.node.config.ts electron/main/media/media-sniffer.test.ts electron/main/media/media-asset-service.test.ts`

Expected: PASS with no staging residue after every failure fixture.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/electron/main/media/media-sniffer.ts apps/desktop/electron/main/media/media-sniffer.test.ts apps/desktop/electron/main/media/media-asset-service.ts apps/desktop/electron/main/media/media-asset-service.test.ts
git commit -m "feat: add managed media asset imports"
```

### Task 5: Make Conversation Media Deletion Crash-Consistent

**Files:**
- Create: `apps/desktop/electron/main/media/media-lifecycle.ts`
- Create: `apps/desktop/electron/main/media/media-lifecycle.test.ts`
- Modify: `apps/desktop/electron/main/database/client.ts:20-30`

**Interfaces:**
- Consumes: conversation/media repositories and `<dataDirectory>/media`.
- Produces: `MediaLifecycle.deleteConversation`, `clearConversations`, and `recover`.

- [ ] **Step 1: Write failing quarantine tests**

```ts
await lifecycle.deleteConversation('conversation_1')
expect(database.conversations.get('conversation_1')).toBeUndefined()
expect(existsSync(join(mediaRoot, 'conversation_1'))).toBe(false)

databaseDelete.mockImplementationOnce(() => { throw new Error('database unavailable') })
await expect(lifecycle.deleteConversation('conversation_2')).rejects.toThrow()
expect(existsSync(join(mediaRoot, 'conversation_2'))).toBe(true)
```

Add startup fixtures for:

- quarantined directory + live conversation → restore;
- quarantined directory + deleted conversation → remove;
- `ready` row + missing file → mark `failed`;
- orphan `.staging` file → remove;
- unclaimed upload older than 24 hours → remove;
- paused video job → preserve.

- [ ] **Step 2: Run lifecycle tests and verify failure**

Run: `pnpm --filter @autoforge/desktop exec vitest run --config vitest.node.config.ts electron/main/media/media-lifecycle.test.ts`

Expected: FAIL because quarantine lifecycle operations are missing.

- [ ] **Step 3: Implement exact delete and recovery order**

```ts
async deleteConversation(conversationId: string): Promise<void> {
  const source = join(this.mediaRoot, conversationId)
  const quarantine = join(this.mediaRoot, '.quarantine', `${conversationId}.deleting`)
  if (await exists(source)) await rename(source, quarantine)
  try {
    this.database.conversations.delete(conversationId)
  } catch (error) {
    if (await exists(quarantine)) await rename(quarantine, source)
    throw error
  }
  await rm(quarantine, { recursive: true, force: true })
}
```

`clearConversations` must quarantine all conversation directories first, execute one database clear transaction, restore all directories if the transaction fails, then clean quarantine. `recover` treats the database as authoritative and never follows symlinks.

- [ ] **Step 4: Run lifecycle tests**

Run: `pnpm --filter @autoforge/desktop exec vitest run --config vitest.node.config.ts electron/main/media/media-lifecycle.test.ts`

Expected: PASS for delete, rollback, restart recovery, and cleanup.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/electron/main/media/media-lifecycle.ts apps/desktop/electron/main/media/media-lifecycle.test.ts apps/desktop/electron/main/database/client.ts
git commit -m "feat: recover media lifecycle atomically"
```

### Task 6: Add the Fixed Media IPC and Preload Bridge

**Files:**
- Modify: `apps/desktop/electron/preload/bridge.ts:1-105`
- Modify: `apps/desktop/electron/preload/index.ts:1-12`
- Modify: `apps/desktop/electron/preload/bridge.test.ts`
- Modify: `apps/desktop/electron/main/ipc/register-ipc.ts:33-160`
- Modify: `apps/desktop/electron/main/ipc/register-ipc.test.ts`
- Modify: `apps/desktop/electron/main/application.ts:46-70, 347-565`
- Modify: `apps/desktop/electron/main/application.test.ts`
- Modify: `apps/desktop/electron/main/index.ts:3-88`

**Interfaces:**
- Consumes: fixed channels from Task 1 and `MediaAssetService` from Task 4.
- Produces: trusted `DesktopAPI.media` methods without a generic transport or Renderer-visible path.

- [ ] **Step 1: Write failing bridge tests**

```ts
const getPathForFile = vi.fn()
  .mockReturnValueOnce('/input/photo.png')
  .mockReturnValueOnce('')
const app = harness({ getPathForFile })
await app.api.media.importDroppedFiles(
  { conversationId: 'conversation_1', existingAssetIds: [] },
  [fileOne, fileTwo],
)
expect(app.ipcRenderer.invoke).toHaveBeenCalledWith(
  ipcChannels.mediaImportDroppedFiles,
  { conversationId: 'conversation_1', existingAssetIds: [], paths: ['/input/photo.png'] },
)
```

Assert every media method uses one literal channel, an untrusted iframe is rejected, more than five paths are rejected by the shared schema, and neither the API result nor thrown errors contain a path. Also assert the two conversation-preference methods use their fixed chat channels and validate the complete preference object.

- [ ] **Step 2: Run bridge and IPC tests and verify failure**

Run: `pnpm --filter @autoforge/desktop exec vitest run --config vitest.node.config.ts electron/preload/bridge.test.ts electron/main/ipc/register-ipc.test.ts`

Expected: FAIL because the media namespace and handlers are absent.

- [ ] **Step 3: Inject dropped-file path resolution only inside Preload**

```ts
export interface DesktopBridgePorts {
  getPathForFile(file: File): string
}

export function createMediaApi(
  ipcRenderer: IpcRendererPort,
  ports: DesktopBridgePorts,
): DesktopAPI['media'] {
  return {
    importDroppedFiles: (context, files) => {
      const paths = files.map((file) => ports.getPathForFile(file)).filter(Boolean)
      return invoke(ipcRenderer, ipcChannels.mediaImportDroppedFiles, { ...context, paths })
    },
    pickFiles: (context) => invoke(ipcRenderer, ipcChannels.mediaPickFiles, context),
    importClipboardImage: (context) =>
      invoke(ipcRenderer, ipcChannels.mediaImportClipboardImage, context),
    removeDraft: (assetId) =>
      invoke(ipcRenderer, ipcChannels.mediaRemoveDraft, { assetId }),
    saveCopy: (assetId) =>
      invoke(ipcRenderer, ipcChannels.mediaSaveCopy, { assetId }),
    reveal: (assetId) =>
      invoke(ipcRenderer, ipcChannels.mediaReveal, { assetId }),
    pauseVideoJob: (jobId) =>
      invoke(ipcRenderer, ipcChannels.mediaPauseVideoJob, { jobId }),
    resumeVideoJob: (jobId) =>
      invoke(ipcRenderer, ipcChannels.mediaResumeVideoJob, { jobId }),
  }
}
```

Wire `webUtils.getPathForFile` in `preload/index.ts`. Do not expose `getPathForFile`, `ipcRenderer`, or the resolved path array.

- [ ] **Step 4: Wire Main system ports and services**

Add explicit runtime options:

```ts
chooseMediaFiles(remainingSlots: number): Promise<string[]>
readClipboardImage(): { bytes: Uint8Array; mimeType: 'image/png'; name: string } | undefined
chooseMediaSavePath(defaultName: string): Promise<string | undefined>
revealPath(path: string): void
```

`index.ts` implements them with Electron `dialog`, `clipboard.readImage().toPNG()`, and `shell.showItemInFolder`. `application.ts` passes only paths/bytes into `MediaAssetService`; IPC responses contain only `MediaAsset`.

Register `chat:get-generation-preferences` and `chat:update-generation-preferences` beside the existing fixed chat handlers. Main reads/writes only the exact conversation row and returns the normalized shared preference object.

- [ ] **Step 5: Run bridge, IPC, and application tests**

Run: `pnpm --filter @autoforge/desktop exec vitest run --config vitest.node.config.ts electron/preload/bridge.test.ts electron/main/ipc/register-ipc.test.ts electron/main/application.test.ts`

Expected: PASS; path extraction stays inside Preload/Main and all existing sender checks still apply.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/desktop-api.ts packages/shared/src/contracts.test.ts apps/desktop/electron/preload/bridge.ts apps/desktop/electron/preload/index.ts apps/desktop/electron/preload/bridge.test.ts apps/desktop/electron/main/ipc/register-ipc.ts apps/desktop/electron/main/ipc/register-ipc.test.ts apps/desktop/electron/main/application.ts apps/desktop/electron/main/application.test.ts apps/desktop/electron/main/index.ts
git commit -m "feat: expose fixed media desktop operations"
```

### Task 7: Serve Local Media Through a Restricted Range-Capable Protocol

**Files:**
- Create: `apps/desktop/electron/main/media/media-protocol.ts`
- Create: `apps/desktop/electron/main/media/media-protocol.test.ts`
- Modify: `apps/desktop/electron/main/index.ts:1-150`
- Modify: `apps/desktop/electron/main/window.ts:18-74`
- Modify: `apps/desktop/electron/main/window.test.ts`
- Modify: `apps/desktop/index.html:5`

**Interfaces:**
- Consumes: `MediaAssetService.resolveReadyAsset`.
- Produces: `autoforge-media://asset/<assetId>` with trusted-webContents filtering and byte ranges.

- [ ] **Step 1: Write failing protocol tests**

```ts
const response = await handler(new Request(
  'autoforge-media://asset/asset_1',
  { headers: { range: 'bytes=10-19' } },
))
expect(response.status).toBe(206)
expect(response.headers.get('content-range')).toBe('bytes 10-19/100')
expect(response.headers.get('accept-ranges')).toBe('bytes')
```

Also test unknown IDs, non-ready rows, traversal-shaped IDs, invalid/multi-range requests, destroyed/non-main webContents, SVG `Content-Disposition: attachment`, and full 200 responses.

- [ ] **Step 2: Run the protocol test and verify failure**

Run: `pnpm --filter @autoforge/desktop exec vitest run --config vitest.node.config.ts electron/main/media/media-protocol.test.ts electron/main/window.test.ts`

Expected: FAIL because the custom scheme is not registered.

- [ ] **Step 3: Implement protocol resolution and Range**

```ts
export function parseSingleRange(header: string | null, size: number):
  | { start: number; end: number }
  | undefined

export function createMediaProtocolHandler(
  assets: Pick<MediaAssetService, 'resolveReadyAsset'>,
): (request: Request) => Promise<Response>
```

Only accept URLs matching `autoforge-media://asset/<identifier>`. Resolve every request through the database, join a stored relative path beneath the canonical media root, and recheck containment before opening.

Use `session.webRequest.onBeforeRequest({ urls: ['autoforge-media://*/*'] }, ...)` to cancel requests whose `webContentsId` is not the current main window. The protocol handler remains independently strict because webRequest is defense in depth.

- [ ] **Step 4: Register the privileged scheme before app ready and tighten CSP**

```ts
protocol.registerSchemesAsPrivileged([{
  scheme: 'autoforge-media',
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
}])
```

Change CSP only to:

```html
img-src 'self' data: autoforge-media:;
media-src 'self' autoforge-media:;
```

Do not add `file:`, `blob:`, remote hosts, or wildcard sources.

- [ ] **Step 5: Run protocol/window tests**

Run: `pnpm --filter @autoforge/desktop exec vitest run --config vitest.node.config.ts electron/main/media/media-protocol.test.ts electron/main/window.test.ts`

Expected: PASS for trusted sender, full response, valid ranges, and all denial cases.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/electron/main/media/media-protocol.ts apps/desktop/electron/main/media/media-protocol.test.ts apps/desktop/electron/main/index.ts apps/desktop/electron/main/window.ts apps/desktop/electron/main/window.test.ts apps/desktop/index.html
git commit -m "feat: serve local media through a safe protocol"
```

### Task 8: Discover and Merge Model Capabilities

**Files:**
- Modify: `apps/desktop/electron/main/chat/model-provider.ts:43-80, 209-229, 245-280`
- Modify: `apps/desktop/electron/main/chat/openrouter-provider.ts:1-39`
- Modify: `apps/desktop/electron/main/chat/deepseek-provider.ts:20-42`
- Modify: `apps/desktop/electron/main/chat/openrouter-provider.test.ts`
- Modify: `apps/desktop/electron/main/chat/deepseek-provider.test.ts`
- Test: `apps/desktop/electron/main/chat/model-provider-registry.test.ts`

**Interfaces:**
- Consumes: capability-rich `ModelInfo`.
- Produces: merged general/image/video OpenRouter catalog and explicit DeepSeek text-only models.

- [ ] **Step 1: Write failing capability merge tests**

```ts
expect(await provider.listModels()).toContainEqual(expect.objectContaining({
  id: 'google/gemini-2.5-flash-image',
  inputModalities: ['text', 'image'],
  outputModalities: ['image'],
  supportsTools: false,
  generation: {
    image: expect.objectContaining({
      resolutions: ['1K', '2K'],
      aspectRatios: ['auto', '1:1', '16:9'],
      formats: ['png', 'jpeg'],
      maxCount: 1,
    }),
  },
}))

expect(await deepseek.listModels()).toEqual([
  expect.objectContaining({
    inputModalities: ['text'],
    outputModalities: ['text'],
    supportsTools: true,
    generation: {},
  }),
])
```

Fixture three endpoints:

- `GET /api/v1/models`;
- `GET /api/v1/images/models`;
- `GET /api/v1/videos/models`.

Use model ID as the merge key, deduplicate/sort values, and ensure definitive dedicated-endpoint parameter values override a general union.

- [ ] **Step 2: Run provider tests and verify failure**

Run: `pnpm --filter @autoforge/desktop exec vitest run --config vitest.node.config.ts electron/main/chat/openrouter-provider.test.ts electron/main/chat/deepseek-provider.test.ts electron/main/chat/model-provider-registry.test.ts`

Expected: FAIL because models currently contain only text/cost metadata.

- [ ] **Step 3: Parse dedicated capability descriptors**

Add endpoint constants:

```ts
const MODELS_ENDPOINT = 'https://openrouter.ai/api/v1/models'
const IMAGE_MODELS_ENDPOINT = 'https://openrouter.ai/api/v1/images/models'
const VIDEO_MODELS_ENDPOINT = 'https://openrouter.ai/api/v1/videos/models'
```

Normalize image descriptor maps (`enum`, `range`, `boolean`) and video fields (`supported_resolutions`, `supported_aspect_ratios`). When voices, formats, or durations are not listed by discovery, return empty arrays so Renderer hides unsupported controls instead of inventing options.

Stop filtering the general OpenRouter catalog to tool-capable text models. Preserve every valid model and set `supportsTools` from `supported_parameters`; media-only models such as Nano Banana must remain discoverable. DeepSeek records are explicitly text/text with `supportsTools: true`.

The OpenRouter documentation used for fixtures and request fields is:

- `https://openrouter.ai/docs/guides/overview/multimodal/image-generation`
- `https://openrouter.ai/docs/guides/overview/multimodal/audio`
- `https://openrouter.ai/docs/guides/overview/multimodal/video-generation`

- [ ] **Step 4: Keep partial discovery useful**

Fetch the general endpoint as required. Fetch image/video catalogs with `Promise.allSettled`; a failed dedicated catalog removes only that catalog’s capabilities and reports a bounded diagnostic. A failed general catalog still fails `listModels`, because it is the authoritative base list and credential check.

- [ ] **Step 5: Run provider tests**

Run: `pnpm --filter @autoforge/desktop exec vitest run --config vitest.node.config.ts electron/main/chat/openrouter-provider.test.ts electron/main/chat/deepseek-provider.test.ts electron/main/chat/model-provider-registry.test.ts`

Expected: PASS for merged capabilities, partial catalog failure, 401 invalid credential, 403 access denial, and no raw error leakage.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/electron/main/chat/model-provider.ts apps/desktop/electron/main/chat/openrouter-provider.ts apps/desktop/electron/main/chat/deepseek-provider.ts apps/desktop/electron/main/chat/openrouter-provider.test.ts apps/desktop/electron/main/chat/deepseek-provider.test.ts apps/desktop/electron/main/chat/model-provider-registry.test.ts
git commit -m "feat: discover model modality capabilities"
```

### Task 9: Build Multimodal Chat Requests and Parse Audio Streams

**Files:**
- Modify: `apps/desktop/electron/main/chat/model-provider.ts:9-37, 68-104, 283-520`
- Modify: `apps/desktop/electron/main/chat/openrouter-provider.test.ts`
- Modify: `apps/desktop/electron/main/chat/deepseek-provider.test.ts`
- Modify: `apps/desktop/electron/main/agent/agent-orchestrator.ts:58-213, 255-313, 392-449`
- Modify: `apps/desktop/electron/main/agent/agent-orchestrator.test.ts`

**Interfaces:**
- Consumes: `ModelMediaInput` from Task 4.
- Produces: normalized `ModelContentPart`, audio output request options, `audio_delta`, and media-aware text/understanding turns.

- [ ] **Step 1: Write failing request and stream tests**

```ts
await collect(provider.stream({
  model: 'audio-model',
  messages: [{
    role: 'user',
    content: [
      { type: 'text', text: '描述这段音频' },
      { type: 'media', kind: 'audio', mimeType: 'audio/mpeg', dataBase64: 'AQID' },
    ],
  }],
  output: { type: 'audio', format: 'mp3' },
}))

expect(JSON.parse(fetchMock.mock.calls[0]![1]!.body as string)).toMatchObject({
  modalities: ['text', 'audio'],
  audio: { format: 'mp3' },
  messages: [{
    content: [
      { type: 'text', text: '描述这段音频' },
      { type: 'input_audio', input_audio: { data: 'AQID', format: 'mp3' } },
    ],
  }],
})
```

Feed SSE with `delta.audio.data` and `delta.audio.transcript`; expect one `audio_delta` event per chunk. Assert DeepSeek rejects any `media` content or audio output before fetch.

- [ ] **Step 2: Run provider/orchestrator tests and verify failure**

Run: `pnpm --filter @autoforge/desktop exec vitest run --config vitest.node.config.ts electron/main/chat/openrouter-provider.test.ts electron/main/chat/deepseek-provider.test.ts electron/main/agent/agent-orchestrator.test.ts`

Expected: FAIL because content is string-only and audio deltas are ignored.

- [ ] **Step 3: Add normalized Main-only content**

```ts
export type ModelContentPart =
  | { type: 'text'; text: string }
  | { type: 'media'; kind: 'image' | 'audio' | 'video'; mimeType: string; dataBase64: string }

export type ModelMessage =
  | { role: 'system' | 'user'; content: string | ModelContentPart[] }
  | { role: 'assistant'; content: string | null; tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> }
  | { role: 'tool'; content: string; tool_call_id: string }

export interface ModelStreamRequest {
  model: string
  messages: ModelMessage[]
  tools?: ModelTool[]
  output?: { type: 'text' } | { type: 'audio'; voice?: string; format: string }
  signal?: AbortSignal
}

export type ModelStreamEvent =
  | { type: 'generation'; id: string }
  | { type: 'text_delta'; choiceIndex: number; text: string }
  | { type: 'tool_call'; choiceIndex: number; index: number; id: string; name: string; arguments: unknown }
  | { type: 'finish'; choiceIndex: number; reason: string }
  | { type: 'usage'; inputTokens: number; outputTokens: number; totalTokens: number; costUsd?: string }
  | { type: 'audio_delta'; choiceIndex: number; dataBase64: string; transcript?: string }
```

`OpenAiCompatibleProvider` converts normalized content to OpenRouter wire parts:

- image → `image_url` with a `data:<mime>;base64,...` URL;
- audio → `input_audio` with raw Base64 and a format derived from verified MIME;
- video → `video_url` with a `data:<mime>;base64,...` URL.

Delete each encoded request-body reference after fetch returns/throws; no logging or persistence may retain it.

- [ ] **Step 4: Extend AgentOrchestrator input without changing workflow turns**

```ts
export interface AgentRunInput {
  conversationId: string
  content: string
  userBlocks: ChatBlock[]
  modelContent: string | ModelContentPart[]
  assetIds: string[]
  allowTools: boolean
  provider: ModelProviderId
  model: string
  requestId?: string
}
```

Persist `userBlocks` through `messages.insertWithAssets`; use `modelContent` only for the first provider user message. When `allowTools` is false, skip workflow retrieval and never attach `tools`; subsequent tool messages otherwise keep the existing behavior.

- [ ] **Step 5: Run provider/orchestrator tests**

Run: `pnpm --filter @autoforge/desktop exec vitest run --config vitest.node.config.ts electron/main/chat/openrouter-provider.test.ts electron/main/chat/deepseek-provider.test.ts electron/main/agent/agent-orchestrator.test.ts`

Expected: PASS for image/audio/video inputs, audio chunks, tool follow-up, cancellation, and DeepSeek local rejection.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/electron/main/chat/model-provider.ts apps/desktop/electron/main/chat/openrouter-provider.test.ts apps/desktop/electron/main/chat/deepseek-provider.test.ts apps/desktop/electron/main/agent/agent-orchestrator.ts apps/desktop/electron/main/agent/agent-orchestrator.test.ts
git commit -m "feat: send multimodal chat content"
```

### Task 10: Secure Remote Media Downloads

**Files:**
- Create: `apps/desktop/electron/main/media/safe-download.ts`
- Create: `apps/desktop/electron/main/media/safe-download.test.ts`

**Interfaces:**
- Produces: `SafeMediaDownloader.download(url, sink, options)`.
- Consumes: `MediaAssetService.commitGeneratedStream` in downstream provider orchestration.

- [ ] **Step 1: Write failing SSRF and bound tests**

```ts
await expect(downloader.download(
  'http://example.com/result.png',
  sink,
  { maxBytes: 500 * 1024 * 1024 },
)).rejects.toMatchObject({ code: 'MEDIA_DOWNLOAD_FAILED' })

resolveHost.mockResolvedValue([{ address: '127.0.0.1', family: 4 }])
await expect(downloader.download(
  'https://provider.example/result.png',
  sink,
  { maxBytes: 500 * 1024 * 1024 },
)).rejects.toMatchObject({ code: 'MEDIA_DOWNLOAD_FAILED' })
```

Cover loopback, RFC1918, link-local, multicast, documentation/reserved ranges, IPv4-mapped IPv6, credentials in URL, non-default ports, more than three redirects, redirect to private IP, connection timeout, first-byte timeout, total timeout, misleading `Content-Length`, actual-byte overflow, and successful bounded streaming.

- [ ] **Step 2: Run the downloader test and verify failure**

Run: `pnpm --filter @autoforge/desktop exec vitest run --config vitest.node.config.ts electron/main/media/safe-download.test.ts`

Expected: FAIL because no downloader exists.

- [ ] **Step 3: Implement URL and IP validation**

```ts
export interface SafeDownloadOptions {
  maxBytes: number
  maxRedirects?: 3
  connectTimeoutMs?: 10_000
  firstByteTimeoutMs?: 15_000
  totalTimeoutMs?: 120_000
}

export interface SafeMediaDownloader {
  download(
    rawUrl: string,
    destination: NodeJS.WritableStream,
    options: SafeDownloadOptions,
  ): Promise<{ byteSize: number; contentType?: string }>
}
```

Use `node:https.request` with a custom `lookup` callback that rejects prohibited resolved addresses before the socket connects. Set `maxRedirects` to 3, handle redirects manually, and repeat complete URL/DNS validation on every hop. Permit only canonical HTTPS URLs with no credentials and default port.

- [ ] **Step 4: Run downloader tests**

Run: `pnpm --filter @autoforge/desktop exec vitest run --config vitest.node.config.ts electron/main/media/safe-download.test.ts`

Expected: PASS for all address families, redirects, timeouts, and actual-byte limits.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/electron/main/media/safe-download.ts apps/desktop/electron/main/media/safe-download.test.ts
git commit -m "feat: secure remote media downloads"
```

### Task 11: Add OpenRouter Image and Video Operations

**Files:**
- Modify: `apps/desktop/electron/main/chat/model-provider.ts:33-59`
- Modify: `apps/desktop/electron/main/chat/openrouter-provider.ts:1-80`
- Modify: `apps/desktop/electron/main/chat/model-provider-registry.ts:1-16`
- Modify: `apps/desktop/electron/main/chat/openrouter-provider.test.ts`
- Modify: `apps/desktop/electron/main/chat/model-provider-registry.test.ts`

**Interfaces:**
- Produces: optional provider operations `generateImage`, `submitVideo`, `pollVideo`, and `downloadVideo`.
- Consumes: OpenRouter credential port, safe errors, and verified image references.

- [ ] **Step 1: Write failing protocol fixture tests**

```ts
const image = await provider.generateImage({
  model: 'google/gemini-2.5-flash-image',
  prompt: 'watercolor harbor',
  options: { count: 1, resolution: '1K', aspectRatio: 'auto', format: 'png' },
  references: [{ mimeType: 'image/png', dataBase64: 'AQID' }],
})
expect(image.outputs).toEqual([{ type: 'base64', dataBase64: 'AQID', mimeType: 'image/png' }])

fetchMock.mockResolvedValueOnce(jsonResponse({
  data: [{ url: 'https://media.example/generated.png' }],
}))
expect((await provider.generateImage({
  model: 'google/gemini-2.5-flash-image',
  prompt: 'watercolor harbor',
  options: { count: 1, resolution: '1K', aspectRatio: 'auto', format: 'png' },
  references: [],
})).outputs).toEqual([
  { type: 'url', url: 'https://media.example/generated.png' },
])

const job = await provider.submitVideo({
  model: 'google/veo-3.1',
  prompt: 'slow camera move',
  options: { durationSeconds: 5, resolution: '720p', aspectRatio: 'auto', generateAudio: false },
  references: [],
})
expect(job).toEqual({ providerJobId: 'abc123', status: 'pending' })
```

Assert image request uses `POST https://openrouter.ai/api/v1/images`, video submit uses `POST /api/v1/videos`, poll uses only `GET /api/v1/videos/<validated-id>`, and download uses only `GET /api/v1/videos/<validated-id>/content?index=0`. Ignore returned polling/download URLs.

- [ ] **Step 2: Run OpenRouter tests and verify failure**

Run: `pnpm --filter @autoforge/desktop exec vitest run --config vitest.node.config.ts electron/main/chat/openrouter-provider.test.ts electron/main/chat/model-provider-registry.test.ts`

Expected: FAIL because media generation methods are missing.

- [ ] **Step 3: Add exact provider operation types**

```ts
export interface ModelImageRequest {
  model: string
  prompt: string
  options: GenerationOptions['image']
  references: Array<{ mimeType: string; dataBase64: string }>
  signal?: AbortSignal
}

export interface ModelImageResult {
  outputs: Array<
    | { type: 'base64'; dataBase64: string; mimeType?: string }
    | { type: 'url'; url: string }
  >
  usage?: { inputTokens?: number; outputTokens?: number; costUsd?: string }
}

export interface ModelVideoRequest {
  model: string
  prompt: string
  options: GenerationOptions['video']
  references: Array<{ mimeType: string; dataBase64: string }>
  signal?: AbortSignal
}

export type ModelVideoStatus =
  | { status: 'pending' | 'in_progress' }
  | { status: 'completed'; generationId?: string; costUsd?: string }
  | { status: 'failed'; errorCode: AppError['code'] }

export interface ModelProvider {
  listModels(signal?: AbortSignal): Promise<ModelInfo[]>
  validateCredential(signal?: AbortSignal): Promise<{ valid: boolean }>
  stream(request: ModelStreamRequest): AsyncIterable<ModelStreamEvent>
  generateImage?(request: ModelImageRequest): Promise<ModelImageResult>
  submitVideo?(request: ModelVideoRequest): Promise<{ providerJobId: string; status: 'pending' | 'in_progress' }>
  pollVideo?(providerJobId: string, signal?: AbortSignal): Promise<ModelVideoStatus>
  downloadVideo?(providerJobId: string, signal?: AbortSignal): Promise<Response>
}
```

Validate provider job IDs with `/^[A-Za-z0-9_-]{1,200}$/`. Parse all provider JSON with strict outer Zod schemas plus `.passthrough()` only inside documented provider records. Drain at most 1,024 diagnostic bytes and keep current 401/403/429/5xx mappings.

- [ ] **Step 4: Implement dedicated endpoint bodies**

Image request:

```ts
{
  model,
  prompt,
  n: 1,
  resolution,
  aspect_ratio,
  output_format,
  input_references: references.map(({ mimeType, dataBase64 }) => ({
    type: 'image_url',
    image_url: { url: `data:${mimeType};base64,${dataBase64}` },
  })),
}
```

Video request:

```ts
{
  model,
  prompt,
  duration,
  resolution,
  aspect_ratio,
  generate_audio,
  input_references: references.map(({ mimeType, dataBase64 }) => ({
    type: 'image_url',
    image_url: { url: `data:${mimeType};base64,${dataBase64}` },
  })),
}
```

Omit `aspect_ratio` when it is `auto` and omit empty references.

- [ ] **Step 5: Run OpenRouter tests**

Run: `pnpm --filter @autoforge/desktop exec vitest run --config vitest.node.config.ts electron/main/chat/openrouter-provider.test.ts electron/main/chat/model-provider-registry.test.ts`

Expected: PASS for image Base64/HTTPS URL/SVG metadata, submit/poll/download, malformed job IDs, status failures, and cancellation.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/electron/main/chat/model-provider.ts apps/desktop/electron/main/chat/openrouter-provider.ts apps/desktop/electron/main/chat/model-provider-registry.ts apps/desktop/electron/main/chat/openrouter-provider.test.ts apps/desktop/electron/main/chat/model-provider-registry.test.ts
git commit -m "feat: add OpenRouter media generation APIs"
```

### Task 12: Route Requests by Provider and Model Capability

**Files:**
- Create: `apps/desktop/electron/main/chat/multimodal-router.ts`
- Create: `apps/desktop/electron/main/chat/multimodal-router.test.ts`

**Interfaces:**
- Consumes: active provider, `ModelInfo`, attachments, output choice, global defaults, and conversation preferences.
- Produces: `ResolvedChatRoute` used by text, image, audio, and video orchestrators.

- [ ] **Step 1: Write the route matrix as failing table tests**

```ts
it.each([
  ['deepseek', ['image'], 'text', 'MODEL_MODALITY_UNSUPPORTED'],
  ['openrouter', [], 'image', 'image'],
  ['openrouter', ['image'], 'video', 'video'],
  ['openrouter', ['audio'], 'image', 'MODEL_MODALITY_UNSUPPORTED'],
])('routes %s with %j to %s', (provider, attachments, output, expected) => {
  // assert either exact route or exact local safe error
})
```

Add cases for:

- automatic text-only model → text;
- automatic image-only model → image;
- first use of a multi-output model → `selectionRequired: true`;
- remembered conversation output → exact route;
- explicit output → only compatible models;
- missing compatible default → `modelRequired: true`;
- more than 5 assets or more than 250 MB → local error before provider access;
- model capability mismatch → no provider method call.

- [ ] **Step 2: Run router tests and verify failure**

Run: `pnpm --filter @autoforge/desktop exec vitest run --config vitest.node.config.ts electron/main/chat/multimodal-router.test.ts`

Expected: FAIL because no capability router exists.

- [ ] **Step 3: Implement one pure resolver**

```ts
export interface ResolveChatRouteInput {
  provider: ModelProviderId
  requestedModel?: string
  requestedOutput: OutputType
  requestedGeneration: GenerationOptions
  defaults: ProviderDefaultModels
  conversationPreferences: ConversationGenerationPreferences
  models: ModelInfo[]
  assets: ResolvedMediaAsset[]
}

export interface ResolvedChatRoute {
  provider: ModelProviderId
  model: string
  supportsTools: boolean
  outputType: 'text' | 'image' | 'audio' | 'video'
  assets: ResolvedMediaAsset[]
  generation: GenerationOptions
}

export function resolveChatRoute(input: ResolveChatRouteInput): ResolvedChatRoute
```

Resolution order:

1. validate provider and credential availability;
2. validate attachment ownership/status/count/bytes;
3. load exact selected model from current provider catalog;
4. resolve `auto` from model output modalities and conversation memory;
5. validate every input modality and target output modality;
6. filter generation options to advertised values;
7. return one route without performing I/O.

Image/video output accepts text plus image references only. Audio output uses Chat Completions and may accept every input modality advertised by that exact model.

- [ ] **Step 4: Run router tests**

Run: `pnpm --filter @autoforge/desktop exec vitest run --config vitest.node.config.ts electron/main/chat/multimodal-router.test.ts`

Expected: PASS for the complete provider/model/modality matrix.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/electron/main/chat/multimodal-router.ts apps/desktop/electron/main/chat/multimodal-router.test.ts
git commit -m "feat: route chat by model capabilities"
```

### Task 13: Persist Image and Audio Generation Turns

**Files:**
- Create: `apps/desktop/electron/main/chat/media-generation-orchestrator.ts`
- Create: `apps/desktop/electron/main/chat/media-generation-orchestrator.test.ts`
- Modify: `apps/desktop/electron/main/agent/agent-orchestrator.ts:58-149`

**Interfaces:**
- Consumes: `AgentPersistencePort`, `MediaAssetService`, `SafeMediaDownloader`, provider `generateImage`/`stream`, and `ResolvedChatRoute`.
- Produces: `MediaGenerationOrchestrator.runImage` and `runAudio`.

- [ ] **Step 1: Write failing persisted-turn tests**

```ts
await orchestrator.runImage({
  requestId: 'request_1',
  conversationId: 'conversation_1',
  prompt: 'paint a harbor',
  userBlocks,
  assetIds: [],
  route: imageRoute,
})

expect(persistence.createAssistant).toHaveBeenCalledWith(expect.objectContaining({
  initialBlocks: [expect.objectContaining({
    type: 'media_generation',
    kind: 'image',
    status: 'in_progress',
  })],
}))
expect(persistence.finalize).toHaveBeenCalledWith(expect.objectContaining({
  status: 'completed',
  blocks: [expect.objectContaining({ type: 'media', kind: 'image', purpose: 'output' })],
}))
```

For audio, emit two `audio_delta` chunks and one transcript; assert decoded bytes are appended in order, transcript becomes a text block, the final audio asset is claimed by the assistant message, and provider failure changes only the generation block to `failed`.

For an image URL output, assert the orchestrator uses `SafeMediaDownloader`, streams into `commitGeneratedStream`, and never forwards or persists the URL.

- [ ] **Step 2: Run orchestrator tests and verify failure**

Run: `pnpm --filter @autoforge/desktop exec vitest run --config vitest.node.config.ts electron/main/chat/media-generation-orchestrator.test.ts`

Expected: FAIL because the generation orchestrator is absent.

- [ ] **Step 3: Generalize persistence without duplicating database logic**

```ts
export interface PersistUserInput {
  messageId: string
  conversationId: string
  blocks: ChatBlock[]
  assetIds: string[]
  createdAt: number
}

export interface CreateAssistantInput {
  messageId: string
  conversationId: string
  initialBlocks: ChatBlock[]
  createdAt: number
}
```

`createAgentPersistence` uses `messages.insertWithAssets` for users and normal `messages.insert` for assistants. Both the existing agent and media orchestrator use the same persistence port.

- [ ] **Step 4: Implement stable generation block replacement**

```ts
const pending: MediaGenerationBlock = {
  type: 'media_generation',
  blockId,
  jobId: requestId,
  kind,
  status: 'in_progress',
}
```

Persist the initial generation block before the provider call. Base64 image output uses `commitGeneratedBase64`; URL image output uses the safe downloader plus `commitGeneratedStream`; audio chunks use `GeneratedAssetWriter.appendBase64Chunk`. On success, commit output bytes first, then replace the same `blockId` with the final `media` block and finalize the chat run. On failure, abort staging, replace the block with `status: 'failed'` and a safe error code, then emit `block_update`.

- [ ] **Step 5: Run image/audio orchestrator tests**

Run: `pnpm --filter @autoforge/desktop exec vitest run --config vitest.node.config.ts electron/main/chat/media-generation-orchestrator.test.ts electron/main/agent/agent-orchestrator.test.ts`

Expected: PASS; text/workflow turns remain unchanged and media turns are durable.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/electron/main/chat/media-generation-orchestrator.ts apps/desktop/electron/main/chat/media-generation-orchestrator.test.ts apps/desktop/electron/main/agent/agent-orchestrator.ts apps/desktop/electron/main/agent/agent-orchestrator.test.ts
git commit -m "feat: persist image and audio generations"
```

### Task 14: Run and Resume Persistent Video Jobs

**Files:**
- Create: `apps/desktop/electron/main/chat/video-job-runner.ts`
- Create: `apps/desktop/electron/main/chat/video-job-runner.test.ts`

**Interfaces:**
- Consumes: provider video methods, media/job repositories, output asset service, and block-update emitter.
- Produces: `submit`, `pause`, `resume`, `recover`, and `stop`.

- [ ] **Step 1: Write failing state-machine tests**

```ts
const result = await runner.submit(videoInput)
expect(result.status).toBe('pending')
expect(database.mediaGenerationJobs.get(result.jobId)).toMatchObject({
  providerJobId: 'provider_job_1',
  status: 'pending',
})

provider.pollVideo.mockResolvedValueOnce({ status: 'in_progress' })
  .mockResolvedValueOnce({ status: 'completed' })
await scheduler.runAll()
expect(database.mediaGenerationJobs.get(result.jobId)?.status).toBe('completed')
expect(database.messages.get('assistant_1')?.blocks).toEqual([
  expect.objectContaining({ type: 'media', kind: 'video' }),
])
```

Cover restart recovery, `downloading` restart, manual pause, resume, terminal failure, 60-minute timeout, download above 500 MB, missing conversation, duplicate scheduler wakeups, and stop-on-app-close without changing durable job state.

- [ ] **Step 2: Run runner tests and verify failure**

Run: `pnpm --filter @autoforge/desktop exec vitest run --config vitest.node.config.ts electron/main/chat/video-job-runner.test.ts`

Expected: FAIL because the video state machine is absent.

- [ ] **Step 3: Implement deterministic persisted transitions**

```ts
export interface SubmitVideoInput {
  requestId: string
  conversationId: string
  prompt: string
  userBlocks: ChatBlock[]
  assetIds: string[]
  route: ResolvedChatRoute & { outputType: 'video' }
}

export interface VideoJobRunner {
  submit(input: SubmitVideoInput): Promise<{ jobId: string; requestId: string }>
  pause(jobId: string): Promise<void>
  resume(jobId: string): Promise<void>
  recover(): Promise<void>
  stop(): Promise<void>
}
```

Transition only:

```text
pending -> in_progress -> downloading -> completed
pending | in_progress | downloading -> failed
pending | in_progress -> paused -> pending
```

Use exact polling delays of 2 seconds for attempts 1-5, 5 seconds for 6-20, then 10 seconds. Timeout at 60 minutes from `created_at`. Store only the validated provider job ID; reconstruct poll/download URLs in the provider.

- [ ] **Step 4: Make download and message replacement atomic in authority order**

1. set job `downloading`;
2. stream fixed content endpoint to `.staging`;
3. validate MIME/bytes and atomically commit the video asset;
4. replace the assistant block with `media`;
5. set job `completed` with `asset_id` and `ended_at`;
6. emit `block_update`.

If the app exits at steps 2-4, `recover()` restarts from `downloading` and idempotently reuses or replaces the staged result.

- [ ] **Step 5: Run video runner tests**

Run: `pnpm --filter @autoforge/desktop exec vitest run --config vitest.node.config.ts electron/main/chat/video-job-runner.test.ts`

Expected: PASS for every transition and crash point.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/electron/main/chat/video-job-runner.ts apps/desktop/electron/main/chat/video-job-runner.test.ts
git commit -m "feat: persist and resume video generations"
```

### Task 15: Integrate Routing, Recovery, Deletion, and Clear-Data Behavior

**Files:**
- Modify: `apps/desktop/electron/main/application.ts:200-582`
- Modify: `apps/desktop/electron/main/application.test.ts`
- Modify: `apps/desktop/electron/main/startup.ts`
- Modify: `apps/desktop/electron/main/startup.test.ts`
- Modify: `apps/desktop/electron/main/index.ts:50-150`

**Interfaces:**
- Consumes: Tasks 4-14.
- Produces: real end-to-end Main services behind `chat.send`, `chat.deleteConversation`, media IPC, recovery, and shutdown.

- [ ] **Step 1: Write failing application routing tests**

```ts
const defaultGeneration = {
  image: { count: 1 as const, resolution: '1K', aspectRatio: 'auto', format: 'png' },
  audio: { format: 'mp3' },
  video: { durationSeconds: 5, resolution: '720p', aspectRatio: 'auto', generateAudio: false },
}

await runtime.services.chat.send({
  conversationId: 'conversation_1',
  content: 'make an image',
  assetIds: [],
  outputType: 'image',
  generation: defaultGeneration,
})
expect(openrouter.generateImage).toHaveBeenCalledTimes(1)
expect(agentProvider.stream).not.toHaveBeenCalled()

await expect(runtime.services.chat.send({
  conversationId: 'conversation_1',
  content: 'analyze',
  assetIds: ['image_asset'],
  outputType: 'text',
  generation: defaultGeneration,
})).rejects.toMatchObject({ code: 'MODEL_MODALITY_UNSUPPORTED' })
expect(deepseek.stream).not.toHaveBeenCalled()
```

Add cases for image/audio/video routes, automatic selection, missing media defaults, per-conversation model preference, deletion quarantine, clear conversations/all, startup video recovery, non-video interrupted block failure, and close stopping timers.

Also test `getGenerationPreferences` and `updateGenerationPreferences` for missing conversations, strict normalization, and persistence across a runtime restart.

- [ ] **Step 2: Run application/startup tests and verify failure**

Run: `pnpm --filter @autoforge/desktop exec vitest run --config vitest.node.config.ts electron/main/application.test.ts electron/main/startup.test.ts`

Expected: FAIL because `chat.send` always invokes the text agent.

- [ ] **Step 3: Wire one route decision before every provider call**

```ts
const route = resolveChatRoute({
  provider: snapshot.activeProvider,
  requestedModel: input.model,
  requestedOutput: input.outputType,
  requestedGeneration: input.generation,
  defaults: snapshot.defaultModels,
  conversationPreferences,
  models: await modelCatalog.get(snapshot.activeProvider),
  assets: await media.resolveInputs(input.conversationId, input.assetIds),
})
```

Then dispatch exactly:

```ts
switch (route.outputType) {
  case 'text': return agent.run({ ...textInput, allowTools: route.supportsTools })
  case 'image': return mediaGeneration.runImage(generationInput)
  case 'audio': return mediaGeneration.runAudio(generationInput)
  case 'video': return videoJobs.submit(videoInput)
}
```

No fallback from an unsupported requested modality to text.

- [ ] **Step 4: Replace direct database deletion/clear calls**

- `chat.deleteConversation` → `mediaLifecycle.deleteConversation`.
- conversation/all clear → `mediaLifecycle.clearConversations` plus the existing scoped database behavior.
- startup recovery order:
  1. database migrations;
  2. media quarantine/staging recovery;
  3. fail interrupted image/audio blocks;
  4. existing execution/chat recovery;
  5. video job recovery;
  6. create window.
- shutdown order:
  1. stop accepting new work;
  2. stop video timers;
  3. cancel active synchronous requests/executions;
  4. close browser contexts/database.

- [ ] **Step 5: Run application/startup tests**

Run: `pnpm --filter @autoforge/desktop exec vitest run --config vitest.node.config.ts electron/main/application.test.ts electron/main/startup.test.ts`

Expected: PASS for all routes, deletion, clear, recovery, and shutdown.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/electron/main/application.ts apps/desktop/electron/main/application.test.ts apps/desktop/electron/main/startup.ts apps/desktop/electron/main/startup.test.ts apps/desktop/electron/main/index.ts
git commit -m "feat: integrate multimodal application routing"
```

### Task 16: Add Draft Attachments and Adaptive Composer Controls

**Files:**
- Modify: `apps/desktop/src/stores/chat.ts:35-234`
- Modify: `apps/desktop/src/components/chat/ChatComposer.vue:1-68`
- Modify: `apps/desktop/src/views/ChatView.vue:1-107`
- Modify: `apps/desktop/tests/components/chat.test.ts`

**Interfaces:**
- Consumes: `DesktopAPI.media`, `ConversationGenerationPreferences`, capability-rich model list.
- Produces: per-conversation draft assets/output options and complete `ChatSendInput`.

- [ ] **Step 1: Write failing composer/store tests**

```ts
await wrapper.get('[data-testid="attach-media"]').trigger('click')
expect(api.media.pickFiles).toHaveBeenCalledWith({
  conversationId: 'conversation_1',
  existingAssetIds: [],
})

await wrapper.get('[data-testid="output-type"]').setValue('video')
expect(wrapper.find('[data-testid="video-options"]').exists()).toBe(true)
expect(wrapper.find('[data-testid="image-options"]').exists()).toBe(false)
```

Add tests for:

- drop imports;
- clipboard image paste;
- remove draft calls `removeDraft`;
- fifth attachment allowed and sixth blocked;
- send with attachment and empty text allowed only for text output;
- selected output/model/options persist per conversation;
- model list filters by output capability;
- automatic multi-output first use displays a required choice;
- switching conversations cannot leak draft assets or late async responses.

- [ ] **Step 2: Run Renderer chat tests and verify failure**

Run: `pnpm --filter @autoforge/desktop exec vitest run --config vitest.config.ts tests/components/chat.test.ts`

Expected: FAIL because the composer has text-only submission.

- [ ] **Step 3: Extend store state and stable block updates**

```ts
draftsByConversation: {} as Record<string, MediaAsset[]>,
preferencesByConversation: {} as Record<string, ConversationGenerationPreferences>,
```

`applyChatEvent` handles:

```ts
if (event.type === 'block_update') {
  const index = message.blocks.findIndex((block) =>
    'blockId' in block && block.blockId === event.blockId)
  if (index >= 0) message.blocks[index] = {
    ...event.block,
    id: `${event.messageId}:${event.blockId}`,
  }
  return
}
```

Do not derive media identity from array position.

Load preferences with `chat.getGenerationPreferences` when selecting a conversation. Serialize full-object updates through a per-conversation promise queue and call `chat.updateGenerationPreferences` after output type, model, or generation options change. A late response for the prior conversation must not overwrite the selected conversation.

- [ ] **Step 4: Build the adaptive composer**

The `submit` event becomes:

```ts
submit: [{
  content: string
  assetIds: string[]
  outputType: OutputType
  generation: GenerationOptions
  model?: string
}]
```

UI order:

1. attachment button;
2. output type (`自动 / 文本 / 图片 / 音频 / 视频`);
3. only the selected output’s supported parameter summary;
4. attachment cards with kind/name/size/remove;
5. text input and send/cancel.

Handle `dragover/drop` on the composer root and `paste` on the textarea. Clipboard handling calls Main import and does not read image bytes in Renderer.

- [ ] **Step 5: Run Renderer chat tests**

Run: `pnpm --filter @autoforge/desktop exec vitest run --config vitest.config.ts tests/components/chat.test.ts`

Expected: PASS for button/drop/paste, per-conversation memory, model filtering, and complete send payload.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/stores/chat.ts apps/desktop/src/components/chat/ChatComposer.vue apps/desktop/src/views/ChatView.vue apps/desktop/tests/components/chat.test.ts
git commit -m "feat: add multimodal chat composer"
```

### Task 17: Render Image, Audio, Video, and Generation Status Blocks

**Files:**
- Create: `apps/desktop/src/components/chat/MediaBlock.vue`
- Create: `apps/desktop/src/components/chat/MediaGenerationBlock.vue`
- Modify: `apps/desktop/src/components/chat/MessageBlock.vue:1-62`
- Modify: `apps/desktop/src/services/desktop-api.ts:20-46`
- Modify: `apps/desktop/tests/components/chat.test.ts`
- Modify: `apps/desktop/src/styles/index.css`

**Interfaces:**
- Consumes: media and generation `ChatBlock` variants.
- Produces: inline media playback/display and job actions using safe asset IDs only.

- [ ] **Step 1: Write failing media rendering tests**

```ts
const wrapper = mount(MessageBlock, {
  props: { block: imageBlock },
  global: { plugins: [ElementPlus] },
})
expect(wrapper.get('img').attributes('src'))
  .toBe('autoforge-media://asset/asset_1')
expect(wrapper.html()).not.toContain('/Users/')
expect(wrapper.html()).not.toContain('base64')
```

Add tests for native `<audio controls>`, `<video controls>`, SVG without `<img>`, save/reveal buttons, indeterminate progress without a fake percentage, pause warning copy, resume action, and isolated failure blocks.

- [ ] **Step 2: Run Renderer tests and verify failure**

Run: `pnpm --filter @autoforge/desktop exec vitest run --config vitest.config.ts tests/components/chat.test.ts`

Expected: FAIL because media components do not exist.

- [ ] **Step 3: Implement the final media component**

```ts
const source = computed(() => `autoforge-media://asset/${props.block.assetId}`)
const inlineImage = computed(() =>
  props.block.kind === 'image' && props.block.mimeType !== 'image/svg+xml')
```

- image: responsive single card/grid item with bounded dimensions;
- audio: native controls plus format/duration/size;
- video: native controls with `preload="metadata"`;
- SVG: filename/size and save/reveal only;
- all: save copy and reveal buttons call `DesktopAPI.media`.

- [ ] **Step 4: Implement generation status truthfully**

Use Element Plus indeterminate progress/spinner for `pending`, `in_progress`, and `downloading`. Show no numeric percent. For video:

- action text: `暂停跟踪`;
- warning: `暂停只会停止本地跟踪，上游任务可能继续执行并产生费用。`;
- paused action: `继续跟踪`.

Failure shows the localized safe error and a retry affordance only when the original request can be reconstructed from stored conversation state.

Map the new safe codes to exact Chinese messages in `desktop-api.ts`:

```ts
MEDIA_TYPE_UNSUPPORTED: '不支持此媒体格式',
MEDIA_ATTACHMENT_LIMIT_EXCEEDED: '每条消息最多添加 5 个附件',
MEDIA_SIZE_LIMIT_EXCEEDED: '媒体文件大小超出限制',
MEDIA_MIME_MISMATCH: '文件内容与格式不匹配',
MEDIA_IMPORT_FAILED: '媒体文件导入失败',
MEDIA_ASSET_UNAVAILABLE: '媒体文件不可用或已损坏',
MEDIA_STORAGE_FULL: '本地磁盘空间不足',
MODEL_MODALITY_UNSUPPORTED: '当前模型不支持所选输入或输出类型',
MEDIA_GENERATION_FAILED: '媒体生成失败',
MEDIA_DOWNLOAD_FAILED: '媒体下载失败',
MEDIA_GENERATION_TIMEOUT: '视频生成超时',
```

- [ ] **Step 5: Run Renderer tests**

Run: `pnpm --filter @autoforge/desktop exec vitest run --config vitest.config.ts tests/components/chat.test.ts`

Expected: PASS with no path/Base64 leakage and correct controls.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/components/chat/MediaBlock.vue apps/desktop/src/components/chat/MediaGenerationBlock.vue apps/desktop/src/components/chat/MessageBlock.vue apps/desktop/src/services/desktop-api.ts apps/desktop/tests/components/chat.test.ts apps/desktop/src/styles/index.css
git commit -m "feat: render multimodal chat blocks"
```

### Task 18: Let Users Edit Default Models per Output Type

**Files:**
- Modify: `apps/desktop/src/stores/settings.ts:18-206`
- Modify: `apps/desktop/src/views/SettingsView.vue`
- Modify: `apps/desktop/tests/components/workbench.test.ts`
- Modify: `apps/desktop/src/views/ChatView.vue:75-95`

**Interfaces:**
- Consumes: nested defaults and `ModelInfo` capabilities.
- Produces: editable DeepSeek text slot and OpenRouter text/image/audio/video slots.

- [ ] **Step 1: Write failing settings tests**

```ts
await store.saveDefaultModel('image', 'google/gemini-2.5-flash-image')
expect(api.settings.update).toHaveBeenCalledWith({
  defaultModels: {
    deepseek: { text: 'deepseek-chat' },
    openrouter: {
      text: 'openai/gpt-4.1-mini',
      image: 'google/gemini-2.5-flash-image',
    },
  },
})
```

Mount Settings and assert:

- DeepSeek shows only `默认文本模型`;
- OpenRouter shows `默认文本模型`, `默认图片模型`, `默认音频模型`, `默认视频模型`;
- each select lists only models whose `outputModalities` contain that slot;
- an empty media slot displays `未设置`;
- a saved model missing from the latest catalog remains visible as `（已保存模型）`;
- switching providers does not overwrite the other provider’s slots.

- [ ] **Step 2: Run settings UI tests and verify failure**

Run: `pnpm --filter @autoforge/desktop exec vitest run --config vitest.config.ts tests/components/workbench.test.ts`

Expected: FAIL because settings currently store one string per provider.

- [ ] **Step 3: Implement slot-aware getters/actions**

```ts
modelOptionsFor(output: 'text' | 'image' | 'audio' | 'video'): ModelInfo[] {
  return this.models.filter((model) => model.outputModalities.includes(output))
}

async saveDefaultModel(
  output: 'text' | 'image' | 'audio' | 'video',
  model: string | undefined,
): Promise<void> {
  // clone the active provider object, set/delete only output, preserve every other provider and slot
}
```

Update ChatView fallback selection to use the resolved output slot, not the old provider string.

- [ ] **Step 4: Run settings and chat UI tests**

Run: `pnpm --filter @autoforge/desktop exec vitest run --config vitest.config.ts tests/components/workbench.test.ts tests/components/chat.test.ts`

Expected: PASS for slot filtering, updates, fallback, and provider switching.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/stores/settings.ts apps/desktop/src/views/SettingsView.vue apps/desktop/src/views/ChatView.vue apps/desktop/tests/components/workbench.test.ts apps/desktop/tests/components/chat.test.ts
git commit -m "feat: edit default models by output type"
```

### Task 19: Run Full Verification and Non-Paid Desktop QA

**Files:**
- Modify only if a failing check exposes a defect in files already listed above.
- Do not create paid-test credentials, fixture secrets, or committed generated media.

**Interfaces:**
- Consumes: the complete feature.
- Produces: verified contracts, tests, build, packaged runtime, and a documented unpaid manual QA result.

- [ ] **Step 1: Run focused security and behavior suites**

Run:

```bash
pnpm exec vitest run packages/shared/src/contracts.test.ts
pnpm --filter @autoforge/desktop exec vitest run --config vitest.node.config.ts electron/main/media electron/main/chat electron/main/application.test.ts electron/main/startup.test.ts electron/main/ipc/register-ipc.test.ts electron/preload/bridge.test.ts
pnpm --filter @autoforge/desktop exec vitest run --config vitest.config.ts tests/components/chat.test.ts tests/components/workbench.test.ts
```

Expected: PASS with no paid network call.

- [ ] **Step 2: Run repository-wide static and test checks**

Run:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Expected: all commands exit 0.

- [ ] **Step 3: Build the directory package**

Run: `pnpm dist:dir`

Expected: exit 0 and produce a launchable app directory under `apps/desktop/dist/`.

- [ ] **Step 4: Perform unpaid local desktop QA**

Use local fixture assets only:

1. create a new conversation;
2. attach one image by button, one by drop, and one clipboard image;
3. confirm the UI shows name/type/size but no path;
4. switch output types and verify only supported controls appear;
5. restart the app and confirm conversation preferences and persisted media blocks remain;
6. play fixture audio/video and seek to prove Range support;
7. save a copy and reveal an asset;
8. delete the conversation and verify its media directory is gone;
9. confirm DeepSeek rejects the same media request locally;
10. confirm text/workflow chat still works with no media.

Expected: all ten checks pass without contacting a paid generation endpoint.

- [ ] **Step 5: Request confirmation before live paid smoke tests**

Ask the user for explicit approval for:

- Nano Banana image input/output;
- one audio input/output request;
- one video submission followed by application restart, resume, and download.

If approval is not given, record these as unexecuted paid smoke tests; do not call the endpoints and do not claim live verification.

- [ ] **Step 6: Confirm the final diff is clean and attributable**

```bash
git status --short
git diff --check
```

If Step 1-4 exposed a defect, return to the owning task, add the regression test there, re-run that task's exact verification command, and use that task's exact staging list. Do not create an empty verification commit and do not stage pre-existing unrelated changes.
