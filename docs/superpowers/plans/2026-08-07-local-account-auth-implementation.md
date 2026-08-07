# Local Account Authentication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 AutoForge 桌面 APP 增加基于本机 SQLite 的账号密码注册、登录、持久会话、路由门禁和 Main IPC 门禁。

**Architecture:** Renderer 只通过 `DesktopAPI.auth` 管理认证状态；Electron Main 中的 `LocalAuthService` 通过专用 SQLite 仓储和版本化 scrypt 摘要完成认证。Vue Router 提供导航体验，Main IPC 的 `requireSession()` 是业务调用的权威门禁；现有业务数据继续设备级共享。

**Tech Stack:** TypeScript 6、Vue 3、Pinia 4、Vue Router 5、Element Plus、Electron 43、better-sqlite3、Drizzle schema、Zod 4、Vitest 4、Node `crypto.scrypt`

## Global Constraints

- 本阶段仅实现账号密码注册与登录，不实现远程后端、验证码、微信、找回密码、改密或账号删除。
- 同一设备允许多个账号；账号仅是访问门禁，现有聊天、工作流、执行、权限、凭证和设置不按账号隔离。
- 账号去除首尾空格后必须匹配 `^[A-Za-z0-9_]{3,32}$`，唯一性按 ASCII 小写值判断。
- 密码保持原样，长度为 8–72 个 Unicode code point，不做 trim 或 Unicode 规范化。
- 密码摘要固定使用异步 scrypt：`N=32768`、`r=8`、`p=3`、`keylen=32`、`maxmem=64 MiB`、16 字节随机盐。
- 注册成功自动登录；会话跨 APP 重启保持；退出幂等且不取消已运行任务。
- 只有四个认证 IPC 可匿名调用；所有现有业务 IPC 必须要求有效会话。
- 不增加第三方依赖，不重构无关模块，不修改或提交用户已有的 `CHAT.md` 变更。
- 每个生产代码步骤前必须先运行对应失败测试，确认失败原因是缺失行为而非测试错误。

---

## File Structure

### New files

- `apps/desktop/resources/migrations/0004_local_auth.sql`：认证表迁移。
- `apps/desktop/electron/main/database/local-auth-repository.ts`：本地用户与单例会话的事务仓储。
- `apps/desktop/electron/main/auth/password-hasher.ts`：版本化 scrypt 摘要生成与验证。
- `apps/desktop/electron/main/auth/password-hasher.test.ts`：真实 scrypt 参数和摘要测试。
- `apps/desktop/electron/main/auth/local-auth-service.ts`：认证领域规则与稳定服务接口。
- `apps/desktop/electron/main/auth/local-auth-service.test.ts`：认证服务行为测试。
- `apps/desktop/src/stores/auth.ts`：Renderer 认证状态和动作。
- `apps/desktop/src/layouts/AuthLayout.vue`：认证页面公共外壳。
- `apps/desktop/src/views/LoginView.vue`：登录表单。
- `apps/desktop/src/views/RegisterView.vue`：注册表单。
- `apps/desktop/tests/components/auth.test.ts`：Store、Router、表单与退出交互测试。

### Modified files

- `packages/shared/src/errors.ts`：认证错误码与安全消息。
- `packages/shared/src/desktop-api.ts`：认证 Schema、类型、Channel 和 `DesktopAPI.auth`。
- `packages/shared/src/contracts.test.ts`：共享契约测试。
- `apps/desktop/electron/main/database/schema.ts`：Drizzle 认证表声明。
- `apps/desktop/electron/main/database/client.ts`：装配认证仓储。
- `apps/desktop/electron/main/database/database.test.ts`：schema v4 与无损升级测试。
- `apps/desktop/electron/main/application.ts`：装配认证服务并过滤匿名业务事件。
- `apps/desktop/electron/main/application.test.ts`：运行时认证与事件门禁测试。
- `apps/desktop/electron/main/ipc/register-ipc.ts`：注册认证 IPC 并保护业务 IPC。
- `apps/desktop/electron/main/ipc/register-ipc.test.ts`：IPC 调用顺序和门禁测试。
- `apps/desktop/electron/preload/bridge.ts`：固定认证 Bridge 方法。
- `apps/desktop/electron/preload/bridge.test.ts`：Bridge 映射测试。
- `apps/desktop/src/services/desktop-api.ts`：Bridge 完整性和认证错误文案。
- `apps/desktop/src/router/index.ts`：认证路由、工作台父路由和 Guard。
- `apps/desktop/src/App.vue`：顶层只渲染当前路由布局。
- `apps/desktop/src/main.ts`：挂载前恢复会话并安装 Guard。
- `apps/desktop/src/components/AppRail.vue`：当前账号和退出入口。
- `apps/desktop/tests/components/workbench.test.ts`、`chat.test.ts`、`developer.test.ts`：现有 DesktopAPI 测试夹具补齐 `auth`。

---

### Task 1: Shared authentication contract

**Files:**
- Modify: `packages/shared/src/errors.ts`
- Modify: `packages/shared/src/desktop-api.ts`
- Modify: `packages/shared/src/contracts.test.ts`

**Interfaces:**
- Produces: `AuthCredentials`, `AuthUser`, `AuthSession`, `authCredentialsSchema`, `authSessionSchema`
- Produces: `DesktopAPI['auth']` with `getSession`, `login`, `register`, `logout`
- Produces: `AUTH_REQUIRED`, `AUTH_INVALID_CREDENTIALS`, `AUTH_ACCOUNT_EXISTS`

- [ ] **Step 1: Write failing shared-contract tests**

