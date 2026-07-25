# Task 9 Implementer Report — Multimodal Chat Requests and Audio Streams

## Status

Implemented and ready for review.

## Provider request boundary

- Added Main-only `ModelContentPart` content with text and Task 4-backed image, audio, and video media parts.
- OpenRouter converts normalized parts at the fetch boundary:
  - image to `image_url` with an exact MIME data URL;
  - audio to `input_audio` with raw Base64 and an exact verified MIME-to-format mapping;
  - video to `video_url` with an exact MIME data URL.
- Accepted Task 4 audio mappings are `audio/mpeg -> mp3`, `audio/wav -> wav`, `audio/ogg -> ogg`, `audio/flac -> flac`, and `audio/mp4 -> m4a`.
- Image, audio, and video MIME sets are exact. A mismatched kind/MIME or unsupported audio MIME fails with `MODEL_MODALITY_UNSUPPORTED` before credential access or fetch.
- OpenRouter audio output adds `modalities: ['text', 'audio']` and the requested `audio` voice/format object.
- DeepSeek rejects media input and audio output locally before credential access or fetch while retaining its existing text, tool, usage, retry, and cancellation behavior.
- Encoded wire messages and serialized request bodies are attempt-local variables and are cleared in `finally` as soon as fetch settles. Diagnostics receive only existing bounded metadata; no encoded request content is logged or persisted.

## Audio stream boundary

- The shared SSE parser accepts `delta.audio.data` plus its optional transcript and emits ordered `audio_delta` events.
- Audio retry replay is tracked by choice and chunk position, so already delivered audio is suppressed and divergent replay fails closed.
- Existing generation, text, tool-call, finish, usage, retry, and cancellation parsing remains unchanged.

## Agent orchestration and persistence

- `AgentRunInput` now requires `userBlocks`, `modelContent`, exact `assetIds`, and `allowTools`.
- User display blocks are persisted through `messages.insertWithAssets`, which keeps the repository's exact block/asset identity and metadata validation authoritative.
- Encoded `modelContent` is used only for the first provider user message and is not part of the persistence input.
- `allowTools: false` skips both workflow listing and retrieval and never attaches tools.
- Tool-enabled follow-up retains the original normalized user message and appends the existing assistant tool call and tool result without changing their shape.
- The current application text path was migrated with text-only defaults. Resolving real attachments and selecting multimodal routes remains Task 10 scope.

## TDD evidence

Initial provider RED:

```text
pnpm --filter @autoforge/desktop exec vitest run --config vitest.node.config.ts electron/main/chat/openrouter-provider.test.ts electron/main/chat/deepseek-provider.test.ts
```

Seven expected tests failed because media parts were sent unchanged, audio request options and deltas were ignored, invalid MIME combinations reached fetch, and DeepSeek media requests reached provider work.

Initial orchestrator RED:

```text
pnpm --filter @autoforge/desktop exec vitest run --config vitest.node.config.ts electron/main/agent/agent-orchestrator.test.ts
```

Four expected tests failed because supplied blocks/assets/model content were discarded, persistence used plain `insert`, and `allowTools: false` still ran workflow discovery.

Each production change was made only after the corresponding failing behavior was observed. Provider and orchestrator suites passed after their respective minimal implementations.

## Regression coverage

- Image/audio/video wire conversion and audio output request body.
- All five verified audio MIME-to-format mappings and incompatible MIME rejection.
- Ordered audio data/transcript deltas plus retry replay suppression.
- DeepSeek media and audio-output rejection before credential/fetch.
- Exact asset-aware user persistence without encoded Base64.
- Tool-disabled workflow bypass and tool-enabled media follow-up.
- Cancellation of an in-flight media provider turn with one terminal persistence.
- Existing provider text/tool/usage/cancel behavior and application/database integration.
- Fixed the prior `ChatEvent` narrowing error and widened only the generated/uploaded test fixture source union needed by database type checking.

## Verification

- Full desktop-node suite: 24 files, 398 tests passed.
- Task provider/orchestrator plus application/database/integration regressions passed.
- Main TypeScript check passed: `tsc --noEmit -p tsconfig.node.json`.
- Repository lint passed with 0 errors and 207 pre-existing Vue formatting warnings.
- Production build passed for packages, Main, Preload, Renderer, and workflow runner. It emitted only the existing two `@vueuse/core` Rollup annotation warnings.
- `git diff --check` passed.

## Desktop typecheck boundary

`pnpm --filter @autoforge/desktop typecheck` now completes the Main TypeScript phase and then stops on three pre-existing Renderer migration errors outside Task 9:

- `src/stores/chat.ts:193` still sends the legacy short chat input without the new asset/output/generation fields.
- `src/stores/settings.ts:48` still treats modality-aware default model state as a string.
- `src/stores/settings.ts:53` still creates a partial `ModelInfo`.

No Task 9 Main or test file is reported by the focused Main TypeScript check.
