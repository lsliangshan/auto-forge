# Workflow Publishing Desktop Submission and Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有 Electron/Vue 桌面应用中实现开发者发布面板、服务端提交与状态跟踪、超级管理员审核工作台、审核决策和站内通知。

**Architecture:** Renderer 只调用严格的 Desktop API；Electron Main 从 CloudBaseAuthService 内部取得短期 access token，经 PublisherClient 访问云端，token 永不穿过 preload。ProjectService 生成规范源码包并绑定最近一次成功本地调试的 build hash。开发页 Inspector 使用“调试/发布”页签；新增仅 super_admin 可见且有路由守卫的 `/reviews` 页面。所有服务端权限仍由 Publisher Service 复核，前端隐藏不是安全边界。

**Tech Stack:** TypeScript 6, Electron 43, Vue 3.5, Pinia 4, Element Plus, Zod, tar/gzip, Web Crypto/Node crypto in Electron Main, Vitest, Vue Test Utils, Playwright headless.

**Spec:** `docs/superpowers/specs/2026-08-21-workflow-publishing-review-distribution-design.md`

## Global Constraints

- 依赖计划：云端基础与安全流水线 Phase Completion Gate 必须完成；本计划不得用前端 mock 伪装真实发布完成。
- CloudBase access token、refresh token、对象存储票据、源码内容不得进入 Renderer state、Pinia、localStorage、console、IPC 返回值或截图。
- Renderer 不直接调用 Publisher API；所有网络、归档、hash、上传均在 Electron Main。
- Publisher Service 仍是角色、所有权、限额、审核状态的唯一权威；客户端 role 只用于导航和 UX。
- 只打包项目目录内允许的相对路径；禁止绝对路径、本机其他文件、symlink、`.env`、`node_modules`、`dist` 和嵌套归档。
- 提交前必须 flush 所有待保存文件，并绑定当前源码 hash 与最近一次成功 debug proof；修改任何发布相关文件后 proof 失效。
- 保留现有本地开发工作流能力；未审核本地工作流仍可在开发模式使用，与官方 release 分离。
- 不做独立 Web 管理后台；审核就在桌面应用。
- UI 仅使用现有视觉 token/组件，不进行无关视觉重构。
- 不打开可见浏览器；E2E 使用 headless。

---

### Task 1: 为 Electron Main 增加内部发布认证与 Publisher Client

**Files:**
- Modify: `apps/desktop/electron/main/auth/auth-service.ts`
- Modify: `apps/desktop/electron/main/auth/cloudbase-auth-service.ts`
- Modify: `apps/desktop/electron/main/auth/cloudbase-auth-service.test.ts`
- Modify: `apps/desktop/electron/main/auth/local-auth-service.ts`
- Create: `apps/desktop/electron/main/publishing/publisher-client.ts`
- Create: `apps/desktop/electron/main/publishing/publisher-client.test.ts`
- Create: `apps/desktop/electron/main/publishing/publisher-config.ts`

**Interfaces:**
- Produces internal-only `AuthService.getPublisherAccessToken(): Promise<string>`; it is not added to shared DesktopApi.
- Produces `PublisherClient` methods for `/v1/me`, uploads, submissions, reviews, admin policy/categories and notifications using `@autoforge/publishing-contracts`.
- Consumes: configured HTTPS base URL and feature flag.

- [ ] **Step 1: 写 token 隔离与 client 失败测试**

覆盖：未登录拒绝、过期 session 刷新后返回 token、刷新失败清 session、请求自动 Bearer、401 只刷新重试一次、AbortController timeout、响应严格解析、错误 envelope 转安全 typed error、日志不含 token/body 源码。

- [ ] **Step 2: 运行测试并确认 RED**

Run:

```bash
pnpm --dir apps/desktop exec node scripts/run-vitest-electron.mjs run \
  --config vitest.node.config.ts \
  electron/main/auth/cloudbase-auth-service.test.ts \
  electron/main/publishing/publisher-client.test.ts
```

