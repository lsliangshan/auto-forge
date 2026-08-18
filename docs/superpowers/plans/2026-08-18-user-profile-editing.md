# AutoForge User Profile Editing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an authenticated personal-profile page whose common profile fields persist in SQLite and whose locally selected avatar is uploaded to Qiniu before its HTTPS URL is saved.

**Architecture:** Keep authentication identity in `local_users` and add a one-to-one `local_user_profiles` repository plus a focused `ProfileService`. Expose only three validated, authenticated profile IPC methods; keep Qiniu credentials and file access in Electron Main. A shared Pinia store supplies both the profile page and the workbench account entry.

**Tech Stack:** TypeScript 6, Vue 3, Pinia 4, Vue Router 5, Element Plus 2, Electron 43, Zod 4, better-sqlite3 12, Qiniu Node SDK 7.15.2, Vitest 4.

## Global Constraints

- Only `avatarUrl`, `displayName`, `gender`, `birthDate`, `email`, and `phone` are editable; `userId` and `account` always come from the current authenticated session.
- Empty editable values are normalized to SQL `NULL`; display name is at most 50 Unicode code points, email at most 254 characters, and phone is optional `+` followed by 6–20 digits after removing spaces and hyphens.
- `birthDate` uses `YYYY-MM-DD` and must not be after Main's local calendar date.
- Avatar files are JPEG, PNG, or WebP only, at most 5 MiB, and must pass content sniffing plus extension matching.
- Qiniu object keys are `profiles/<userId>/<randomUUID>.<ext>`; original filenames are never used remotely.
- Qiniu credentials remain in Electron Main and must never cross Preload, IPC responses, Renderer state, user-visible errors, or logs.
- `.env` is local-only and ignored; `.env.example` contains empty values. Public distribution requires a future server-issued upload-token design.
- Do not add email or phone verification, avatar cropping, cloud deletion, garbage collection, or unsaved-navigation prompts.
- Preserve all unrelated worktree changes. Every commit stages only files named in that task.

---

## File Map

**Shared contract**

- Modify `packages/shared/src/desktop-api.ts`: profile schemas, IPC channels, request/response schemas, and `DesktopAPI.profile`.
- Modify `packages/shared/src/errors.ts`: safe `PROFILE_AVATAR_UPLOAD_FAILED` code.
- Modify `packages/shared/src/contracts.test.ts`: profile schema and error-contract coverage.

**Persistence and domain**

- Create `apps/desktop/resources/migrations/0005_user_profile.sql`: one-to-one profile table.
- Modify `apps/desktop/electron/main/database/schema.ts`: Drizzle profile table declaration.
- Create `apps/desktop/electron/main/database/user-profile-repository.ts`: profile record lookup and upsert only.
- Modify `apps/desktop/electron/main/database/client.ts`: construct and expose the profile repository.
- Modify `apps/desktop/electron/main/database/database.test.ts`: migration, persistence, isolation, and cascade tests.
- Create `apps/desktop/electron/main/profile/profile-service.ts`: session-scoped validation, normalization, and profile composition.
- Create `apps/desktop/electron/main/profile/profile-service.test.ts`: service behavior.

**Qiniu adapter and composition**

- Create `apps/desktop/electron/main/profile/avatar-uploader.ts`: config parsing, file validation, key creation, Qiniu adapter, and safe error mapping.
- Create `apps/desktop/electron/main/profile/avatar-uploader.test.ts`: deterministic adapter tests.
- Create `.env.example`: documented empty Qiniu variables.
- Modify `apps/desktop/package.json` and `pnpm-lock.yaml`: add `qiniu@7.15.2`.
- Modify `apps/desktop/electron/main/index.ts`: load root `.env`, provide avatar chooser, and pass Qiniu config into the runtime.
- Modify `apps/desktop/electron/main/application.ts`: construct `ProfileService` and `QiniuAvatarUploader`, expose profile services.
- Modify `apps/desktop/electron/main/application.test.ts`: add one integration check for session-scoped profile composition.

**IPC and Renderer**

- Modify `apps/desktop/electron/main/ipc/register-ipc.ts` and its test: register three authenticated profile handlers.
- Modify `apps/desktop/electron/preload/bridge.ts` and its test: expose the fixed profile bridge.
- Create `apps/desktop/src/stores/profile.ts`: shared profile state and operations.
- Create `apps/desktop/src/views/ProfileView.vue`: form UI.
- Modify `apps/desktop/src/router/index.ts`: authenticated `/profile` route.
- Modify `apps/desktop/src/components/AppRail.vue`: profile entry, avatar/name fallback, profile reset on logout.
- Create `apps/desktop/tests/components/profile.test.ts`: route, store, form, upload, save, and rail behavior.
- Modify existing Renderer API fixtures in `apps/desktop/tests/components/auth.test.ts`, `apps/desktop/tests/components/workbench.test.ts`, `apps/desktop/tests/components/chat.test.ts`, `apps/desktop/tests/components/developer.test.ts`, and `apps/desktop/tests/components/token-usage-charts.test.ts` only where TypeScript requires the new `DesktopAPI.profile` member.

---

### Task 1: Define the shared profile and error contracts

**Files:**

- Modify: `packages/shared/src/desktop-api.ts`
- Modify: `packages/shared/src/errors.ts`
- Modify: `packages/shared/src/contracts.test.ts`

**Interfaces:**

- Consumes: existing `identifierSchema`, strict Zod IPC maps, `DesktopAPI`, and `AppErrorCode` patterns.
- Produces: `ProfileGender`, `UserProfile`, `UserProfileUpdate`, `userProfileSchema`, `userProfileUpdateSchema`, `profileAvatarUploadResultSchema`, three `ipcChannels`, and `DesktopAPI.profile`.

- [ ] **Step 1: Write failing shared-contract tests**

Add imports for the new schemas and these cases to `packages/shared/src/contracts.test.ts`:

```ts
it('validates normalized user profiles and rejects identity fields in updates', () => {
  expect(userProfileSchema.parse({
    userId: 'user_1',
    account: 'Alice',
    avatarUrl: 'https://cdn.example.com/profiles/user_1/avatar.webp',
    displayName: 'Alice Zhang',
    gender: 'prefer_not_to_say',
    birthDate: '2000-02-29',
    email: 'alice@example.com',
    phone: '+8613800138000',
    updatedAt: '2026-08-18T00:00:00.000Z',
  })).toMatchObject({ userId: 'user_1', account: 'Alice' })

  expect(userProfileUpdateSchema.safeParse({ account: 'Mallory' }).success).toBe(false)
  expect(userProfileUpdateSchema.safeParse({ userId: 'user_2' }).success).toBe(false)
  expect(userProfileUpdateSchema.safeParse({ displayName: 'A'.repeat(51) }).success).toBe(false)
  expect(userProfileUpdateSchema.safeParse({ avatarUrl: 'http://cdn.example.com/a.png' }).success).toBe(false)
  expect(userProfileUpdateSchema.safeParse({ email: 'not-an-email' }).success).toBe(false)
  expect(userProfileUpdateSchema.safeParse({ phone: '12345' }).success).toBe(false)
  expect(userProfileUpdateSchema.safeParse({ displayName: '', birthDate: '', email: '', phone: '' }).success).toBe(true)
  expect(userProfileUpdateSchema.safeParse({ phone: '+86 138-0013-8000' }).success).toBe(true)
})

it('maps the profile avatar upload failure without exposing provider details', () => {
  expect(toSafeAppError({
    code: 'PROFILE_AVATAR_UPLOAD_FAILED',
    message: 'qiniu secret response',
  })).toEqual({
    code: 'PROFILE_AVATAR_UPLOAD_FAILED',
    message: 'The profile avatar upload failed.',
  })
})
```

- [ ] **Step 2: Run the shared test and verify RED**

Run:

```bash
pnpm exec vitest run packages/shared/src/contracts.test.ts
```

Expected: FAIL because the profile schemas and error code are not exported.

- [ ] **Step 3: Add strict profile schemas and types**

Add to `packages/shared/src/desktop-api.ts` beside authentication schemas:

```ts
export const profileGenderSchema = z.enum(['male', 'female', 'other', 'prefer_not_to_say'])
export type ProfileGender = z.infer<typeof profileGenderSchema>

const canonicalHttpsUrlSchema = z.string().url().superRefine((value, context) => {
  const parsed = new URL(value)
  if (parsed.protocol !== 'https:'
    || parsed.username !== ''
    || parsed.password !== ''
    || parsed.port !== ''
    || parsed.hash !== ''
    || parsed.href !== value) {
    context.addIssue({ code: 'custom', message: 'A canonical HTTPS URL is required' })
  }
})

const profileDisplayNameSchema = z.string().superRefine((value, context) => {
  if (Array.from(value).length > 50) {
    context.addIssue({ code: 'custom', message: 'Display name must contain at most 50 Unicode code points' })
  }
})
const profileBirthDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const profileEmailSchema = z.string().email().max(254)
const profilePhoneSchema = z.string().regex(/^\+?\d{6,20}$/)

const normalizedProfileFieldsSchema = z.object({
  avatarUrl: canonicalHttpsUrlSchema.optional(),
  displayName: profileDisplayNameSchema.min(1).optional(),
  gender: profileGenderSchema.optional(),
  birthDate: profileBirthDateSchema.optional(),
  email: profileEmailSchema.optional(),
  phone: profilePhoneSchema.optional(),
}).strict()

export const userProfileUpdateSchema = z.object({
  avatarUrl: canonicalHttpsUrlSchema.optional(),
  displayName: profileDisplayNameSchema.optional(),
  gender: profileGenderSchema.optional(),
  birthDate: z.union([z.literal(''), profileBirthDateSchema]).optional(),
  email: z.union([z.literal(''), z.string().trim().email().max(254)]).optional(),
  phone: z.string().trim().regex(/^(?:$|\+?[0-9 -]{6,32})$/).optional(),
}).strict()
export type UserProfileUpdate = z.infer<typeof userProfileUpdateSchema>

export const userProfileSchema = normalizedProfileFieldsSchema.extend({
  userId: identifierSchema,
  account: authAccountSchema,
  updatedAt: timestampSchema.optional(),
}).strict()
export type UserProfile = z.infer<typeof userProfileSchema>

export const profileAvatarUploadResultSchema = z.object({ url: canonicalHttpsUrlSchema }).strict()
export type ProfileAvatarUploadResult = z.infer<typeof profileAvatarUploadResultSchema>
```

Add the channels and map entries:

```ts
profileGet: 'profile:get',
profileUpdate: 'profile:update',
profilePickAndUploadAvatar: 'profile:pick-and-upload-avatar',
```

```ts
[ipcChannels.profileGet]: z.undefined(),
[ipcChannels.profileUpdate]: userProfileUpdateSchema,
[ipcChannels.profilePickAndUploadAvatar]: z.undefined(),
```

```ts
[ipcChannels.profileGet]: userProfileSchema,
[ipcChannels.profileUpdate]: userProfileSchema,
[ipcChannels.profilePickAndUploadAvatar]: profileAvatarUploadResultSchema.nullable(),
```

Add this fixed bridge surface to `DesktopAPI` after `auth`:

```ts
profile: {
  get(): Promise<UserProfile>
  update(input: UserProfileUpdate): Promise<UserProfile>
  pickAndUploadAvatar(): Promise<ProfileAvatarUploadResult | null>
}
```

- [ ] **Step 4: Add the safe profile upload error**

Add `'PROFILE_AVATAR_UPLOAD_FAILED'` to `appErrorCodeSchema` and this exact safe message to `safeErrorMessages` in `packages/shared/src/errors.ts`:

```ts
PROFILE_AVATAR_UPLOAD_FAILED: 'The profile avatar upload failed.',
```

- [ ] **Step 5: Run tests and typecheck**

Run:

```bash
pnpm exec vitest run packages/shared/src/contracts.test.ts
pnpm --filter @autoforge/shared typecheck
```

Expected: both commands PASS.

- [ ] **Step 6: Commit the contract**

```bash
git add packages/shared/src/desktop-api.ts packages/shared/src/errors.ts packages/shared/src/contracts.test.ts
git commit -m "feat: define user profile contracts"
```

