# Workflow Marketplace and Signed Installation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为登录用户提供工作流大厅、已安装版本管理、签名下载与本地验证、手动升级/回退、离线缓存和撤销后在线禁用机制。

**Architecture:** Publisher Service 只公开已发布且未撤销工作流的最小元数据，并为特定 release 颁发短时下载 URL。Electron Main 下载 manifest/runtime/signature，使用内置可信根验证签名链和所有 hash 后，通过现有隔离安装目录与事务日志原子安装。SQLite 保存 release 来源、签名 key、校验状态、权限快照和上次在线状态；Renderer 只看到安全 DTO。升级先安装新版本，成功后启用新版本并禁用旧版本，旧版本保留用于显式回退。

**Tech Stack:** TypeScript 6, Electron 43, Vue 3.5, Pinia 4, Zod, Node crypto/Web Crypto, better-sqlite3, Drizzle, CloudBase Storage signed URLs, Vitest, Playwright headless.

**Spec:** `docs/superpowers/specs/2026-08-21-workflow-publishing-review-distribution-design.md`

## Global Constraints

- 依赖计划：前三份计划 Phase Completion Gate 全部完成，至少有一个测试环境 `published` release。
- 大厅仅登录用户可访问；客户端不得显示或下载 `publishing`、`revoked`、未审核候选和源码。
- 任何网络下载内容在签名、manifest hash、runtime hash、大小和契约全部通过前不得进入正式安装目录或数据库。
- 首发只安装每个 workflow 最新稳定版；历史版本可查看，但不得从大厅新装。已本地持有的旧版本可用于回退。
- 不自动升级。升级必须由用户明确触发，先装新、后启用新、再禁用旧；失败保持旧版本启用。
- 权限授予按 `workflowId@version` 保存；新版本不得继承旧版本超出新 manifest 的 grant，也不得静默扩大权限。
- 撤销后服务端立即停止下载；客户端下一次在线同步后禁用该版本。离线设备存在延迟，UI 必须显示上次同步时间。
- 本地开发项目与官方安装版本分区展示和存储；同 id/version 也不得相互覆盖。
- trusted publisher 来自 CloudBase owner；`workflow.json.author` 仅作署名，不参与信任。
- 不打开可见浏览器；E2E 使用 headless。

---

### Task 1: 实现公开大厅、版本和下载票据 API

**Files:**
- Create: `apps/publisher-service/src/routes/marketplace-routes.ts`
- Create: `apps/publisher-service/src/routes/marketplace-routes.test.ts`
- Create: `apps/publisher-service/src/services/marketplace-service.ts`
- Create: `apps/publisher-service/src/services/marketplace-service.test.ts`
- Modify: `packages/publishing-contracts/src/contracts.ts`
- Modify: `packages/publishing-contracts/src/contracts.test.ts`

**Interfaces:**
- `GET /v1/marketplace/workflows` filters category/search and returns one card per workflow at latest published stable version.
- `GET /v1/marketplace/workflows/:workflowId` returns latest plus visible history metadata.
- `POST /v1/marketplace/releases/:releaseId/download` returns short-lived URLs for manifest/runtime/signature and immutable expected hashes/sizes.
- `GET /v1/releases/status?ids=...` returns published/revoked status for installed release IDs.

- [ ] **Step 1: 写 API 失败测试**

覆盖匿名 401、仅 latest stable card、publishing/revoked hidden、历史不可 download、latest revoked 后回退到仍 published 的下一最新版本或无 card、disabled category 历史仍可识别、cursor/search/category、下载 ticket release/user scoped、ticket 日志无 query secret。

- [ ] **Step 2: 运行测试并确认 RED**

Run: `pnpm --filter @autoforge/publishing-contracts test`

Run: `pnpm --filter @autoforge/publisher-service test -- marketplace-routes.test.ts marketplace-service.test.ts`

Expected: 失败。

- [ ] **Step 3: 扩展严格公开契约**