Expected: 失败，因为 internal token 方法和 client 不存在。

- [ ] **Step 3: 实现 internal token 方法**

从已加密 session store 读取 access token；若到期，调用现有 CloudBase refresh 流程并原子保存新 token。`LocalAuthService` 明确抛 `PUBLISHER_AUTH_UNAVAILABLE`，不得制造本地假 token。不要把方法加入 preload/IPC。

- [ ] **Step 4: 实现严格 PublisherClient**

构造函数注入 `fetch`、auth、baseUrl、clock；baseUrl 必须为配置的 canonical HTTPS origin。每次请求获取 token，默认 20s timeout；上传流单独 5min。响应先检查 content-type/size，再用契约 schema parse；重试只覆盖一次 401 refresh 和幂等 GET，不自动重试提交/审核 POST。

- [ ] **Step 5: 验证**

运行 Step 2 命令。

Run: `pnpm --filter @autoforge/desktop typecheck`

Expected: 均通过，并确认 `rg "getPublisherAccessToken" apps/desktop/electron/preload packages/shared` 无结果。

- [ ] **Step 6: 提交**

```bash
git add apps/desktop/electron/main/auth apps/desktop/electron/main/publishing
git commit -m "feat: add authenticated publisher client"
```

---

### Task 2: 生成可发布项目与本地调试证明

**Files:**
- Modify: `apps/desktop/electron/main/workflows/project-service.ts`
- Modify: `apps/desktop/electron/main/workflows/project-service.test.ts`
- Create: `apps/desktop/electron/main/publishing/source-package-service.ts`
- Create: `apps/desktop/electron/main/publishing/source-package-service.test.ts`
- Create: `apps/desktop/electron/main/publishing/debug-proof-repository.ts`
- Create: `apps/desktop/electron/main/publishing/debug-proof-repository.test.ts`
- Modify: `apps/desktop/electron/main/database/schema.ts`
- Modify: `apps/desktop/electron/main/database/database.test.ts`
- Create: `apps/desktop/resources/migrations/0008_publishing_debug_proofs.sql`

**Interfaces:**
- New project creates `workflow.json`, `src/index.ts`, `package.json`, `pnpm-lock.yaml`.
- Existing project compatibility check returns `ready | missing_package_json | missing_lockfile | invalid_dependency_policy` and supports explicit file generation after user confirmation.
- SourcePackageService produces temp archive stream metadata `{ path, sha256, sizeBytes, buildHash }`; never returns source bytes to Renderer.

- [ ] **Step 1: 写失败测试**

覆盖新项目文件、旧项目检测但不静默改写、显式生成 exact-version package + lock、absolute/symlink/local external file rejection、200/2MiB/10MiB limits、deterministic archive、debug success 保存 proof、编辑/build hash 变化后 proof 失效。

- [ ] **Step 2: 运行测试并确认 RED**

Run:

```bash
pnpm --dir apps/desktop exec node scripts/run-vitest-electron.mjs run \
  --config vitest.node.config.ts \
  electron/main/workflows/project-service.test.ts \
  electron/main/publishing/source-package-service.test.ts \
  electron/main/publishing/debug-proof-repository.test.ts
```

Expected: 失败。

- [ ] **Step 3: 实现兼容检查与明确生成**

新建项目默认依赖只含当前精确版本 `@autoforge/workflow-sdk`，lockfile 由 workspace 固定 pnpm 版本生成且禁 scripts。旧项目 API 只返回缺失项；只有 `prepareForPublishing(projectId)` 在 Renderer 已确认后生成缺失文件，已有文件永不覆盖。

- [ ] **Step 4: 实现发布文件枚举与归档**

从已注册 project root 开始，用 `lstat` 拒绝 symlink，仅允许 `workflow.json`、`package.json`、`pnpm-lock.yaml`、`src/**` 及 manifest 明确引用的相对资产。所有 path 使用 POSIX 相对路径；复用服务端相同限额和 denylist。tar metadata 固定以保证 buildHash 可重复。

