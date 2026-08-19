# Generic Qiniu File Upload Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract Qiniu upload into a reusable Electron Main-process file uploader that prefixes every object key with `QINIU_DEFAULT_PATH` and sends uploads through `QINIU_UPLOAD_URL`, then use it for profile avatars.

**Architecture:** A new `upload/qiniu-file-uploader.ts` owns configuration parsing, safe key normalization, Qiniu token/SDK adaptation, upload execution, response verification, and public URL construction. `profile/avatar-uploader.ts` retains only avatar selection and image-specific validation, delegating the actual upload through a narrow `QiniuFileUploaderPort` interface. The application composition root creates the generic uploader once and injects it into the avatar uploader.

**Tech Stack:** TypeScript 6, Electron Main, Node.js 22+, Qiniu Node SDK 7.15.2, Vitest 4, pnpm.

## Global Constraints

- Modify only the `auto-forge` repository; the referenced `smlrtapi` upload service remains read-only.
- `QINIU_DEFAULT_PATH=autoforge/` is the mandatory prefix for every uploaded object key.
- `QINIU_UPLOAD_URL=https://up-z2.qiniup.com` is the upload endpoint used by the Qiniu SDK adapter.
- Keep avatar-specific 5 MiB and JPEG/PNG/WebP validation outside the generic uploader.
- Do not add a renderer-facing arbitrary-file-upload IPC.
- Do not expose credentials, upload tokens, provider responses, or local paths through profile errors.
- Preserve the existing ignored `.env`; commit only `.env.example` changes.

---

### Task 1: Add the generic Qiniu file uploader

**Files:**
- Create: `apps/desktop/electron/main/upload/qiniu-file-uploader.ts`
- Create: `apps/desktop/electron/main/upload/qiniu-file-uploader.test.ts`

**Interfaces:**
- Consumes: `qiniu` SDK and `toSafeAppError()` from `@autoforge/shared`.
- Produces: `QiniuConfig`, `QiniuFileUploadInput`, `QiniuFileUploadResult`, `QiniuFileUploaderPort`, `QiniuUploadPort`, `readQiniuConfig(env)`, and `QiniuFileUploader`.

- [ ] **Step 1: Write failing configuration and upload tests**

Create tests that define the desired public contract:

```ts
import { describe, expect, it, vi } from 'vitest'
import {
  QiniuFileUploader,
  readQiniuConfig,
  type QiniuUploadPort,
} from './qiniu-file-uploader.js'

const env = {
  QINIU_ACCESS_KEY: 'access',
  QINIU_SECRET_KEY: 'secret',
  QINIU_BUCKET: 'bucket',
  QINIU_DOMAIN: 'https://cdn.example.com',
  QINIU_DEFAULT_PATH: '/autoforge//',
  QINIU_UPLOAD_URL: 'https://up-z2.qiniup.com',
}

it('reads and normalizes the generic Qiniu configuration', () => {
  expect(readQiniuConfig(env)).toEqual({
    accessKey: 'access',
    secretKey: 'secret',
    bucket: 'bucket',
    domain: 'https://cdn.example.com',
    defaultPath: 'autoforge/',
    uploadUrl: 'https://up-z2.qiniup.com',
  })
})

it('prefixes and normalizes the key before using the configured upload URL', async () => {
  const upload: QiniuUploadPort = {
    putFile: vi.fn(async ({ key }) => ({ key, hash: 'hash' })),
  }
  const uploader = new QiniuFileUploader({ config: () => readQiniuConfig(env), upload })

  await expect(uploader.uploadFile({
    localPath: '/tmp/avatar.png',
    key: '../profiles//./user_1/avatar 1.png',
    mimeType: 'image/png',
  })).resolves.toEqual({
    url: 'https://cdn.example.com/autoforge/profiles/user_1/avatar%201.png',
    key: 'autoforge/profiles/user_1/avatar 1.png',
    hash: 'hash',
    bucket: 'bucket',
  })
  expect(upload.putFile).toHaveBeenCalledWith(expect.objectContaining({
    uploadUrl: 'https://up-z2.qiniup.com',
    key: 'autoforge/profiles/user_1/avatar 1.png',
  }))
})

it('rejects invalid upload URLs and mismatched response keys', async () => {
  expect(() => readQiniuConfig({ ...env, QINIU_UPLOAD_URL: 'http://up.example.com' }))
    .toThrowError(expect.objectContaining({ code: 'CREDENTIAL_INVALID' }))
  const upload: QiniuUploadPort = { putFile: async () => ({ key: 'different' }) }
  const uploader = new QiniuFileUploader({ config: () => readQiniuConfig(env), upload })
  await expect(uploader.uploadFile({ localPath: '/tmp/file.txt', key: 'file.txt' }))
    .rejects.toThrow('different object key')
})
```

