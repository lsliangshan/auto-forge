# CloudBase OTP Authentication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace AutoForge local authentication with CloudBase phone/email OTP registration, phone/email OTP login, and username/password login while preserving the Electron Main-process security boundary.

**Architecture:** The Renderer owns only form state and a random OTP challenge ID. Typed Preload/IPC calls enter a Main-process `CloudBaseAuthService`, which owns the CloudBase JS SDK, short-lived verification callbacks, encrypted session persistence, session restoration, and `requireSession()`. Production creates the CloudBase service; application tests inject a deterministic in-memory `AuthService`.

**Tech Stack:** Electron 43, Vue 3.5, Pinia 4, Element Plus 2.14, TypeScript 6, Zod 4, Vitest 4, `@cloudbase/js-sdk@3.8.0`, Electron `safeStorage`

## Global Constraints

- Canonical CloudBase environment ID is `autoforge-d1gkhyfb419ba8455`; region is `ap-shanghai`.
- Read the existing publishable key from `AUTOFORGE_CLOUDBASE_PUBLISHABLE_KEY`; never commit or log its value.
- Never persist or log passwords, OTP codes, SMTP credentials, SDK verification IDs, access tokens, or refresh tokens in plaintext.
- Login priority and default: phone OTP, email OTP, username/password.
- Registration priority and default: phone OTP, email OTP; both include username and password.
- OTP login must pass `options: { shouldCreateUser: false }`.
- Main-process challenges expire after 300 seconds, are random, single-use, and are cancelled when relevant fields or auth method change.
- Keep old local-auth tables/classes intact but remove them from production runtime assembly.
- Preserve current Router Guard and all business IPC `requireSession()` checks.
- No Cloud Functions, CloudRun service, local-user migration, account recovery, or identity rebinding.
- Follow TDD: every production behavior starts with a focused failing test.
- Do not modify unrelated files or reformat neighboring code.

---

### Task 1: Replace the shared authentication contract

**Files:**
- Modify: `packages/shared/src/desktop-api.ts`
- Modify: `packages/shared/src/errors.ts`
- Modify: `packages/shared/src/contracts.test.ts`
- Modify: `apps/desktop/tests/components/profile.test.ts`
- Modify: `apps/desktop/tests/components/developer.test.ts`
- Modify: `apps/desktop/tests/components/workbench.test.ts`
- Modify: `apps/desktop/tests/components/chat.test.ts`

**Interfaces:**
- Produces: `AuthOtpChannel`, `AuthOtpRequest`, `AuthOtpChallenge`, `AuthOtpVerification`, `AuthCredentials`
- Produces Desktop API methods: `sendOtp`, `verifyOtp`, `cancelOtp`, `loginWithPassword`, `getSession`, `logout`
- Produces error codes consumed by all later tasks

- [ ] **Step 1: Write failing contract tests**

Replace the old local-auth assertions with tests equivalent to:

```ts
it('validates CloudBase username, password, phone, email, and OTP inputs', () => {
  expect(authCredentialsSchema.parse({ account: '  Alice_1  ', password: '密码密码密码密码' }))
    .toEqual({ account: 'Alice_1', password: '密码密码密码密码' })
  expect(authOtpRequestSchema.parse({
    intent: 'login', channel: 'phone', target: ' 18311032722 ',
  })).toEqual({ intent: 'login', channel: 'phone', target: '18311032722' })
  expect(authOtpRequestSchema.parse({
    intent: 'register',
    channel: 'email',
    target: ' User@Example.com ',
    account: ' Alice_1 ',
    password: 'password',
  })).toEqual({
    intent: 'register',
    channel: 'email',
    target: 'user@example.com',
    account: 'Alice_1',
    password: 'password',
  })
  expect(authOtpVerificationSchema.parse({ challengeId: 'challenge_1', code: '123456' }))
    .toEqual({ challengeId: 'challenge_1', code: '123456' })
  expect(() => authOtpRequestSchema.parse({
    intent: 'login', channel: 'phone', target: '123',
  })).toThrow()
  expect(() => authOtpVerificationSchema.parse({
    challengeId: 'challenge_1', code: '12345',
  })).toThrow()
})

it('exposes the CloudBase authentication IPC contract', () => {
  expect(ipcChannels.authSendOtp).toBe('auth:send-otp')
  expect(ipcChannels.authVerifyOtp).toBe('auth:verify-otp')
  expect(ipcChannels.authCancelOtp).toBe('auth:cancel-otp')
  expect(ipcChannels.authLoginWithPassword).toBe('auth:login-with-password')
  expect(ipcRequestSchemas[ipcChannels.authCancelOtp].parse({ challengeId: 'challenge_1' }))
    .toEqual({ challengeId: 'challenge_1' })
  expect(ipcResponseSchemas[ipcChannels.authSendOtp].parse({
    challengeId: 'challenge_1', expiresIn: 300,
  })).toEqual({ challengeId: 'challenge_1', expiresIn: 300 })
})

it.each([
  'AUTH_REQUIRED',
  'AUTH_INVALID_CREDENTIALS',
  'AUTH_ACCOUNT_EXISTS',
  'AUTH_INVALID_OTP',
  'AUTH_OTP_EXPIRED',
  'AUTH_OTP_RATE_LIMITED',
  'AUTH_ACCOUNT_NOT_FOUND',
] as const)('keeps %s as a safe application error', (code) => {
  expect(toSafeAppError({ code })).toMatchObject({ code })
})
```

- [ ] **Step 2: Run the contract test and verify RED**

Run:

```bash
pnpm exec vitest run packages/shared/src/contracts.test.ts
```

Expected: FAIL because OTP schemas, channels, methods, and error codes do not exist.

- [ ] **Step 3: Implement the minimal shared schemas and types**

Define the authentication schemas near the top of `desktop-api.ts`:

```ts
export const authAccountSchema = z.string().trim().regex(/^[A-Za-z0-9_]{5,24}$/)
export const authPhoneSchema = z.string().trim().regex(/^1[3-9]\d{9}$/)
export const authEmailSchema = z.string().trim().toLowerCase().email().max(254)
export const authOtpCodeSchema = z.string().trim().regex(/^\d{6}$/)

export const authPasswordSchema = z.string().superRefine((value, context) => {
  const length = Array.from(value).length
  if (length < 8 || length > 72) {
    context.addIssue({ code: 'custom', message: 'Password must contain 8 to 72 Unicode code points' })
  }
})

export const authCredentialsSchema = z.object({
  account: authAccountSchema,
  password: authPasswordSchema,
}).strict()
export type AuthCredentials = z.infer<typeof authCredentialsSchema>

export const authOtpChannelSchema = z.enum(['phone', 'email'])
export type AuthOtpChannel = z.infer<typeof authOtpChannelSchema>

const authOtpLoginRequestSchema = z.discriminatedUnion('channel', [
  z.object({ intent: z.literal('login'), channel: z.literal('phone'), target: authPhoneSchema }).strict(),
  z.object({ intent: z.literal('login'), channel: z.literal('email'), target: authEmailSchema }).strict(),
])
const authOtpRegisterRequestSchema = z.discriminatedUnion('channel', [
  z.object({
    intent: z.literal('register'),
    channel: z.literal('phone'),
    target: authPhoneSchema,
    account: authAccountSchema,
    password: authPasswordSchema,
  }).strict(),
  z.object({
    intent: z.literal('register'),
    channel: z.literal('email'),
    target: authEmailSchema,
    account: authAccountSchema,
    password: authPasswordSchema,
  }).strict(),
])
export const authOtpRequestSchema = z.union([
  authOtpLoginRequestSchema,
  authOtpRegisterRequestSchema,
])
export type AuthOtpRequest = z.infer<typeof authOtpRequestSchema>

export const authOtpChallengeSchema = z.object({
  challengeId: identifierSchema,
  expiresIn: z.number().int().positive().max(300),
}).strict()
export type AuthOtpChallenge = z.infer<typeof authOtpChallengeSchema>

export const authOtpVerificationSchema = z.object({
  challengeId: identifierSchema,
  code: authOtpCodeSchema,
}).strict()
export type AuthOtpVerification = z.infer<typeof authOtpVerificationSchema>
```

Change `authUserSchema.account` from `authAccountSchema` to `z.string().trim().min(1).max(64)` so a safe phone/email fallback can be displayed.

Replace old auth channels with:

```ts
authGetSession: 'auth:get-session',
authSendOtp: 'auth:send-otp',
authVerifyOtp: 'auth:verify-otp',
authCancelOtp: 'auth:cancel-otp',
authLoginWithPassword: 'auth:login-with-password',
authLogout: 'auth:logout',
```

Wire request/response schemas and change `DesktopAPI['auth']` to:

```ts
auth: {
  getSession(): Promise<AuthSession | null>
  sendOtp(input: AuthOtpRequest): Promise<AuthOtpChallenge>
  verifyOtp(input: AuthOtpVerification): Promise<AuthSession>
  cancelOtp(challengeId: string): Promise<void>
  loginWithPassword(input: AuthCredentials): Promise<AuthSession>
  logout(): Promise<void>
}
```

Add the four new error codes and safe English messages to `errors.ts`.

Update the four non-authentication component-test API factories so their `auth` stubs implement the new six-method `DesktopAPI['auth']` contract. These are contract-only fixture changes: keep every existing page assertion unchanged.

- [ ] **Step 4: Run the contract test and verify GREEN**

Run the Step 2 command.

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/desktop-api.ts packages/shared/src/errors.ts packages/shared/src/contracts.test.ts apps/desktop/tests/components/profile.test.ts apps/desktop/tests/components/developer.test.ts apps/desktop/tests/components/workbench.test.ts apps/desktop/tests/components/chat.test.ts
git commit -m "feat: define CloudBase auth contracts"
```

---

### Task 2: Add the CloudBase SDK adapter and configuration boundary

**Files:**
- Modify: `apps/desktop/package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `.env.example`
- Create: `apps/desktop/electron/main/auth/cloudbase-auth-port.ts`
- Create: `apps/desktop/electron/main/auth/cloudbase-auth-port.test.ts`

**Interfaces:**
- Produces: `CloudBaseAuthPort`
- Produces: `readCloudBaseAuthConfig(env)`
- Produces: `createCloudBaseAuthPort(config)`
- Consumed by Task 3 and Task 4

- [ ] **Step 1: Write failing configuration and adapter tests**

Test exact environment parsing and SDK call forwarding without a network request:

```ts
describe('CloudBase auth port', () => {
  it('requires the publishable key without exposing it in the error', () => {
    expect(() => readCloudBaseAuthConfig({})).toThrow('CloudBase authentication is not configured')
    expect(() => readCloudBaseAuthConfig({
      AUTOFORGE_CLOUDBASE_PUBLISHABLE_KEY: 'publishable-test',
    })).not.toThrow()
  })

  it('initializes the canonical environment and forwards auth calls', async () => {
    const auth = {
      signInWithOtp: vi.fn(),
      signUp: vi.fn(),
      signInWithPassword: vi.fn(),
      getSession: vi.fn(),
      setSession: vi.fn(),
      refreshSession: vi.fn(),
      signOut: vi.fn(),
    }
    const init = vi.fn(() => ({ auth }))
    const port = createCloudBaseAuthPort({
      env: 'autoforge-d1gkhyfb419ba8455',
      region: 'ap-shanghai',
      accessKey: 'publishable-test',
    }, { init })

    await port.signInWithPassword({ username: 'alice', password: 'password' })
    expect(init).toHaveBeenCalledWith({
      env: 'autoforge-d1gkhyfb419ba8455',
      region: 'ap-shanghai',
      accessKey: 'publishable-test',
      auth: { detectSessionInUrl: false },
    })
    expect(auth.signInWithPassword).toHaveBeenCalledWith({
      username: 'alice', password: 'password',
    })
  })
})
```

- [ ] **Step 2: Run the adapter test and verify RED**

```bash
pnpm --dir apps/desktop exec node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts electron/main/auth/cloudbase-auth-port.test.ts
```

Expected: FAIL because the adapter does not exist and the SDK dependency is absent.

- [ ] **Step 3: Install the exact dependency**

```bash
pnpm --filter @autoforge/desktop add @cloudbase/js-sdk@3.8.0 --save-exact
```

Append only the variable name to `.env.example`:

```dotenv
AUTOFORGE_CLOUDBASE_PUBLISHABLE_KEY=
```

- [ ] **Step 4: Implement the adapter**

Use a narrow port returning `unknown` so SDK response validation remains inside the service and no explicit `any` is introduced:

```ts
import cloudbase from '@cloudbase/js-sdk'
import type { AuthCredentials, AuthOtpChannel } from '@autoforge/shared'

export interface CloudBaseAuthConfig {
  env: 'autoforge-d1gkhyfb419ba8455'
  region: 'ap-shanghai'
  accessKey: string
}

export interface CloudBaseAuthPort {
  signInWithOtp(input:
    | { phone: string; options: { shouldCreateUser: false } }
    | { email: string; options: { shouldCreateUser: false } }
  ): Promise<unknown>
  signUp(input:
    | { phone: string; username: string; password: string; nickname: string }
    | { email: string; username: string; password: string; nickname: string }
  ): Promise<unknown>
  signInWithPassword(input: { username: string; password: string }): Promise<unknown>
  getSession(): Promise<unknown>
  setSession(input: { refresh_token: string }): Promise<unknown>
  refreshSession(refreshToken?: string): Promise<unknown>
  signOut(): Promise<unknown>
}

interface CloudBaseFactory {
  init(config: {
    env: string
    region: string
    accessKey: string
    auth: { detectSessionInUrl: false }
  }): { auth: CloudBaseAuthPort }
}

export function readCloudBaseAuthConfig(env: NodeJS.ProcessEnv): CloudBaseAuthConfig {
  const accessKey = env.AUTOFORGE_CLOUDBASE_PUBLISHABLE_KEY?.trim()
  if (!accessKey) throw new Error('CloudBase authentication is not configured')
  return {
    env: 'autoforge-d1gkhyfb419ba8455',
    region: 'ap-shanghai',
    accessKey,
  }
}

export function createCloudBaseAuthPort(
  config: CloudBaseAuthConfig,
  factory: CloudBaseFactory = cloudbase,
): CloudBaseAuthPort {
  return factory.init({
    ...config,
    auth: { detectSessionInUrl: false },
  }).auth
}

export function cloudBaseOtpTarget(channel: AuthOtpChannel, target: string) {
  return channel === 'phone' ? { phone: `+86${target}` } : { email: target }
}

export function cloudBasePasswordCredentials(input: AuthCredentials) {
  return { username: input.account.toLowerCase(), password: input.password }
}
```

If the exact SDK type rejects the injected factory shape, keep the public port unchanged and add a small internal structural wrapper; do not cast through `any`.

- [ ] **Step 5: Run adapter test, typecheck, and verify GREEN**

```bash
pnpm --dir apps/desktop exec node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts electron/main/auth/cloudbase-auth-port.test.ts
pnpm --filter @autoforge/desktop typecheck
```

Expected: both commands PASS.

- [ ] **Step 6: Commit**

```bash
git add .env.example apps/desktop/package.json pnpm-lock.yaml apps/desktop/electron/main/auth/cloudbase-auth-port.ts apps/desktop/electron/main/auth/cloudbase-auth-port.test.ts
git commit -m "feat: add CloudBase auth SDK adapter"
```

---

### Task 3: Implement Main-process OTP challenges and encrypted CloudBase sessions

**Files:**
- Create: `apps/desktop/electron/main/auth/auth-service.ts`
- Create: `apps/desktop/electron/main/auth/cloudbase-auth-service.ts`
- Create: `apps/desktop/electron/main/auth/cloudbase-auth-service.test.ts`
- Modify: `apps/desktop/electron/main/auth/local-auth-service.ts`
- Modify: `apps/desktop/electron/main/profile/profile-service.ts`
- Modify: `apps/desktop/electron/main/security/secret-store.test.ts`

**Interfaces:**
- Consumes: Task 1 auth types and errors
- Consumes: Task 2 `CloudBaseAuthPort`
- Produces: `AuthService` and `CloudBaseAuthService`
- Produces: encrypted secret key `cloudbase_auth_session`

- [ ] **Step 1: Write failing service tests for login and registration challenges**

Create a harness with a fake port, fake secret store, deterministic IDs, and deterministic time. Cover both channels using `it.each`:

```ts
it.each([
  ['phone', '18311032722', { phone: '+8618311032722', options: { shouldCreateUser: false } }],
  ['email', 'USER@example.com', { email: 'user@example.com', options: { shouldCreateUser: false } }],
] as const)('sends %s login OTP without creating users', async (channel, target, expected) => {
  const app = harness()
  app.port.signInWithOtp.mockResolvedValue(otpResponse(app.verifyOtp))

  await expect(app.service.sendOtp({ intent: 'login', channel, target }))
    .resolves.toEqual({ challengeId: 'challenge_1', expiresIn: 300 })
  expect(app.port.signInWithOtp).toHaveBeenCalledWith(expected)
})

it.each(['phone', 'email'] as const)('registers through %s with username and password', async (channel) => {
  const app = harness()
  app.port.signUp.mockResolvedValue(otpResponse(app.verifyOtp))
  const target = channel === 'phone' ? '18311032722' : 'User@example.com'
  const challenge = await app.service.sendOtp({
    intent: 'register',
    channel,
    target,
    account: ' Alice_1 ',
    password: 'password',
  })

  expect(app.port.signUp).toHaveBeenCalledWith(channel === 'phone' ? {
    phone: '+8618311032722',
    username: 'alice_1',
    password: 'password',
    nickname: 'Alice_1',
  } : {
    email: 'user@example.com',
    username: 'alice_1',
    password: 'password',
    nickname: 'Alice_1',
  })

  app.verifyOtp.mockResolvedValue(authResponse(cloudSession()))
  await expect(app.service.verifyOtp({ challengeId: challenge.challengeId, code: '123456' }))
    .resolves.toMatchObject({ user: { id: 'cloud_uid', account: 'Alice_1' } })
  expect(app.verifyOtp).toHaveBeenCalledWith({ token: '123456' })
  expect(app.secrets.set).toHaveBeenCalledWith('cloudbase_auth_session', expect.any(String))
})
```

- [ ] **Step 2: Run the service test and verify RED**

```bash
pnpm --dir apps/desktop exec node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts electron/main/auth/cloudbase-auth-service.test.ts
```

Expected: FAIL because `CloudBaseAuthService` does not exist.

- [ ] **Step 3: Define the service and secret-store ports**