Add focused cases to `contracts.test.ts`:

```ts
it('validates local authentication credentials by normalized account and code-point password length', () => {
  expect(authCredentialsSchema.parse({ account: '  Alice_1  ', password: '密码密码密码密码' }))
    .toEqual({ account: 'Alice_1', password: '密码密码密码密码' })
  expect(() => authCredentialsSchema.parse({ account: 'a b', password: 'password' })).toThrow()
  expect(() => authCredentialsSchema.parse({ account: 'alice', password: 'short' })).toThrow()
  expect(() => authCredentialsSchema.parse({ account: 'alice', password: 'x'.repeat(73) })).toThrow()
})

it('exposes fixed authentication IPC contracts', () => {
  expect(ipcChannels.authGetSession).toBe('auth:get-session')
  expect(ipcRequestSchemas[ipcChannels.authLogin].parse({ account: 'alice', password: 'password' }))
    .toEqual({ account: 'alice', password: 'password' })
  expect(ipcResponseSchemas[ipcChannels.authGetSession].parse(null)).toBeNull()
  expect(ipcResponseSchemas[ipcChannels.authRegister].parse({
    user: { id: 'user_1', account: 'Alice' },
    authenticatedAt: '2026-08-07T00:00:00.000Z',
  })).toMatchObject({ user: { account: 'Alice' } })
})

it.each(['AUTH_REQUIRED', 'AUTH_INVALID_CREDENTIALS', 'AUTH_ACCOUNT_EXISTS'] as const)(
  'keeps %s as a safe application error',
  (code) => expect(toSafeAppError({ code })).toMatchObject({ code }),
)
```

- [ ] **Step 2: Run the contract test and verify RED**

Run:

```bash
pnpm exec vitest run packages/shared/src/contracts.test.ts
```

Expected: FAIL because the authentication schemas, channels, API and error codes do not exist.

- [ ] **Step 3: Add the minimal shared contract**

Add these schemas and inferred types near the other API-domain schemas in `desktop-api.ts`:

```ts
export const authAccountSchema = z.string().trim().regex(/^[A-Za-z0-9_]{3,32}$/)
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

export const authUserSchema = z.object({
  id: identifierSchema,
  account: authAccountSchema,
}).strict()
export type AuthUser = z.infer<typeof authUserSchema>

export const authSessionSchema = z.object({
  user: authUserSchema,
  authenticatedAt: timestampSchema,
}).strict()
export type AuthSession = z.infer<typeof authSessionSchema>
```

Add the four channels to `ipcChannels`, map their request/response schemas, and add this API group:

```ts
auth: {
  getSession(): Promise<AuthSession | null>
  login(input: AuthCredentials): Promise<AuthSession>
  register(input: AuthCredentials): Promise<AuthSession>
  logout(): Promise<void>
}
```

Add the three error codes and safe English messages to `errors.ts`:

```ts
AUTH_REQUIRED: 'Authentication is required.',
AUTH_INVALID_CREDENTIALS: 'The account or password is incorrect.',
AUTH_ACCOUNT_EXISTS: 'The account already exists.',
```

- [ ] **Step 4: Run the contract test and verify GREEN**

Run:

```bash
pnpm exec vitest run packages/shared/src/contracts.test.ts
```

Expected: PASS with all existing shared contracts unchanged.

- [ ] **Step 5: Commit the contract**

```bash
git add packages/shared/src/errors.ts packages/shared/src/desktop-api.ts packages/shared/src/contracts.test.ts
git commit -m "feat: define local authentication contract"
```

---

### Task 2: SQLite authentication migration and repository

**Files:**
- Create: `apps/desktop/resources/migrations/0004_local_auth.sql`
- Create: `apps/desktop/electron/main/database/local-auth-repository.ts`
- Modify: `apps/desktop/electron/main/database/schema.ts`
- Modify: `apps/desktop/electron/main/database/client.ts`
- Modify: `apps/desktop/electron/main/database/database.test.ts`

**Interfaces:**
- Produces: `LocalUserRecord`, `LocalAuthSessionRecord`, `LocalAuthRepository`
- Produces: `openAppDatabase(path).localAuth`
- Preserves: every pre-v4 business table and row

- [ ] **Step 1: Write failing migration and repository tests**

Add tests that assert schema version 4, v3 data preservation, normalized uniqueness and the singleton session:

```ts
it('stores local users and one persistent authentication session', () => {
  const database = openTestDatabase()
  const user = {
    id: 'user_1', account: 'Alice', accountNormalized: 'alice',
    passwordDigest: 'digest', createdAt: 10, updatedAt: 10,
  }

  expect(database.localAuth.createUserAndSession(user, 11)).toMatchObject({
    user: { id: 'user_1', account: 'Alice' }, authenticatedAt: 11,
  })
  expect(database.localAuth.findUserByNormalizedAccount('alice')).toEqual(user)
  expect(database.localAuth.getCurrentSession()).toMatchObject({ user: { id: 'user_1' } })
  database.localAuth.clearSession()
  database.localAuth.clearSession()
  expect(database.localAuth.getCurrentSession()).toBeUndefined()
})

it('rejects a case-insensitive duplicate without replacing the current session', () => {
  const database = openTestDatabase()
  database.localAuth.createUserAndSession({
    id: 'user_1', account: 'Alice', accountNormalized: 'alice',
    passwordDigest: 'digest-1', createdAt: 10, updatedAt: 10,
  }, 11)
  expect(database.localAuth.createUserAndSession({
    id: 'user_2', account: 'ALICE', accountNormalized: 'alice',
    passwordDigest: 'digest-2', createdAt: 12, updatedAt: 12,
  }, 13)).toBeUndefined()
  expect(database.localAuth.getCurrentSession()?.user.id).toBe('user_1')
})
```