- [ ] **Step 5: 实现 debug proof**

本地 debug execution 只有 `completed` 才写 `{ projectId, buildHash, executionId, testedAt }` 到 SQLite。SourcePackageService 重新算 buildHash 并要求等于 proof；任何文件变化自然导致 mismatch，不依赖不可靠的 dirty flag。

- [ ] **Step 6: 验证**

运行 Step 2 命令。

Run: `pnpm --filter @autoforge/desktop typecheck`

Expected: 均通过。

- [ ] **Step 7: 提交**

```bash
git add apps/desktop/electron/main/workflows apps/desktop/electron/main/publishing apps/desktop/electron/main/database/schema.ts apps/desktop/electron/main/database/database.test.ts apps/desktop/resources/migrations/0008_publishing_debug_proofs.sql
git commit -m "feat: prepare local projects for publishing"
```

---

### Task 3: 定义桌面发布 IPC 契约并实现 Main 协调服务

**Files:**
- Modify: `packages/shared/src/desktop-api.ts`
- Modify: `packages/shared/src/contracts.test.ts`
- Modify: `apps/desktop/electron/preload/bridge.ts`
- Modify: `apps/desktop/electron/main/ipc/register-ipc.ts`
- Modify: `apps/desktop/electron/main/ipc/register-ipc.test.ts`
- Modify: `apps/desktop/electron/main/application.ts`
- Modify: `apps/desktop/electron/main/application.test.ts`
- Create: `apps/desktop/electron/main/publishing/publishing-service.ts`
- Create: `apps/desktop/electron/main/publishing/publishing-service.test.ts`

**Interfaces:**
- Desktop API namespaces: `publishing` for current user submission operations, `reviews` for admin operations, `notifications` for in-app notices.
- `publishing.submitProject(projectId)` performs package → upload → complete → submit entirely in Main and returns `SubmissionSummary`.
- No IPC accepts local path, source bytes, userId, ownerId or role.

- [ ] **Step 1: 写共享契约与 IPC 失败测试**

测试严格参数、未知字段拒绝、source/path/token 不在返回 schema；register handlers 解析参数；admin calls are forwarded but server remains authority；销毁窗口/取消操作会 abort upload。

- [ ] **Step 2: 运行测试并确认 RED**

Run: `pnpm exec vitest run packages/shared/src/contracts.test.ts`

Run:

```bash
pnpm --dir apps/desktop exec node scripts/run-vitest-electron.mjs run \
  --config vitest.node.config.ts \
  electron/main/publishing/publishing-service.test.ts \
  electron/main/ipc/register-ipc.test.ts \
  electron/main/application.test.ts
```

Expected: 失败。

- [ ] **Step 3: 添加最小 Desktop API**

```ts
publishing: {
  getMe(): Promise<PublisherMe>
  getProjectReadiness(projectId: string): Promise<ProjectPublishReadiness>
  prepareProject(projectId: string): Promise<ProjectPublishReadiness>
  submitProject(projectId: string): Promise<SubmissionSummary>
  listMine(query?: SubmissionQuery): Promise<SubmissionSummary[]>
  getMine(submissionId: string): Promise<SubmissionDetail>
}
reviews: {
  list(query?: ReviewQuery): Promise<ReviewSummary[]>
  get(submissionId: string): Promise<ReviewDetail>
  approve(input: ReviewApprovalInput): Promise<ReviewDecisionResult>
  reject(input: ReviewRejectionInput): Promise<ReviewDecisionResult>
  runSandbox(submissionId: string): Promise<ReviewSandboxRun>
}
```

所有 channel 使用现有 invoke schema pattern，preload 仅暴露这些 DTO。

- [ ] **Step 4: 实现提交协调**

先 flush/validate 由 Renderer 发起，但 Main 必须再次 build/validate/readiness/debug-proof；创建 temp archive → create upload → stream PUT → complete → submit。失败 finally 删除明确 temp archive；在 submit 成功后不删除私有云源码，保留由服务端策略控制。