大厅 DTO 只含：workflowId、latest version/releaseId、name/summary/category、owner displayName、author attribution、permissions summary、publishedAt、size、signature key id。详情历史不含 source/candidate/build log/reviewer private note。下载 ticket URL 必须 canonical HTTPS 且 expiresAt 最长 5 分钟。

- [ ] **Step 4: 实现查询与 ticket**

查询使用 window function/distinct-on 从 `published` release 选最高 SemVer；不能按字符串排序，写入时保存 SemVer major/minor/patch 或在仓储中可靠比较。下载前再次锁/读取 release status，只对正式 artifact 的精确 object key 颁发 read ticket。

- [ ] **Step 5: 验证**

运行 Step 2 命令。

Run: `pnpm --filter @autoforge/publisher-service typecheck`

Expected: 均通过。

- [ ] **Step 6: 提交**

```bash
git add apps/publisher-service/src/routes/marketplace-routes* apps/publisher-service/src/services/marketplace-service* packages/publishing-contracts/src
git commit -m "feat: expose signed workflow marketplace"
```

---

### Task 2: 扩展本地安装模型和可信签名 key 存储

**Files:**
- Modify: `apps/desktop/electron/main/database/schema.ts`
- Create: `apps/desktop/resources/migrations/0009_published_workflow_installations.sql`
- Modify: `apps/desktop/electron/main/database/database.test.ts`
- Create: `apps/desktop/electron/main/publishing/signing-key-store.ts`
- Create: `apps/desktop/electron/main/publishing/signing-key-store.test.ts`
- Modify: `apps/desktop/electron/main/database/repositories.ts`

**Interfaces:**
- Extends installed workflow record with nullable `releaseId`, `publisherUserId`, `signingKeyId`, `signatureAlgorithm`, `verifiedAt`, `releaseStatus`, `lastStatusSyncAt` and `origin='local'|'official'`.
- Stores trusted signing key metadata and public key, never private key.
- Existing rows migrate to `origin='local'` without behavior change.

- [ ] **Step 1: 写迁移和 key store 失败测试**

覆盖旧 DB migrate、official releaseId unique、local row nullable、key add/rotate/retire、同 keyId 不同 material 拒绝、未知算法拒绝、仍被安装引用的 retired key 可验证。

- [ ] **Step 2: 运行测试并确认 RED**

Run:

```bash
pnpm --dir apps/desktop exec node scripts/run-vitest-electron.mjs run \
  --config vitest.node.config.ts \
  electron/main/database/database.test.ts \
  electron/main/publishing/signing-key-store.test.ts
```

Expected: 失败。

- [ ] **Step 3: 实现向后兼容 migration**

新增字段有明确 default/nullability；为 `release_id IS NOT NULL` 建 unique index。权限仍使用现有 version scoped key。迁移不能修改现有 installPath 或启用状态。

- [ ] **Step 4: 实现可信根与远端 key 更新**

应用包内置首个 key 的 id/algorithm/public key fingerprint。远端 key list 必须由当前已信任 key 签名的 keyset envelope 或应用升级带入的新根验证；不能仅通过 TLS 下载就信任陌生 key。rotation 先加入新 key，旧 key保留验证历史 release。

- [ ] **Step 5: 验证**

运行 Step 2 命令。

Run: `pnpm --filter @autoforge/desktop typecheck`

Expected: 均通过。

- [ ] **Step 6: 提交**

```bash
git add apps/desktop/electron/main/database apps/desktop/electron/main/publishing/signing-key-store*
git commit -m "feat: persist official workflow trust metadata"
```

---

### Task 3: 实现正式包下载与密码学验证

**Files:**
- Create: `apps/desktop/electron/main/publishing/release-downloader.ts`
- Create: `apps/desktop/electron/main/publishing/release-downloader.test.ts`
- Create: `apps/desktop/electron/main/publishing/release-verifier.ts`
- Create: `apps/desktop/electron/main/publishing/release-verifier.test.ts`
- Create: `apps/desktop/electron/main/publishing/fixtures/README.md`
- Modify: `apps/desktop/electron/main/publishing/publisher-client.ts`