```ts
import type {
  AuthCredentials,
  AuthOtpChallenge,
  AuthOtpRequest,
  AuthOtpVerification,
  AuthSession,
} from '@autoforge/shared'

export interface AuthService {
  getSession(): Promise<AuthSession | null>
  sendOtp(input: AuthOtpRequest): Promise<AuthOtpChallenge>
  verifyOtp(input: AuthOtpVerification): Promise<AuthSession>
  cancelOtp(challengeId: string): Promise<void>
  loginWithPassword(input: AuthCredentials): Promise<AuthSession>
  logout(): Promise<void>
  requireSession(): Promise<AuthSession>
}

export interface AuthSecretStore {
  set(key: string, value: string): Promise<void>
  get(key: string): Promise<string | undefined>
  delete(key: string): void
}
```

Update `ProfileService` to import `AuthService` from `auth-service.ts`; keep its existing `Pick<AuthService, 'requireSession'>` dependency.

Remove the old exported `AuthService` interface and `implements AuthService` clause from `local-auth-service.ts`. Keep `LocalAuthService`, its local-only `login/register` methods, repository, migrations, and tests intact so no historical data is deleted and no duplicate service contract remains.

- [ ] **Step 4: Implement challenge creation, cancellation, expiry, and one-time verification**

Use:

```ts
const SESSION_KEY = 'cloudbase_auth_session'
const CHALLENGE_TTL_MS = 300_000

interface PendingChallenge {
  verifyOtp(input: { token: string }): Promise<unknown>
  intent: AuthOtpRequest['intent']
  expiresAt: number
}
```

The constructor receives:

```ts
constructor(
  private readonly auth: CloudBaseAuthPort,
  private readonly secrets: AuthSecretStore,
  private readonly dependencies = {
    createId: randomUUID,
    now: Date.now,
  },
) {}
```

Implementation requirements:

- Parse every public input with Task 1 schemas.
- Clear any previous challenge before sending a new OTP.
- Extract `data.verifyOtp` only when it is a function and `error` is absent.
- Return only `{ challengeId, expiresIn: 300 }`.
- `cancelOtp` deletes only the matching challenge.
- `verifyOtp` checks expiry, deletes the challenge before invoking it, validates a real session, persists it, and returns a public session.
- A second verification attempt returns `AUTH_OTP_EXPIRED`.
- `logout` clears the challenge table before calling CloudBase.

- [ ] **Step 5: Add failing tests for challenge lifecycle and error mapping**

```ts
it('replaces, cancels, expires, and consumes challenges once', async () => {
  const app = harness()
  app.port.signInWithOtp.mockResolvedValue(otpResponse(app.verifyOtp))
  const first = await app.service.sendOtp({
    intent: 'login', channel: 'phone', target: '18311032722',
  })
  const second = await app.service.sendOtp({
    intent: 'login', channel: 'email', target: 'user@example.com',
  })
  await expect(app.service.verifyOtp({ challengeId: first.challengeId, code: '123456' }))
    .rejects.toMatchObject({ code: 'AUTH_OTP_EXPIRED' })
  await app.service.cancelOtp(second.challengeId)
  await expect(app.service.verifyOtp({ challengeId: second.challengeId, code: '123456' }))
    .rejects.toMatchObject({ code: 'AUTH_OTP_EXPIRED' })
})

it.each([
  ['invalid verification code', 'AUTH_INVALID_OTP'],
  ['verification expired', 'AUTH_OTP_EXPIRED'],
  ['rate limit exceeded', 'AUTH_OTP_RATE_LIMITED'],
  ['user not found', 'AUTH_ACCOUNT_NOT_FOUND'],
  ['username already exists', 'AUTH_ACCOUNT_EXISTS'],
  ['invalid username or password', 'AUTH_INVALID_CREDENTIALS'],
] as const)('maps %s without exposing provider details', async (message, code) => {
  const app = harness()
  app.port.signInWithPassword.mockResolvedValue({
    data: { user: null, session: null },
    error: { message },
  })
  await expect(app.service.loginWithPassword({
    account: 'alice_1', password: 'password',
  })).rejects.toMatchObject({ code })
})
```

- [ ] **Step 6: Implement response validation and safe error mapping**

Use `unknown` type guards or Zod schemas for:

- `{ data: { verifyOtp: Function }, error: null }`
- `{ data: { session, user }, error: null }`
- session fields `access_token`, `refresh_token`, `expires_in`, and `user.id`
- optional user display fields `user_metadata.nickname`, `nickName`, `username`, `name`, `phone`, and `email`

Error classification must inspect only stable string/code fields and return `toSafeAppError({ code })`; never pass the original error through. Unknown errors map to `INTERNAL_ERROR`.

Public session composition:

```ts
function publicSession(session: CloudBaseSession, authenticatedAt: string): AuthSession {
  return {
    user: {
      id: session.user.id,
      account: displayAccount(session.user),
    },
    authenticatedAt,
  }
}
```

Mask fallback phone/email values before returning them as `AuthUser.account`.

- [ ] **Step 7: Add failing tests for persistence, restore, refresh, logout, and requireSession**

Cover:

- Stored JSON contains access token, refresh token, expiry, and authenticated timestamp before encryption.
- Service never calls a plaintext repository; only `AuthSecretStore.set`.
- `SecretStore` persistence test reads the raw `encrypted_secrets` record and proves neither a sample access token nor refresh token appears in the stored ciphertext.
- `getSession()` accepts SDK in-memory session first.
- On restart, `getSession()` reads the encrypted JSON and calls `setSession({ refresh_token })`.
- A rotated refresh token overwrites the old encrypted value.
- Invalid/expired credentials delete the stored secret and return `null`.
- Infrastructure errors keep the stored secret and throw `INTERNAL_ERROR`.
- Successful or already-signed-out logout deletes the secret.
- Failed logout preserves the secret and current session.
- `requireSession()` rejects with `AUTH_REQUIRED` when no real session exists.

- [ ] **Step 8: Implement session persistence and verify GREEN**

Persist this internal shape:

```ts
interface StoredCloudBaseSession {
  accessToken: string
  refreshToken: string
  expiresAt: number
  authenticatedAt: string
}
```

On restore, validate stored JSON, call `setSession({ refresh_token: stored.refreshToken })`, validate the returned real session, then overwrite the stored value with rotated tokens. Delete malformed or provider-invalid credentials; retain the secret for network/internal failures.

Run:

```bash
pnpm --dir apps/desktop exec node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts electron/main/auth/cloudbase-auth-service.test.ts electron/main/profile/profile-service.test.ts
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add apps/desktop/electron/main/auth/auth-service.ts apps/desktop/electron/main/auth/cloudbase-auth-service.ts apps/desktop/electron/main/auth/cloudbase-auth-service.test.ts apps/desktop/electron/main/auth/local-auth-service.ts apps/desktop/electron/main/profile/profile-service.ts apps/desktop/electron/main/security/secret-store.test.ts
git commit -m "feat: implement CloudBase auth service"
```

---

### Task 4: Switch production assembly to CloudBase without networking in tests

**Files:**
- Modify: `apps/desktop/electron/main/application.ts`
- Modify: `apps/desktop/electron/main/application.test.ts`
- Modify: `apps/desktop/electron/main/index.ts`

**Interfaces:**
- Consumes: Task 3 `AuthService` and `CloudBaseAuthService`
- Produces: injectable `ApplicationRuntimeOptions.authService?`
- Keeps: production `DesktopIpcServices['auth']`

- [ ] **Step 1: Write a failing application assembly test**

Add a deterministic `createTestAuthService()` implementing the exact Task 3 interface. Add a test that passes it through runtime options and verifies the runtime exposes it unchanged:

```ts
it('uses the injected auth service and keeps business gates on its session', async () => {
  const root = await mkdtemp(join(tmpdir(), 'autoforge-application-auth-'))
  directories.push(root)
  const authService = createTestAuthService()
  const runtime = createApplicationRuntime(options(root, { authService }))

  await expect(runtime.services.auth.requireSession())
    .rejects.toMatchObject({ code: 'AUTH_REQUIRED' })
  const session = await authenticate(runtime, 'Alice')
  expect(session.user.account).toBe('Alice')
  expect(runtime.services.auth).toMatchObject({
    getSession: expect.any(Function),
    sendOtp: expect.any(Function),
    verifyOtp: expect.any(Function),
    cancelOtp: expect.any(Function),
    loginWithPassword: expect.any(Function),
    logout: expect.any(Function),
    requireSession: expect.any(Function),
  })
  await runtime.close()
})
```

- [ ] **Step 2: Run the application test and verify RED**

```bash
pnpm --dir apps/desktop exec node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts electron/main/application.test.ts
```

Expected: FAIL because `authService` is not an application option and old methods remain.

- [ ] **Step 3: Implement injectable assembly**

Add `authService?: AuthService` and `cloudbaseEnv?: NodeJS.ProcessEnv` to `ApplicationRuntimeOptions`. Construct `SecretStore` before auth, then:

```ts
const secretStore = new SecretStore(database.encryptedSecrets, options.safeStorage)
const auth = options.authService ?? new CloudBaseAuthService(
  createCloudBaseAuthPort(readCloudBaseAuthConfig(options.cloudbaseEnv ?? process.env)),
  secretStore,
)
```

Replace runtime auth forwarding with:

```ts
auth: {
  getSession: () => auth.getSession(),
  sendOtp: (input) => auth.sendOtp(input),
  verifyOtp: (input) => auth.verifyOtp(input),
  cancelOtp: (challengeId) => auth.cancelOtp(challengeId),
  loginWithPassword: (input) => auth.loginWithPassword(input),
  logout: () => auth.logout(),
  requireSession: () => auth.requireSession(),
},
```

Remove the production `LocalAuthService` import, but do not delete the class, repository, migration, or tests.

- [ ] **Step 4: Update application tests to use the fake service**

Make `options(root)` create a fresh fake auth service unless overridden. Change the helper to perform an OTP registration:

```ts
async function authenticate(
  runtime: ReturnType<typeof createApplicationRuntime>,
  account = 'TestUser',
) {
  const challenge = await runtime.services.auth.sendOtp({
    intent: 'register',
    channel: 'email',
    target: `${account.toLowerCase()}@example.com`,
    account,
    password: 'password',
  })
  return runtime.services.auth.verifyOtp({
    challengeId: challenge.challengeId,
    code: '123456',
  })
}
```

Mechanically replace the twelve direct `runtime.services.auth.register(...)` calls with `authenticate(runtime, account)`. Preserve each assertion and user identity distinction.

Create the default fake once inside each returned options object. Tests that deliberately reuse the same `runtimeOptions` object across restart must therefore reuse the same fake session state; separate calls to `options(root)` remain isolated.

- [ ] **Step 5: Wire production environment**

In `index.ts`, pass:

```ts
cloudbaseEnv: process.env,
```

Do not pass the publishable key through Renderer or Preload.

- [ ] **Step 6: Run application tests and typecheck**

```bash
pnpm --dir apps/desktop exec node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts electron/main/application.test.ts electron/main/profile/profile-service.test.ts
pnpm --filter @autoforge/desktop typecheck
```