Create a populated v3 fixture with this helper, then assert version 4 plus preserved rows after `openAppDatabase(path)`:

```ts
function createV3Database() {
  const directory = mkdtempSync(join(tmpdir(), 'autoforge-database-v3-'))
  temporaryDirectories.push(directory)
  const path = join(directory, 'autoforge.sqlite')
  const sqlite = new Database(path)
  for (const [index, fileName] of [
    '0001_init.sql',
    '0002_multimodal_media.sql',
    '0003_conversation_context.sql',
  ].entries()) {
    sqlite.exec(readFileSync(fileURLToPath(new URL(`../../../resources/migrations/${fileName}`, import.meta.url)), 'utf8'))
    sqlite.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
      .run(index + 1, index + 1)
  }
  sqlite.prepare('INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run('conversation_v3', 'Persisted v3', 1, 1)
  sqlite.prepare('INSERT INTO messages (id, conversation_id, role, blocks_json, ordinal, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run('message_v3', 'conversation_v3', 'user', JSON.stringify([{ type: 'text', text: 'before auth' }]), 1, 1)
  sqlite.close()
  return openAppDatabase(path)
}
```

- [ ] **Step 2: Run the database test and verify RED**

Run:

```bash
pnpm --filter @autoforge/desktop exec node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts electron/main/database/database.test.ts
```

Expected: FAIL because migration 0004 and `database.localAuth` do not exist and existing version expectations still equal 3.

- [ ] **Step 3: Add the migration and Drizzle schema**

Use this complete migration:

```sql
CREATE TABLE local_users (
  id TEXT PRIMARY KEY,
  account TEXT NOT NULL,
  account_normalized TEXT NOT NULL UNIQUE,
  password_digest TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE local_auth_session (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  user_id TEXT NOT NULL REFERENCES local_users(id) ON DELETE CASCADE,
  authenticated_at INTEGER NOT NULL
);
```

Mirror both tables in `schema.ts`:

```ts
export const localUsers = sqliteTable('local_users', {
  id: text('id').primaryKey(),
  account: text('account').notNull(),
  accountNormalized: text('account_normalized').notNull(),
  passwordDigest: text('password_digest').notNull(),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
}, (table) => [uniqueIndex('local_users_account_normalized_unique').on(table.accountNormalized)])

export const localAuthSession = sqliteTable('local_auth_session', {
  id: integer('id').primaryKey(),
  userId: text('user_id').notNull().references(() => localUsers.id, { onDelete: 'cascade' }),
  authenticatedAt: integer('authenticated_at').notNull(),
})
```

- [ ] **Step 4: Implement the focused repository**

Define these exact records and methods in `local-auth-repository.ts`:

```ts
export interface LocalUserRecord {
  id: string
  account: string
  accountNormalized: string
  passwordDigest: string
  createdAt: number
  updatedAt: number
}

export interface LocalAuthSessionRecord {
  user: Pick<LocalUserRecord, 'id' | 'account'>
  authenticatedAt: number
}

export interface LocalAuthRepository {
  findUserByNormalizedAccount(accountNormalized: string): LocalUserRecord | undefined
  createUserAndSession(user: LocalUserRecord, authenticatedAt: number): LocalAuthSessionRecord | undefined
  replaceSession(userId: string, authenticatedAt: number): LocalAuthSessionRecord
  getCurrentSession(): LocalAuthSessionRecord | undefined
  clearSession(): void
}
```

Implement `createUserAndSession` as one better-sqlite3 transaction. Use `INSERT OR IGNORE`; when no row is inserted, verify that the normalized account exists and return `undefined` without changing `local_auth_session`. Implement `replaceSession` with singleton ID 1 and `ON CONFLICT(id) DO UPDATE`. Implement `getCurrentSession` with a join to `local_users`; if a raw session row exists without a joined user, delete it and return `undefined`.

Use these SQL operations inside the repository; keep them private to this file:

```ts
const readSession = () => database.prepare(`
  SELECT u.id AS userId, u.account, s.authenticated_at AS authenticatedAt
  FROM local_auth_session s
  JOIN local_users u ON u.id = s.user_id
  WHERE s.id = 1
`).get() as { userId: string; account: string; authenticatedAt: number } | undefined

const writeSession = (userId: string, authenticatedAt: number) => {
  database.prepare(`
    INSERT INTO local_auth_session (id, user_id, authenticated_at)
    VALUES (1, @userId, @authenticatedAt)
    ON CONFLICT(id) DO UPDATE SET
      user_id = excluded.user_id,
      authenticated_at = excluded.authenticated_at
  `).run({ userId, authenticatedAt })
  const row = readSession()
  if (!row) throw new Error('Local authentication session was not persisted')
  return { user: { id: row.userId, account: row.account }, authenticatedAt: row.authenticatedAt }
}
```

Create the registration transaction with this body and expose it from the returned repository; `clearSession` executes `DELETE FROM local_auth_session WHERE id = 1`:

```ts
const createUserAndSession = database.transaction((user: LocalUserRecord, authenticatedAt: number) => {
  const inserted = database.prepare(`
    INSERT OR IGNORE INTO local_users
      (id, account, account_normalized, password_digest, created_at, updated_at)
    VALUES
      (@id, @account, @accountNormalized, @passwordDigest, @createdAt, @updatedAt)
  `).run(user)
  if (inserted.changes !== 1) {
    const existing = database.prepare(
      'SELECT 1 FROM local_users WHERE account_normalized = ?',
    ).get(user.accountNormalized)
    if (existing) return undefined
    throw new Error('Local user was not persisted')
  }
  return writeSession(user.id, authenticatedAt)
})
```