**Interfaces:**
- Downloader writes only to an owned `mkdtemp` directory with byte/time limits and redirects disabled or constrained to the configured storage origin.
- Verifier consumes ticket expectations, canonical manifest bytes, runtime bytes, signature and trusted public key.
- Produces `VerifiedReleaseArtifact`; unverified paths/bytes are never accepted by installer.

- [ ] **Step 1: 写攻击 fixture 失败测试**

覆盖 valid release、manifest/runtime tamper、wrong release/workflow/version/hash/size/key/algorithm/signature、unknown/retired-but-valid key、extra manifest field、oversize/chunked overflow、redirect to other origin、partial download、revoked between ticket and download。

- [ ] **Step 2: 运行测试并确认 RED**

Run:

```bash
pnpm --dir apps/desktop exec node scripts/run-vitest-electron.mjs run \
  --config vitest.node.config.ts \
  electron/main/publishing/release-downloader.test.ts \
  electron/main/publishing/release-verifier.test.ts
```

Expected: 失败。

- [ ] **Step 3: 实现流式下载**

每个 artifact 读取时累计 bytes/hash，超过 ticket size 或全局固定上限立即 abort；下载完成要求 exact size/hash。URL 不写日志，错误只含 releaseId/artifact kind/requestId。临时目录 finally 删除，只有 VerifiedReleaseArtifact 可延长生命周期至 install 完成。

- [ ] **Step 4: 实现验证顺序**

固定顺序：parse strict manifest → canonicalize → compare manifestSha256 → 查 trusted key/fingerprint → verify signature over manifest digest/canonical bytes（与 signer 契约一致）→ compare ticket identity/status → hash runtime → verify runtime metadata。任何失败返回统一 `WORKFLOW_SIGNATURE_INVALID` 或更窄的安全错误，不回显签名/URL。

- [ ] **Step 5: 验证**

运行 Step 2 命令。

Run: `pnpm --filter @autoforge/desktop typecheck`

Expected: 所有 tamper fixture 在写正式目录前失败。

- [ ] **Step 6: 提交**

```bash
git add apps/desktop/electron/main/publishing/release-downloader* apps/desktop/electron/main/publishing/release-verifier* apps/desktop/electron/main/publishing/fixtures apps/desktop/electron/main/publishing/publisher-client.ts
git commit -m "feat: verify signed workflow releases"
```

---

### Task 4: 抽取双调用方安装事务并安装官方 release

**Files:**
- Create: `apps/desktop/electron/main/workflows/installation-transaction.ts`
- Create: `apps/desktop/electron/main/workflows/installation-transaction.test.ts`
- Modify: `apps/desktop/electron/main/workflows/project-service.ts`
- Modify: `apps/desktop/electron/main/workflows/project-service.test.ts`
- Create: `apps/desktop/electron/main/publishing/published-workflow-installer.ts`
- Create: `apps/desktop/electron/main/publishing/published-workflow-installer.test.ts`
- Modify: `apps/desktop/electron/main/workflows/registry.ts`
- Modify: `apps/desktop/electron/main/workflows/retriever.test.ts`

**Interfaces:**
- `InstallationTransaction` has exactly two real callers: existing local ProjectService and new PublishedWorkflowInstaller.
- Official installer only accepts `VerifiedReleaseArtifact`, writes `origin='official'`, immutable release metadata and per-file hashes.
- Registry exposes local development and official installed sources without collision.

- [ ] **Step 1: 先写现有行为 characterization tests**

固定现有 install success、same version conflict、concurrent serialization、persistence failure cleanup、quarantine recovery、integrity failure disable；新测试 official success、unverified type cannot be constructed at runtime boundary、local/official namespace separation、releaseId idempotency。

- [ ] **Step 2: 运行测试并确认 RED（现有绿、新增红）**