Expected: PASS with no CloudBase network requests.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/electron/main/application.ts apps/desktop/electron/main/application.test.ts apps/desktop/electron/main/index.ts
git commit -m "feat: assemble CloudBase authentication"
```

---

### Task 5: Expose OTP operations through fixed IPC and Preload

**Files:**
- Modify: `apps/desktop/electron/main/ipc/register-ipc.ts`
- Modify: `apps/desktop/electron/main/ipc/register-ipc.test.ts`
- Modify: `apps/desktop/electron/preload/bridge.ts`
- Modify: `apps/desktop/electron/preload/bridge.test.ts`

**Interfaces:**
- Consumes: Task 1 channels and `DesktopAPI`
- Consumes: Task 4 runtime auth methods
- Produces: fixed Renderer bridge methods

- [ ] **Step 1: Write failing IPC tests**

Replace old login/register expectations with all six anonymous auth operations:

```ts
await expect(app.invoke(ipcChannels.authGetSession)).resolves.toBeNull()
await expect(app.invoke(ipcChannels.authSendOtp, {
  intent: 'login', channel: 'phone', target: '18311032722',
})).resolves.toEqual({ challengeId: 'challenge_1', expiresIn: 300 })
await expect(app.invoke(ipcChannels.authVerifyOtp, {
  challengeId: 'challenge_1', code: '123456',
})).resolves.toEqual(authSession)
await expect(app.invoke(ipcChannels.authCancelOtp, {
  challengeId: 'challenge_1',
})).resolves.toBeUndefined()
await expect(app.invoke(ipcChannels.authLoginWithPassword, {
  account: 'Alice_1', password: 'password',
})).resolves.toEqual(authSession)
await expect(app.invoke(ipcChannels.authLogout)).resolves.toBeUndefined()
expect(app.dependencies.auth.requireSession).not.toHaveBeenCalled()
```

Also assert malformed phone/email/code inputs are rejected before service invocation.

- [ ] **Step 2: Run IPC test and verify RED**

```bash
pnpm --dir apps/desktop exec node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts electron/main/ipc/register-ipc.test.ts
```

Expected: FAIL because new channel handlers are missing.

- [ ] **Step 3: Implement fixed IPC handlers**

```ts
register(ipcChannels.authGetSession, () => options.services.auth.getSession(), { anonymous: true })
register(ipcChannels.authSendOtp, (input) => options.services.auth.sendOtp(input), { anonymous: true })
register(ipcChannels.authVerifyOtp, (input) => options.services.auth.verifyOtp(input), { anonymous: true })
register(ipcChannels.authCancelOtp, (input) => options.services.auth.cancelOtp(input.challengeId), { anonymous: true })
register(ipcChannels.authLoginWithPassword, (input) => options.services.auth.loginWithPassword(input), { anonymous: true })
register(ipcChannels.authLogout, () => options.services.auth.logout(), { anonymous: true })
```

- [ ] **Step 4: Write failing Preload bridge tests**

Call each new method and assert exact channel/input forwarding:

```ts
await app.api.auth.sendOtp({ intent: 'login', channel: 'phone', target: '18311032722' })
await app.api.auth.verifyOtp({ challengeId: 'challenge_1', code: '123456' })
await app.api.auth.cancelOtp('challenge_1')
await app.api.auth.loginWithPassword({ account: 'Alice_1', password: 'password' })
```

- [ ] **Step 5: Implement Preload forwarding**

```ts
auth: {
  getSession: () => invoke(ipcRenderer, ipcChannels.authGetSession),
  sendOtp: (input) => invoke(ipcRenderer, ipcChannels.authSendOtp, input),
  verifyOtp: (input) => invoke(ipcRenderer, ipcChannels.authVerifyOtp, input),
  cancelOtp: (challengeId) => invoke(ipcRenderer, ipcChannels.authCancelOtp, { challengeId }),
  loginWithPassword: (input) => invoke(ipcRenderer, ipcChannels.authLoginWithPassword, input),
  logout: () => invoke(ipcRenderer, ipcChannels.authLogout),
},
```

- [ ] **Step 6: Run IPC and Preload tests and verify GREEN**

```bash
pnpm --dir apps/desktop exec node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts electron/main/ipc/register-ipc.test.ts electron/preload/bridge.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/electron/main/ipc/register-ipc.ts apps/desktop/electron/main/ipc/register-ipc.test.ts apps/desktop/electron/preload/bridge.ts apps/desktop/electron/preload/bridge.test.ts
git commit -m "feat: expose CloudBase auth IPC"
```

---

### Task 6: Update the Pinia authentication state machine

**Files:**
- Modify: `apps/desktop/src/stores/auth.ts`
- Modify: `apps/desktop/src/services/desktop-api.ts`
- Modify: `apps/desktop/tests/components/auth.test.ts`

**Interfaces:**
- Consumes: Task 1 `AuthOtpRequest`, `AuthOtpChallenge`, `AuthCredentials`
- Produces Store actions: `sendOtp`, `verifyOtp`, `cancelOtp`, `loginWithPassword`

- [ ] **Step 1: Write failing store tests**

Update `createApi()` with the new bridge methods. Add:

```ts
it('stores only the current OTP challenge and authenticates after verification', async () => {
  const api = createApi()
  vi.mocked(api.auth.sendOtp).mockResolvedValue({
    challengeId: 'challenge_1',
    expiresIn: 300,
  })
  Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
  const auth = useAuthStore()

  await expect(auth.sendOtp({
    intent: 'login', channel: 'phone', target: '18311032722',
  })).resolves.toEqual({ challengeId: 'challenge_1', expiresIn: 300 })
  expect(auth.challenge).toEqual({ challengeId: 'challenge_1', expiresIn: 300 })
  expect(auth.session).toBeNull()

  vi.mocked(api.auth.verifyOtp).mockResolvedValue(authSession)
  await expect(auth.verifyOtp('123456')).resolves.toEqual(authSession)
  expect(auth.challenge).toBeNull()
  expect(auth.session).toEqual(authSession)
})

it('clears a challenge locally before cancelling it in Main', async () => {
  const api = createApi()
  Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
  const auth = useAuthStore()
  auth.challenge = { challengeId: 'challenge_1', expiresIn: 300 }

  const cancelling = auth.cancelOtp()
  expect(auth.challenge).toBeNull()
  await cancelling
  expect(api.auth.cancelOtp).toHaveBeenCalledWith('challenge_1')
})
```

- [ ] **Step 2: Run component auth test and verify RED**

```bash
pnpm --dir apps/desktop exec node scripts/run-vitest-electron.mjs run --config vitest.config.ts tests/components/auth.test.ts
```

Expected: FAIL because the Store still exposes local `login/register`.

- [ ] **Step 3: Implement the Store state machine**

State:

```ts
challenge: null as AuthOtpChallenge | null,
sendingOtp: false,
```

Actions:

- `sendOtp(request)`: synchronously clear/cancel an existing challenge, set `sendingOtp`, call bridge, store only the returned challenge, and map errors with “验证码发送失败”.
- `verifyOtp(code)`: reject locally when no challenge, set `submitting`, call bridge with current ID, clear challenge regardless of result, and store session only on success.
- `cancelOtp()`: set `challenge = null` before awaiting bridge cancellation; cancellation failure must not resurrect it.
- `loginWithPassword(credentials)`: replace old `login`.
- Remove old `register`.
- `logout()`: cancel the challenge before CloudBase logout; retain current session if remote logout fails.

Use exact imported types; do not store target, password, OTP code, or full registration request in Pinia state.

- [ ] **Step 4: Add Renderer messages for new safe errors**

Add:

```ts
AUTH_INVALID_OTP: '验证码错误，请重新发送后再试',
AUTH_OTP_EXPIRED: '验证码已失效，请重新发送',
AUTH_OTP_RATE_LIMITED: '验证码发送过于频繁，请稍后再试',
AUTH_ACCOUNT_NOT_FOUND: '该手机号或邮箱尚未注册',
```

- [ ] **Step 5: Run store tests and verify GREEN**

Run the Step 2 command.

Expected: Store tests PASS; page tests may still fail until Tasks 7–8.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/stores/auth.ts apps/desktop/src/services/desktop-api.ts apps/desktop/tests/components/auth.test.ts
git commit -m "feat: add OTP auth store state"
```