- [ ] **Step 5: 验证**

运行 Step 2 两组命令。

Run: `pnpm --filter @autoforge/shared typecheck && pnpm --filter @autoforge/desktop typecheck`

Expected: 均通过；preload snapshot 无 token/path/source。

- [ ] **Step 6: 提交**

```bash
git add packages/shared/src apps/desktop/electron/preload/bridge.ts apps/desktop/electron/main/ipc apps/desktop/electron/main/application* apps/desktop/electron/main/publishing
git commit -m "feat: expose safe desktop publishing APIs"
```

---

### Task 4: 实现开发页“调试 / 发布”Inspector

**Files:**
- Create: `apps/desktop/src/components/developer/PublishPanel.vue`
- Modify: `apps/desktop/src/components/InspectorPanel.vue`
- Modify: `apps/desktop/src/stores/developer.ts`
- Create: `apps/desktop/src/stores/publishing.ts`
- Create: `apps/desktop/tests/components/workflow-publishing.test.ts`

**Interfaces:**
- Inspector on `/developer` has tabs `调试` and `发布`.
- Publish panel displays readiness, debug proof, immutable snapshot summary, quota hints, current active submission and history.
- Submission button cannot bypass unsaved files/validation/debug proof/compatibility confirmation.

- [ ] **Step 1: 写组件与 store 失败测试**

覆盖 tab 切换、默认 Debug、缺 package/lock 的确认、dirty flush、invalid validation、无成功 debug、hash stale、提交 loading 防重复、5/50 远端错误文案、build_failed/rejected actionable detail、重新发布同版本条件、项目切换取消陈旧响应。

- [ ] **Step 2: 运行测试并确认 RED**

Run:

```bash
pnpm --dir apps/desktop exec node scripts/run-vitest-electron.mjs run \
  --config vitest.renderer.config.ts \
  tests/components/workflow-publishing.test.ts
```

Expected: 失败。

- [ ] **Step 3: 实现 publishing store 的竞态保护**

state 按 projectId 缓存 readiness/current/history，所有 async load 使用递增 request version；submit 中依次 `flushPendingSaves()`、`developer.build()`、`developer.validate()`、`getProjectReadiness()`、用户确认兼容生成、`submitProject()`。任何一步失败停止，不连续猜测重试。

- [ ] **Step 4: 实现 PublishPanel**

显示版本、分类、权限、文件数/大小/hash、最后调试时间、服务器将重新构建的说明。提交确认明确“上传不可变源码快照并占用一次服务端构建额度”。状态时间线使用服务端 event；rejected 显示结构化分类与详情，提供回到编辑，不自动改版本。

- [ ] **Step 5: 验证可访问性与响应式**

tabs 使用 button/aria-selected/keyboard arrows；错误 `role=alert`；320px inspector 不横向溢出；窄屏抽屉仍可滚动并保持主操作可达。

Run: Step 2 test command.

Run: `pnpm --filter @autoforge/desktop typecheck`

Expected: 均通过。

- [ ] **Step 6: 提交**

```bash
git add apps/desktop/src/components/InspectorPanel.vue apps/desktop/src/components/developer/PublishPanel.vue apps/desktop/src/stores/developer.ts apps/desktop/src/stores/publishing.ts apps/desktop/tests/components/workflow-publishing.test.ts
git commit -m "feat: add developer publishing panel"
```

---

### Task 5: 实现角色投影、审核导航和双重路由守卫

**Files:**
- Modify: `apps/desktop/src/stores/auth.ts`
- Modify: `apps/desktop/src/router/index.ts`
- Modify: `apps/desktop/src/components/AppRail.vue`
- Create: `apps/desktop/src/views/ReviewsView.vue`
- Modify: `apps/desktop/tests/components/auth.test.ts`
- Create: `apps/desktop/tests/components/workflow-reviews.test.ts`