Run:

```bash
pnpm --dir apps/desktop exec node scripts/run-vitest-electron.mjs run \
  --config vitest.node.config.ts \
  electron/main/workflows/project-service.test.ts \
  electron/main/workflows/installation-transaction.test.ts \
  electron/main/publishing/published-workflow-installer.test.ts
```

Expected: 现有 project tests 通过，新文件测试失败。

- [ ] **Step 3: 最小抽取现有安装事务**

只抽取已有两个调用方共同需要的：owned staging dir、journal、atomic rename、DB callback、rollback/quarantine、lock。ProjectService 的 build/validate/manifest 逻辑保留原处。抽取前后现有 tests 必须无变化通过。

- [ ] **Step 4: 实现 official installer**

把 verified runtime 写为规范 `dist/index.js`，写规范 manifest/signature metadata/owner marker，inventory hash 入 DB；目标路径包含 official namespace，不能覆盖 local install。事务成功后才删除 download temp；失败恢复旧状态且不产生 DB row。

- [ ] **Step 5: 扩展 registry/retriever**

官方安装仍以现有 VM/SDK permission runtime 执行，不启用 Node host modules。列表 key 使用 workflowId@version@origin 或等价稳定 key；development 模式仅额外显示本地开发项。

- [ ] **Step 6: 验证**

运行 Step 2 命令。

Run: `pnpm --filter @autoforge/desktop typecheck`

Expected: 现有与新增安装测试均通过。

- [ ] **Step 7: 提交**

```bash
git add apps/desktop/electron/main/workflows apps/desktop/electron/main/publishing/published-workflow-installer*
git commit -m "feat: atomically install verified releases"
```

---

### Task 5: 扩展 Desktop API 与 Marketplace Main Service

**Files:**
- Modify: `packages/shared/src/desktop-api.ts`
- Modify: `packages/shared/src/contracts.test.ts`
- Modify: `apps/desktop/electron/preload/bridge.ts`
- Modify: `apps/desktop/electron/main/ipc/register-ipc.ts`
- Modify: `apps/desktop/electron/main/ipc/register-ipc.test.ts`
- Modify: `apps/desktop/electron/main/application.ts`
- Create: `apps/desktop/electron/main/publishing/marketplace-service.ts`
- Create: `apps/desktop/electron/main/publishing/marketplace-service.test.ts`

**Interfaces:**
- Desktop API adds `marketplace.list/get/installLatest` and `officialWorkflows.listVersions/upgrade/rollback/syncStatuses`.
- IPC takes release/workflow identifiers only, never URL/path/public key/source.
- Main coordinates ticket → download → verify → install → enable switch.

- [ ] **Step 1: 写契约与协调失败测试**

覆盖严格 params、非 latest install blocked、unpublished/revoked blocked、download verification failure no install、successful install、duplicate release idempotent、upgrade failure old enabled、upgrade success new enabled/old disabled、rollback only locally held verified version。

- [ ] **Step 2: 运行测试并确认 RED**

Run: `pnpm exec vitest run packages/shared/src/contracts.test.ts`

Run:

```bash
pnpm --dir apps/desktop exec node scripts/run-vitest-electron.mjs run \
  --config vitest.node.config.ts \
  electron/main/publishing/marketplace-service.test.ts \
  electron/main/ipc/register-ipc.test.ts
```

Expected: 失败。

- [ ] **Step 3: 实现 Main service**

`installLatest(workflowId)` 先拉详情并确认 releaseId 与 latest；获取 ticket 后再次确认 identity。`upgrade` 先完整安装新版本，再在 SQLite 单事务切换 enabled flags；若权限需要新增，安装成功但保持 disabled，返回 `permissionsRequired` 由用户确认后启用。`rollback` 仅选择本地 verified 且非 revoked 的旧版本。

- [ ] **Step 4: 实现 IPC/preload**

