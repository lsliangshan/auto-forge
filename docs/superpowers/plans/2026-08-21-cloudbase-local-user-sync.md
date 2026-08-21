# CloudBase Local User Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Synchronize each authenticated CloudBase user into AutoForge's local user, profile, and current-session tables while keeping CloudBase as the only authentication authority.

**Architecture:** `CloudBaseAuthService` produces a validated public identity snapshot. The Application auth facade passes that snapshot to one better-sqlite3 aggregate transaction that upserts `local_users`, merges `local_user_profiles`, and replaces `local_auth_session`. Profile edits update CloudBase first for shared fields and then persist the local projection; email and phone are read-only.

**Tech Stack:** TypeScript, Electron Main/Preload, Vue 3, Pinia, Zod, better-sqlite3, Drizzle schema declarations, `@cloudbase/js-sdk@3.8.0`, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-21-cloudbase-local-user-sync-design.md`

## Global Constraints

- CloudBase environment stays `autoforge-d1gkhyfb419ba8455` in `ap-shanghai`; do not change providers, SMTP, SMS, or Publishable Key configuration.
- CloudBase `getSession()` / `requireSession()` remains the only authentication proof; `local_auth_session` is a projection only.
- Use CloudBase UID as `local_users.id`; never merge historical users by username, email, or phone.
- Do not store passwords, OTPs, tokens, Publishable Key, SMTP authorization code, or raw Provider errors in user/profile tables, Renderer state, logs, or snapshots.
- Do not modify the three table structures unless a failing test proves the existing schema cannot satisfy the confirmed transaction.
- Email and phone are output-only profile fields in this feature; no contact-change OTP flow.
- Do not use `any`; parse SDK responses as `unknown` with type guards.
- Do not open a visible browser. User-visible verification, if needed, must be headless.

---

### Task 1: Public identity and profile update contracts

**Files:**
- Modify: `packages/shared/src/desktop-api.ts`
- Modify: `packages/shared/src/contracts.test.ts`

**Interfaces:**
- Produces: `AuthUserProfileSnapshot`, optional `AuthUser.profile`, and a `UserProfileUpdate` that excludes email/phone.
- Consumes: existing `ProfileGender`, canonical HTTPS URL validation, and `AuthUser`/`AuthSession` schemas.

- [ ] **Step 1: Write failing contract tests**

Add tests proving an auth user accepts strict three-state profile fields and that ordinary profile updates reject contact fields:

```ts
expect(authUserSchema.parse({
  id: 'cloud_uid',
  account: 'Alice_1',
  profile: {
    displayName: 'Alice',
    avatarUrl: null,
    gender: 'female',
    email: 'alice@example.com',
    phone: undefined,
  },
})).toMatchObject({ id: 'cloud_uid', profile: { avatarUrl: null } })

expect(userProfileUpdateSchema.safeParse({ email: 'other@example.com' }).success).toBe(false)
expect(userProfileUpdateSchema.safeParse({ phone: '+8613800138000' }).success).toBe(false)
```

- [ ] **Step 2: Run the tests and verify RED**

Run: `pnpm exec vitest run packages/shared/src/contracts.test.ts`

Expected: failure because `AuthUser.profile` is rejected and contact keys are still accepted.

- [ ] **Step 3: Implement the exact schemas**

Define the snapshot after `ProfileGender` is available and use it from `authUserSchema`:

```ts
export const authUserProfileSnapshotSchema = z.object({
  displayName: z.union([profileDisplayNameSchema, z.null()]).optional(),
  avatarUrl: z.union([canonicalHttpsUrlSchema, z.null()]).optional(),
  gender: z.union([profileGenderSchema, z.null()]).optional(),
  email: z.union([profileEmailSchema, z.null()]).optional(),
  phone: z.union([z.string().regex(/^\+?\d{6,20}$/), z.null()]).optional(),
}).strict()

export type AuthUserProfileSnapshot = z.infer<typeof authUserProfileSnapshotSchema>
```

Move or order declarations so `authUserSchema` can reference this schema without duplicating validation. Remove `email` and `phone` from `userProfileUpdateSchema`; leave them in `userProfileSchema` output.

- [ ] **Step 4: Run shared tests and typecheck the package**

Run: `pnpm exec vitest run packages/shared/src/contracts.test.ts`

Run: `pnpm --filter @autoforge/shared typecheck`

Expected: both pass.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/desktop-api.ts packages/shared/src/contracts.test.ts
git commit -m "feat: add CloudBase identity snapshot contract"
```

---