Expose it from `client.ts`:

```ts
const localAuth = createLocalAuthRepository(sqlite)

return {
  db,
  localAuth,
  close: () => sqlite.close(),
}
```

Retain every existing returned repository and helper after these members.

- [ ] **Step 5: Run the database test and verify GREEN**

Run:

```bash
pnpm --filter @autoforge/desktop exec node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts electron/main/database/database.test.ts
```

Expected: PASS; fresh and upgraded databases report schema version 4 and retain existing records.

- [ ] **Step 6: Commit the persistence slice**

```bash
git add apps/desktop/resources/migrations/0004_local_auth.sql apps/desktop/electron/main/database/local-auth-repository.ts apps/desktop/electron/main/database/schema.ts apps/desktop/electron/main/database/client.ts apps/desktop/electron/main/database/database.test.ts
git commit -m "feat: persist local accounts and sessions"
```

---

### Task 3: Versioned scrypt password hashing and local auth service

**Files:**
- Create: `apps/desktop/electron/main/auth/password-hasher.ts`
- Create: `apps/desktop/electron/main/auth/password-hasher.test.ts`
- Create: `apps/desktop/electron/main/auth/local-auth-service.ts`
- Create: `apps/desktop/electron/main/auth/local-auth-service.test.ts`

**Interfaces:**
- Consumes: `LocalAuthRepository`, `AuthCredentials`, `AuthSession`
- Produces: `PasswordHasher`, `ScryptPasswordHasher`
- Produces: `AuthService`, `LocalAuthService`
- Produces: `LocalAuthService.isAuthenticated()` for synchronous event filtering

- [ ] **Step 1: Write failing password-hasher tests**

Cover envelope format, correct verification, incorrect verification, missing-user work, and malformed persisted digests:

```ts
it('hashes with the fixed versioned scrypt envelope and verifies without plaintext storage', async () => {
  const hasher = new ScryptPasswordHasher()
  const digest = await hasher.hash('correct horse battery staple')
  expect(digest).toMatch(/^scrypt\$v=1\$N=32768,r=8,p=3\$/)
  expect(digest).not.toContain('correct horse battery staple')
  await expect(hasher.verify('correct horse battery staple', digest)).resolves.toBe(true)
  await expect(hasher.verify('incorrect password', digest)).resolves.toBe(false)
})

it('performs a dummy derivation for a missing account and returns false', async () => {
  const hasher = new ScryptPasswordHasher()
  await expect(hasher.verify('unregistered password', undefined)).resolves.toBe(false)
})
```

- [ ] **Step 2: Run the hasher test and verify RED**

Run:

```bash
pnpm --filter @autoforge/desktop exec node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts electron/main/auth/password-hasher.test.ts
```

Expected: FAIL because the hasher module does not exist.

- [ ] **Step 3: Implement `ScryptPasswordHasher`**

Use async `scrypt`, `randomBytes(16)`, `timingSafeEqual`, and these constants:

```ts
const SCRYPT_N = 32_768
const SCRYPT_R = 8
const SCRYPT_P = 3
const KEY_LENGTH = 32
const MAX_MEMORY = 64 * 1024 * 1024
const PREFIX = 'scrypt$v=1$N=32768,r=8,p=3'

export interface PasswordHasher {
  hash(password: string): Promise<string>
  verify(password: string, digest: string | undefined): Promise<boolean>
}
```

Wrap `node:crypto.scrypt` in a Promise and serialize `PREFIX`, salt and derived key with `$` separators. Parse only the exact five-part envelope; malformed stored data throws instead of becoming an invalid-credential result. Use this fixed valid dummy envelope when `digest` is `undefined`, perform the same derivation and comparison, then return `false` regardless of the comparison result:

```ts
const DUMMY_DIGEST = 'scrypt$v=1$N=32768,r=8,p=3$QXV0b0ZvcmdlRHVtbXkwMQ==$KNgMTZnBehAtPZG00687u03IWPUrCJhqLAtJqtFH2zg='
```

- [ ] **Step 4: Run the hasher test and verify GREEN**

Run the command from Step 2. Expected: PASS.

- [ ] **Step 5: Write failing auth-service tests**

Use an in-memory fake `LocalAuthRepository` and deterministic dependencies. Cover:

```ts
const service = new LocalAuthService(repository, {
  hasher,
  createId: () => 'user_1',
  now: () => 1_786_060_800_000,
})

await expect(service.register({ account: ' Alice ', password: 'password' })).resolves.toEqual({
  user: { id: 'user_1', account: 'Alice' },
  authenticatedAt: '2026-08-07T00:00:00.000Z',
})
await expect(service.login({ account: 'ALICE', password: 'password' })).resolves.toMatchObject({
  user: { account: 'Alice' },
})
```

Add separate cases for invalid input, duplicate account preserving the previous session, incorrect password, missing account using `hasher.verify(password, undefined)`, restart restoration, stale-session cleanup delegated to the repository, `requireSession`, and double logout.

- [ ] **Step 6: Run the auth-service test and verify RED**

Run:

```bash
pnpm --filter @autoforge/desktop exec node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts electron/main/auth/local-auth-service.test.ts
```

Expected: FAIL because `LocalAuthService` does not exist.

- [ ] **Step 7: Implement `LocalAuthService` minimally**

Define the port and injected defaults:

```ts
export interface AuthService {
  getSession(): Promise<AuthSession | null>
  login(input: AuthCredentials): Promise<AuthSession>
  register(input: AuthCredentials): Promise<AuthSession>
  logout(): Promise<void>
  requireSession(): Promise<AuthSession>
}

export class LocalAuthService implements AuthService {
  constructor(
    private readonly repository: LocalAuthRepository,
    private readonly dependencies: {
      hasher: PasswordHasher
      createId(): string
      now(): number
    } = {
      hasher: new ScryptPasswordHasher(),
      createId: randomUUID,
      now: Date.now,
    },
  ) {}
}
```

Parse both login and registration with `authCredentialsSchema`; normalize the parsed account using `toLowerCase()`. Map duplicate creation to `AUTH_ACCOUNT_EXISTS`, login mismatch to `AUTH_INVALID_CREDENTIALS`, missing required session to `AUTH_REQUIRED`, and invalid input to `INVALID_INPUT`. Convert stored millisecond timestamps with `new Date(value).toISOString()`. Implement `isAuthenticated()` as a synchronous repository session check solely for event filtering.

- [ ] **Step 8: Run both auth-domain tests and verify GREEN**

```bash
pnpm --filter @autoforge/desktop exec node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts electron/main/auth/password-hasher.test.ts electron/main/auth/local-auth-service.test.ts
```

Expected: PASS.

- [ ] **Step 9: Commit the auth domain**

```bash
git add apps/desktop/electron/main/auth/password-hasher.ts apps/desktop/electron/main/auth/password-hasher.test.ts apps/desktop/electron/main/auth/local-auth-service.ts apps/desktop/electron/main/auth/local-auth-service.test.ts
git commit -m "feat: authenticate local accounts securely"
```

---

### Task 4: Application runtime authentication composition and event filtering

**Files:**
- Modify: `apps/desktop/electron/main/application.ts`
- Modify: `apps/desktop/electron/main/application.test.ts`
- Modify: `apps/desktop/electron/main/ipc/register-ipc.ts`

**Interfaces:**
- Consumes: `LocalAuthService`, `database.localAuth`
- Produces: `runtime.services.auth`
- Enforces: no chat or execution events are forwarded while logged out

- [ ] **Step 1: Write failing runtime tests**

Add a registration/login lifecycle case using a temporary real database:

```ts
const runtime = createApplicationRuntime(options(root))
await expect(runtime.services.auth.getSession()).resolves.toBeNull()
const session = await runtime.services.auth.register({ account: 'Alice', password: 'password' })
expect(session.user.account).toBe('Alice')
await runtime.services.auth.logout()
await expect(runtime.services.auth.requireSession()).rejects.toMatchObject({ code: 'AUTH_REQUIRED' })
```

Add an event case: emit a chat and execution event before registration and expect both runtime option spies untouched; register; emit again and expect forwarding; logout; emit again and expect call counts unchanged.

- [ ] **Step 2: Run the runtime tests and verify RED**

```bash
pnpm --filter @autoforge/desktop exec node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts electron/main/application.test.ts
```

Expected: FAIL because runtime services have no `auth` group and events are not session-filtered.

- [ ] **Step 3: Compose authentication in the runtime**

Immediately after opening the database, construct:

```ts
const auth = new LocalAuthService(database.localAuth)
```

Expose methods without duplicating authentication logic:

```ts
auth: {
  getSession: () => auth.getSession(),
  login: (input) => auth.login(input),
  register: (input) => auth.register(input),
  logout: () => auth.logout(),
  requireSession: () => auth.requireSession(),
},
```

Extend `DesktopIpcServices` in `register-ipc.ts` with the service shape so `application.ts` remains type-correct before the IPC handlers are added in Task 5:

```ts
auth: DesktopAPI['auth'] & {
  requireSession(): Promise<AuthSession>
}
```

In both existing event wrappers, retain internal bookkeeping but guard only the external renderer emission:

```ts
if (auth.isAuthenticated()) {
  try { options.emitExecution(event) } catch { /* Renderer events are observational. */ }
}
```

Apply the equivalent guard to `options.emitChat(event)`.

- [ ] **Step 4: Run the runtime test and verify GREEN**

Run the command from Step 2. Expected: PASS.

- [ ] **Step 5: Commit runtime composition**

```bash
git add apps/desktop/electron/main/application.ts apps/desktop/electron/main/application.test.ts apps/desktop/electron/main/ipc/register-ipc.ts
git commit -m "feat: compose local authentication runtime"
```

---

### Task 5: Protected IPC and fixed Preload bridge

**Files:**
- Modify: `apps/desktop/electron/main/ipc/register-ipc.ts`
- Modify: `apps/desktop/electron/main/ipc/register-ipc.test.ts`
- Modify: `apps/desktop/electron/preload/bridge.ts`
- Modify: `apps/desktop/electron/preload/bridge.test.ts`
- Modify: `apps/desktop/src/services/desktop-api.ts`

**Interfaces:**
- Consumes: `runtime.services.auth.requireSession()`
- Produces: `window.autoForge.auth`
- Enforces order: trusted sender → Zod request → authentication → service operation → Zod response

- [ ] **Step 1: Write failing IPC tests**

Extend the IPC service fixture with a nullable session and mocked auth methods. Add cases that prove:

```ts
await expect(app.invoke(ipcChannels.authGetSession)).resolves.toBeNull()
await expect(app.invoke(ipcChannels.authRegister, {
  account: 'Alice', password: 'password',
})).resolves.toMatchObject({ user: { account: 'Alice' } })
await expect(app.invoke(ipcChannels.chatListConversations))
  .rejects.toMatchObject({ code: 'AUTH_REQUIRED' })
expect(app.dependencies.chat.listConversations).not.toHaveBeenCalled()
```