复用共享 schema parse，Renderer 只收到 marketplace metadata、安装进度阶段和安全错误。安装进度阶段固定 `requesting_download/downloading/verifying/installing/activating`；不暴露 URL/path。

- [ ] **Step 5: 验证**

运行 Step 2 命令。

Run: `pnpm --filter @autoforge/shared typecheck && pnpm --filter @autoforge/desktop typecheck`

Expected: 均通过。

- [ ] **Step 6: 提交**

```bash
git add packages/shared/src apps/desktop/electron/preload/bridge.ts apps/desktop/electron/main/ipc apps/desktop/electron/main/application.ts apps/desktop/electron/main/publishing/marketplace-service*
git commit -m "feat: expose signed marketplace installation"
```

---

### Task 6: 实现“工作流大厅 / 已安装”界面

**Files:**
- Modify: `apps/desktop/src/views/WorkflowsView.vue`
- Modify: `apps/desktop/src/stores/workflow.ts`
- Create: `apps/desktop/src/stores/marketplace.ts`
- Create: `apps/desktop/src/components/workflows/MarketplaceGrid.vue`
- Create: `apps/desktop/src/components/workflows/MarketplaceDetail.vue`
- Create: `apps/desktop/src/components/workflows/InstalledWorkflowList.vue`
- Create: `apps/desktop/tests/components/workflow-marketplace.test.ts`

**Interfaces:**
- Workflows page top-level tabs: `工作流大厅` and `已安装`.
- Marketplace one card per workflow, latest stable install only; detail may show older metadata without install action.
- Installed lists official and local/development with explicit source badges and version controls.

- [ ] **Step 1: 写 UI/store 失败测试**

覆盖登录后默认大厅、offline cached badge、search/category竞态、one-card/latest、history no install button、install stages、signature error、installed source labels、manual upgrade、permission confirmation、rollback、local dev preserved、empty/error/keyboard states。

- [ ] **Step 2: 运行测试并确认 RED**

Run:

```bash
pnpm --dir apps/desktop exec node scripts/run-vitest-electron.mjs run \
  --config vitest.renderer.config.ts \
  tests/components/workflow-marketplace.test.ts
```

Expected: 失败。

- [ ] **Step 3: 实现 marketplace store**

query/search/category 使用 request version 和 250ms debounce；缓存按登录 UID 分区，仅保存公开 metadata/lastFetchedAt，不保存 ticket。offline 时读 cache 并标 `离线缓存`，安装按钮 disabled。安装/升级状态按 workflowId 隔离，避免全页锁定。

- [ ] **Step 4: 实现页面层级**

卡片显示 name/summary/category/owner/version/permissions summary/size/publishedAt。详情把“发布者（可信 owner）”与“作者署名”分开。已安装页按 workflow 聚合版本，突出 active、revoked、integrity failed、local development；删除仍复用现有确认流程。

- [ ] **Step 5: 实现升级/回退确认**

升级 dialog 显示版本差异、权限差异和“不会自动更新”。新权限必须逐项确认；成功后提示旧版本仍保留可回退。回退提示使用旧版本权限快照，不能自动恢复已撤销 grant。

- [ ] **Step 6: 验证**

运行 Step 2 命令。

Run: `pnpm --filter @autoforge/desktop typecheck`

Expected: 均通过且 1024px 宽无横向溢出。

- [ ] **Step 7: 提交**

```bash
git add apps/desktop/src/views/WorkflowsView.vue apps/desktop/src/stores/workflow.ts apps/desktop/src/stores/marketplace.ts apps/desktop/src/components/workflows apps/desktop/tests/components/workflow-marketplace.test.ts
git commit -m "feat: add workflow marketplace UI"
```

---

### Task 7: 实现撤销同步、离线策略和版本级权限