### Task 2: Parse and update CloudBase user profiles

**Files:**
- Modify: `apps/desktop/electron/main/auth/auth-service.ts`
- Modify: `apps/desktop/electron/main/auth/cloudbase-auth-port.ts`
- Modify: `apps/desktop/electron/main/auth/cloudbase-auth-port.test.ts`
- Modify: `apps/desktop/electron/main/auth/cloudbase-auth-service.ts`
- Modify: `apps/desktop/electron/main/auth/cloudbase-auth-service.test.ts`
- Modify: `apps/desktop/electron/main/auth/local-auth-service.ts`

**Interfaces:**
- Consumes: `AuthUserProfileSnapshot` from Task 1.
- Produces on `AuthService`:

```ts
updateUserProfile(input: {
  displayName?: string
  avatarUrl?: string
  gender?: ProfileGender
}): Promise<AuthUser>

discardSession(): Promise<void>
```

- Produces on `CloudBaseAuthPort`: `getUser()`, `refreshUser()`, and `updateUser(input)` passthrough methods using `unknown` at the service boundary.

- [ ] **Step 1: Write failing CloudBase service tests**

Cover these cases with provider-shaped fixtures:

```ts
it('returns a normalized verified CloudBase profile in the auth session', async () => {
  // username/nickname, HTTPS avatar, FEMALE, confirmed email and phone
  // expect session.user.profile to contain normalized local values
})

it('distinguishes missing, empty, malformed and unverified provider fields', async () => {
  // missing => undefined, explicit empty => null, malformed => undefined
  // unconfirmed email/phone => undefined
})

it('updates CloudBase profile fields and returns the refreshed identity snapshot', async () => {
  // expect port.updateUser({ nickname, avatar_url, gender: 'FEMALE' })
})

it('discards local credentials even when remote signOut fails', async () => {
  // expect encrypted session deleted and later getSession() to return null
})
```

Extend the stored encrypted session assertions so `user.profile` survives SDK malformed-function restoration without logging or snapshotting real tokens.

- [ ] **Step 2: Run the focused service tests and verify RED**

Run:

```bash
pnpm --dir apps/desktop exec node scripts/run-vitest-electron.mjs run \
  --config vitest.node.config.ts \
  electron/main/auth/cloudbase-auth-port.test.ts \
  electron/main/auth/cloudbase-auth-service.test.ts
```

Expected: failures for missing port/service methods and missing snapshot parsing.

- [ ] **Step 3: Add port and service contracts**

Add exact port methods:

```ts
getUser(): Promise<unknown>
refreshUser(): Promise<unknown>
updateUser(input: {
  nickname?: string
  avatar_url?: string
  gender?: 'MALE' | 'FEMALE' | 'OTHER' | 'PREFER_NOT_TO_SAY'
}): Promise<unknown>
```

Add `updateUserProfile` and `discardSession` to `AuthService`. Keep `LocalAuthService` compiling with a local-only compatibility implementation: it returns the current public user for profile updates and clears its local session for discard; production continues to construct CloudBaseAuthService.

- [ ] **Step 4: Implement safe CloudBase user parsing**

Use narrow helpers that return `undefined`, `null`, or a validated value without invoking function-valued SDK fields. Parse:

- username before nickname for `account`.
- nickname/name for `displayName`.
- canonical HTTPS avatar aliases.
- provider gender into local enum.
- email/phone only when the matching confirmation timestamp is a non-empty string.

Persist the full public `AuthUser` snapshot in the existing encrypted session JSON. Reuse it when SDK restoration returns function-valued fields.

- [ ] **Step 5: Implement profile update and forced discard**

`updateUserProfile` must require a current non-anonymous session, call `port.updateUser`, check `error`, refresh/parse the returned user when necessary, persist the refreshed public snapshot with the current tokens, and return `AuthUser`.

`discardSession` must invalidate OTP challenges, remove the encrypted session and in-memory identity even if `signOut` throws, and expose only fixed safe errors where the caller needs one. It is an internal rollback boundary, not the normal logout path.

- [ ] **Step 6: Run focused tests, typecheck and lint**

Run the Task 2 focused test command again.

Run: `pnpm --filter @autoforge/desktop typecheck`

Run:

```bash
pnpm exec eslint \
  apps/desktop/electron/main/auth/auth-service.ts \
  apps/desktop/electron/main/auth/cloudbase-auth-port.ts \
  apps/desktop/electron/main/auth/cloudbase-auth-service.ts \
  apps/desktop/electron/main/auth/local-auth-service.ts
```

Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/electron/main/auth
git commit -m "feat: expose CloudBase user profile snapshots"
```

---

### Task 3: Atomically project CloudBase identity into SQLite

**Files:**
- Create: `apps/desktop/electron/main/database/cloudbase-identity-repository.ts`
- Create: `apps/desktop/electron/main/database/cloudbase-identity-repository.test.ts`
- Modify: `apps/desktop/electron/main/database/client.ts`
- Modify: `apps/desktop/electron/main/database/database.test.ts`

**Interfaces:**
- Consumes: `AuthSession` with optional `user.profile` from Task 1.
- Produces:

```ts
export interface CloudBaseIdentityRepository {
  sync(session: AuthSession, timestamp: number): LocalAuthSessionRecord
}
```

The repository is constructed with the same raw better-sqlite3 connection used by `localAuth` and `userProfiles` and returned from `openAppDatabase` as `cloudBaseIdentities`.

- [ ] **Step 1: Write failing transaction tests**

Cover:

```ts
it('atomically creates a CloudBase user, profile and current local session', () => {})
it('updates cloud fields while preserving birth date and created_at', () => {})
it('clears explicit null fields and preserves missing fields', () => {})
it('keeps a same-name historical local user separate', () => {})
it('rolls back all three tables when the CloudBase UID belongs to a local identity', () => {})
```

Use an actual temporary SQLite database with migrations and inspect all three tables after success/failure.

- [ ] **Step 2: Run the repository tests and verify RED**

Run:

```bash
pnpm --dir apps/desktop exec node scripts/run-vitest-electron.mjs run \
  --config vitest.node.config.ts \
  electron/main/database/cloudbase-identity-repository.test.ts
```

Expected: failure because the repository does not exist.

- [ ] **Step 3: Implement one aggregate transaction**

Inside `database.transaction`, perform:

```ts
const accountNormalized = `cloudbase:${session.user.id}`
const passwordDigest = `!external-identity:${session.user.id}`
```

Upsert and verify `local_users`; read the current profile; merge each three-state cloud field while always retaining `birthDate`; upsert a profile row; replace `local_auth_session(id = 1)` using `Date.parse(session.authenticatedAt)` after checking it is finite. Read back the session and throw if it does not point to the CloudBase UID.

Do not compose the transaction from separately committed repository calls.

- [ ] **Step 4: Expose the repository from the database aggregate**

Construct it in `openAppDatabase` and return it as `cloudBaseIdentities`. Keep existing `localAuth` and `userProfiles` APIs intact for legacy tests and Profile reads.

- [ ] **Step 5: Run database tests and typecheck**

Run:

```bash
pnpm --dir apps/desktop exec node scripts/run-vitest-electron.mjs run \
  --config vitest.node.config.ts \
  electron/main/database/cloudbase-identity-repository.test.ts \
  electron/main/database/database.test.ts
```

Run: `pnpm --filter @autoforge/desktop typecheck`

Expected: all pass and schema version remains unchanged.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/electron/main/database
git commit -m "feat: atomically project CloudBase identities"
```

---

### Task 4: Synchronize every authenticated application path

**Files:**
- Modify: `apps/desktop/electron/main/application.ts`
- Modify: `apps/desktop/electron/main/application.test.ts`

**Interfaces:**
- Consumes: `AuthService.discardSession()` from Task 2 and `database.cloudBaseIdentities.sync()` from Task 3.
- Produces: an observed AuthService that only marks itself authenticated after the local transaction succeeds.

- [ ] **Step 1: Replace the old projection expectations with failing synchronization tests**

Update the current test that expects zero local sessions. Assert after authentication:

```ts
expect(localUser.id).toBe(session.user.id)
expect(localProfile.userId).toBe(session.user.id)
expect(localSession).toEqual({ userId: session.user.id })
```

Add tests for OTP/password/restore through the shared observed methods, successful logout clearing `local_auth_session`, failed logout retaining it, and a transaction failure calling `discardSession` while returning fixed `INTERNAL_ERROR`.

- [ ] **Step 2: Run Application tests and verify RED**

Run:

```bash
pnpm --dir apps/desktop exec node scripts/run-vitest-electron.mjs run \
  --config vitest.node.config.ts electron/main/application.test.ts
```

Expected: failures because the facade only calls `ensureExternalIdentity` and never writes/clears local session.

- [ ] **Step 3: Replace projection with fail-closed synchronization**

Change `observeAuthService` dependencies to:

```ts
{
  sync(session: AuthSession, timestamp: number): LocalAuthSessionRecord
  clearSession(): void
}
```

