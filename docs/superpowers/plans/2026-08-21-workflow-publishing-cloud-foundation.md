# Workflow Publishing Cloud Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立工作流发布系统的共享契约、CloudBase PostgreSQL 真相源、身份与角色校验、动态策略、私有源码上传会话和提交受理 API。

**Architecture:** 新建 `@autoforge/publishing-contracts` 作为桌面端与云端唯一的 DTO/状态枚举来源；新建 CloudRun `publisher-service`，它是唯一持有 PostgreSQL 业务凭据的服务。桌面端使用 CloudBase access token 调用公开 API；Builder/Signer 后续只调用受服务身份保护的内部 API。源码先传至私有对象存储，再由一次 PostgreSQL 事务校验所有权、版本、活跃提交和每日构建限额并创建不可变提交。

**Tech Stack:** TypeScript 6, Node.js 22, Fastify, Zod, Drizzle ORM, `pg`, CloudBase Authentication, CloudBase PostgreSQL, CloudBase Storage, Vitest, pnpm.

**Spec:** `docs/superpowers/specs/2026-08-21-workflow-publishing-review-distribution-design.md`

## Global Constraints

- 实施前先安装完整 CloudBase skill pack：`npx plugins add TencentCloudBase/cloudbase-plugin -y --scope user`，重启 Codex 后必须使用 `postgresql-development-cloudbase` 完成 PG 资源与权限步骤；若该 skill 仍不可用，停止云资源变更，只完成本地可验证代码。
- CloudBase 环境保持 `autoforge-d1gkhyfb419ba8455`、区域保持 `ap-shanghai`；不得新建第二套身份系统。
- `publisher-service` 是唯一可直接访问业务 PostgreSQL 的进程。Renderer、Electron Main、Builder、Signer 均不得持有 PG 凭据。
- 所有公开请求先验证 CloudBase access token，再从服务端角色表读取角色；不得信任客户端传入的 userId、ownerId 或 role。
- 数据库时间使用 `timestamptz` 和服务端 `now()`；状态转换必须使用带旧状态条件的原子更新。
- 不在仓库、日志、测试快照或前端状态中保存数据库密码、CloudBase 密钥、对象存储长期密钥和 access token。
- 所有 DTO 使用严格 Zod schema；禁止 `any`，外部输入以 `unknown` 接收并解析。
- 动态配置只能调整运营数值和分类。包体边界、路径边界、签名要求、身份校验等安全不变量不得进入可关闭配置。
- 不操作用户当前未提交的工作区变更；每个任务只提交列出的文件。
- 不打开可见浏览器；API/UI 验证使用单元、集成或 headless 测试。

---

### Task 1: 创建发布共享契约包

**Files:**
- Create: `packages/publishing-contracts/package.json`
- Create: `packages/publishing-contracts/tsconfig.json`
- Create: `packages/publishing-contracts/src/index.ts`
- Create: `packages/publishing-contracts/src/contracts.ts`
- Create: `packages/publishing-contracts/src/contracts.test.ts`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Produces: `SubmissionStatus`, `ReleaseStatus`, `UploadSession`, `SubmissionSummary`, `ReviewDetail`, `MarketplaceWorkflow`, `PublishedReleaseManifest`, `PublisherErrorEnvelope` 及对应严格 schema。
- Consumes: `WorkflowManifest` 的稳定字段语义；不依赖 Electron 或服务实现。

- [ ] **Step 1: 写失败的契约测试**

覆盖状态全集、稳定错误结构、严格 SemVer、HTTPS 下载 URL、发布清单哈希与签名字段，并证明额外字段会被拒绝：

```ts
expect(submissionStatusSchema.options).toEqual([
  'queued', 'building', 'build_failed', 'pending_review', 'approved', 'rejected',
])
expect(createSubmissionRequestSchema.safeParse({
  uploadSessionId: 'upl_01J00000000000000000000000',
  workflowId: 'com.example.collector',
  version: '1.2.0-beta.1',
  debugProof: { buildHash: 'a'.repeat(64), testedAt: '2026-08-21T00:00:00.000Z' },
}).success).toBe(false)
expect(publisherErrorEnvelopeSchema.parse({
  error: { code: 'ACTIVE_SUBMISSION_LIMIT', message: 'active submission limit reached', requestId: 'req_1' },
})).toBeTruthy()
```