Set `requireSession` to resolve and assert the business call succeeds. Submit malformed input and an untrusted sender, then assert `requireSession` was not called, preserving the required validation order.

- [ ] **Step 2: Run the IPC test and verify RED**

```bash
pnpm --filter @autoforge/desktop exec node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts electron/main/ipc/register-ipc.test.ts
```

Expected: FAIL because auth services/channels are missing and business calls are anonymous.

- [ ] **Step 3: Implement public auth registrations and default business protection**

Use the `DesktopIpcServices.auth` shape added in Task 4:

```ts
auth: DesktopAPI['auth'] & {
  requireSession(): Promise<AuthSession>
}
```

Change the local `register` helper to accept `{ public: boolean }`, defaulting to `{ public: false }`. After trusted-sender and request parsing, call `options.services.auth.requireSession()` unless the registration is public. Register exactly these public operations:

```ts
register(ipcChannels.authGetSession, () => options.services.auth.getSession(), { public: true })
register(ipcChannels.authLogin, (input) => options.services.auth.login(input), { public: true })
register(ipcChannels.authRegister, (input) => options.services.auth.register(input), { public: true })
register(ipcChannels.authLogout, () => options.services.auth.logout(), { public: true })
```

Leave every existing registration on the protected default.

- [ ] **Step 4: Run the IPC test and verify GREEN**

Run the command from Step 2. Expected: PASS.

- [ ] **Step 5: Write failing Preload bridge tests**

```ts
it('maps the fixed local authentication methods', async () => {
  const app = harness()
  await app.api.auth.getSession()
  await app.api.auth.login({ account: 'Alice', password: 'password' })
  await app.api.auth.register({ account: 'Bob', password: 'password' })
  await app.api.auth.logout()
  expect(app.ipcRenderer.invoke).toHaveBeenNthCalledWith(1, ipcChannels.authGetSession, undefined)
  expect(app.ipcRenderer.invoke).toHaveBeenNthCalledWith(2, ipcChannels.authLogin, { account: 'Alice', password: 'password' })
  expect(app.ipcRenderer.invoke).toHaveBeenNthCalledWith(3, ipcChannels.authRegister, { account: 'Bob', password: 'password' })
  expect(app.ipcRenderer.invoke).toHaveBeenNthCalledWith(4, ipcChannels.authLogout, undefined)
})
```

- [ ] **Step 6: Run the bridge test and verify RED**

```bash
pnpm --filter @autoforge/desktop exec node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts electron/preload/bridge.test.ts
```

Expected: FAIL because `api.auth` is missing.

- [ ] **Step 7: Add the fixed Bridge methods and renderer error mapping**

Add this group at the start of `createDesktopApi`'s returned object:

```ts
auth: {
  getSession: () => invoke(ipcRenderer, ipcChannels.authGetSession),
  login: (input) => invoke(ipcRenderer, ipcChannels.authLogin, input),
  register: (input) => invoke(ipcRenderer, ipcChannels.authRegister, input),
  logout: () => invoke(ipcRenderer, ipcChannels.authLogout),
},
```

Require `api.auth` in `getDesktopApi()` and add Chinese display strings:

```ts
AUTH_REQUIRED: '请先登录',
AUTH_INVALID_CREDENTIALS: '账号或密码错误',
AUTH_ACCOUNT_EXISTS: '该账号已存在',
```

- [ ] **Step 8: Run IPC and bridge tests together**

```bash
pnpm --filter @autoforge/desktop exec node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts electron/main/ipc/register-ipc.test.ts electron/preload/bridge.test.ts
```

Expected: PASS.

- [ ] **Step 9: Commit the transport boundary**

```bash
git add apps/desktop/electron/main/ipc/register-ipc.ts apps/desktop/electron/main/ipc/register-ipc.test.ts apps/desktop/electron/preload/bridge.ts apps/desktop/electron/preload/bridge.test.ts apps/desktop/src/services/desktop-api.ts
git commit -m "feat: protect desktop ipc with authentication"
```

---

### Task 6: Renderer authentication state

**Files:**
- Create: `apps/desktop/src/stores/auth.ts`
- Create: `apps/desktop/tests/components/auth.test.ts`

**Interfaces:**
- Consumes: `DesktopAPI.auth`
- Produces: `useAuthStore`

- [ ] **Step 1: Write failing Store tests**

Use a real Pinia and typed `DesktopAPI` fixture. Cover deduplicated restoration plus login, register and logout state:

```ts
vi.mocked(api.auth.getSession).mockResolvedValue(authSession)
await Promise.all([auth.restore(), auth.restore()])
expect(api.auth.getSession).toHaveBeenCalledOnce()
expect(auth.session).toEqual(authSession)
expect(auth.initialized).toBe(true)
```

Assert two concurrent `restore()` calls invoke `getSession` once. Assert a failed logout leaves the previous session intact and sets a displayable error.

- [ ] **Step 2: Run the renderer auth test and verify RED**

```bash
pnpm --filter @autoforge/desktop exec vitest run --config vitest.config.ts tests/components/auth.test.ts
```

Expected: FAIL because the Store does not exist.

- [ ] **Step 3: Implement the auth Store**

Use this state contract:

```ts
state: () => ({
  session: null as AuthSession | null,
  initialized: false,
  restoring: false,
  submitting: false,
  error: '',
  _restorePromise: undefined as Promise<void> | undefined,
})
```