---

### Task 2: Add profile persistence and migration

**Files:**

- Create: `apps/desktop/resources/migrations/0005_user_profile.sql`
- Create: `apps/desktop/electron/main/database/user-profile-repository.ts`
- Modify: `apps/desktop/electron/main/database/schema.ts`
- Modify: `apps/desktop/electron/main/database/client.ts`
- Modify: `apps/desktop/electron/main/database/database.test.ts`

**Interfaces:**

- Consumes: `local_users(id)`, the existing migration runner, and `openAppDatabase()` composition.
- Produces: `UserProfileRecord`, `UserProfileRepository`, `createUserProfileRepository(database)`, and `database.userProfiles`.

- [ ] **Step 1: Write failing migration and repository tests**

Extend `apps/desktop/electron/main/database/database.test.ts`:

```ts
it('migrates profile storage and keeps profiles isolated by user', () => {
  const database = openTestDatabase()
  const alice = {
    id: 'user_1', account: 'Alice', accountNormalized: 'alice',
    passwordDigest: 'digest', createdAt: 10, updatedAt: 10,
  }
  const bob = {
    id: 'user_2', account: 'Bob', accountNormalized: 'bob',
    passwordDigest: 'digest', createdAt: 11, updatedAt: 11,
  }
  database.localAuth.createUserAndSession(alice, 12)
  database.localAuth.createUserAndSession(bob, 13)

  expect(database.schemaVersion()).toBe(5)
  expect(database.userProfiles.findByUserId('user_1')).toBeUndefined()
  database.userProfiles.upsert({
    userId: 'user_1', avatarUrl: null, displayName: 'Alice Zhang', gender: null,
    birthDate: null, email: 'alice@example.com', phone: null, updatedAt: 20,
  })
  expect(database.userProfiles.findByUserId('user_1')).toMatchObject({ displayName: 'Alice Zhang' })
  expect(database.userProfiles.findByUserId('user_2')).toBeUndefined()
})

it('updates a profile and cascades profile deletion with its user', () => {
  const database = openTestDatabase()
  database.localAuth.createUserAndSession({
    id: 'user_1', account: 'Alice', accountNormalized: 'alice',
    passwordDigest: 'digest', createdAt: 10, updatedAt: 10,
  }, 11)
  database.userProfiles.upsert({
    userId: 'user_1', avatarUrl: null, displayName: 'First', gender: null,
    birthDate: null, email: null, phone: null, updatedAt: 20,
  })
  database.userProfiles.upsert({
    userId: 'user_1', avatarUrl: 'https://cdn.example.com/a.png', displayName: 'Second', gender: 'female',
    birthDate: '2000-01-01', email: null, phone: '+8613800138000', updatedAt: 30,
  })
  expect(database.userProfiles.findByUserId('user_1')).toMatchObject({
    displayName: 'Second', gender: 'female', updatedAt: 30,
  })
  database.db.$client.prepare('DELETE FROM local_users WHERE id = ?').run('user_1')
  expect(database.userProfiles.findByUserId('user_1')).toBeUndefined()
})
```

Also update all existing schema-version expectations from `4` to `5`, and add a v4-upgrade fixture that applies migrations `0001` through `0004` before opening with `openAppDatabase`.

- [ ] **Step 2: Run the database test and verify RED**

Run:

```bash
pnpm --filter @autoforge/desktop exec vitest run --config vitest.node.config.ts electron/main/database/database.test.ts
```

Expected: FAIL because migration 0005 and `database.userProfiles` do not exist.

- [ ] **Step 3: Create the migration and Drizzle declaration**

Create `apps/desktop/resources/migrations/0005_user_profile.sql`:

```sql
CREATE TABLE local_user_profiles (
  user_id TEXT PRIMARY KEY REFERENCES local_users(id) ON DELETE CASCADE,
  avatar_url TEXT,
  display_name TEXT,
  gender TEXT,
  birth_date TEXT,
  email TEXT,
  phone TEXT,
  updated_at INTEGER NOT NULL
);
```

Add to `apps/desktop/electron/main/database/schema.ts`:

```ts
export const localUserProfiles = sqliteTable('local_user_profiles', {
  userId: text('user_id').primaryKey().references(() => localUsers.id, { onDelete: 'cascade' }),
  avatarUrl: text('avatar_url'),
  displayName: text('display_name'),
  gender: text('gender'),
  birthDate: text('birth_date'),
  email: text('email'),
  phone: text('phone'),
  updatedAt: integer('updated_at').notNull(),
})
```

- [ ] **Step 4: Implement the focused repository**

Create `apps/desktop/electron/main/database/user-profile-repository.ts`:

```ts
import type Database from 'better-sqlite3'

export interface UserProfileRecord {
  userId: string
  avatarUrl: string | null
  displayName: string | null
  gender: string | null
  birthDate: string | null
  email: string | null
  phone: string | null
  updatedAt: number
}

export interface UserProfileRepository {
  findByUserId(userId: string): UserProfileRecord | undefined
  upsert(profile: UserProfileRecord): UserProfileRecord
}

export function createUserProfileRepository(database: Database.Database): UserProfileRepository {
  const findByUserId = (userId: string) => database.prepare(`
    SELECT user_id AS userId, avatar_url AS avatarUrl, display_name AS displayName,
      gender, birth_date AS birthDate, email, phone, updated_at AS updatedAt
    FROM local_user_profiles WHERE user_id = ?
  `).get(userId) as UserProfileRecord | undefined

  return {
    findByUserId,
    upsert(profile) {
      database.prepare(`
        INSERT INTO local_user_profiles
          (user_id, avatar_url, display_name, gender, birth_date, email, phone, updated_at)
        VALUES
          (@userId, @avatarUrl, @displayName, @gender, @birthDate, @email, @phone, @updatedAt)
        ON CONFLICT(user_id) DO UPDATE SET
          avatar_url = excluded.avatar_url,
          display_name = excluded.display_name,
          gender = excluded.gender,
          birth_date = excluded.birth_date,
          email = excluded.email,
          phone = excluded.phone,
          updated_at = excluded.updated_at
      `).run(profile)
      const stored = findByUserId(profile.userId)
      if (!stored) throw new Error('User profile was not persisted')
      return stored
    },
  }
}
```

