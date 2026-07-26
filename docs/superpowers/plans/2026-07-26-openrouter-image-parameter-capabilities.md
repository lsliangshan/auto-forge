# OpenRouter Image Parameter Capabilities Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop AutoForge from sending image-generation parameters that the selected OpenRouter image model does not advertise.

**Architecture:** `resolveChatRoute` derives explicit image parameter-support metadata from the selected model catalog entry. `MediaGenerationOrchestrator` passes that metadata through the `ModelImageRequest` contract, and `OpenRouterProvider` conditionally serializes only supported optional fields while preserving the existing non-retrying paid POST.

**Tech Stack:** TypeScript, Electron Main, Zod, Vitest, pnpm.

## Global Constraints

- API keys remain Main-only in `SecretStore`/`safeStorage`; no key or raw provider error body crosses Preload.
- Keep `retry: "never"` for image-generation POST requests.
- Do not hardcode FLUX model IDs.
- Do not change audio/video request behavior, settings UI, defaults, or the SQLite schema.
- Do not issue a real paid image request during automated verification.
- Treat an empty image capability array as “parameter not advertised” for the dedicated OpenRouter Images API.

---

### Task 1: Derive selected-model image parameter support in the router

**Files:**
- Modify: `apps/desktop/electron/main/chat/model-provider.ts:54`
- Modify: `apps/desktop/electron/main/chat/multimodal-router.ts:30-38`
- Test: `apps/desktop/electron/main/chat/multimodal-router.test.ts`

**Interfaces:**
- Produces:

```ts
export interface ModelImageParameterSupport {
  resolution: boolean
  aspectRatio: boolean
  outputFormat: boolean
}
```

- Produces: optional `ResolvedChatRoute.imageParameterSupport`, present for every resolved `outputType: "image"` route.
- Consumes: `ModelInfo.generation.image.resolutions`, `.aspectRatios`, and `.formats`.

- [ ] **Step 1: Write the failing FLUX-style router test**

Add this case inside `describe('resolveChatRoute', ...)`:

```ts
it('marks only advertised image request parameters as supported', () => {
  const route = resolveChatRoute(input({
    requestedModel: 'black-forest-labs/flux.2-flex',
    requestedOutput: 'image',
    models: [model({
      id: 'black-forest-labs/flux.2-flex',
      inputModalities: ['text', 'image'],
      outputModalities: ['image'],
      generation: {
        image: {
          resolutions: [],
          aspectRatios: ['16:9'],
          formats: ['png', 'jpeg'],
          maxCount: 1,
        },
      },
    })],
  }))

  expect(route).toMatchObject({
    outputType: 'image',
    imageParameterSupport: {
      resolution: false,
      aspectRatio: true,
      outputFormat: true,
    },
  })
})
```

- [ ] **Step 2: Run the router test and verify RED**

Run:

```bash
pnpm --filter @autoforge/desktop exec vitest run \
  --config vitest.node.config.ts \
  electron/main/chat/multimodal-router.test.ts
```

Expected: FAIL because `imageParameterSupport` is absent from the resolved route.

- [ ] **Step 3: Add the support contract and minimal route derivation**

In `model-provider.ts`, export:

```ts
export interface ModelImageParameterSupport {
  resolution: boolean
  aspectRatio: boolean
  outputFormat: boolean
}
```

In `multimodal-router.ts`, import that type and extend the internal route:

```ts
export interface ResolvedChatRoute {
  provider: ModelProviderId
  model: string
  supportsTools: boolean
  outputType: ConcreteOutput
  assets: ResolvedMediaAsset[]
  generation: GenerationOptions
  imageParameterSupport?: ModelImageParameterSupport
}
```

In `route(...)`, derive support only for image output:

```ts
const imageCapability = output === 'image' ? model.generation.image : undefined

return {
  provider: input.provider,
  model: model.id,
  supportsTools: output === 'text' && model.supportsTools && model.inputModalities.includes('text'),
  outputType: output,
  assets: input.assets.slice(),
  generation: normalizeGeneration(input.requestedGeneration, model, output),
  ...(imageCapability
    ? {
        imageParameterSupport: {
          resolution: imageCapability.resolutions.length > 0,
          aspectRatio: imageCapability.aspectRatios.length > 0,
          outputFormat: imageCapability.formats.length > 0,
        },
      }
    : {}),
}
```