`restore()` must reuse `_restorePromise`, set `initialized` in `finally`, and retain a readable bridge error. `login()` and `register()` set `session` only after successful API completion. `logout()` clears `session` only after `api.auth.logout()` resolves; on rejection it preserves the session. All actions reset stale errors at their start.

- [ ] **Step 4: Run the Store test and verify GREEN**

```bash
pnpm --filter @autoforge/desktop exec vitest run --config vitest.config.ts tests/components/auth.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit the Renderer auth state**

```bash
git add apps/desktop/src/stores/auth.ts apps/desktop/tests/components/auth.test.ts
git commit -m "feat: manage renderer authentication state"
```

---

### Task 7: Login/register UI and workbench logout entry

**Files:**
- Create: `apps/desktop/src/layouts/AuthLayout.vue`
- Create: `apps/desktop/src/views/LoginView.vue`
- Create: `apps/desktop/src/views/RegisterView.vue`
- Modify: `apps/desktop/src/router/index.ts`
- Modify: `apps/desktop/src/App.vue`
- Modify: `apps/desktop/src/main.ts`
- Modify: `apps/desktop/src/components/AppRail.vue`
- Modify: `apps/desktop/tests/components/auth.test.ts`
- Modify: `apps/desktop/tests/components/workbench.test.ts`
- Modify: `apps/desktop/tests/components/chat.test.ts`
- Modify: `apps/desktop/tests/components/developer.test.ts`

**Interfaces:**
- Consumes: `useAuthStore`, `safeRedirect`
- Produces: `createAuthGuard`, `safeRedirect`, `/login`, `/register`, protected workbench routes, accessible forms and logout control

- [ ] **Step 1: Add failing page interaction tests**

Mount the current APP with memory history, Element Plus and a typed API fixture. The first assertion must fail because `/login` does not yet exist. Cover protected-route redirect, guest-only redirect, safe internal redirect, the two forms and logout:

```ts
await router.push('/login?redirect=/settings')
expect(wrapper.find('[data-testid="login-form"]').exists()).toBe(true)
await wrapper.get('[data-testid="login-account"] input').setValue(' Alice ')
await wrapper.get('[data-testid="login-password"] input').setValue('password')
await wrapper.get('[data-testid="login-form"]').trigger('submit')
await vi.waitFor(() => expect(api.auth.login).toHaveBeenCalledWith({
  account: 'Alice', password: 'password',
}))
expect(router.currentRoute.value.fullPath).toBe('/settings')
```

Add separate assertions for anonymous `/settings` redirect, authenticated `/login` redirect, `//attacker.invalid` and `https://attacker.invalid` redirect fallback, invalid account, short password, confirmation mismatch, duplicate submit suppression, `AUTH_INVALID_CREDENTIALS`, `AUTH_ACCOUNT_EXISTS`, register success to `/chat`, correct autocomplete values, visible labels, `role="alert"`, current account display, failed logout preservation, and successful logout to `/login`.

- [ ] **Step 2: Run the page test and verify RED**

```bash
pnpm --filter @autoforge/desktop exec vitest run --config vitest.config.ts tests/components/auth.test.ts
```

Expected: FAIL with the current wildcard route resolving `/login` to `/chat`; the authentication page and guards are absent.

- [ ] **Step 3: Implement `AuthLayout.vue`**

Create a full-height canvas with a centered white card, AutoForge mark, heading and default slot. Reuse only existing CSS variables and include no workbench navigation:

```vue
<template>
  <main class="auth-shell">
    <section class="auth-card" aria-labelledby="auth-title">
      <div class="auth-brand"><span aria-hidden="true">AF</span><strong>AutoForge</strong></div>
      <slot />
    </section>
  </main>
</template>
```

Set the card width to `min(420px, calc(100vw - 48px))`, use `var(--af-surface)`, `var(--af-border)`, and the existing focus styles. Both page components must render their visible `<h1 id="auth-title">` so the region label resolves.

- [ ] **Step 4: Refactor routes around explicit layouts and install the Guard**

Export `safeRedirect` and `createAuthGuard(auth)` from `router/index.ts`. `safeRedirect` returns its input only when it is a string beginning with `/` but not `//`; otherwise it returns `/chat`. Define guest routes plus a protected parent:

```ts
export const routes: RouteRecordRaw[] = [
  { path: '/login', name: 'login', component: LoginView, meta: { guestOnly: true } },
  { path: '/register', name: 'register', component: RegisterView, meta: { guestOnly: true } },
  {
    path: '/',
    component: WorkbenchLayout,
    meta: { requiresAuth: true },
    children: [
      { path: '', redirect: '/chat' },
      { path: 'chat', name: 'chat', component: ChatView, meta: { title: '聊天', inspector: true } },
      { path: 'workflows', name: 'workflows', component: WorkflowsView, meta: { title: '工作流', inspector: true } },
      { path: 'developer', name: 'developer', component: DeveloperView, meta: { title: '开发', inspector: true } },
      { path: 'executions', name: 'executions', component: ExecutionsView, meta: { title: '执行记录', inspector: true } },
      { path: 'settings', name: 'settings', component: SettingsView, meta: { title: '设置', inspector: false } },
    ],
  },
  { path: '/:pathMatch(.*)*', redirect: '/chat' },
]
```

The Guard awaits `auth.restore()` when uninitialized, sends anonymous protected requests to `{ name: 'login', query: { redirect: to.fullPath } }`, and sends authenticated guest-route requests to `/chat`.

Change `App.vue` to render only `<RouterView />`. In `main.ts`, create one Pinia instance, construct the auth Store with that instance, install the Guard, await `auth.restore()` before mounting, and still mount after a recoverable restore failure so the login page can display the error.

