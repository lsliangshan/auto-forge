# OpenRouter Video Frame Images Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make OpenRouter image-to-video requests send ordered `frame_images` instead of unsupported `input_references`.

**Architecture:** Keep the existing `ModelVideoRequest.references` boundary and correct only the OpenRouter wire adapter. Validate at most two frame images before credential access, then serialize them as first and last frames while leaving text-to-video, polling, and downloading unchanged.

**Tech Stack:** TypeScript, Zod, Vitest, Electron Node test runtime.

## Global Constraints

- Touch only the OpenRouter provider and its provider test file.
- Preserve text-to-video request bodies.
- Do not add model-ID-specific branches.
- Use TDD and verify the regression test fails for the old `input_references` behavior before editing production code.

---

### Task 1: Correct video frame request serialization

**Files:**
- Modify: `apps/desktop/electron/main/chat/openrouter-provider.ts:94-116,330-357`
- Test: `apps/desktop/electron/main/chat/openrouter-provider.test.ts:477-506`

**Interfaces:**
- Consumes: `ModelVideoRequest.references: Array<{ mimeType: string; dataBase64: string }>` in attachment order.
- Produces: OpenRouter JSON `frame_images` entries with `frame_type: "first_frame" | "last_frame"`.

- [ ] **Step 1: Change the existing single-image request assertion to the desired wire contract**

Replace the expected `input_references` block with:

```ts
frame_images: [{
  type: 'image_url',
  image_url: { url: 'data:image/webp;base64,AQID' },
  frame_type: 'first_frame',
}],
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
pnpm --filter @autoforge/desktop exec node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts electron/main/chat/openrouter-provider.test.ts -t 'submits verified video frames with explicit aspect ratio' --reporter=verbose
```

Expected: FAIL because the received body contains `input_references` instead of `frame_images`.

- [ ] **Step 3: Add coverage for ordered first/last frames and the two-frame limit**

Add a two-image request assertion whose exact frame list is:

```ts
[
  {
    type: 'image_url',
    image_url: { url: 'data:image/png;base64,AQID' },
    frame_type: 'first_frame',
  },
  {
    type: 'image_url',
    image_url: { url: 'data:image/jpeg;base64,BAUG' },
    frame_type: 'last_frame',
  },
]
```

Add a three-image request test that expects `{ code: 'INVALID_INPUT' }` and verifies neither credential access nor fetch occurs.

- [ ] **Step 4: Implement the minimal provider change**

Set the video request schema to `references: z.array(imageReferenceSchema).max(2)` and add:

```ts
function wireFrameImages(references: Array<{ mimeType: string; dataBase64: string }>) {
  return wireReferences(references).map((reference, index) => ({
    ...reference,
    frame_type: index === 0 ? 'first_frame' : 'last_frame',
  }))
}
```

In `submitVideo`, replace `inputReferences` with `frameImages` and serialize:

```ts
...(frameImages.length ? { frame_images: frameImages } : {}),
```

- [ ] **Step 5: Run focused and provider tests and verify GREEN**

Run:

```bash
pnpm --filter @autoforge/desktop exec node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts electron/main/chat/openrouter-provider.test.ts --reporter=verbose
```

Expected: all tests in `openrouter-provider.test.ts` pass.

- [ ] **Step 6: Run type and diff verification**

Run:

```bash
pnpm --filter @autoforge/desktop typecheck
git diff --check
```

Expected: both commands exit successfully with no type or whitespace errors.

- [ ] **Step 7: Commit the implementation**

```bash
git add apps/desktop/electron/main/chat/openrouter-provider.ts apps/desktop/electron/main/chat/openrouter-provider.test.ts docs/superpowers/plans/2026-08-18-openrouter-video-frame-images.md
git commit -m "fix: send video inputs as frame images"
```