Construct it in `client.ts` and expose it as `userProfiles` next to `localAuth`.

- [ ] **Step 5: Run the database tests and typecheck**

Run:

```bash
pnpm --filter @autoforge/desktop exec vitest run --config vitest.node.config.ts electron/main/database/database.test.ts
pnpm --filter @autoforge/desktop typecheck
```

Expected: PASS with schema version 5 and no TypeScript errors.

- [ ] **Step 6: Commit persistence**

```bash
git add apps/desktop/resources/migrations/0005_user_profile.sql apps/desktop/electron/main/database/schema.ts apps/desktop/electron/main/database/user-profile-repository.ts apps/desktop/electron/main/database/client.ts apps/desktop/electron/main/database/database.test.ts
git commit -m "feat: persist local user profiles"
```

---

### Task 3: Implement the session-scoped Profile Service

**Files:**

- Create: `apps/desktop/electron/main/profile/profile-service.ts`
- Create: `apps/desktop/electron/main/profile/profile-service.test.ts`

**Interfaces:**

- Consumes: `AuthService.requireSession()`, `UserProfileRepository`, `UserProfileUpdate`, and `userProfileUpdateSchema`.
- Produces: `ProfileService.get(): Promise<UserProfile>` and `ProfileService.update(input): Promise<UserProfile>`.

- [ ] **Step 1: Write failing Profile Service tests**

Create `profile-service.test.ts` with an in-memory repository and authenticated session fixture. Cover this exact behavior:

```ts
it('returns an empty profile without creating a row', async () => {
  const app = harness()
  await expect(app.service.get()).resolves.toEqual({ userId: 'user_1', account: 'Alice' })
  expect(app.repository.upsert).not.toHaveBeenCalled()
})

it('normalizes optional fields and always writes the session user', async () => {
  const app = harness()
  await expect(app.service.update({
    avatarUrl: 'https://cdn.example.com/profiles/user_1/a.webp',
    displayName: '  Alice Zhang  ',
    email: '  alice@example.com  ',
    phone: '+86 138-0013-8000',
  })).resolves.toMatchObject({
    userId: 'user_1', account: 'Alice', displayName: 'Alice Zhang',
    email: 'alice@example.com', phone: '+8613800138000',
  })
  expect(app.repository.upsert).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user_1' }))
})

it('rejects impossible and future local dates', async () => {
  const app = harness()
  await expect(app.service.update({ birthDate: '2026-02-30' })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  await expect(app.service.update({ birthDate: '2026-08-19' })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
})
```

The harness fixes `today()` to `'2026-08-18'`, fixes `now()` to `1_787_011_200_000`, and asserts blank strings become `null` in the repository.

- [ ] **Step 2: Run the service test and verify RED**

Run:

```bash
pnpm --filter @autoforge/desktop exec vitest run --config vitest.node.config.ts electron/main/profile/profile-service.test.ts
```

Expected: FAIL because `ProfileService` does not exist.

- [ ] **Step 3: Implement normalization and calendar validation**

Create `profile-service.ts` with these public boundaries:

```ts
export interface ProfileServiceDependencies {
  now(): number
  today(): string
}

export class ProfileService {
  constructor(
    private readonly auth: Pick<AuthService, 'requireSession'>,
    private readonly repository: UserProfileRepository,
    private readonly dependencies: ProfileServiceDependencies = {
      now: Date.now,
      today: () => {
        const now = new Date()
        const year = String(now.getFullYear()).padStart(4, '0')
        const month = String(now.getMonth() + 1).padStart(2, '0')
        const day = String(now.getDate()).padStart(2, '0')
        return `${year}-${month}-${day}`
      },
    },
  ) {}

  async get(): Promise<UserProfile> {
    const session = await this.auth.requireSession()
    return composeProfile(session.user, this.repository.findByUserId(session.user.id))
  }

  async update(input: UserProfileUpdate): Promise<UserProfile> {
    const session = await this.auth.requireSession()
    const normalized = normalizeProfileInput(input)
    const parsed = userProfileUpdateSchema.safeParse(normalized)
    if (!parsed.success || !validBirthDate(parsed.data.birthDate, this.dependencies.today())) {
      throw toSafeAppError({ code: 'INVALID_INPUT' })
    }
    const stored = this.repository.upsert({
      userId: session.user.id,
      avatarUrl: parsed.data.avatarUrl ?? null,
      displayName: parsed.data.displayName ?? null,
      gender: parsed.data.gender ?? null,
      birthDate: parsed.data.birthDate ?? null,
      email: parsed.data.email ?? null,
      phone: parsed.data.phone ?? null,
      updatedAt: this.dependencies.now(),
    })
    return composeProfile(session.user, stored)
  }
}
```

Implement `normalizeProfileInput` so it trims `displayName` and `email`, strips `[ -]` from phone, and converts blank values to `undefined`. Implement `validBirthDate` by parsing numeric year/month/day, reconstructing a local `Date(year, month - 1, day)`, comparing all components, and finally checking `value <= today`; do not rely on permissive `Date.parse` rollover.

Implement `composeProfile` to omit null fields and convert `updatedAt` to an ISO timestamp.

- [ ] **Step 4: Run the service tests and typecheck**

Run:

```bash
pnpm --filter @autoforge/desktop exec vitest run --config vitest.node.config.ts electron/main/profile/profile-service.test.ts
pnpm --filter @autoforge/desktop typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit the Profile Service**

```bash
git add apps/desktop/electron/main/profile/profile-service.ts apps/desktop/electron/main/profile/profile-service.test.ts
git commit -m "feat: add session scoped profile service"
```

---

### Task 4: Add the Qiniu avatar adapter and `.env` configuration

**Files:**

- Create: `apps/desktop/electron/main/profile/avatar-uploader.ts`
- Create: `apps/desktop/electron/main/profile/avatar-uploader.test.ts`
- Create: `.env.example`
- Modify: `apps/desktop/package.json`
- Modify: `pnpm-lock.yaml`

**Interfaces:**

- Consumes: a Main-only file chooser, `detectMediaType()`, Node filesystem APIs, and Qiniu SDK 7.15.2.
- Produces: `AvatarUploader.pickAndUpload(userId)`, `QiniuConfig`, `readQiniuConfig(env)`, and a testable `QiniuUploadPort`.

- [ ] **Step 1: Install the exact Qiniu SDK**

Run:

```bash
pnpm --filter @autoforge/desktop add qiniu@7.15.2
```

Expected: `apps/desktop/package.json` lists `"qiniu": "7.15.2"` and `pnpm-lock.yaml` records the package.

- [ ] **Step 2: Write failing avatar adapter tests**

Create deterministic tests with temporary files and an injected upload port:

```ts
it('returns null when the chooser is cancelled', async () => {
  const app = harness({ chooseAvatar: vi.fn().mockResolvedValue(undefined) })
  await expect(app.uploader.pickAndUpload('user_1')).resolves.toBeNull()
  expect(app.upload.putFile).not.toHaveBeenCalled()
})

it('uploads a sniffed image under a random user-scoped key', async () => {
  const path = await pngFixture()
  const app = harness({ chooseAvatar: vi.fn().mockResolvedValue(path) })
  await expect(app.uploader.pickAndUpload('user_1')).resolves.toEqual({
    url: 'https://cdn.example.com/profiles/user_1/avatar-id.png',
  })
  expect(app.upload.putFile).toHaveBeenCalledWith(expect.objectContaining({
    bucket: 'bucket', key: 'profiles/user_1/avatar-id.png', path,
  }))
})

it('rejects missing config, oversized files, unsupported content and extension mismatch', async () => {
  expect(() => readQiniuConfig({})).toThrowError(expect.objectContaining({ code: 'CREDENTIAL_UNAVAILABLE' }))
  await expect(oversizedHarness().uploader.pickAndUpload('user_1'))
    .rejects.toMatchObject({ code: 'MEDIA_SIZE_LIMIT_EXCEEDED' })
  await expect(textHarness().uploader.pickAndUpload('user_1'))
    .rejects.toMatchObject({ code: 'MEDIA_TYPE_UNSUPPORTED' })
  await expect(jpegNamedPngHarness().uploader.pickAndUpload('user_1'))
    .rejects.toMatchObject({ code: 'MEDIA_MIME_MISMATCH' })
})

it('maps Qiniu failures to one safe profile error', async () => {
  const app = harness({ uploadError: new Error('provider response with token') })
  await expect(app.uploader.pickAndUpload('user_1'))
    .rejects.toEqual(toSafeAppError({ code: 'PROFILE_AVATAR_UPLOAD_FAILED' }))
})
```

- [ ] **Step 3: Run the avatar test and verify RED**

Run:

```bash
pnpm --filter @autoforge/desktop exec vitest run --config vitest.node.config.ts electron/main/profile/avatar-uploader.test.ts
```

Expected: FAIL because the adapter does not exist.

- [ ] **Step 4: Implement config parsing and the narrow upload port**

Create these boundaries in `avatar-uploader.ts`:

```ts
export interface QiniuConfig {
  accessKey: string
  secretKey: string
  bucket: string
  domain: string
  region: string
}

export interface QiniuUploadPort {
  putFile(input: {
    accessKey: string
    secretKey: string
    bucket: string
    region: string
    key: string
    path: string
  }): Promise<{ key: string }>
}

export interface AvatarUploader {
  pickAndUpload(userId: string): Promise<ProfileAvatarUploadResult | null>
}

export interface QiniuAvatarUploaderOptions {
  chooseAvatar(): Promise<string | undefined>
  config(): QiniuConfig
  upload?: QiniuUploadPort
  createId?: () => string
}