- [ ] **Step 2: 运行测试并确认 RED**

Run: `pnpm exec vitest run packages/publishing-contracts/src/contracts.test.ts`

Expected: 失败，因为包和 schema 尚不存在。

- [ ] **Step 3: 实现最小严格契约**

使用稳定字符串枚举；版本 schema 使用 `semver.valid(value) === value && !semver.prerelease(value)`。正式清单至少包含：

```ts
export const publishedReleaseManifestSchema = z.object({
  formatVersion: z.literal(1),
  workflowId: workflowIdSchema,
  version: stableSemverSchema,
  sourceSubmissionId: idSchema,
  publisher: z.object({ userId: idSchema, displayName: z.string().min(1).max(80) }).strict(),
  categoryId: z.string().min(1).max(64),
  permissions: z.array(z.string().min(1)).max(64),
  runtimeSha256: sha256Schema,
  manifestSha256: sha256Schema,
  sizeBytes: z.number().int().nonnegative(),
  publishedAt: z.string().datetime({ offset: true }),
  signingKeyId: z.string().min(1).max(128),
}).strict()
```

错误码至少固定：`UNAUTHENTICATED`、`FORBIDDEN`、`INVALID_INPUT`、`UPLOAD_EXPIRED`、`UPLOAD_HASH_MISMATCH`、`WORKFLOW_OWNERSHIP_CONFLICT`、`VERSION_ALREADY_OCCUPIED`、`VERSION_NOT_INCREASING`、`ACTIVE_WORKFLOW_SUBMISSION_EXISTS`、`ACTIVE_SUBMISSION_LIMIT`、`DAILY_BUILD_LIMIT`、`STATE_CONFLICT`、`PLATFORM_UNAVAILABLE`。

- [ ] **Step 4: 验证包**

Run: `pnpm exec vitest run packages/publishing-contracts/src/contracts.test.ts`

Run: `pnpm --filter @autoforge/publishing-contracts typecheck`

Expected: 均通过。

- [ ] **Step 5: 提交**

```bash
git add packages/publishing-contracts pnpm-lock.yaml
git commit -m "feat: add workflow publishing contracts"
```

---

### Task 2: 搭建 Publisher Service 与认证请求边界

**Files:**
- Create: `apps/publisher-service/package.json`
- Create: `apps/publisher-service/tsconfig.json`
- Create: `apps/publisher-service/src/config.ts`
- Create: `apps/publisher-service/src/server.ts`
- Create: `apps/publisher-service/src/app.ts`
- Create: `apps/publisher-service/src/http/error-handler.ts`
- Create: `apps/publisher-service/src/auth/cloudbase-token-verifier.ts`
- Create: `apps/publisher-service/src/auth/authenticate.ts`
- Create: `apps/publisher-service/src/auth/authenticate.test.ts`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Consumes: `Authorization: Bearer <CloudBase access token>`。
- Produces: `AuthenticatedPrincipal { userId: string }` request decoration 和稳定错误 envelope。
- Does not produce: Renderer 可见 token、客户端可覆盖角色。

- [ ] **Step 1: 写认证边界失败测试**

使用注入的 `CloudBaseTokenVerifier` fake，覆盖缺失 header、非 Bearer、无效 token、有效 token，并断言日志序列化后不含 token：

```ts
const response = await app.inject({ method: 'GET', url: '/v1/me', headers: { authorization: 'Bearer secret-token' } })
expect(response.statusCode).toBe(200)
expect(response.json()).toEqual({ userId: 'user_1', roles: [] })
expect(logOutput).not.toContain('secret-token')
```

- [ ] **Step 2: 运行测试并确认 RED**

Run: `pnpm --filter @autoforge/publisher-service test -- authenticate.test.ts`

Expected: 失败，因为服务尚未创建。

- [ ] **Step 3: 实现配置和依赖注入**

`loadConfig(env: NodeJS.ProcessEnv)` 必须解析且拒绝缺失的 `PORT`、`DATABASE_URL`、`CLOUDBASE_ENV_ID`、`CLOUDBASE_REGION`、`PRIVATE_SOURCE_BUCKET`。`createApp(deps)` 接收 verifier/repositories/storage/clock/idGenerator/logger，测试不得读取真实环境。