For `getSession`, `verifyOtp`, `loginWithPassword`, and `requireSession`, call one shared `synchronize(session)` function. If it throws, call `delegate.discardSession()`, set `authenticated = false`, and throw fixed `INTERNAL_ERROR`.

After normal `delegate.logout()` succeeds, clear the local session and set `authenticated = false`. If delegate logout fails, do not clear either state.

- [ ] **Step 4: Wire the database aggregate**

Pass `database.cloudBaseIdentities` and `database.localAuth.clearSession` through a small object; do not expose raw SQL to Application.

- [ ] **Step 5: Run Application/database/auth regression tests**

Run:

```bash
pnpm --dir apps/desktop exec node scripts/run-vitest-electron.mjs run \
  --config vitest.node.config.ts \
  electron/main/application.test.ts \
  electron/main/database/cloudbase-identity-repository.test.ts \
  electron/main/auth/cloudbase-auth-service.test.ts
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/electron/main/application.ts apps/desktop/electron/main/application.test.ts
git commit -m "feat: synchronize local data after CloudBase auth"
```

---

### Task 5: Cloud-first profile updates and read-only contacts

**Files:**
- Modify: `apps/desktop/electron/main/profile/profile-service.ts`
- Modify: `apps/desktop/electron/main/profile/profile-service.test.ts`
- Modify: `apps/desktop/src/views/ProfileView.vue`
- Modify: `apps/desktop/src/stores/profile.ts` only if its typed input requires adjustment
- Modify: `apps/desktop/tests/components/profile.test.ts`
- Modify: `apps/desktop/electron/main/ipc/register-ipc.test.ts`
- Modify: `apps/desktop/electron/preload/bridge.test.ts`

**Interfaces:**
- Consumes: `AuthService.updateUserProfile()` and contact-free `UserProfileUpdate`.
- Produces: Cloud-first updates for shared fields and local-only birthday updates.

- [ ] **Step 1: Write failing Profile service tests**

Cover ordering and failure semantics:

```ts
it('updates CloudBase before persisting shared profile fields', async () => {})
it('does not write local profile when CloudBase update fails', async () => {})
it('updates only birth date locally without calling CloudBase', async () => {})
it('uses the refreshed CloudBase snapshot for local display fields', async () => {})
```

Use a call-order array or Vitest invocation order assertions; do not rely only on both mocks being called.

- [ ] **Step 2: Write failing component tests**

Assert email and phone controls are readonly, the explanatory text is present, editing/saving does not include contact keys, and display/phone/email values from the loaded profile remain visible.

- [ ] **Step 3: Run focused tests and verify RED**

Run:

```bash
pnpm --dir apps/desktop exec node scripts/run-vitest-electron.mjs run \
  --config vitest.node.config.ts electron/main/profile/profile-service.test.ts

pnpm --dir apps/desktop exec node scripts/run-vitest-electron.mjs run \
  --config vitest.config.ts tests/components/profile.test.ts
```

Expected: service still writes only locally and contacts are editable.

- [ ] **Step 4: Implement Cloud-first ProfileService**

Validate input first. If `displayName`, `avatarUrl`, or `gender` is present, call `auth.updateUserProfile` before repository upsert. Use the returned snapshot fields for corresponding local columns. Preserve existing email/phone when the update snapshot omits them; apply explicit nulls. Apply the requested `birthDate` locally.

If the CloudBase call fails, propagate a fixed safe error and do not invoke `repository.upsert`.

- [ ] **Step 5: Make contacts read-only in ProfileView**

Keep loaded email/phone values in the draft for display, but add `readonly`, remove contact autocomplete/edit validation, remove them from `input()`, and change the copy to `来自 CloudBase 账号，修改需验证码。`. Ensure dirty comparison ignores read-only contact changes caused by profile reload.

- [ ] **Step 6: Update IPC/Preload fixtures and run regressions**

Remove email/phone from update fixtures while retaining them in profile responses. Run:

```bash
pnpm --dir apps/desktop exec node scripts/run-vitest-electron.mjs run \
  --config vitest.node.config.ts \
  electron/main/profile/profile-service.test.ts \
  electron/main/ipc/register-ipc.test.ts \
  electron/preload/bridge.test.ts

pnpm --dir apps/desktop exec node scripts/run-vitest-electron.mjs run \
  --config vitest.config.ts \
  tests/components/profile.test.ts \
  tests/components/auth.test.ts
```

Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src apps/desktop/electron/main/profile apps/desktop/electron/main/ipc \
  apps/desktop/electron/preload apps/desktop/src/views/ProfileView.vue \
  apps/desktop/src/stores/profile.ts apps/desktop/tests/components