export function readQiniuConfig(env: NodeJS.ProcessEnv): QiniuConfig {
  const values = {
    accessKey: env.QINIU_ACCESS_KEY?.trim(),
    secretKey: env.QINIU_SECRET_KEY?.trim(),
    bucket: env.QINIU_BUCKET?.trim(),
    domain: env.QINIU_DOMAIN?.trim(),
    region: env.QINIU_REGION?.trim(),
  }
  if (Object.values(values).some((value) => !value)) throw toSafeAppError({ code: 'CREDENTIAL_UNAVAILABLE' })
  const url = new URL(values.domain!)
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash) {
    throw toSafeAppError({ code: 'CREDENTIAL_INVALID' })
  }
  return {
    accessKey: values.accessKey!, secretKey: values.secretKey!, bucket: values.bucket!,
    domain: url.href.replace(/\/$/, ''), region: values.region!,
  }
}
```

Export `class QiniuAvatarUploader implements AvatarUploader` with constructor `constructor(options: QiniuAvatarUploaderOptions)`; Step 5 supplies the complete `pickAndUpload` behavior.

Implement `QiniuUploadPort` with `qiniu.auth.digest.Mac`, a bucket/key-scoped `qiniu.rs.PutPolicy`, `qiniu.conf.Config`, the configured region, HTTPS, and `qiniu.form_up.FormUploader.putFile`. Reject if the SDK response key differs from the requested key.

- [ ] **Step 5: Implement file validation and safe URL construction**

`QiniuAvatarUploader.pickAndUpload` must:

```ts
const AVATAR_MAX_BYTES = 5 * 1024 * 1024
const AVATAR_TYPES = new Map([
  ['image/jpeg', 'jpg'],
  ['image/png', 'png'],
  ['image/webp', 'webp'],
])
```

1. Await `chooseAvatar()` and return `null` for cancellation.
2. Open the file with `node:fs/promises`, reject non-regular or symbolic-link paths, check `size <= AVATAR_MAX_BYTES`, and read at most 64 KiB for `detectMediaType`.
3. Require one of `AVATAR_TYPES`; normalize both `.jpg` and `.jpeg` to detected JPEG, but reject every other extension mismatch.
4. Construct `profiles/${userId}/${createId()}.${extension}` where `createId` defaults to `randomUUID`.
5. Upload, verify the returned key, and return `{ url: `${config.domain}/${key.split('/').map(encodeURIComponent).join('/')}` }`.
6. Preserve local validation error codes and map every SDK/network error to `PROFILE_AVATAR_UPLOAD_FAILED`.
7. Close the file handle in `finally`; never log config or provider errors.

- [ ] **Step 6: Add the environment example**

Create root `.env.example`:

```dotenv
QINIU_ACCESS_KEY=
QINIU_SECRET_KEY=
QINIU_BUCKET=
QINIU_DOMAIN=https://cdn.example.com
QINIU_REGION=z0
```

- [ ] **Step 7: Run tests and typecheck**

Run:

```bash
pnpm --filter @autoforge/desktop exec vitest run --config vitest.node.config.ts electron/main/profile/avatar-uploader.test.ts
pnpm --filter @autoforge/desktop typecheck
```

Expected: PASS; no credential values appear in test output.

- [ ] **Step 8: Commit the Qiniu adapter**

```bash
git add .env.example apps/desktop/package.json pnpm-lock.yaml apps/desktop/electron/main/profile/avatar-uploader.ts apps/desktop/electron/main/profile/avatar-uploader.test.ts
git commit -m "feat: upload profile avatars to qiniu"
```

---

### Task 5: Wire profile services through Main IPC and Preload

**Files:**

- Modify: `apps/desktop/electron/main/application.ts`
- Modify: `apps/desktop/electron/main/application.test.ts`
- Modify: `apps/desktop/electron/main/index.ts`
- Modify: `apps/desktop/electron/main/ipc/register-ipc.ts`
- Modify: `apps/desktop/electron/main/ipc/register-ipc.test.ts`
- Modify: `apps/desktop/electron/preload/bridge.ts`
- Modify: `apps/desktop/electron/preload/bridge.test.ts`

**Interfaces:**

- Consumes: `ProfileService`, `AvatarUploader`, `DesktopAPI.profile`, and current automatic authenticated IPC registration.
- Produces: working `profile:get`, `profile:update`, and `profile:pick-and-upload-avatar` calls from Renderer to Main.

- [ ] **Step 1: Write failing bridge tests**

Add to `bridge.test.ts`:

```ts
it('exposes only the fixed profile operations', async () => {
  const app = harness()
  const update = { displayName: 'Alice', email: 'alice@example.com' }
  await app.api.profile.get()
  await app.api.profile.update(update)
  await app.api.profile.pickAndUploadAvatar()
  expect(app.ipcRenderer.invoke).toHaveBeenNthCalledWith(1, ipcChannels.profileGet, undefined)
  expect(app.ipcRenderer.invoke).toHaveBeenNthCalledWith(2, ipcChannels.profileUpdate, update)
  expect(app.ipcRenderer.invoke).toHaveBeenNthCalledWith(3, ipcChannels.profilePickAndUploadAvatar, undefined)
})
```

- [ ] **Step 2: Write failing authenticated IPC tests**

Extend the IPC service fixture with `profile` mocks and add:

```ts
it('guards and validates every profile operation', async () => {
  const app = harness()
  await app.invoke(ipcChannels.profileGet)
  await app.invoke(ipcChannels.profileUpdate, { displayName: 'Alice' })
  await app.invoke(ipcChannels.profilePickAndUploadAvatar)
  expect(app.services.auth.requireSession).toHaveBeenCalledTimes(3)
  expect(app.services.profile.get).toHaveBeenCalledOnce()
  expect(app.services.profile.update).toHaveBeenCalledWith({ displayName: 'Alice' })
  expect(app.services.profile.pickAndUploadAvatar).toHaveBeenCalledOnce()
  await expect(app.invoke(ipcChannels.profileUpdate, { account: 'Mallory' })).rejects.toMatchObject({
    code: 'INVALID_INPUT',
  })
})
```

- [ ] **Step 3: Run focused tests and verify RED**

Run:

```bash
pnpm --filter @autoforge/desktop exec vitest run --config vitest.node.config.ts electron/preload/bridge.test.ts electron/main/ipc/register-ipc.test.ts
```

Expected: FAIL because the profile bridge and handlers are missing.

- [ ] **Step 4: Add Preload and IPC mappings**

Add to `createDesktopApi()`:

```ts
profile: {
  get: () => invoke(ipcRenderer, ipcChannels.profileGet),
  update: (input) => invoke(ipcRenderer, ipcChannels.profileUpdate, input),
  pickAndUploadAvatar: () => invoke(ipcRenderer, ipcChannels.profilePickAndUploadAvatar),
},
```

Add `profile: DesktopAPI['profile']` to `DesktopIpcServices`, then register:

```ts
register(ipcChannels.profileGet, () => options.services.profile.get())
register(ipcChannels.profileUpdate, (input) => options.services.profile.update(input))
register(ipcChannels.profilePickAndUploadAvatar, () => options.services.profile.pickAndUploadAvatar())
```

Do not mark these registrations anonymous; the existing registration wrapper must call `auth.requireSession()` first.

- [ ] **Step 5: Compose the domain and adapter in Main**

Extend `ApplicationRuntimeOptions` with optional adapter seams so existing runtime fixtures remain focused:

```ts
chooseAvatarFile?: () => Promise<string | undefined>
qiniuEnv?: NodeJS.ProcessEnv
```

In `createApplicationRuntime`, create:

```ts
const profiles = new ProfileService(auth, database.userProfiles)
const avatarUploader = new QiniuAvatarUploader({
  chooseAvatar: options.chooseAvatarFile ?? (async () => undefined),
  config: () => readQiniuConfig(options.qiniuEnv ?? process.env),
})
```

Expose this service without letting the Renderer select a user:

```ts
profile: {
  get: () => profiles.get(),
  update: (input) => profiles.update(input),
  pickAndUploadAvatar: async () => {
    const session = await auth.requireSession()
    return avatarUploader.pickAndUpload(session.user.id)
  },
},
```

At the beginning of `initialize()` in `electron/main/index.ts`, load the repository-root environment file:

```ts
try {
  process.loadEnvFile(join(app.getAppPath(), '..', '..', '.env'))
} catch (error) {
  const code = (error as NodeJS.ErrnoException).code
  if (code !== 'ENOENT') throw error
}
```

Pass `qiniuEnv: process.env` and a single-image chooser:

```ts
chooseAvatarFile: async () => {
  const dialogOptions: OpenDialogOptions = {
    title: '选择头像',
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
  }
  const result = mainWindow
    ? await dialog.showOpenDialog(mainWindow, dialogOptions)
    : await dialog.showOpenDialog(dialogOptions)
  return result.canceled ? undefined : result.filePaths[0]
},
```

Add one `application.test.ts` case that registers Alice, calls `runtime.services.profile.update({ displayName: 'Alice Zhang' })`, closes and recreates the runtime against the same database, logs Alice in, and expects `runtime.services.profile.get()` to retain `displayName: 'Alice Zhang'`. Use `qiniuEnv: {}` and `chooseAvatarFile: async () => undefined`; this test must not contact Qiniu.

- [ ] **Step 6: Run Main and bridge tests**

Run:

```bash
pnpm --filter @autoforge/desktop exec vitest run --config vitest.node.config.ts electron/preload/bridge.test.ts electron/main/ipc/register-ipc.test.ts electron/main/application.test.ts electron/main/profile
pnpm --filter @autoforge/desktop typecheck
```

Expected: PASS. Existing application fixtures compile unchanged because the two new adapter seams are optional.

- [ ] **Step 7: Commit Main wiring**

```bash
git add apps/desktop/electron/main/application.ts apps/desktop/electron/main/application.test.ts apps/desktop/electron/main/index.ts apps/desktop/electron/main/ipc/register-ipc.ts apps/desktop/electron/main/ipc/register-ipc.test.ts apps/desktop/electron/preload/bridge.ts apps/desktop/electron/preload/bridge.test.ts
git commit -m "feat: expose authenticated profile api"
```

---

### Task 6: Build the Profile Store, page, and workbench entry

**Files:**

- Create: `apps/desktop/src/stores/profile.ts`
- Create: `apps/desktop/src/views/ProfileView.vue`
- Modify: `apps/desktop/src/router/index.ts`
- Modify: `apps/desktop/src/components/AppRail.vue`
- Create: `apps/desktop/tests/components/profile.test.ts`
- Modify: `apps/desktop/tests/components/auth.test.ts`
- Modify: `apps/desktop/tests/components/workbench.test.ts`
- Modify: `apps/desktop/tests/components/chat.test.ts`
- Modify: `apps/desktop/tests/components/developer.test.ts`
- Modify: `apps/desktop/tests/components/token-usage-charts.test.ts`

**Interfaces:**

- Consumes: `DesktopAPI.profile` and `UserProfile` from Task 1.
- Produces: `/profile`, `useProfileStore()`, the editable form, and the profile-aware rail account entry.

- [ ] **Step 1: Write failing Renderer tests**

Create `profile.test.ts` with a `DesktopAPI` fixture whose `profile` methods return:

```ts
const profile: UserProfile = {
  userId: 'user_1', account: 'Alice', displayName: 'Alice Zhang',
  avatarUrl: 'https://cdn.example.com/profiles/user_1/a.png',
  gender: 'female', birthDate: '2000-01-01',
  email: 'alice@example.com', phone: '+8613800138000',
  updatedAt: '2026-08-18T00:00:00.000Z',
}
```

Cover these behaviors:

```ts
it('loads the authenticated profile route and renders all fields', async () => {
  const app = await mountProfileApp('/profile')
  await vi.waitFor(() => expect(app.api.profile.get).toHaveBeenCalledOnce())
  expect(app.wrapper.get('input[aria-label="账号"]').attributes('readonly')).toBeDefined()
  expect(app.wrapper.get('input[aria-label="显示名称"]').element.value).toBe('Alice Zhang')
  expect(app.wrapper.get('input[aria-label="邮箱"]').element.value).toBe('alice@example.com')
  expect(app.wrapper.text()).toContain('联系方式')
})