`CloudBaseTokenVerifier` 只返回经过 SDK/官方验证端点确认的 UID；禁止仅解码 JWT payload。若当前 SDK 没有服务端验证接口，CloudBase skill 执行阶段必须选定官方服务端校验方法并将适配器契约测试固定，不能用自签名或前端 `getUser()` 代替。

- [ ] **Step 4: 实现错误与日志脱敏**

Fastify error handler 将已知领域错误映射为契约状态码，未知错误统一返回 `PLATFORM_UNAVAILABLE` 和 requestId。redact 至少包含 `req.headers.authorization`、`DATABASE_URL`、cookie、storage ticket。

- [ ] **Step 5: 验证服务骨架**

Run: `pnpm --filter @autoforge/publisher-service test -- authenticate.test.ts`

Run: `pnpm --filter @autoforge/publisher-service typecheck`

Expected: 均通过。

- [ ] **Step 6: 提交**

```bash
git add apps/publisher-service pnpm-lock.yaml
git commit -m "feat: scaffold authenticated publisher service"
```

---

### Task 3: 建立 PostgreSQL 模型、约束与迁移测试

**Files:**
- Create: `apps/publisher-service/src/db/schema.ts`
- Create: `apps/publisher-service/src/db/client.ts`
- Create: `apps/publisher-service/migrations/0001_publishing_core.sql`
- Create: `apps/publisher-service/migrations/0002_default_policy.sql`
- Create: `apps/publisher-service/src/db/migrations.integration.test.ts`
- Modify: `apps/publisher-service/package.json`

**Interfaces:**
- Produces tables: `publisher_users`, `publisher_user_roles`, `workflow_owners`, `workflow_id_reservations`, `upload_sessions`, `workflow_submissions`, `submission_events`, `workflow_releases`, `workflow_release_artifacts`, `workflow_reviews`, `publisher_policy`, `workflow_categories`, `publisher_audit_log`, `publisher_notifications`。
- Consumes: CloudBase UID，Task 1 状态枚举。

- [ ] **Step 1: 写迁移集成测试**

测试只读取 `PUBLISHER_TEST_DATABASE_URL`，缺失时明确 skip；CI/CloudBase 测试环境必须提供独立数据库。覆盖：

- `(workflow_id, version)` 对 published/revoked release 永久唯一。
- 一个 workflow 只有一个活跃提交（`queued/building/pending_review/approved`）。
- 同一 submission 只有一个 review decision。
- role 仅允许 `super_admin`。
- event/audit 表 append-only：应用角色无 UPDATE/DELETE 权限。
- 时间字段均为 `timestamptz`。

- [ ] **Step 2: 运行迁移测试并确认 RED**

Run: `PUBLISHER_TEST_DATABASE_URL="$PUBLISHER_TEST_DATABASE_URL" pnpm --filter @autoforge/publisher-service test:integration -- migrations.integration.test.ts`

Expected: 失败，因为迁移不存在；若环境变量缺失，结果为 skip，不能视为本任务云端完成证据。

- [ ] **Step 3: 实现 schema 与 SQL 约束**

使用 PostgreSQL enum/check 和 partial unique index 固化状态不变量，例如：

```sql
CREATE UNIQUE INDEX workflow_submissions_one_active_per_workflow
ON workflow_submissions (workflow_id)
WHERE status IN ('queued', 'building', 'pending_review', 'approved');

CREATE UNIQUE INDEX workflow_releases_version_occupied
ON workflow_releases (workflow_id, version);
```

`publisher_policy` 使用单行 `policy_key='global'`，默认 `max_active_submissions_per_user=5`、`max_daily_server_builds_per_user=50`，同时写入包/文件/构建资源固定值供展示，但代码中的安全上限仍必须二次夹紧。分类迁移写入规格中的 14 个默认分类并包含 `enabled`、`sort_order`。

- [ ] **Step 4: 运行迁移、回滚后再迁移**

在独立测试库运行 up → assertions → 清库 → up，确认幂等的迁移 runner 不会重复种子数据。