**Files:**
- Create: `apps/desktop/electron/main/publishing/release-status-sync.ts`
- Create: `apps/desktop/electron/main/publishing/release-status-sync.test.ts`
- Modify: `apps/desktop/electron/main/workflows/execution-service.ts`
- Modify: `apps/desktop/electron/main/workflows/execution-service.test.ts`
- Modify: `apps/desktop/electron/main/permissions/policy-engine.ts`
- Modify: `apps/desktop/electron/main/permissions/policy-engine.test.ts`
- Modify: `apps/desktop/electron/main/database/repositories.ts`
- Modify: `apps/desktop/electron/main/application.ts`
- Modify: `apps/desktop/src/stores/workflow.ts`

**Interfaces:**
- Sync runs after login/network restore/app start and periodically while online; batches installed release IDs.
- Revoked official versions are atomically marked revoked and disabled before further execution.
- Execution gate rechecks local releaseStatus/integrity and exact version permissions.

- [ ] **Step 1: 写撤销与权限失败测试**

覆盖 startup online revoke disable、network restore revoke、offline delay keeps last known state with timestamp、server unknown does not falsely revoke、revoked execution blocked、in-flight execution policy（完成当前步骤后中止或立即取消）固定为收到同步后禁止下一步 capability、new version no grant inheritance、rollback asks exact old-version grants。

- [ ] **Step 2: 运行测试并确认 RED**

Run:

```bash
pnpm --dir apps/desktop exec node scripts/run-vitest-electron.mjs run \
  --config vitest.node.config.ts \
  electron/main/publishing/release-status-sync.test.ts \
  electron/main/workflows/execution-service.test.ts \
  electron/main/permissions/policy-engine.test.ts
```

Expected: 失败。

- [ ] **Step 3: 实现同步与原子禁用**

每批最多 100 IDs；response 严格匹配请求 IDs。SQLite transaction 更新 releaseStatus/lastStatusSyncAt，revoked 同时 enabled=false 并撤销该 version 的 active permission grants。网络/5xx 仅记录 sync error 和旧 timestamp，不改变 status。

- [ ] **Step 4: 加强 execution gate**

启动 execution 前检查 exact installed row：official 必须 signature verified、integrity valid、releaseStatus published、enabled。每个 capability step 前再次检查 revoke generation，收到在线撤销后不执行新的宿主动作。local development 路径不套 official releaseStatus，但仍走现有权限系统。

- [ ] **Step 5: 实现调度生命周期**

登录完成立即 sync，online event 立即 sync，前台每 15 分钟 sync，后台每 60 分钟；登出停止并清 UID-specific cache。计时器和 request 在 app shutdown 正确关闭。

- [ ] **Step 6: 验证**

运行 Step 2 命令。

Run: `pnpm --filter @autoforge/desktop typecheck`

Expected: 均通过。

- [ ] **Step 7: 提交**

```bash
git add apps/desktop/electron/main/publishing/release-status-sync* apps/desktop/electron/main/workflows/execution-service* apps/desktop/electron/main/permissions/policy-engine* apps/desktop/electron/main/database/repositories.ts apps/desktop/electron/main/application.ts apps/desktop/src/stores/workflow.ts
git commit -m "feat: enforce workflow release revocation"
```

---

### Task 8: 大厅、安装、升级、回退和撤销端到端验证及上线

**Files:**
- Create: `apps/desktop/e2e/workflow-marketplace.spec.ts`
- Create: `apps/desktop/electron/main/publishing/marketplace-flow.integration.test.ts`
- Create: `docs/runbooks/workflow-marketplace-rollout.md`
- Modify: `scripts/verify-publisher-foundation.mjs`

**Interfaces:**
- Main integration uses real signed fixture and temp installation DB/filesystem.
- CloudBase smoke uses a test published release and real signed URLs/key.
- Rollout runbook controls feature flag, monitoring, rollback and emergency revoke.

- [ ] **Step 1: 写 Main 集成测试**

真实 crypto key/signature fixture：list → ticket → stream download → verify → install → execute；upgrade 1.0.0→1.1.0，旧版保留；rollback；tamper no install；revoked sync disable；offline installed workflow execute；offline marketplace cached/no install。