**Interfaces:**
- Auth store restores Publisher `/v1/me` roles after CloudBase session restore.
- `/reviews` route requires auth and `super_admin`; nav appears between Developer and Executions only for the role.
- Direct navigation without role redirects to `/chat` with non-sensitive denied state.

- [ ] **Step 1: 写失败测试**

覆盖 role restore success/failure、普通用户无 nav、管理员 nav 顺序、普通用户 direct route denied、role load pending 不闪现页面、服务端 403 后清 stale role 并退出 review view。

- [ ] **Step 2: 运行测试并确认 RED**

Run:

```bash
pnpm --dir apps/desktop exec node scripts/run-vitest-electron.mjs run \
  --config vitest.renderer.config.ts \
  tests/components/auth.test.ts \
  tests/components/workflow-reviews.test.ts
```

Expected: 失败。

- [ ] **Step 3: 实现 role projection 与 guard**

auth state 加 `publisherRoles` 和 `rolesInitialized`，登录/restore 后调用 `publishing.getMe()`；网络失败不注销 CloudBase session，但把 admin capability 设为不可用。guard 在 requiresRole 路由等待 role 初始化，再判断；不要接受 query/localStorage role。

- [ ] **Step 4: 实现导航与页面骨架**

AppRail items 改为 computed；插入 `/reviews` 于 `/developer` 与 `/executions` 之间。ReviewsView 建立 `待审核 / 历史 / 发布版本 / 设置` 四 tab，首版每个 tab 有 loading/empty/error，不在本任务实现详情逻辑。

- [ ] **Step 5: 验证**

运行 Step 2 命令。

Run: `pnpm --filter @autoforge/desktop typecheck`

Expected: 均通过。

- [ ] **Step 6: 提交**

```bash
git add apps/desktop/src/stores/auth.ts apps/desktop/src/router/index.ts apps/desktop/src/components/AppRail.vue apps/desktop/src/views/ReviewsView.vue apps/desktop/tests/components/auth.test.ts apps/desktop/tests/components/workflow-reviews.test.ts
git commit -m "feat: gate workflow review workspace"
```

---

### Task 6: 实现审核列表、详情、沙箱与决策交互

**Files:**
- Create: `apps/desktop/src/stores/reviews.ts`
- Create: `apps/desktop/src/components/reviews/ReviewQueue.vue`
- Create: `apps/desktop/src/components/reviews/ReviewDetail.vue`
- Create: `apps/desktop/src/components/reviews/ReviewDecisionDialog.vue`
- Create: `apps/desktop/src/components/reviews/ReleaseAdmin.vue`
- Create: `apps/desktop/src/components/reviews/PolicySettings.vue`
- Modify: `apps/desktop/src/views/ReviewsView.vue`
- Modify: `apps/desktop/tests/components/workflow-reviews.test.ts`

**Interfaces:**
- Queue/detail consume server cursors and decisionVersion.
- Approval sends the full checklist, Moderate acknowledgement, note and explicit selfReviewConfirmation.
- Rejection sends category and actionable detail; stale decision shows conflict and reloads.

- [ ] **Step 1: 写 store/decision 失败测试**

覆盖分页竞态、详情权限报告、源码仅 admin 请求、Moderate warning gate、批准 checklist、驳回长度/类别、自审醒目标记+二次确认+备注、并发 `STATE_CONFLICT` reload、发布中 retry display、revoke reason、policy 5/50 修改与 server clamp 结果。

- [ ] **Step 2: 运行测试并确认 RED**

Run:

```bash
pnpm --dir apps/desktop exec node scripts/run-vitest-electron.mjs run \
  --config vitest.renderer.config.ts \
  tests/components/workflow-reviews.test.ts
```

Expected: 失败。

- [ ] **Step 3: 实现三栏审核工作区**

左侧 queue 筛选/分页，中间材料（manifest diff、权限、dependencies/licenses/vulnerabilities、build report、源码文件树与只读内容），右侧 sticky 决策栏。源码内容按选中文件按需获取，不进入持久缓存；离开详情清除。