- [ ] **Step 5: Implement the login form**

Use a native `<form @submit.prevent="submit">` around Element Plus inputs. Bind visible labels and these attributes:

```vue
<form data-testid="login-form" @submit.prevent="submit">
  <el-input id="login-account" v-model="account" data-testid="login-account" autocomplete="username" />
  <el-input
    id="login-password"
    v-model="password"
    data-testid="login-password"
    type="password"
    autocomplete="current-password"
    show-password
  />
</form>
```

Validate with `authCredentialsSchema.safeParse({ account, password })`; send `parsed.data` so the account is trimmed while the password is unchanged. Disable the complete form while `auth.submitting`. On success call `router.replace(safeRedirect(route.query.redirect))`. Render `auth.error` in a form-level `role="alert"`, and link to `/register`.

- [ ] **Step 6: Implement the register form**

Use account, password and confirmation fields with `autocomplete="username"` and `autocomplete="new-password"`. Check confirmation equality before calling `auth.register`. Use the shared credential schema for remaining client validation. On success replace with `/chat`; display duplicate-account and format failures inside the form; link back to `/login`.

- [ ] **Step 7: Add current account and logout to `AppRail.vue`**

Keep the five existing navigation items unchanged. Add a bottom section after them:

```vue
<div class="rail-account">
  <span class="rail-account-name" :title="auth.session?.user.account">
    {{ auth.session?.user.account }}
  </span>
  <button type="button" aria-label="退出登录" :disabled="auth.submitting" @click="logout">
    <el-icon><SwitchButton /></el-icon>
  </button>
</div>
```

`logout()` awaits `auth.logout()` and replaces with `/login` only on success. Set `.rail-account { margin-top: auto; }`, truncate the account within the existing 44 px rail, and retain an accessible title and label.

- [ ] **Step 8: Update existing API fixtures**

Add this deterministic group to every test fixture that is consumed through `getDesktopApi()`:

```ts
auth: {
  getSession: vi.fn().mockResolvedValue(null),
  login: vi.fn(),
  register: vi.fn(),
  logout: vi.fn().mockResolvedValue(undefined),
},
```

Update `workbench.test.ts`, `chat.test.ts`, and `developer.test.ts`; do not alter their business assertions.

- [ ] **Step 9: Run all renderer component tests and verify GREEN**

```bash
pnpm --filter @autoforge/desktop exec vitest run --config vitest.config.ts
```

Expected: PASS with the new auth coverage and all existing component behavior intact.

- [ ] **Step 10: Commit the UI and navigation slice**

```bash
git add apps/desktop/src/layouts/AuthLayout.vue apps/desktop/src/views/LoginView.vue apps/desktop/src/views/RegisterView.vue apps/desktop/src/router/index.ts apps/desktop/src/App.vue apps/desktop/src/main.ts apps/desktop/src/components/AppRail.vue apps/desktop/tests/components/auth.test.ts apps/desktop/tests/components/workbench.test.ts apps/desktop/tests/components/chat.test.ts apps/desktop/tests/components/developer.test.ts
git commit -m "feat: add local login and registration flow"
```

---

### Task 8: Full regression and production verification

**Files:**
- Modify only files already listed when a verification failure is directly caused by this feature.

**Interfaces:**
- Verifies every public contract and production entry point from Tasks 1–7.

- [ ] **Step 1: Run the focused authentication suite**

```bash
pnpm exec vitest run packages/shared/src/contracts.test.ts
pnpm --filter @autoforge/desktop exec node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts electron/main/auth/password-hasher.test.ts electron/main/auth/local-auth-service.test.ts electron/main/database/database.test.ts electron/main/application.test.ts electron/main/ipc/register-ipc.test.ts electron/preload/bridge.test.ts
pnpm --filter @autoforge/desktop exec vitest run --config vitest.config.ts tests/components/auth.test.ts
```

Expected: every command exits 0.

- [ ] **Step 2: Run the full automated quality gates**

```bash
pnpm test
pnpm typecheck
pnpm lint
pnpm build
```

Expected: every command exits 0. If an unrelated pre-existing failure appears, record its exact command and error separately; do not change unrelated code.

- [ ] **Step 3: Inspect the final diff for scope and secrets**

```bash
git diff --check HEAD~7..HEAD
git diff --stat HEAD~7..HEAD
rg -n "password" apps/desktop/electron/main apps/desktop/src packages/shared/src -g '!*.test.ts'
git status --short
```

Expected: no whitespace errors; password references are limited to schemas, form state, hashing and authentication call paths; `CHAT.md` remains unstaged and unchanged by this work.

- [ ] **Step 4: Perform the desktop smoke test**

Run:

```bash
pnpm dev
```

Verify manually:

1. Existing upgraded data opens on the registration page without appearing behind it.
2. Register `Alice_1` with an 8+ character password and arrive at `/chat`.
3. Restart the APP and remain logged in.
4. Exit, open `/settings`, log in as `alice_1`, and return to `/settings`.
5. Register a second account after exiting; both accounts see the same device-level conversations and executions.
6. Wrong credentials show only “账号或密码错误”.
7. Account/password format errors and confirmation mismatch stay inside the form.
8. Logout during a running task hides subsequent events; logging in again reveals persisted execution state.

- [ ] **Step 5: Record the verification result without staging unrelated files**

Use `git status --short` to list remaining changes. If a verification-caused fix was needed, stage only its explicit feature files and commit:

```bash
git commit -m "test: verify local authentication flow"
```

Skip this commit when verification required no code change.