- [ ] **Step 2: Run the new test and verify RED**

Run from `apps/desktop`:

```bash
node scripts/run-vitest-electron.mjs run electron/main/upload/qiniu-file-uploader.test.ts --config vitest.node.config.ts
```

Expected: FAIL because `qiniu-file-uploader.js` does not exist.

- [ ] **Step 3: Implement the generic configuration and uploader contract**

Create the public types and minimal implementation:

```ts
export interface QiniuConfig {
  accessKey: string
  secretKey: string
  bucket: string
  domain: string
  defaultPath: string
  uploadUrl: string
}

export interface QiniuFileUploadInput {
  localPath: string
  key: string
  mimeType?: string
}

export interface QiniuFileUploadResult {
  url: string
  key: string
  hash?: string
  bucket: string
}

export interface QiniuFileUploaderPort {
  uploadFile(input: QiniuFileUploadInput): Promise<QiniuFileUploadResult>
}

export interface QiniuUploadPort {
  putFile(input: {
    accessKey: string
    secretKey: string
    bucket: string
    uploadUrl: string
    key: string
    localPath: string
    mimeType?: string
  }): Promise<{ key: string; hash?: string }>
}
```

Implement `readQiniuConfig` so missing values throw `CREDENTIAL_UNAVAILABLE`, both URLs require a root HTTPS origin, and `defaultPath` is normalized through the same safe-segment routine used for object keys. Implement `QiniuFileUploader.uploadFile()` so it:

```ts
const config = this.options.config()
const key = normalizeObjectPath(`${config.defaultPath}/${input.key}`)
const uploaded = await this.upload.putFile({
  accessKey: config.accessKey,
  secretKey: config.secretKey,
  bucket: config.bucket,
  uploadUrl: config.uploadUrl,
  key,
  localPath: input.localPath,
  ...(input.mimeType ? { mimeType: input.mimeType } : {}),
})
if (uploaded.key !== key) throw new Error('Qiniu returned a different object key')
const encodedKey = key.split('/').map(encodeURIComponent).join('/')
return {
  url: `${config.domain}/${encodedKey}`,
  key,
  ...(uploaded.hash ? { hash: uploaded.hash } : {}),
  bucket: config.bucket,
}
```

Implement the default `QiniuUploadPort` with `qiniu.rs.PutPolicy` and `qiniu.form_up.FormUploader`. Parse `uploadUrl`, pass its host into a custom `qiniu.conf.Zone`, set `useHttpsDomain: true`, and stream `localPath` through `putFile`. The generic policy must contain only the exact key scope, ten-minute expiry, and `insertOnly: 1`; do not include avatar MIME or size limits.

- [ ] **Step 4: Run the generic uploader test and verify GREEN**

Run:

```bash
node scripts/run-vitest-electron.mjs run electron/main/upload/qiniu-file-uploader.test.ts --config vitest.node.config.ts
```

Expected: the new test file passes with no warnings.

- [ ] **Step 5: Commit the public uploader**

```bash
git add apps/desktop/electron/main/upload/qiniu-file-uploader.ts apps/desktop/electron/main/upload/qiniu-file-uploader.test.ts
git commit -m "feat: add generic qiniu file uploader"
```

---

### Task 2: Delegate avatar uploads to the public uploader

**Files:**
- Modify: `apps/desktop/electron/main/profile/avatar-uploader.ts`
- Modify: `apps/desktop/electron/main/profile/avatar-uploader.test.ts`
- Modify: `apps/desktop/electron/main/application.ts`
- Modify: `.env.example`
- Modify locally, ignored by Git: `.env`

**Interfaces:**
- Consumes: `QiniuFileUploader`, `QiniuFileUploaderPort`, and `readQiniuConfig` from Task 1.
- Produces: `QiniuAvatarUploader` that depends on `upload: QiniuFileUploaderPort` and passes only validated avatar metadata plus the relative profile key.

- [ ] **Step 1: Rewrite avatar tests against the public uploader contract**

Replace the avatar harness upload double with:

```ts
const upload: QiniuFileUploaderPort = {
  uploadFile: vi.fn(async ({ key }) => ({
    url: `https://cdn.example.com/autoforge/${key}`,
    key: `autoforge/${key}`,
    hash: 'hash',
    bucket: 'bucket',
  })),
}
const uploader = new QiniuAvatarUploader({
  chooseAvatar: vi.fn(async () => path),
  upload,
  createId: () => 'avatar-id',
})
```

The primary behavior assertion must be:

```ts
expect(upload.uploadFile).toHaveBeenCalledWith({
  key: 'profiles/user_1/avatar-id.png',
  localPath: path,
  mimeType: 'image/png',
})
```

Keep cancellation, JPEG extension, oversized file, unsupported type, MIME mismatch, and safe profile error tests. The generic uploader test proves the `autoforge/` prefix while this test proves the avatar layer supplies the `profiles/<userId>/` relative key.

- [ ] **Step 2: Run avatar and application tests and verify RED**

Run from `apps/desktop`:

```bash
node scripts/run-vitest-electron.mjs run electron/main/profile/avatar-uploader.test.ts --config vitest.node.config.ts
```

Expected: FAIL because `QiniuAvatarUploader` still requires `config` and exposes the old `putFile` dependency.

- [ ] **Step 3: Refactor the avatar uploader and composition root**

Remove all Qiniu SDK/config/key-prefix/public-URL code from `profile/avatar-uploader.ts`. Its options become:

```ts
export interface QiniuAvatarUploaderOptions {
  chooseAvatar(): Promise<string | undefined>
  upload: QiniuFileUploaderPort
  createId?: () => string
}
```

After `inspectAvatar`, delegate exactly once:

```ts
const key = `profiles/${userId}/${this.createId()}.${inspected.extension}`
try {
  const uploaded = await this.options.upload.uploadFile({
    key,
    localPath: path,
    mimeType: inspected.mimeType,
  })
  return { url: uploaded.url }
} catch {
  throw failure('PROFILE_AVATAR_UPLOAD_FAILED')
}
```

In `application.ts`, compose both modules:

```ts
const qiniuUploader = new QiniuFileUploader({
  config: () => readQiniuConfig(options.qiniuEnv ?? process.env),
})
const avatarUploader = new QiniuAvatarUploader({
  chooseAvatar: options.chooseAvatarFile ?? (async () => undefined),
  upload: qiniuUploader,
})
```

Add the new values to `.env.example` and the ignored `.env`:

```dotenv
QINIU_DEFAULT_PATH=autoforge/
QINIU_UPLOAD_URL=https://up-z2.qiniup.com
```

Keep `QINIU_REGION=z0` untouched in both files for compatibility, but do not read it in the generic uploader.

- [ ] **Step 4: Run avatar and application tests and verify GREEN**

Run:

```bash
node scripts/run-vitest-electron.mjs run electron/main/upload/qiniu-file-uploader.test.ts electron/main/profile/avatar-uploader.test.ts --config vitest.node.config.ts
```

Expected: all selected test files pass with avatar URLs under `autoforge/profiles/`.

- [ ] **Step 5: Commit the avatar integration and tracked configuration**

```bash
git add .env.example apps/desktop/electron/main/profile/avatar-uploader.ts apps/desktop/electron/main/profile/avatar-uploader.test.ts apps/desktop/electron/main/application.ts
git commit -m "refactor: use generic uploader for profile avatars"
```

---

### Task 3: Verify the complete feature on the current branch

**Files:**
- Verify: `.env`
- Verify: `.env.example`
- Verify: `apps/desktop/electron/main/upload/qiniu-file-uploader.ts`
- Verify: `apps/desktop/electron/main/profile/avatar-uploader.ts`

**Interfaces:**
- Consumes: the completed public uploader and avatar integration.
- Produces: verified current-branch implementation with no uncommitted tracked changes.

- [ ] **Step 1: Verify configuration presence without printing secrets**

Run:

```bash
test -f .env
rg -n '^QINIU_(DEFAULT_PATH|UPLOAD_URL)=' .env .env.example
git check-ignore .env
```

Expected: both files contain `QINIU_DEFAULT_PATH=autoforge/` and `QINIU_UPLOAD_URL=https://up-z2.qiniup.com`; Git reports `.env` as ignored.

- [ ] **Step 2: Run focused lint and type checking**

Run:

```bash
pnpm exec eslint apps/desktop/electron/main/upload/qiniu-file-uploader.ts apps/desktop/electron/main/upload/qiniu-file-uploader.test.ts apps/desktop/electron/main/profile/avatar-uploader.ts apps/desktop/electron/main/profile/avatar-uploader.test.ts apps/desktop/electron/main/application.ts
pnpm typecheck
```

Expected: both commands exit successfully. Existing unrelated full-repository lint failures in `ContextSidebar.vue` and `.worktrees` are reported separately and are not modified.

- [ ] **Step 3: Run the complete test suite**

Run:

```bash
pnpm test
```

Expected: all test files and tests pass.

- [ ] **Step 4: Build the production application**

Run:

```bash
pnpm build
```

Expected: shared packages, Electron Main, preload, renderer, and workflow runner all build successfully.

- [ ] **Step 5: Check the final diff and current branch**

Run:

```bash
git diff --check
git status --short
git branch --show-current
```

Expected: no whitespace errors, no uncommitted tracked changes, and branch `v2` remains checked out.