- [ ] **Step 4: Run the router test and verify GREEN**

Run the command from Step 2.

Expected: all router tests PASS.

- [ ] **Step 5: Commit the router contract**

```bash
git add \
  apps/desktop/electron/main/chat/model-provider.ts \
  apps/desktop/electron/main/chat/multimodal-router.ts \
  apps/desktop/electron/main/chat/multimodal-router.test.ts
git commit -m "fix: derive image parameter capabilities"
```

---

### Task 2: Serialize only supported OpenRouter image parameters

**Files:**
- Modify: `apps/desktop/electron/main/chat/model-provider.ts:54-60`
- Modify: `apps/desktop/electron/main/chat/media-generation-orchestrator.ts:232-252`
- Modify: `apps/desktop/electron/main/chat/openrouter-provider.ts:76-87,237-262`
- Test: `apps/desktop/electron/main/chat/openrouter-provider.test.ts`
- Test: `apps/desktop/electron/main/chat/media-generation-orchestrator.test.ts`

**Interfaces:**
- Consumes: `ResolvedChatRoute.imageParameterSupport` from Task 1.
- Changes `ModelImageRequest` to require:

```ts
parameterSupport: ModelImageParameterSupport
```

- Produces: an OpenRouter `/api/v1/images` body that omits unsupported `resolution`, `aspect_ratio`, and `output_format`.

- [ ] **Step 1: Write the failing Provider request-body tests**

Add a shared all-supported fixture near the Provider test credential:

```ts
const allImageParameters = {
  resolution: true,
  aspectRatio: true,
  outputFormat: true,
} as const
```

Add two focused tests:

```ts
it('omits image parameters not advertised by a FLUX-style model', async () => {
  let body: Record<string, unknown> | undefined
  const provider = new OpenRouterProvider({
    credential,
    fetch: vi.fn(async (_input, init) => {
      body = JSON.parse(String(init?.body))
      return Response.json({ data: [{ b64_json: 'AQID' }] })
    }),
  })

  await provider.generateImage({
    model: 'black-forest-labs/flux.2-flex',
    prompt: '2d puppy',
    options: { count: 1, resolution: '1K', aspectRatio: '16:9', format: 'png' },
    parameterSupport: {
      resolution: false,
      aspectRatio: true,
      outputFormat: true,
    },
    references: [],
  })

  expect(body).toEqual({
    model: 'black-forest-labs/flux.2-flex',
    prompt: '2d puppy',
    n: 1,
    aspect_ratio: '16:9',
    output_format: 'png',
  })
})

it('keeps resolution but omits an unadvertised output format', async () => {
  let body: Record<string, unknown> | undefined
  const provider = new OpenRouterProvider({
    credential,
    fetch: vi.fn(async (_input, init) => {
      body = JSON.parse(String(init?.body))
      return Response.json({ data: [{ b64_json: 'AQID' }] })
    }),
  })

  await provider.generateImage({
    model: 'google/gemini-3-pro-image',
    prompt: '2d puppy',
    options: { count: 1, resolution: '2K', aspectRatio: '1:1', format: 'png' },
    parameterSupport: {
      resolution: true,
      aspectRatio: true,
      outputFormat: false,
    },
    references: [],
  })

  expect(body).toEqual({
    model: 'google/gemini-3-pro-image',
    prompt: '2d puppy',
    n: 1,
    resolution: '2K',
    aspect_ratio: '1:1',
  })
})
```

- [ ] **Step 2: Run the Provider tests and verify RED**

Run:

```bash
pnpm --filter @autoforge/desktop exec vitest run \
  --config vitest.node.config.ts \
  electron/main/chat/openrouter-provider.test.ts
```

Expected: the new tests FAIL because the strict request schema rejects
`parameterSupport`, or because the request body still contains unsupported fields.

- [ ] **Step 3: Write the failing orchestrator forwarding test**

