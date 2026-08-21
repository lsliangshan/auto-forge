# Workflow Publishing Secure Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将已受理源码提交置于隔离服务端环境中完成解包、依赖审计、静态扫描、构建、候选产物生成、审核决策、数字签名与原子发布。

**Architecture:** 新建内部 `publisher-builder` CloudRun 服务处理一次性构建任务，但不直连 PostgreSQL；它用服务身份向 Publisher Service 领取任务和短期对象票据，再回报结构化结果。Publisher Service 持有状态机和审核事务。Signer 是独立最小权限边界，只对已批准 release 的规范化 manifest 摘要签名；正式产物写入不可变私有对象，公开下载由 Publisher Service 颁发短期 URL。

**Tech Stack:** TypeScript 6, Node.js 22, Fastify, pnpm frozen lockfile, esbuild, tar streaming parser, SPDX license parser, OSV-compatible vulnerability adapter, CloudRun sandbox limits, CloudBase Storage, managed KMS/signing key, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-21-workflow-publishing-review-distribution-design.md`

## Global Constraints

- 依赖计划：先完成 `2026-08-21-workflow-publishing-cloud-foundation.md` 的 Phase Completion Gate。
- Builder 和 Signer 禁止直连业务 PostgreSQL，不得获得 bucket-wide storage credential。
- 构建只接受 `package.json` + `pnpm-lock.yaml`，依赖必须来自公开 npm registry 且为精确版本；禁止 lifecycle scripts、native addon、Git/file/http/private dependencies。
- 解包上限固定：压缩包 10 MiB、解包总量 10 MiB、单文件 2 MiB、最多 200 entries；禁止符号链接、硬链接、嵌套归档、绝对路径、`..`、`node_modules`、`dist`、`.env`。
- Node 兼容仅由构建期受控 shim 提供：`node:buffer`、`node:url`、`node:util` 和受限 `node:crypto`；最终 runtime 不暴露宿主 Node。
- 禁止 `eval`、`new Function`、WebAssembly、动态 require、无法静态解析的 import。
- 构建容器：5 分钟、2 vCPU、1 GiB 内存、1 GiB 临时磁盘；install 阶段仅可访问受控 npm proxy，之后禁网；不注入用户或生产凭据。
- 正式发布必须验证 runtime hash、manifest hash 和 KMS 签名；私钥不得导出或进入应用内存以外的 signer 调用边界。
- 平台失败自动最多重试 3 次且不计用户每日构建额度；项目失败不自动重试。
- 不打开可见浏览器；审核沙箱自动化使用 headless 且仅当前已支持的 browser capability。

---

### Task 1: 安全流式解包与源码包契约校验

**Files:**
- Create: `apps/publisher-builder/package.json`
- Create: `apps/publisher-builder/tsconfig.json`
- Create: `apps/publisher-builder/src/archive/source-archive-validator.ts`
- Create: `apps/publisher-builder/src/archive/source-archive-validator.test.ts`
- Create: `apps/publisher-builder/src/domain/build-report.ts`
- Create: `apps/publisher-builder/src/index.ts`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Consumes: readable tar.gz stream and expected archive SHA-256.
- Produces: validated temporary source tree plus deterministic file inventory `{ path, sizeBytes, sha256 }[]`.
- Rejects before writing outside assigned temp root.

- [ ] **Step 1: 写恶意归档失败测试**

用测试 fixture 构造绝对路径、`../`、Unicode/反斜杠绕过、symlink/hardlink、201 entries、2 MiB+1 file、解包总量超限、nested `.zip/.tar/.tgz`、`.env`、`node_modules`、`dist`、重复规范化路径和 gzip bomb；正常包必须通过。

- [ ] **Step 2: 运行测试并确认 RED**

Run: `pnpm --filter @autoforge/publisher-builder test -- source-archive-validator.test.ts`

Expected: 失败，因为 builder 包和 validator 不存在。

- [ ] **Step 3: 实现先校验后落盘的流式解包**

每个 entry 先把 `\` 转 `/`、NFC 规范化、`path.posix.normalize`，拒绝绝对路径、空路径、`.`、`..` segment 和重复 canonical path。仅允许 regular file/directory；累计原始流和解包字节，超限立即 abort。落盘路径必须通过 `path.resolve(tempRoot, entry)` 后验证仍以 `tempRoot + path.sep` 开头。

- [ ] **Step 4: 生成确定性 inventory**

按 UTF-8 byte order 排序，hash 使用流式 SHA-256；不读取本机工作区或任意绝对来源路径。临时根由 `mkdtemp` 创建，finally 中递归删除明确的临时根。

- [ ] **Step 5: 验证**

Run: `pnpm --filter @autoforge/publisher-builder test -- source-archive-validator.test.ts`

Run: `pnpm --filter @autoforge/publisher-builder typecheck`

Expected: 全部恶意 fixture 被拒绝，正常 fixture inventory 稳定。

- [ ] **Step 6: 提交**

```bash
git add apps/publisher-builder pnpm-lock.yaml
git commit -m "feat: validate workflow source archives"
```

---

### Task 2: 锁定依赖、许可证与漏洞策略

**Files:**
- Create: `apps/publisher-builder/src/dependencies/dependency-policy.ts`
- Create: `apps/publisher-builder/src/dependencies/dependency-policy.test.ts`
- Create: `apps/publisher-builder/src/dependencies/pnpm-installer.ts`
- Create: `apps/publisher-builder/src/dependencies/pnpm-installer.test.ts`
- Create: `apps/publisher-builder/src/dependencies/license-auditor.ts`
- Create: `apps/publisher-builder/src/dependencies/license-auditor.test.ts`
- Create: `apps/publisher-builder/src/dependencies/vulnerability-auditor.ts`
- Create: `apps/publisher-builder/src/dependencies/vulnerability-auditor.test.ts`

**Interfaces:**
- Consumes: strict `package.json`, `pnpm-lock.yaml`, configured npm proxy and injected vulnerability provider.
- Produces: installed dependency tree plus structured `dependencyReport`, `licenseReport`, `vulnerabilityReport`.
- Blocks: Critical/High vulnerability and licenses outside MIT/Apache-2.0/BSD-2-Clause/BSD-3-Clause/ISC/0BSD.

- [ ] **Step 1: 写策略失败测试**

覆盖 ranges/caret/tilde/tag、缺 lockfile、lock mismatch、Git/file/http/private registry、overrides 指向非 registry、`scripts`、package lifecycle、`.node` native file、unknown/compound license、Critical/High block、Moderate warning、Low record。

- [ ] **Step 2: 运行测试并确认 RED**

Run: `pnpm --filter @autoforge/publisher-builder test -- dependency-policy.test.ts pnpm-installer.test.ts license-auditor.test.ts vulnerability-auditor.test.ts`

Expected: 失败，因为策略未实现。

- [ ] **Step 3: 实现 package/lock 静态策略**

只允许 `dependencies`；`devDependencies` 可用于构建但同样进入审计和 bundle，禁止 optional/peer 造成运行期外部依赖。每个声明版本必须为 `semver.valid(value) === value`。解析 lock importer 并逐项与 package.json 精确一致。

- [ ] **Step 4: 实现受控安装器**

spawn 参数固定：

```ts
['install', '--frozen-lockfile', '--ignore-scripts', '--offline=false', '--config.ignore-dep-scripts=true']
```

环境白名单只保留 PATH、HOME 指向临时目录、受控 registry、proxy CA；清除 npm token、CloudBase secret 和宿主代理变量。超时/输出上限触发 kill process group。安装后扫描 `.node` 文件和依赖 manifest scripts，并拒绝。

- [ ] **Step 5: 实现许可证与漏洞适配器**

SPDX 表达式必须能归约为允许项；`OR` 只要存在明确允许分支即可，`AND` 的全部分支必须允许。漏洞 adapter 接收 lockfile 解析后的精确 package/version 列表，返回去重 findings；provider 不可用归类为平台失败，不得当作无漏洞。

- [ ] **Step 6: 验证**

Run: `pnpm --filter @autoforge/publisher-builder test -- dependency-policy.test.ts pnpm-installer.test.ts license-auditor.test.ts vulnerability-auditor.test.ts`

Run: `pnpm --filter @autoforge/publisher-builder typecheck`

Expected: 均通过。

- [ ] **Step 7: 提交**

```bash
git add apps/publisher-builder/src/dependencies
git commit -m "feat: audit workflow dependencies"
```

---

### Task 3: 实现 Node shim、动态代码和 capability 扫描

**Files:**
- Create: `packages/workflow-sdk/src/node-compat/buffer.ts`
- Create: `packages/workflow-sdk/src/node-compat/url.ts`
- Create: `packages/workflow-sdk/src/node-compat/util.ts`
- Create: `packages/workflow-sdk/src/node-compat/crypto.ts`
- Create: `packages/workflow-sdk/src/node-compat/index.test.ts`
- Create: `apps/publisher-builder/src/scans/source-scanner.ts`
- Create: `apps/publisher-builder/src/scans/source-scanner.test.ts`
- Create: `apps/publisher-builder/src/build/esbuild-workflow.ts`
- Create: `apps/publisher-builder/src/build/esbuild-workflow.test.ts`
- Modify: `packages/workflow-sdk/src/index.ts`

**Interfaces:**
- Consumes: validated source tree and manifest-declared browser capabilities.
- Produces: fully bundled ESM runtime with only `@autoforge/workflow-sdk` runtime bridge external.
- Maps allowed `node:*` imports to controlled browser-safe shims; all other Node imports fail.

- [ ] **Step 1: 写扫描和 bundling 失败测试**

覆盖允许的 Buffer/base64、URL、TextEncoder/util、crypto digest/random；拒绝 `node:fs/path/os/process/child_process/net/http/https/tls/dns/vm/module/worker_threads`、bare aliases、dynamic import expression、require、eval/new Function/Wasm、SDK 未实现 capability，以及 bundle 残留 external import。

- [ ] **Step 2: 运行测试并确认 RED**

Run: `pnpm --filter @autoforge/workflow-sdk test -- node-compat/index.test.ts`

Run: `pnpm --filter @autoforge/publisher-builder test -- source-scanner.test.ts esbuild-workflow.test.ts`

Expected: 失败。

- [ ] **Step 3: 实现最小 shim**

`crypto` 只暴露 WebCrypto 支持的 `randomUUID`、`getRandomValues`、`subtle.digest` 的薄封装；不模拟 createCipher、filesystem entropy、sync crypto。shim 不导出 `process` 或宿主对象。SDK 导出保持现有 API 兼容。

- [ ] **Step 4: 实现 AST 扫描与 esbuild 插件**

使用 parser/AST visitor 而非纯 regex 定位动态代码。esbuild resolver 将允许模块映射到 shim 文件，其他 `node:`/Node builtin 立即报稳定 diagnostic。`platform: 'browser'`、`format: 'esm'`、`bundle: true`，metafile 中除 SDK bridge 外不得有 external。

- [ ] **Step 5: 实现 capability 交集检查**

远程可发布白名单仅：browser open/fill/click/read-url/close 的仓库实际能力名。manifest 声明必须为白名单子集；代码无法静态推导权限时仍以 manifest 为准，运行时权限层二次强制。

- [ ] **Step 6: 验证**

Run: `pnpm --filter @autoforge/workflow-sdk test -- node-compat/index.test.ts`

Run: `pnpm --filter @autoforge/publisher-builder test -- source-scanner.test.ts esbuild-workflow.test.ts`

Run: `pnpm --filter @autoforge/workflow-sdk typecheck && pnpm --filter @autoforge/publisher-builder typecheck`

Expected: 均通过。

- [ ] **Step 7: 提交**

```bash
git add packages/workflow-sdk apps/publisher-builder/src/scans apps/publisher-builder/src/build
git commit -m "feat: sandbox workflow publish builds"
```

---

### Task 4: 实现内部任务领取、构建状态机和重试归因

**Files:**
- Create: `apps/publisher-service/src/routes/internal-build-routes.ts`
- Create: `apps/publisher-service/src/routes/internal-build-routes.test.ts`
- Create: `apps/publisher-service/src/services/build-orchestrator.ts`
- Create: `apps/publisher-service/src/services/build-orchestrator.test.ts`
- Create: `apps/publisher-builder/src/publisher/internal-publisher-client.ts`
- Create: `apps/publisher-builder/src/publisher/internal-publisher-client.test.ts`
- Create: `apps/publisher-builder/src/worker.ts`
- Create: `apps/publisher-builder/src/worker.test.ts`
- Create: `apps/publisher-builder/src/server.ts`

**Interfaces:**
- Internal: `POST /internal/builds/claim`, `/heartbeat`, `/complete`, `/fail` protected by CloudRun service identity and request nonce.
- Claim returns one job, scoped source read ticket and candidate/log write tickets.
- Builder reports either `project_failure` with diagnostics or `platform_failure` with safe reason.

- [ ] **Step 1: 写状态与身份失败测试**

覆盖无服务身份 401、nonce replay、两个 worker 只能 claim 一次、过期 lease 可重领、heartbeat 延长 lease、project failure 不重试、platform failure 1/2/3 次重试且不增加用户构建计数、第四次终结、旧 lease 回报被拒绝。

- [ ] **Step 2: 运行测试并确认 RED**

Run: `pnpm --filter @autoforge/publisher-service test -- internal-build-routes.test.ts build-orchestrator.test.ts`

Run: `pnpm --filter @autoforge/publisher-builder test -- internal-publisher-client.test.ts worker.test.ts`

Expected: 失败。

- [ ] **Step 3: 实现数据库租约状态机**

claim 使用 `FOR UPDATE SKIP LOCKED`，原子地将 `queued → building`，写 lease token/expiry/attempt。所有回报条件包含 submissionId + lease token + 当前状态。用户每日构建计数只在第一次项目构建被受理时已计入；平台重试只增加 `platform_attempts`。

- [ ] **Step 4: 实现 Builder worker pipeline**

顺序固定：下载并核对 archive hash → Task 1 解包 → manifest/schema → Task 2 dependency install/audit → Task 3 scan/bundle → runtime smoke load → 生成报告 → 上传候选与日志 → complete。任何 finally 删除专用临时目录。输出日志逐行限制长度并脱敏 URL query/token/home path。

- [ ] **Step 5: 配置资源与网络边界**

Builder container 以非 root 运行，read-only root FS，临时盘 1 GiB，2 vCPU/1 GiB memory，request timeout 300s。install 仅能访问 npm proxy；scan/build/smoke 阶段切换至无网络执行容器或隔离子进程网络 namespace。若 CloudRun 产品能力不能阶段性断网，拆成 install job 与 offline build job，不能仅靠约定。

- [ ] **Step 6: 验证**

Run: `pnpm --filter @autoforge/publisher-service test -- internal-build-routes.test.ts build-orchestrator.test.ts`

Run: `pnpm --filter @autoforge/publisher-builder test -- internal-publisher-client.test.ts worker.test.ts`

Expected: 均通过。

- [ ] **Step 7: 提交**

```bash
git add apps/publisher-service/src/routes/internal-build-routes.ts apps/publisher-service/src/services/build-orchestrator* apps/publisher-builder
git commit -m "feat: orchestrate isolated workflow builds"
```

---

### Task 5: 固化候选产物、自动报告与所有权建立

**Files:**
- Create: `apps/publisher-builder/src/artifacts/candidate-artifact.ts`
- Create: `apps/publisher-builder/src/artifacts/candidate-artifact.test.ts`
- Create: `apps/publisher-service/src/services/build-result-service.ts`
- Create: `apps/publisher-service/src/services/build-result-service.test.ts`
- Modify: `apps/publisher-service/src/repositories/postgres-publishing-repository.ts`

**Interfaces:**
- Candidate contains runtime bundle, normalized workflow manifest, inventory, dependency/license/vulnerability/capability reports and build metadata.
- Build success atomically changes `building → pending_review`; build failure changes `building → build_failed`.
- First successful automation also converts workflow reservation to permanent owner.

- [ ] **Step 1: 写确定性与所有权失败测试**

同源码/lock/toolchain 两次构建的候选 tar 文件 hash 必须一致；mtime/uid/gid/order 固定。测试首个构建失败不建立 owner，首个成功建立 owner，竞争 reservation 只有一个 owner，Moderate vulnerability 写 warning 而非失败。

- [ ] **Step 2: 运行测试并确认 RED**

Run: `pnpm --filter @autoforge/publisher-builder test -- candidate-artifact.test.ts`

Run: `pnpm --filter @autoforge/publisher-service test -- build-result-service.test.ts`

Expected: 失败。

- [ ] **Step 3: 实现规范化候选包**

JSON 使用固定 key ordering 和 UTF-8/LF；tar entry 排序、mode 0644/0755、mtime epoch、uid/gid 0。候选对象 key 由服务生成 `candidates/<submissionId>/<candidateSha256>.tar`，upload ticket 只能写该 key。

- [ ] **Step 4: 实现结果事务**

complete 前 Publisher Service head candidate object 并核对 hash/size。事务中写报告摘要、event、状态；若 workflow 无 owner，则验证 reservation 属于提交者再 insert owner。候选源码/报告仅 owner 与 super_admin 可读取。

- [ ] **Step 5: 验证**

Run: `pnpm --filter @autoforge/publisher-builder test -- candidate-artifact.test.ts`

Run: `pnpm --filter @autoforge/publisher-service test -- build-result-service.test.ts`

Expected: 均通过。

- [ ] **Step 6: 提交**

```bash
git add apps/publisher-builder/src/artifacts apps/publisher-service/src/services/build-result-service* apps/publisher-service/src/repositories/postgres-publishing-repository.ts
git commit -m "feat: produce reviewable workflow candidates"
```

---

### Task 6: 实现审核决策、并发控制和自审保障

**Files:**
- Create: `apps/publisher-service/src/routes/review-routes.ts`
- Create: `apps/publisher-service/src/routes/review-routes.test.ts`
- Create: `apps/publisher-service/src/services/review-service.ts`
- Create: `apps/publisher-service/src/services/review-service.test.ts`
- Create: `apps/publisher-service/src/domain/review-policy.ts`
- Create: `apps/publisher-service/src/domain/review-policy.test.ts`

**Interfaces:**
- `GET /v1/admin/reviews`, `GET /v1/admin/reviews/:submissionId`。
- `POST /v1/admin/reviews/:submissionId/approve` consumes decisionVersion, checklist, Moderate acknowledgement, note, and selfReviewConfirmation.
- `POST /v1/admin/reviews/:submissionId/reject` consumes decisionVersion, category, actionable detail.

- [ ] **Step 1: 写审核失败测试**

覆盖普通用户拒绝、非 pending_review、两个管理员并发仅一个成功、清单缺项、Moderate 未确认、空驳回原因、非法分类、自审未二次确认/无备注失败、自审满足条件成功且 audit 标记、管理员不能绕过机器 gate。

- [ ] **Step 2: 运行测试并确认 RED**

Run: `pnpm --filter @autoforge/publisher-service test -- review-policy.test.ts review-service.test.ts review-routes.test.ts`

Expected: 失败。

- [ ] **Step 3: 实现纯审核策略**

批准清单固定包含：功能与描述一致、权限最小化、依赖/许可证、Moderate 风险确认、敏感数据、审核沙箱结果（可选执行但结果必须明确）。驳回分类使用契约枚举，detail 10–2000 字。自审判定 `principal.userId === ownerId`，要求 `selfReviewConfirmation === true` 且 note 20–2000 字。

- [ ] **Step 4: 实现乐观并发事务**

decisionVersion 来自 submission row version；`UPDATE ... WHERE status='pending_review' AND row_version=?`。驳回写 review/event/notification 并转 `rejected`。通过写 review/event，转 `approved` 并创建唯一 `release(status='publishing')`；发布失败时不回滚审核决定。

- [ ] **Step 5: 验证**

Run: `pnpm --filter @autoforge/publisher-service test -- review-policy.test.ts review-service.test.ts review-routes.test.ts`

Run: `pnpm --filter @autoforge/publisher-service typecheck`

Expected: 均通过。

- [ ] **Step 6: 提交**

```bash
git add apps/publisher-service/src/routes/review-routes* apps/publisher-service/src/services/review-service* apps/publisher-service/src/domain/review-policy*
git commit -m "feat: add guarded workflow reviews"
```

---

### Task 7: 实现独立签名边界与原子正式发布

**Files:**
- Create: `apps/publisher-signer/package.json`
- Create: `apps/publisher-signer/tsconfig.json`
- Create: `apps/publisher-signer/src/canonical-json.ts`
- Create: `apps/publisher-signer/src/canonical-json.test.ts`
- Create: `apps/publisher-signer/src/kms-signer.ts`
- Create: `apps/publisher-signer/src/server.ts`
- Create: `apps/publisher-signer/src/server.test.ts`
- Create: `apps/publisher-service/src/services/release-publisher.ts`
- Create: `apps/publisher-service/src/services/release-publisher.test.ts`
- Create: `apps/publisher-service/src/routes/internal-signing-routes.ts`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Signer consumes service-authenticated `{ releaseId, keyId, manifestSha256, canonicalManifest }` and returns `{ algorithm, keyId, signature }`.
- Publisher validates candidate, creates minimal runtime package and canonical public manifest, calls signer, stores immutable artifacts, then atomically `publishing → published`.

- [ ] **Step 1: 写签名与失败恢复测试**

覆盖 canonical JSON 稳定、字段重排同 hash、内容变化 hash 变化、无服务身份、未知 key、manifest hash mismatch、非 approved release、storage/signing failure 保持 `publishing`、重试幂等、成功后 version 永久占用。

- [ ] **Step 2: 运行测试并确认 RED**

Run: `pnpm --filter @autoforge/publisher-signer test`

Run: `pnpm --filter @autoforge/publisher-service test -- release-publisher.test.ts`

Expected: 失败。

- [ ] **Step 3: 实现 canonical JSON 与 KMS port**

canonicalizer 递归按 Unicode code point 排 key，禁止 NaN/Infinity/undefined，字符串 UTF-8。KMS adapter 仅暴露 asymmetric sign 和 public key metadata；私钥不可 export。测试使用临时 Ed25519/P-256 fake；生产算法由 CloudBase/Tencent KMS 实际能力选定并固定进 `algorithm` 字段，客户端支持该单一首发算法。

- [ ] **Step 4: 实现发布幂等协调器**

以 releaseId 作为幂等键：验证 candidate hash → 提取 runtime/normalized manifest → 写 content-addressed immutable objects → canonical manifest → sign → 写 signature/public key id → head 所有对象复核 → 事务置 published/event/notification。任一步失败记录安全错误并排队平台重试，submission 仍为 approved。

- [ ] **Step 5: 实现 key rotation 元数据**

公开 `GET /v1/signing-keys` 返回当前和仍需验证历史 release 的 public keys、algorithm、validFrom/retiredAt；禁止删除仍有安装包引用的 key。新发布只用 current key。

- [ ] **Step 6: 验证**

Run: `pnpm --filter @autoforge/publisher-signer test && pnpm --filter @autoforge/publisher-signer typecheck`

Run: `pnpm --filter @autoforge/publisher-service test -- release-publisher.test.ts`

Expected: 均通过。

- [ ] **Step 7: 提交**

```bash
git add apps/publisher-signer apps/publisher-service/src/services/release-publisher* apps/publisher-service/src/routes/internal-signing-routes.ts pnpm-lock.yaml
git commit -m "feat: sign and publish workflow releases"
```

---

### Task 8: 审核沙箱、撤销、保留策略与端到端流水线

**Files:**
- Create: `apps/publisher-service/src/services/review-sandbox-service.ts`
- Create: `apps/publisher-service/src/services/review-sandbox-service.test.ts`
- Create: `apps/publisher-service/src/services/retention-service.ts`
- Create: `apps/publisher-service/src/services/retention-service.test.ts`
- Create: `apps/publisher-service/src/routes/release-admin-routes.ts`
- Create: `apps/publisher-service/src/routes/release-admin-routes.test.ts`
- Create: `apps/publisher-builder/Dockerfile`
- Create: `apps/publisher-signer/Dockerfile`
- Create: `apps/publisher-service/src/pipeline/publishing-pipeline.integration.test.ts`
- Create: `docs/runbooks/workflow-publishing-pipeline.md`

**Interfaces:**
- Admin may start optional sandbox run against candidate; it never installs locally and still enforces manifest permissions.
- `POST /v1/admin/releases/:id/revoke` records reason and changes published → revoked.
- Retention removes blobs after 30/180 days as specified while preserving required metadata/audit.

- [ ] **Step 1: 写失败测试**

覆盖沙箱无源码外泄、无额外权限、无网时 remote action 失败；撤销幂等、普通用户禁止、下载票据停止；failed/incomplete 30 天删除 blob、rejected 180 天删除 blob、metadata/audit retained、published/revoked retained。

- [ ] **Step 2: 运行测试并确认 RED**

Run: `pnpm --filter @autoforge/publisher-service test -- review-sandbox-service.test.ts retention-service.test.ts release-admin-routes.test.ts`

Expected: 失败。

- [ ] **Step 3: 实现沙箱和撤销**

沙箱使用候选 runtime、临时空 profile、声明权限交集和 headless browser port；输出截图/日志作为私有审核附件。撤销事务写 actor/reason/event/notification；之后公开 download API 必须返回 `RELEASE_REVOKED`。

- [ ] **Step 4: 实现保留 job**

先选取有明确 cutoff 且未 legal-hold 的对象，写 deletion job，再删除 storage，成功后标 `blob_deleted_at`；失败重试。不得物理删除 submission/review/audit/release rows。

- [ ] **Step 5: 写真实流水线集成测试**

使用独立测试 PG、fake private storage、fake KMS、fixture npm proxy：提交 → claim → build → pending_review → self-review with safeguards → publishing → published；另测 project failure、platform retry、reject/resubmit same version、published version re-submit blocked、revoke。禁止只 mock 状态转换服务本身。

- [ ] **Step 6: 构建容器与 CloudBase 测试部署**

Run: `docker build -f apps/publisher-builder/Dockerfile -t autoforge-builder:test .`

Run: `docker build -f apps/publisher-signer/Dockerfile -t autoforge-signer:test .`

按 runbook 部署测试服务身份、网络策略、资源限制、KMS key 和定时 retention job；用测试账号完成一次端到端发布，仍保持桌面 feature flag 关闭。

- [ ] **Step 7: 全量验证**

Run: `pnpm --filter @autoforge/publisher-builder test && pnpm --filter @autoforge/publisher-builder typecheck`

Run: `pnpm --filter @autoforge/publisher-signer test && pnpm --filter @autoforge/publisher-signer typecheck`

Run: `pnpm --filter @autoforge/publisher-service test && pnpm --filter @autoforge/publisher-service typecheck`

Run: `pnpm --filter @autoforge/publisher-service test:integration -- publishing-pipeline.integration.test.ts`

Expected: 均通过；没有测试 PG/KMS/网络隔离证据时不得宣布安全流水线完成。

- [ ] **Step 8: 提交**

```bash
git add apps/publisher-builder/Dockerfile apps/publisher-signer/Dockerfile apps/publisher-service/src/services apps/publisher-service/src/routes/release-admin-routes* apps/publisher-service/src/pipeline docs/runbooks/workflow-publishing-pipeline.md
git commit -m "feat: complete secure publishing pipeline"
```

---

## Phase Completion Gate

- [ ] 所有恶意归档、依赖、动态代码和 Node builtin fixture 均被预期 gate 拒绝。
- [ ] 真实测试环境证明 install 之外无外网，容器资源/时间限制生效且无敏感凭据。
- [ ] 项目失败与平台失败分流；平台最多重试 3 次且不额外计入每天 50 次默认额度。
- [ ] 自审只能在二次确认、必填备注、完整机器 gate 与批准清单下通过，审计明确标记。
- [ ] 签名私钥不可导出；签名/存储失败保持 approved + publishing 并可幂等恢复。
- [ ] 正式包只含最小 runtime/manifest/signature，不含源码、lockfile、构建日志或审核材料。
- [ ] 撤销立即阻止新下载，保留策略符合 30/180 天及长期保留规则。