Run: `pnpm --filter @autoforge/publisher-service test:integration -- migrations.integration.test.ts`

Run: `pnpm --filter @autoforge/publisher-service typecheck`

Expected: 均通过且没有连接生产库。

- [ ] **Step 5: 提交**

```bash
git add apps/publisher-service/src/db apps/publisher-service/migrations apps/publisher-service/package.json pnpm-lock.yaml
git commit -m "feat: add publishing PostgreSQL schema"
```

---

### Task 4: 实现角色、策略、所有权、版本与限额事务

**Files:**
- Create: `apps/publisher-service/src/repositories/publishing-repository.ts`
- Create: `apps/publisher-service/src/repositories/postgres-publishing-repository.ts`
- Create: `apps/publisher-service/src/repositories/postgres-publishing-repository.integration.test.ts`
- Create: `apps/publisher-service/src/domain/submission-policy.ts`
- Create: `apps/publisher-service/src/domain/submission-policy.test.ts`

**Interfaces:**
- Consumes: authenticated UID, `workflowId`, stable version, uploaded object metadata, debug proof。
- Produces atomically: accepted `queued` submission or one stable domain error。
- Produces read models: `getPrincipalRoles`, `getEffectivePolicy`, `listEnabledCategories`。

- [ ] **Step 1: 写领域与并发失败测试**

覆盖默认 5/50、动态改为 3/12 后即时生效、安全值被夹在代码硬上限内、同一 workflow 并发提交仅一条成功、未拥有 workflowId 的首个有效提交拿临时 reservation、已发布版本不可复用、版本必须高于最新 published/revoked 稳定版。

- [ ] **Step 2: 运行测试并确认 RED**

Run: `pnpm --filter @autoforge/publisher-service test -- submission-policy.test.ts`

Run: `pnpm --filter @autoforge/publisher-service test:integration -- postgres-publishing-repository.integration.test.ts`

Expected: 领域测试失败；集成测试在有测试库时失败。

- [ ] **Step 3: 实现策略纯函数**

定义硬上限，配置只能收紧或在允许区间调整：

```ts
export const POLICY_HARD_LIMITS = {
  activeSubmissions: { min: 1, max: 20 },
  dailyBuilds: { min: 1, max: 200 },
} as const
```

活跃提交计数按账号、状态集计算；每日构建按 UTC 日期或明确的 `Asia/Shanghai` 业务日二选一。采用规格部署区域对应的 `Asia/Shanghai`，并在 SQL 使用传入的 dayStart/dayEnd，禁止依赖数据库 session timezone。

- [ ] **Step 4: 实现 SERIALIZABLE 受理事务**

事务顺序固定：锁全局 policy → 锁/创建 workflow reservation → 校验 owner → 锁账号计数键 → 校验活跃数/日构建数 → 检查版本占用与递增 → 插入 submission/event。遇到 serialization failure 最多重试 3 次；同业务冲突返回稳定错误码，不返回 SQL 文本。

首个提交此时只写 reservation，不写 `workflow_owners`；所有权在后续自动构建通过并转 `pending_review` 的事务中落定。

- [ ] **Step 5: 验证并发与边界**

Run: `pnpm --filter @autoforge/publisher-service test -- submission-policy.test.ts`

Run: `pnpm --filter @autoforge/publisher-service test:integration -- postgres-publishing-repository.integration.test.ts`

Expected: 50 个并发请求下只有符合限额/唯一约束的请求成功，数据库无重复活跃记录。

- [ ] **Step 6: 提交**

```bash
git add apps/publisher-service/src/repositories apps/publisher-service/src/domain
git commit -m "feat: enforce publishing ownership and quotas"
```

---

### Task 5: 实现私有源码上传会话

**Files:**
- Create: `apps/publisher-service/src/storage/private-source-storage.ts`
- Create: `apps/publisher-service/src/storage/cloudbase-private-source-storage.ts`
- Create: `apps/publisher-service/src/storage/private-source-storage.test.ts`
- Create: `apps/publisher-service/src/routes/upload-routes.ts`
- Create: `apps/publisher-service/src/routes/upload-routes.test.ts`
- Modify: `apps/publisher-service/src/app.ts`