---

### Task 7: Implement the prioritized login page

**Files:**
- Modify: `apps/desktop/src/views/LoginView.vue`
- Modify: `apps/desktop/tests/components/auth.test.ts`

**Interfaces:**
- Consumes: Task 6 Store actions
- Produces: phone OTP, email OTP, and password login UI

- [ ] **Step 1: Write failing page tests for method order and default**

```ts
it('prioritizes phone OTP, then email OTP, then username password login', async () => {
  const { wrapper } = await mountAuthApp('/login')
  const methods = wrapper.findAll('[data-testid^="login-method-"]')
  expect(methods.map((item) => item.text())).toEqual(['手机号', '邮箱', '用户名密码'])
  expect(wrapper.get('[data-testid="login-method-phone"]').attributes('aria-pressed')).toBe('true')
  expect(wrapper.find('[data-testid="login-phone"]').exists()).toBe(true)
  expect(wrapper.find('[data-testid="login-email"]').exists()).toBe(false)
  expect(wrapper.find('[data-testid="login-account"]').exists()).toBe(false)
})
```

- [ ] **Step 2: Write failing OTP login interaction tests**

For phone and email, assert:

- Invalid target never calls `sendOtp`.
- Valid target calls `sendOtp({ intent: 'login', channel, target })`.
- Send button enters a 60-second disabled countdown.
- Six-digit submit calls `verifyOtp` and returns to the safe redirect.
- Switching method invokes `cancelOtp`, clears code/error/countdown, and renders the next field.
- Duplicate send/submit clicks are suppressed.
- Password tab still trims username, preserves password, calls `loginWithPassword`, and uses `safeRedirect`.

- [ ] **Step 3: Run login page tests and verify RED**

Run:

```bash
pnpm --dir apps/desktop exec node scripts/run-vitest-electron.mjs run --config vitest.config.ts tests/components/auth.test.ts
```

Expected: FAIL because the segmented methods and OTP fields do not exist.

- [ ] **Step 4: Implement method switching and validation**

Use:

```ts
type LoginMethod = 'phone' | 'email' | 'password'
const method = ref<LoginMethod>('phone')
const target = ref('')
const code = ref('')
const account = ref('')
const password = ref('')
const countdown = ref(0)
```

Render an Element Plus segmented/radio control or three accessible buttons with test IDs:

```text
login-method-phone
login-method-email
login-method-password
```

On method change:

```ts
async function selectMethod(next: LoginMethod) {
  if (next === method.value) return
  await auth.cancelOtp()
  stopCountdown()
  code.value = ''
  validationError.value = ''
  auth.error = ''
  method.value = next
}
```

Watch the active phone/email target. If it changes after a challenge was issued, clear the code/countdown immediately and call `auth.cancelOtp()` so a code can never be submitted for a stale destination.

Use `authPhoneSchema`, `authEmailSchema`, `authOtpCodeSchema`, and `authCredentialsSchema` for form validation.

- [ ] **Step 5: Implement sending, countdown, and submitting**

```ts
async function sendCode() {
  if (auth.sendingOtp || auth.submitting || countdown.value > 0) return
  const schema = method.value === 'phone' ? authPhoneSchema : authEmailSchema
  const parsed = schema.safeParse(target.value)
  if (!parsed.success) {
    validationError.value = method.value === 'phone' ? '请输入有效的手机号' : '请输入有效的邮箱地址'
    return
  }
  const challenge = await auth.sendOtp({
    intent: 'login',
    channel: method.value,
    target: parsed.data,
  })
  if (challenge) startCountdown(60)
}

async function submit() {
  if (auth.submitting) return
  if (method.value === 'password') {
    const parsed = authCredentialsSchema.safeParse({ account: account.value, password: password.value })
    if (!parsed.success) {
      validationError.value = parsed.error.issues.some(({ path }) => path[0] === 'account')
        ? '账号需为 5–24 位字母、数字或下划线'
        : '密码长度须为 8–72 个字符'
      return
    }
    if (await auth.loginWithPassword(parsed.data)) {
      await router.replace(safeRedirect(route.query.redirect))
    }
    return
  }
  const parsedCode = authOtpCodeSchema.safeParse(code.value)
  if (!auth.challenge) {
    validationError.value = '请先发送验证码'
    return
  }
  if (!parsedCode.success) {
    validationError.value = '请输入 6 位验证码'
    return
  }
  if (await auth.verifyOtp(parsedCode.data)) {
    await router.replace(safeRedirect(route.query.redirect))
  }
}
```

Use `onBeforeUnmount` to clear the timer and fire-and-forget `auth.cancelOtp()`.

- [ ] **Step 6: Preserve visual tokens and update copy**

- Heading: “登录 AutoForge”
- Description: “使用 AutoForge 云端账号继续。”
- Switch copy: “还没有云端账号？去注册”
- Keep existing Logo, card, CSS tokens, button width, error role, and responsive behavior.
- Add only segmented control and OTP row styles; no new colors/fonts/gradients.

- [ ] **Step 7: Run login page tests and verify GREEN**

Run the Step 3 command.