Add `imageParameterSupport` to the existing `imageRoute` fixture:

```ts
imageParameterSupport: {
  resolution: false,
  aspectRatio: true,
  outputFormat: true,
},
```

In the existing successful image-generation test, capture the argument passed to
`generateImage` and assert:

```ts
expect(generateImage).toHaveBeenCalledWith(expect.objectContaining({
  parameterSupport: {
    resolution: false,
    aspectRatio: true,
    outputFormat: true,
  },
}))
```

- [ ] **Step 4: Run the orchestrator test and verify RED**

Run:

```bash
pnpm --filter @autoforge/desktop exec vitest run \
  --config vitest.node.config.ts \
  electron/main/chat/media-generation-orchestrator.test.ts
```

Expected: FAIL because the orchestrator does not pass `parameterSupport`.

- [ ] **Step 5: Extend and validate the Model Provider request contract**

In `model-provider.ts`:

```ts
export interface ModelImageRequest {
  model: string
  prompt: string
  options: GenerationOptions['image']
  parameterSupport: ModelImageParameterSupport
  references: Array<{ mimeType: string; dataBase64: string }>
  signal?: AbortSignal
}
```

In `openrouter-provider.ts`, extend `imageRequestSchema`:

```ts
parameterSupport: z.object({
  resolution: z.boolean(),
  aspectRatio: z.boolean(),
  outputFormat: z.boolean(),
}).strict(),
```

Add `parameterSupport: allImageParameters` to existing valid image requests in
`openrouter-provider.test.ts`. Keep invalid-input cases explicit so the strict
boundary remains covered.

- [ ] **Step 6: Forward support metadata from the orchestrator**

Before calling the Provider:

```ts
if (!input.route.imageParameterSupport) {
  throw toSafeAppError({ code: 'INVALID_INPUT' })
}
```

Then pass:

```ts
parameterSupport: input.route.imageParameterSupport,
```

- [ ] **Step 7: Conditionally serialize the OpenRouter request body**

Replace unconditional optional fields with:

```ts
const support = parsedRequest.parameterSupport

body: JSON.stringify({
  model: parsedRequest.model,
  prompt: parsedRequest.prompt,
  n: 1,
  ...(support.resolution
    ? { resolution: parsedRequest.options.resolution }
    : {}),
  ...(support.aspectRatio && parsedRequest.options.aspectRatio !== 'auto'
    ? { aspect_ratio: parsedRequest.options.aspectRatio }
    : {}),
  ...(support.outputFormat
    ? { output_format: parsedRequest.options.format }
    : {}),
  ...(inputReferences.length ? { input_references: inputReferences } : {}),
}),
```

Leave the call option unchanged:

```ts
{ retry: 'never' }
```

- [ ] **Step 8: Run focused tests and verify GREEN**

Run:

```bash
pnpm --filter @autoforge/desktop exec vitest run \
  --config vitest.node.config.ts \
  electron/main/chat/multimodal-router.test.ts \
  electron/main/chat/openrouter-provider.test.ts \
  electron/main/chat/media-generation-orchestrator.test.ts
```

Expected: all focused tests PASS.

- [ ] **Step 9: Run repository verification**

Run:

```bash
pnpm build
pnpm test
pnpm typecheck
pnpm lint
git diff --check
```

Expected:

- build exits 0;
- 37 test files and at least 884 tests pass;
- typecheck exits 0;
- lint reports 0 errors (existing warnings may remain);
- `git diff --check` exits 0.

- [ ] **Step 10: Commit the request serialization fix**

```bash
git add \
  apps/desktop/electron/main/chat/model-provider.ts \
  apps/desktop/electron/main/chat/media-generation-orchestrator.ts \
  apps/desktop/electron/main/chat/media-generation-orchestrator.test.ts \
  apps/desktop/electron/main/chat/openrouter-provider.ts \
  apps/desktop/electron/main/chat/openrouter-provider.test.ts
git commit -m "fix: honor OpenRouter image parameter capabilities"
```

After the commit, verify `git status --short` is empty. Do not run a paid provider
request without new explicit authorization.