it('uploads a new avatar into the draft and saves normalized fields', async () => {
  const app = await mountProfileApp('/profile')
  vi.mocked(app.api.profile.pickAndUploadAvatar).mockResolvedValue({ url: 'https://cdn.example.com/new.png' })
  await app.wrapper.get('[data-testid="change-avatar"]').trigger('click')
  await app.wrapper.get('input[aria-label="显示名称"]').setValue('New Name')
  await app.wrapper.get('[data-testid="save-profile"]').trigger('click')
  await vi.waitFor(() => expect(app.api.profile.update).toHaveBeenCalledWith(expect.objectContaining({
    avatarUrl: 'https://cdn.example.com/new.png', displayName: 'New Name',
  })))
})

it('keeps a failed save draft and synchronizes a successful rail profile', async () => {
  const app = await mountProfileApp('/profile')
  vi.mocked(app.api.profile.update).mockRejectedValueOnce(toSafeAppError({ code: 'INTERNAL_ERROR' }))
  await app.wrapper.get('input[aria-label="显示名称"]').setValue('Unsaved')
  await app.wrapper.get('[data-testid="save-profile"]').trigger('click')
  await vi.waitFor(() => expect(app.wrapper.get('input[aria-label="显示名称"]').element.value).toBe('Unsaved'))
  vi.mocked(app.api.profile.update).mockResolvedValue({ ...profile, displayName: 'Saved' })
  await app.wrapper.get('[data-testid="save-profile"]').trigger('click')
  await vi.waitFor(() => expect(app.wrapper.get('[data-testid="current-account"]').text()).toContain('Saved'))
})