**Interfaces:**
- `POST /v1/uploads` → short-lived upload session with scoped write ticket and canonical object key.
- `POST /v1/uploads/:id/complete` consumes `sha256` and `sizeBytes`, verifies storage metadata, then seals session.
- Object key is server-generated: `sources/<userId>/<uploadSessionId>/source.tar.gz`; client never supplies a path.

- [ ] **Step 1: 写上传 API 失败测试**

覆盖匿名、超出 10 MiB、过期、重复 complete、对象不存在、哈希不符、用户访问他人 session，以及响应中不存在长期 storage credential。

- [ ] **Step 2: 运行测试并确认 RED**

Run: `pnpm --filter @autoforge/publisher-service test -- upload-routes.test.ts private-source-storage.test.ts`

Expected: 失败，因为 storage port/routes 不存在。

- [ ] **Step 3: 实现 storage port 与 CloudBase adapter**

Port 仅允许 `createScopedUpload`、`headPrivateObject`、`createScopedRead`、`deletePrivateObject`。CloudBase adapter 必须强制私有 bucket、5 分钟到期、单 object key、Content-Length 上限和 content-type；不得提供 list 或 bucket-wide ticket。

- [ ] **Step 4: 实现上传会话状态机**

状态仅 `created → uploaded → consumed` 或 `expired`。complete 使用对象服务返回的 size/hash；若 CloudBase metadata 不提供可信 SHA-256，则服务端流式读取一次计算，不信任客户端值。日志只写 uploadSessionId、用户、大小和结果。

- [ ] **Step 5: 验证**

Run: `pnpm --filter @autoforge/publisher-service test -- upload-routes.test.ts private-source-storage.test.ts`

Run: `pnpm --filter @autoforge/publisher-service typecheck`

Expected: 均通过。

- [ ] **Step 6: 提交**

```bash
git add apps/publisher-service/src/storage apps/publisher-service/src/routes apps/publisher-service/src/app.ts
git commit -m "feat: add private workflow source uploads"
```

---

### Task 6: 实现提交、本人查询与管理员配置 API

**Files:**
- Create: `apps/publisher-service/src/routes/submission-routes.ts`
- Create: `apps/publisher-service/src/routes/submission-routes.test.ts`
- Create: `apps/publisher-service/src/routes/admin-policy-routes.ts`
- Create: `apps/publisher-service/src/routes/admin-policy-routes.test.ts`
- Create: `apps/publisher-service/src/services/submission-service.ts`
- Create: `apps/publisher-service/src/services/submission-service.test.ts`
- Modify: `apps/publisher-service/src/app.ts`

**Interfaces:**
- `POST /v1/submissions`, `GET /v1/submissions`, `GET /v1/submissions/:id`, `GET /v1/me`。
- `GET/PATCH /v1/admin/policy`, `GET/POST/PATCH /v1/admin/categories`，仅 super_admin。
- Submit consumes a sealed upload exactly once and queues a build job record; response does not claim build success.

- [ ] **Step 1: 写 API 失败测试**

覆盖：仅本人可读源码提交；admin 可读任意提交；普通用户不能改 policy/category；自报 userId/role 被忽略；动态 5/50 限额的稳定错误；同一 uploadSession 只能产生一个 submission；未知字段 400。

- [ ] **Step 2: 运行测试并确认 RED**

Run: `pnpm --filter @autoforge/publisher-service test -- submission-routes.test.ts admin-policy-routes.test.ts submission-service.test.ts`

Expected: 失败，因为路由和服务不存在。

- [ ] **Step 3: 实现提交服务事务协调**

先读取 sealed upload 元数据，再调用 Task 4 事务；成功后将 upload 标为 consumed。二者必须在同一 PG 事务中，storage object 不在事务中删除。写 `submission_events`：`submission.created`，并写审计 actor、requestId、policy snapshot；不得写 token 或源码。

- [ ] **Step 4: 实现查询和 admin policy/category**

列表使用 cursor pagination，默认 20、最大 100；字段白名单排序。policy PATCH 只接受 `maxActiveSubmissionsPerUser` 和 `maxDailyServerBuildsPerUser`。category id 发布后不可改名主键，只能改显示名、排序、enabled；禁用分类不影响历史 release。