- [ ] **Step 4: 实现沙箱与决策**

沙箱按钮启动云端候选运行并轮询/订阅结果，不调用本地 install。批准按钮只有所有必填清单满足才可用。自审用单独 warning block 和第二个确认 dialog，自动附 `selfReview=true` 但仍要求人工 note。提交后立即锁按钮，成功刷新队列。

- [ ] **Step 5: 实现 history/releases/settings tabs**

history 显示 actor/self-review/reason；releases 显示 publishing/published/revoked、签名 key、撤销操作；settings 仅允许编辑 5/50 两数与分类显示名/排序/enabled，并展示不可配置安全规则只读说明。

- [ ] **Step 6: 验证**

运行 Step 2 命令。

Run: `pnpm --filter @autoforge/desktop typecheck`

Expected: 均通过。

- [ ] **Step 7: 提交**

```bash
git add apps/desktop/src/stores/reviews.ts apps/desktop/src/components/reviews apps/desktop/src/views/ReviewsView.vue apps/desktop/tests/components/workflow-reviews.test.ts
git commit -m "feat: add workflow review workspace"
```

---

### Task 7: 实现站内通知与状态同步

**Files:**
- Create: `apps/desktop/src/stores/publisher-notifications.ts`
- Create: `apps/desktop/src/components/PublisherNotificationCenter.vue`
- Modify: `apps/desktop/src/layouts/WorkbenchLayout.vue`
- Modify: `apps/desktop/electron/main/publishing/publishing-service.ts`
- Modify: `packages/shared/src/desktop-api.ts`
- Create: `apps/desktop/tests/components/publisher-notifications.test.ts`

**Interfaces:**
- Desktop API: list unread notifications, mark read, and subscribe/poll while authenticated.
- Notification kinds: build_failed, pending_review, rejected, approved, published, revoked.
- Clicking navigates to own submission or admin review/release according to role.

- [ ] **Step 1: 写失败测试**

覆盖账号隔离、未读数、mark read、重复 event 去重、登出清空、离线保留最后安全摘要、普通用户不能通过通知打开 review route、rejected detail 显示。

- [ ] **Step 2: 运行测试并确认 RED**

Run:

```bash
pnpm --dir apps/desktop exec node scripts/run-vitest-electron.mjs run \
  --config vitest.renderer.config.ts \
  tests/components/publisher-notifications.test.ts
```

Expected: 失败。

- [ ] **Step 3: 实现轮询与生命周期**

登录后每 30 秒用 cursor 拉增量，窗口隐藏时降为 2 分钟，offline 时停止；恢复网络立即拉一次。登出取消 timer/requests 并清内存。服务端通知正文已安全化，客户端本地只缓存 id/kind/title/timestamp/read/targetId。

- [ ] **Step 4: 实现通知中心**

Workbench header 增铃铛、badge、popover；键盘可访问、错误不遮挡主工作区。发布面板/审核 store 收到相关通知时只标 stale，由用户可见页面触发刷新，避免后台覆盖正在填写的表单。

- [ ] **Step 5: 验证**

运行 Step 2 命令。

Run: `pnpm --filter @autoforge/desktop typecheck`

Expected: 均通过。

- [ ] **Step 6: 提交**

```bash
git add apps/desktop/src/stores/publisher-notifications.ts apps/desktop/src/components/PublisherNotificationCenter.vue apps/desktop/src/layouts/WorkbenchLayout.vue apps/desktop/electron/main/publishing/publishing-service.ts packages/shared/src/desktop-api.ts apps/desktop/tests/components/publisher-notifications.test.ts
git commit -m "feat: add publishing notifications"
```

---

### Task 8: 桌面提交流程与审核流程集成验证

**Files:**
- Create: `apps/desktop/e2e/workflow-publishing.spec.ts`
- Create: `apps/desktop/e2e/fixtures/fake-publisher-server.ts`
- Create: `apps/desktop/electron/main/publishing/publishing-flow.integration.test.ts`
- Create: `playwright.config.ts`
- Create: `docs/runbooks/workflow-publishing-desktop-qa.md`