it('uses account fallbacks and navigates through the rail profile entry', async () => {
  const app = await mountProfileApp('/chat', { userId: 'user_1', account: 'Alice' })
  await vi.waitFor(() => expect(app.wrapper.get('[data-testid="profile-entry"]').text()).toContain('Alice'))
  expect(app.wrapper.get('[data-testid="profile-avatar-fallback"]').text()).toBe('A')
  await app.wrapper.get('[data-testid="profile-entry"]').trigger('click')
  expect(app.router.currentRoute.value.fullPath).toBe('/profile')
})
```

Also assert anonymous `/profile` redirects to `/login?redirect=/profile`, future birth dates and malformed email/phone block submission, cancellation does not show an error, and logout clears `ProfileStore`.

- [ ] **Step 2: Run the Renderer test and verify RED**

Run:

```bash
pnpm --filter @autoforge/desktop exec vitest run --config vitest.config.ts tests/components/profile.test.ts
```

Expected: FAIL because the route, Store, and view do not exist.

- [ ] **Step 3: Implement the shared Profile Store**

Create `apps/desktop/src/stores/profile.ts` with state:

```ts
state: () => ({
  profile: null as UserProfile | null,
  loading: false,
  saving: false,
  uploadingAvatar: false,
  error: '',
  loadedUserId: '',
})
```

Implement:

- `load(userId, force = false)`: deduplicate concurrent loads, skip only when `loadedUserId === userId`, call `profile.get()`, and discard a late response if the active auth user changed.
- `update(input)`: preserve the current profile on error; on success replace it with the returned full profile.
- `pickAndUploadAvatar()`: return the uploaded URL, `undefined` on cancellation/failure, and map errors with `displayError`.
- `reset()`: restore the initial state and invalidate pending responses with a monotonically increasing generation number.

Use an `acceptHMRUpdate` export consistent with other Stores.

- [ ] **Step 4: Implement the route and page**

Add `ProfileView` import and route:

```ts
{ path: 'profile', name: 'profile', component: ProfileView, meta: { title: '个人资料', inspector: false } },
```

`ProfileView.vue` must:

- Call `profileStore.load(auth.session!.user.id)` on mount.
- Keep a local reactive draft copied only when a new loaded profile arrives and the current draft is not dirty.
- Render avatar, upload status, read-only account, display name, gender select, date picker capped at today, email, and phone.
- Use visible labels and stable `aria-label`/`data-testid` hooks from the tests.
- Represent “未设置” gender as an empty draft value and omit it from the update input.
- Validate display-name code-point length, an actually parseable non-future birth date, email, and normalized phone before calling Main.
- Disable save while clean, invalid, saving, or loading.
- On save success replace the draft with the returned profile and call `ElMessage.success('个人资料已保存')`.
- On avatar cancellation leave the draft untouched; on upload error show the Store's safe message.

Use existing CSS variables and Element Plus controls. Keep all page-specific styles scoped; do not edit global visual tokens.

- [ ] **Step 5: Convert the rail account area into the profile entry**

In `AppRail.vue`:

- Import and load `useProfileStore` for the current authenticated user.
- Replace the plain account span with a `RouterLink` carrying `data-testid="profile-entry"`, an image when `avatarUrl` exists, and `data-testid="profile-avatar-fallback"` otherwise.
- Display `profile.displayName || auth.session.user.account`.
- Keep the existing independent logout button.
- After a successful logout call `profile.reset()` before navigating to `/login`; leave profile and session intact when logout fails.

- [ ] **Step 6: Update existing typed API fixtures**

Where existing tests construct `DesktopAPI`, add this exact inert member:

```ts
profile: {
  get: vi.fn().mockResolvedValue({ userId: 'user_1', account: 'Alice' }),
  update: vi.fn(),
  pickAndUploadAvatar: vi.fn().mockResolvedValue(null),
},
```

Use each fixture's existing account value where it differs. Do not change unrelated assertions or snapshots.

- [ ] **Step 7: Run Renderer tests and typecheck**

Run:

```bash
pnpm --filter @autoforge/desktop exec vitest run --config vitest.config.ts tests/components/profile.test.ts tests/components/auth.test.ts tests/components/workbench.test.ts
pnpm --filter @autoforge/desktop typecheck
```

Expected: PASS. The workbench still has exactly five primary navigation items because profile is an account entry, not a sixth primary item.

- [ ] **Step 8: Commit the Renderer feature**

```bash
git add apps/desktop/src/stores/profile.ts apps/desktop/src/views/ProfileView.vue apps/desktop/src/router/index.ts apps/desktop/src/components/AppRail.vue apps/desktop/tests/components/profile.test.ts apps/desktop/tests/components/auth.test.ts apps/desktop/tests/components/workbench.test.ts apps/desktop/tests/components/chat.test.ts apps/desktop/tests/components/developer.test.ts apps/desktop/tests/components/token-usage-charts.test.ts
git commit -m "feat: add personal profile page"
```

---

### Task 7: Full regression verification and documentation check

**Files:**

- Modify only files already owned by Tasks 1–6 if verification reveals a feature-caused failure.

**Interfaces:**

- Consumes: the complete profile feature.
- Produces: evidence that contracts, migration, Main, Preload, Renderer, lint, types, and production bundling all pass together.

- [ ] **Step 1: Verify the exact environment contract**

Run:

```bash
git check-ignore .env
git check-ignore -v .env.example || true
rg -n "QINIU_(ACCESS_KEY|SECRET_KEY)" apps packages --glob '!*.test.ts'
```

Expected: `.env` is ignored, `.env.example` is not ignored, and the `rg` output contains only Main-side environment reads—no Renderer, Preload response, or logged value.

- [ ] **Step 2: Run all tests**

Run:

```bash
pnpm test
```

Expected: all Vitest projects PASS. If an unrelated pre-existing failure appears, record it verbatim and verify every profile-focused test separately before proceeding.

- [ ] **Step 3: Run static checks**

Run:

```bash
pnpm typecheck
pnpm lint
```

Expected: both commands exit 0.

- [ ] **Step 4: Build the application**

Run:

```bash
pnpm build
```

Expected: packages and Electron desktop build successfully; Qiniu remains a Main dependency and no credential value is bundled from `.env.example`.

- [ ] **Step 5: Inspect the final change boundary**

Run:

```bash
git status --short
git diff --check HEAD~6..HEAD
git diff --stat HEAD~6..HEAD
```

Expected: no whitespace errors; changed files correspond to the approved profile design. Do not clean or stage unrelated user changes.

- [ ] **Step 6: Commit only verification fixes if needed**

If Tasks 1–6 required no verification fix, do not create an empty commit. Otherwise stage only the feature-owned files and commit:

```bash
git commit -m "fix: complete profile integration"
```

Record the final test, typecheck, lint, and build results in the implementation handoff.