git commit -m "feat: sync editable profiles with CloudBase"
```

---

### Task 6: Final integration, CloudBase review and verification

**Files:**
- Modify only files required by concrete failures attributable to Tasks 1–5.
- Do not change Provider configuration or unrelated lint failures.

**Interfaces:**
- Consumes: all prior task outputs.
- Produces: verified CloudBase/local synchronization with a clean worktree.

- [ ] **Step 1: Run focused integration suites**

Run:

```bash
pnpm exec vitest run packages/shared/src/contracts.test.ts

pnpm --dir apps/desktop exec node scripts/run-vitest-electron.mjs run \
  --config vitest.node.config.ts \
  electron/main/auth/cloudbase-auth-port.test.ts \
  electron/main/auth/cloudbase-auth-service.test.ts \
  electron/main/database/cloudbase-identity-repository.test.ts \
  electron/main/database/database.test.ts \
  electron/main/profile/profile-service.test.ts \
  electron/main/application.test.ts \
  electron/main/ipc/register-ipc.test.ts \
  electron/preload/bridge.test.ts

pnpm --dir apps/desktop exec node scripts/run-vitest-electron.mjs run \
  --config vitest.config.ts \
  tests/components/auth.test.ts \
  tests/components/profile.test.ts
```

Expected: all pass with zero retries.

- [ ] **Step 2: Run static verification**

Run:

```bash
pnpm typecheck
pnpm exec eslint \
  packages/shared/src/desktop-api.ts \
  packages/shared/src/contracts.test.ts \
  apps/desktop/electron/main/auth/auth-service.ts \
  apps/desktop/electron/main/auth/cloudbase-auth-port.ts \
  apps/desktop/electron/main/auth/cloudbase-auth-port.test.ts \
  apps/desktop/electron/main/auth/cloudbase-auth-service.ts \
  apps/desktop/electron/main/auth/cloudbase-auth-service.test.ts \
  apps/desktop/electron/main/auth/local-auth-service.ts \
  apps/desktop/electron/main/database/cloudbase-identity-repository.ts \
  apps/desktop/electron/main/database/cloudbase-identity-repository.test.ts \
  apps/desktop/electron/main/database/client.ts \
  apps/desktop/electron/main/database/database.test.ts \
  apps/desktop/electron/main/application.ts \
  apps/desktop/electron/main/application.test.ts \
  apps/desktop/electron/main/profile/profile-service.ts \
  apps/desktop/electron/main/profile/profile-service.test.ts \
  apps/desktop/electron/main/ipc/register-ipc.test.ts \
  apps/desktop/electron/preload/bridge.test.ts \
  apps/desktop/src/views/ProfileView.vue \
  apps/desktop/src/stores/profile.ts \
  apps/desktop/tests/components/profile.test.ts
git diff --check
pnpm build
```

Expected: exit 0 for each command. If repository-wide lint has unrelated existing failures, report them separately and keep the changed-file lint green.

- [ ] **Step 3: Run CloudBase code review**

Read and apply `cloudbase-code-review` rules. Verify semantically:

- Authentication guards still use `getSession()` and reject anonymous sessions.
- Every SDK response checks `error` before `data`.
- No secret or raw Provider response is logged or returned.
- No local session is used as authentication proof.
- No unverified email/phone is projected.

- [ ] **Step 4: Review final scope and security diff**

Run:

```bash
git status --short
git diff --stat 28c7751..HEAD
git diff --check 28c7751..HEAD
```

Inspect every changed file against the spec. Remove only code made unused by this implementation; do not refactor adjacent modules.

- [ ] **Step 5: Commit final fixes, if any**

```bash
git add \
  packages/shared/src/desktop-api.ts packages/shared/src/contracts.test.ts \
  apps/desktop/electron/main/auth apps/desktop/electron/main/database \
  apps/desktop/electron/main/application.ts apps/desktop/electron/main/application.test.ts \
  apps/desktop/electron/main/profile apps/desktop/electron/main/ipc/register-ipc.test.ts \
  apps/desktop/electron/preload/bridge.test.ts apps/desktop/src/views/ProfileView.vue \
  apps/desktop/src/stores/profile.ts apps/desktop/tests/components/profile.test.ts
git commit -m "fix: close CloudBase user sync verification gaps"
```

Skip this commit if no final fixes are needed.