**Interfaces:**
- Integration test exercises Main with real temp project/archive and contract-faithful fake HTTP server.
- Headless E2E exercises Renderer/IPC without real cloud mutation; CloudBase test-environment smoke remains a separate runbook step.

- [ ] **Step 1: 写 Main 集成测试**

真实 temp project：编辑 → build → completed debug proof → package → upload → submit；检查 archive 无绝对路径/本机文件/token，server receives matching hash。另测 stale debug、upload abort cleanup、限额和 rejection。

- [ ] **Step 2: 写 headless E2E**

普通开发者：发布 tab → compatibility confirm → submit → build_failed/rejected 展示。super_admin：看到 Reviews → 打开材料 → 自审二次确认 → approve → publishing。普通用户 direct `/reviews` 被拒绝。

- [ ] **Step 3: 运行新集成测试并确认 RED**

Run:

```bash
pnpm --dir apps/desktop exec node scripts/run-vitest-electron.mjs run \
  --config vitest.node.config.ts \
  electron/main/publishing/publishing-flow.integration.test.ts
```

Run: `pnpm build && pnpm exec playwright test apps/desktop/e2e/workflow-publishing.spec.ts --project=electron`

Expected: 至少一项失败，因为 contract-faithful fake Publisher 的依赖注入、Electron 启动配置或跨层状态刷新尚未接通；失败断言必须落在发布流程，不接受选择器拼写错误作为 RED。

- [ ] **Step 4: 接通测试 harness 并运行 focused verification**

把 fake server 仅注入测试构建的 Publisher base URL 和确定性账号/角色；等待状态使用可观察 UI/API 条件，不用固定 sleep。

Run:

```bash
pnpm --dir apps/desktop exec node scripts/run-vitest-electron.mjs run \
  --config vitest.node.config.ts \
  electron/main/publishing/publishing-flow.integration.test.ts
```

Run: `pnpm build && pnpm exec playwright test apps/desktop/e2e/workflow-publishing.spec.ts --project=electron`

Expected: 均通过且不打开 headed browser。

- [ ] **Step 5: 对 CloudBase 测试环境做真实冒烟**

按 QA runbook 使用测试账号：完成成功 debug、提交、服务端构建、管理员（含一次自审场景）审核、发布中/发布成功通知。核对 Renderer devtools/log 不含 token/source。正式 feature flag 仍关闭。

- [ ] **Step 6: 全量回归**

Run: `pnpm lint`

Run: `pnpm typecheck`

Run: `pnpm test`

Run: `pnpm build`

Expected: 全部通过；若有与本分支无关的既有失败，记录准确命令和失败文件，不把它描述为本功能通过。

- [ ] **Step 7: 提交**

```bash
git add apps/desktop/e2e apps/desktop/electron/main/publishing/publishing-flow.integration.test.ts playwright.config.ts docs/runbooks/workflow-publishing-desktop-qa.md
git commit -m "test: cover desktop publishing and reviews"
```

---

## Phase Completion Gate

- [ ] CloudBase token 和源码未穿过 preload/IPC，Publisher API 只从 Electron Main 调用。
- [ ] 发布按钮只接受与最近成功调试完全相同 buildHash 的已保存项目。
- [ ] 开发页具有调试/发布双页签，驳回后可明确回到编辑并重提。
- [ ] `/reviews` 只对 super_admin 投影可见，并同时有客户端 guard 与服务端 403。
- [ ] 超级管理员可自审，但 UI 与 API 都要求二次确认、备注和完整机器/人工清单。
- [ ] 站内通知覆盖 build failure、驳回、批准、发布、撤销，登出后无跨账号残留。
- [ ] headless E2E、Main 集成测试与 CloudBase 测试环境冒烟均有记录；正式 feature flag 保持关闭。