Expected: Login and existing guard/logo/logout tests PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/desktop/src/views/LoginView.vue apps/desktop/tests/components/auth.test.ts
git commit -m "feat: add prioritized CloudBase login methods"
```

---

### Task 8: Implement phone/email OTP registration

**Files:**
- Modify: `apps/desktop/src/views/RegisterView.vue`
- Modify: `apps/desktop/tests/components/auth.test.ts`

**Interfaces:**
- Consumes: Task 6 Store actions
- Produces: phone/email registration UI with username and password

- [ ] **Step 1: Write failing registration page tests**

Assert:

```ts
it('prioritizes phone registration before email registration', async () => {
  const { wrapper } = await mountAuthApp('/register')
  const methods = wrapper.findAll('[data-testid^="register-method-"]')
  expect(methods.map((item) => item.text())).toEqual(['手机号', '邮箱'])
  expect(wrapper.get('[data-testid="register-method-phone"]').attributes('aria-pressed')).toBe('true')
})
```

Add interaction coverage:

- Registration fields are target, username, password, confirmation, code.
- Mismatched confirmation prevents OTP send.
- Invalid target/account/password prevents OTP send.
- Phone send request includes `intent: 'register'`, normalized phone, account, and password.
- Email target is lowercased.
- Password never appears in rendered text, Store state, or test snapshots.
- Field edits after sending call `cancelOtp`, clear the code, and require resend.
- OTP verification navigates to `/chat`.
- Switching methods cancels the challenge, clears target/code/countdown, preserves username/password, and requires an explicit resend.

- [ ] **Step 2: Run registration tests and verify RED**

```bash
pnpm --dir apps/desktop exec node scripts/run-vitest-electron.mjs run --config vitest.config.ts tests/components/auth.test.ts
```

Expected: FAIL because the old page performs immediate local registration.

- [ ] **Step 3: Implement registration method switching and fields**

Use:

```ts
type RegisterMethod = 'phone' | 'email'
const method = ref<RegisterMethod>('phone')
const target = ref('')
const account = ref('')
const password = ref('')
const confirmation = ref('')
const code = ref('')
const countdown = ref(0)
```

The default is `phone`; render method buttons in phone/email order. Use username autocomplete `username`, password autocomplete `new-password`, phone autocomplete `tel`, email autocomplete `email`, and code autocomplete `one-time-code`.

- [ ] **Step 4: Implement registration OTP send and verify**

```ts
async function sendCode() {
  if (auth.sendingOtp || auth.submitting || countdown.value > 0) return
  if (password.value !== confirmation.value) {
    validationError.value = '两次输入的密码不一致'
    return
  }
  const credentials = authCredentialsSchema.safeParse({
    account: account.value,
    password: password.value,
  })
  const targetResult = (method.value === 'phone' ? authPhoneSchema : authEmailSchema)
    .safeParse(target.value)
  if (!credentials.success) {
    validationError.value = credentials.error.issues.some(({ path }) => path[0] === 'account')
      ? '用户名需为 5–24 位字母、数字或下划线'
      : '密码长度须为 8–72 个字符'
    return
  }
  if (!targetResult.success) {
    validationError.value = method.value === 'phone' ? '请输入有效的手机号' : '请输入有效的邮箱地址'
    return
  }
  const challenge = await auth.sendOtp({
    intent: 'register',
    channel: method.value,
    target: targetResult.data,
    ...credentials.data,
  })
  if (challenge) startCountdown(60)
}

async function submit() {
  if (!auth.challenge) {
    validationError.value = '请先发送验证码'
    return
  }
  const parsed = authOtpCodeSchema.safeParse(code.value)
  if (!parsed.success) {
    validationError.value = '请输入 6 位验证码'
    return
  }
  if (await auth.verifyOtp(parsed.data)) await router.replace('/chat')
}
```

Watch `target`, `account`, and `password`; if a challenge exists, synchronously clear the local challenge, reset countdown/code, and invoke `cancelOtp`. Do not send confirmation to Main.

- [ ] **Step 5: Update copy and preserve the existing visual system**

- Heading: “注册云端账号”
- Description: “通过手机号或邮箱验证，注册成功后将自动登录。”
- Switch copy: “已有云端账号？返回登录”
- Keep existing Logo, card, CSS variables, form spacing, error role, and primary button.
- Add no new design dependency.

- [ ] **Step 6: Run registration tests and verify GREEN**

Run the Step 2 command.

Expected: all authentication component tests PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/views/RegisterView.vue apps/desktop/tests/components/auth.test.ts
git commit -m "feat: add CloudBase OTP registration"
```

---

### Task 9: Full verification, CloudBase review, and manual flow

**Files:**
- Modify only files implicated by verification failures
- Update: `docs/superpowers/plans/2026-08-19-cloudbase-otp-auth-implementation.md` checkboxes

**Interfaces:**
- Verifies all previous task outputs together
- No new feature surface

- [ ] **Step 1: Run focused authentication tests**

```bash
pnpm exec vitest run packages/shared/src/contracts.test.ts
pnpm --dir apps/desktop exec node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts electron/main/auth/cloudbase-auth-port.test.ts electron/main/auth/cloudbase-auth-service.test.ts electron/main/ipc/register-ipc.test.ts electron/preload/bridge.test.ts electron/main/application.test.ts
pnpm --dir apps/desktop exec node scripts/run-vitest-electron.mjs run --config vitest.config.ts tests/components/auth.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run repository verification**

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

Expected: all commands exit 0. If an unrelated pre-existing failure appears, record it separately and do not change unrelated code.

- [ ] **Step 3: Run CloudBase code review**

Read and follow `cloudbase-code-review/SKILL.md`. Check specifically:

- No deprecated `getLoginState()` or `getUser()` session guard.
- OTP login always uses `shouldCreateUser: false`.
- Every successful auth path requires `data.session`.
- No token, password, OTP, publishable key, or SMTP authorization code is logged or rendered.
- Provider readiness remains phone/email/username enabled and email custom SMTP enabled.

- [ ] **Step 4: Start the desktop app and inspect the UI**

Set `AUTOFORGE_CLOUDBASE_PUBLISHABLE_KEY` in the ignored local `.env`, then run:

```bash
pnpm --filter @autoforge/desktop dev
```

Inspect:

- Login default and order: phone, email, username/password.
- Registration default and order: phone, email.
- Field labels, autocomplete attributes, errors, countdown, disabled states, and method switching.
- Router redirect and logout behavior.

- [ ] **Step 5: Perform authorized CloudBase smoke tests**

Use only user-authorized test destinations. Verify:

1. Phone OTP send from login/registration UI.
2. Email OTP send through 126 SMTP from login/registration UI.
3. With user-supplied OTP, complete one registration using a disposable test username/password.
4. Confirm the new UID appears in the CloudBase identity user list.
5. Logout, log in by username/password, restart the app, and confirm encrypted session restoration.

Do not store the OTP or test password in source, shell history, screenshots, logs, or the plan.

- [ ] **Step 6: Inspect the final diff**

```bash
git status --short
git diff --check
git diff --stat
```

Expected: only task-related files are changed; no whitespace errors.