- [ ] **Step 2: 写 headless E2E**

测试大厅/已安装 tabs、搜索分类、latest only、install progress、权限确认、upgrade/rollback、revoked badge、local dev separation、offline cache。不得使用 headed mode。

- [ ] **Step 3: 运行新测试并确认 RED**

Run:

```bash
pnpm --dir apps/desktop exec node scripts/run-vitest-electron.mjs run \
  --config vitest.node.config.ts \
  electron/main/publishing/marketplace-flow.integration.test.ts
```

Run: `pnpm build && pnpm exec playwright test apps/desktop/e2e/workflow-marketplace.spec.ts --project=electron`

Expected: 至少一项失败，因为真实签名 fixture、下载服务器或 Electron 测试启动注入尚未接通；失败必须来自目标流程，不接受等待超时或选择器错误作为 RED。

- [ ] **Step 4: 接通 fixture/harness 并运行 focused tests**

fixture 使用测试私钥在测试进程中生成规范签名，不把私钥打进应用 bundle；HTTP server 严格返回与 Publisher API 相同 schema 和 byte limits。

Run:

```bash
pnpm --dir apps/desktop exec node scripts/run-vitest-electron.mjs run \
  --config vitest.node.config.ts \
  electron/main/publishing/marketplace-flow.integration.test.ts
```

Run: `pnpm build && pnpm exec playwright test apps/desktop/e2e/workflow-marketplace.spec.ts --project=electron`

Expected: 均通过。

- [ ] **Step 5: CloudBase 测试环境真实冒烟**

测试账号完成：登录 → 大厅看到单卡最新 stable → 安装并运行 → 发布新版本但不自动更新 → 手动升级 → 回退 → 管理员撤销当前版 → 客户端 online sync 后禁用 → 下载 API 拒绝。校验包无源码、签名 key rotation 前后旧包仍验证。

- [ ] **Step 6: 安全与全量回归**

Run: `pnpm lint`

Run: `pnpm typecheck`

Run: `pnpm test`

Run: `pnpm build`

Run: `node scripts/verify-publisher-foundation.mjs`

Expected: 均通过。检查日志/Renderer storage/安装目录不含 token、signed URL、源码、lockfile、审核材料。

- [ ] **Step 7: 分阶段开启 feature flag**

先 super_admin/test allowlist，再内部账号，再全部登录用户。每阶段监控 build failure 分类、publish retry、signature verification failure、install rollback、revoke sync lag。任一 signature/integrity 异常立即关闭 marketplace install flag，但保留本地已验证工作流执行和管理员撤销能力。

- [ ] **Step 8: 提交**

```bash
git add apps/desktop/e2e/workflow-marketplace.spec.ts apps/desktop/electron/main/publishing/marketplace-flow.integration.test.ts docs/runbooks/workflow-marketplace-rollout.md scripts/verify-publisher-foundation.mjs
git commit -m "test: verify signed workflow distribution"
```

---

## Phase Completion Gate

- [ ] 大厅只对登录用户开放，每个 workflow 只显示最新仍 published 的稳定版卡片。
- [ ] 所有安装在正式目录写入前完成可信 key、签名、manifest hash、runtime hash、size 和 identity 验证。
- [ ] 历史版本不能从大厅新装；已持有旧版可显式回退；系统不自动升级。
- [ ] 升级失败保持旧版启用；升级成功新启用旧禁用，新增权限必须再次确认。
- [ ] 撤销立即停止新下载，客户端下一次在线同步禁用；离线延迟和最后同步时间对用户可见。
- [ ] 本地开发工作流与官方版本不冲突，离线仍能使用本地/已验证安装工作流。
- [ ] CloudBase 真实端到端、tamper tests、headless UI、全量 lint/typecheck/test/build 均有通过证据。
- [ ] feature flag 按 allowlist 分阶段开启，存在可执行的紧急关闭和撤销 runbook。