- [ ] **Step 5: 验证完整 API**

Run: `pnpm --filter @autoforge/publisher-service test`

Run: `pnpm --filter @autoforge/publisher-service typecheck`

Run: `pnpm exec eslint apps/publisher-service packages/publishing-contracts`

Expected: 均通过。

- [ ] **Step 6: 提交**

```bash
git add apps/publisher-service/src/routes apps/publisher-service/src/services apps/publisher-service/src/app.ts
git commit -m "feat: accept workflow publishing submissions"
```

---

### Task 7: CloudBase 资源配置、部署与基础冒烟验证

**Files:**
- Create: `apps/publisher-service/Dockerfile`
- Create: `apps/publisher-service/cloudbaserc.json`
- Create: `docs/runbooks/workflow-publisher-cloudbase.md`
- Create: `scripts/verify-publisher-foundation.mjs`
- Modify: `package.json`

**Interfaces:**
- Produces: 可复现的 CloudRun build/deploy、PG migration、私有 bucket 与健康检查流程。
- Consumes: CloudBase skill 确认的官方资源名称和 secret injection 机制。

- [ ] **Step 1: 写本地部署资产测试**

`scripts/verify-publisher-foundation.mjs` 解析 Dockerfile/cloudbaserc/runbook，断言非 root 用户、只复制 workspace 必需文件、无硬编码 secret、健康检查路径 `/healthz`、发布 API feature flag 默认关闭。

- [ ] **Step 2: 运行检查并确认 RED**

Run: `node scripts/verify-publisher-foundation.mjs`

Expected: 失败，因为部署资产不存在。

- [ ] **Step 3: 编写部署资产与 runbook**

runbook 必须逐项记录：环境确认、独立测试 PG、生产 PG、最小权限应用角色、私有 source bucket、CloudRun 服务身份、secret 注入、迁移、super_admin 首次授予的双人/审计操作、feature flag、回滚。禁止把真实标识符以外的凭据写入文件。

- [ ] **Step 4: 本地验证容器**

Run: `pnpm --filter @autoforge/publisher-service build`

Run: `docker build -f apps/publisher-service/Dockerfile -t autoforge-publisher:test .`

Run: `node scripts/verify-publisher-foundation.mjs`

Expected: 均通过；若本机无 Docker，记录该项未验证，不能声明容器完成。

- [ ] **Step 5: 使用 CloudBase skill 创建测试资源并执行冒烟**

仅在 skill 与用户授权环境可用后执行：部署到测试服务、应用迁移、设置一个测试 super_admin，验证未登录 401、普通账号 403 admin route、管理员读取默认 5/50、私有 object 无公共 URL、提交进入 `queued`。不得启用正式用户入口。

- [ ] **Step 6: 全量阶段验证**

Run: `pnpm --filter @autoforge/publishing-contracts test`

Run: `pnpm --filter @autoforge/publisher-service test`

Run: `pnpm --filter @autoforge/publisher-service typecheck`

Run: `node scripts/verify-publisher-foundation.mjs`

Expected: 本地全部通过；CloudBase 冒烟结果记录在 runbook 的部署记录中。

- [ ] **Step 7: 提交**

```bash
git add apps/publisher-service/Dockerfile apps/publisher-service/cloudbaserc.json docs/runbooks/workflow-publisher-cloudbase.md scripts/verify-publisher-foundation.mjs package.json pnpm-lock.yaml
git commit -m "chore: add publisher CloudBase deployment assets"
```

---

## Phase Completion Gate

- [ ] `@autoforge/publishing-contracts`、`publisher-service` 的 test/typecheck/lint 全部通过。
- [ ] 有真实测试 PG 时，迁移与并发集成测试通过；没有测试 PG 时明确标记为未完成，不用 mock 结果替代。
- [ ] 私有对象无法匿名读取，上传 ticket 只能写单一 object key 且短时有效。
- [ ] 普通用户无法访问 admin API；服务端不信任客户端角色。
- [ ] 默认 5 个活跃提交、每天 50 次构建可由管理员动态修改，且安全硬边界不可关闭。
- [ ] 功能开关保持关闭；尚未连接 Builder 时任何提交不得进入 `pending_review`。
