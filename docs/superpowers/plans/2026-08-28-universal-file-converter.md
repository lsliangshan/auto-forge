# 万象转换（Universal File Converter）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `examples/universal-file-converter` 新增名为“万象转换”的本地工作流，并补齐受控的宿主转换能力，使聊天附件和开发者调试页都能把常见图片、图标、文档、PDF、音频、视频转换为明确目标格式，产物可保存副本、在文件夹中显示和删除，且文件字节不发送给模型提供商。

**Architecture:** 工作流只声明精确的 `file.convert` 格式范围，并通过 SDK 使用附件序号提交任务；Main 进程持有附件绑定、任务状态机、产物目录、组件包下载验签和固定参数转换引擎，Worker 永远拿不到任意路径或进程能力。转换任务和产物采用本地持久化、epoch/CAS 状态迁移与临时文件原子提交；聊天消息只同步无文件载荷的转换卡片引用，其他设备显示“本机不可用”。

**Tech Stack:** TypeScript 6, Vue 3, Pinia, Electron 43, better-sqlite3, Zod, AJV, Vitest, Playwright, libvips, LibreOffice headless, PDFium/Poppler-compatible renderer, FFmpeg/FFprobe, signed converter-pack index.

**Spec:** `docs/superpowers/specs/2026-08-28-universal-file-converter-design.md`

## Global Constraints

- 只实现批准的格式矩阵，不增加 OCR、PDF 转 Office、栅格图转 SVG、批量目录扫描或任意命令执行。
- 文件内容只在本机 Main/受控子进程边界内流动；Provider 请求只能包含附件序号、净化后的名称、MIME、大小和转换意图，不能包含附件字节、Base64、绝对路径、artifact path 或 job ID。
- `file.convert` 只允许单次、精确附件、精确目标格式授权；Main 必须拒绝 `always` 决策，不能复用宽泛授权。
- Worker 只提交 `{ attachmentIndex, targetFormat, preset?, background? }`；路径解析、所有权检查、argv 构造、环境变量白名单和产物提交全部由 Main 完成。
- 输出先写用户专属临时目录，经格式探测、大小/页数/帧数检查和 SHA-256 后原子移动到托管结果区；任何失败、取消或超时都不得暴露半成品。
- 全局最多并发 2 个任务；LibreOffice 同时 1 个，视频编码同时 1 个。图片/图标 2 分钟，文档/PDF 5 分钟，音频 10 分钟，视频 30 分钟。
- 固定上限：每次最多 5 个附件；图片 20 MiB、音频 50 MiB、视频 200 MiB、普通文件 100 MiB、请求总量 250 MiB、输出总量 500 MiB；图片每帧 100 MP、总计 500 MP；PDF 最多 100 页。
- 支持 macOS arm64/x64 和 Windows x64。正式根公钥、CDN 地址和生产签名包缺失时必须保持下载入口 fail-closed；测试包只能使用测试根密钥并明确标记为 fixture。
- 新增的转换任务、组件缓存和产物均为 local-only，不进入 CloudBase outbox、同步 payload、备份导出或 Provider evidence。
- 每个任务先写失败测试并实际确认 RED，再做最小实现、确认 GREEN 后独立提交；不得顺手重构相邻模块。

## File Structure Map

```text
packages/shared/src/conversion.ts                         # 格式目录、任务/产物/IPC/聊天块公共契约
packages/shared/src/{worker-protocol,desktop-api,events}.ts
                                                          # file.convert 请求、桌面桥和无载荷卡片
packages/workflow-schema/manifest.schema.json             # manifest 中 file.convert 精确范围
packages/workflow-sdk/src/context.ts                      # ctx.converter.submit
apps/desktop/electron/main/conversion/
  conversion-catalog.ts                                   # 输入探测、格式矩阵、大小/页帧限制
  conversion-artifact-service.ts                          # 所有权绑定、临时输出、验证、原子提交
  converter-pack-{types,verifier,manager}.ts               # 组件索引验签、下载、安装、租约
  conversion-process-runner.ts                            # 固定 executable/argv/env、取消和超时
  adapters/{image-icon,document,pdf,media}.ts              # 四类确定性命令计划
  conversion-job-runner.ts                                # durable queue、并发、epoch/CAS、恢复
apps/desktop/electron/main/database/{schema,repositories,migrations}.ts
                                                          # local-only jobs/artifacts 表与仓储
apps/desktop/electron/main/workflows/execution-service.ts  # execution 附件 vault 与能力分派
apps/desktop/electron/workers/workflow-runner.ts           # Worker converter RPC shim
apps/desktop/electron/main/agent/                          # schema 投影、精确审批、模型脱敏
apps/desktop/electron/main/ipc/register-ipc.ts             # 转换/文件选择/产物操作 IPC
apps/desktop/electron/preload/bridge.ts                    # contextBridge 类型安全方法
apps/desktop/src/components/conversion/ConversionBlock.vue # 任务卡片与产物操作
apps/desktop/src/components/developer/DebugPanel.vue       # x-autoforge-file-picker 控件
apps/desktop/src/stores/{developer,conversion}.ts           # 附件草稿与任务事件状态
examples/universal-file-converter/                         # workflow.json、源码和确定性构建产物
apps/desktop/scripts/converter-packs/                      # 测试包、正式包索引、签名与包装校验
apps/desktop/tests/e2e/universal-file-converter.spec.ts     # Electron 真实边界验收
```

---

### Task 1: 公共格式目录、manifest 范围和稳定错误契约

**Files:**
- Create: `packages/shared/src/conversion.ts`
- Create: `packages/shared/src/conversion.test.ts`
- Modify: `packages/shared/src/index.ts`
- Modify: `packages/shared/src/errors.ts`
- Modify: `packages/shared/src/worker-protocol.ts`
- Modify: `packages/shared/src/desktop-api.ts`
- Modify: `packages/shared/src/contracts.test.ts`
- Modify: `packages/workflow-schema/manifest.schema.json`
- Modify: `packages/workflow-schema/src/validator.test.ts`

**Interfaces:**
- Consumes: manifest `permissions.file.convert.formats` and Worker capability request.
- Produces: one canonical target-format union, conversion state union, strict request schema and stable user-facing errors.

- [ ] **Step 1: 写契约失败测试**

覆盖完整目标格式、重复/空格式范围、未知格式、超出 manifest 范围、额外字段、`attachmentIndex < 0`、非法 preset，以及 `file.convert` 不能使用 `origins`/`paths`。错误码至少覆盖 `CONVERSION_FORMAT_UNSUPPORTED`、`CONVERSION_COMPONENT_UNAVAILABLE`、`CONVERSION_INPUT_INVALID`、`CONVERSION_OUTPUT_TOO_LARGE`、`CONVERSION_TIMEOUT`、`CONVERSION_CANCELLED`、`CONVERSION_INTERRUPTED`。

- [ ] **Step 2: 运行并确认 RED**

```bash
pnpm --filter @autoforge/workflow-schema test -- validator.test.ts
node apps/desktop/scripts/run-vitest-electron.mjs run --config apps/desktop/vitest.node.config.ts packages/shared/src/conversion.test.ts packages/shared/src/contracts.test.ts
```

Expected: `file.convert` 和 `conversion.ts` 尚不存在，测试失败。

- [ ] **Step 3: 增加唯一格式源和严格请求 schema**

```ts
export const CONVERSION_TARGET_FORMATS = [
  'png', 'jpeg', 'webp', 'avif', 'tiff', 'bmp', 'gif', 'ico', 'icns',
  'pdf', 'xlsx', 'mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus',
  'mp4', 'webm', 'mov'
] as const;

export const conversionTargetFormatSchema = z.enum(CONVERSION_TARGET_FORMATS);
export const conversionPresetSchema = z.enum(['default', 'favicon', 'app-icon']);
export const conversionJobStatusSchema = z.enum([
  'queued', 'downloading_component', 'converting', 'verifying',
  'completed', 'failed', 'cancelled', 'interrupted'
]);

export const fileConvertRequestSchema = z.object({
  capability: z.literal('file.convert'),
  scope: z.object({ formats: z.array(conversionTargetFormatSchema).min(1) }).strict(),
  arguments: z.object({
    attachmentIndex: z.number().int().nonnegative(),
    targetFormat: conversionTargetFormatSchema,
    preset: conversionPresetSchema.optional(),
    background: z.boolean().optional()
  }).strict()
}).strict();
```

manifest schema 对 `formats` 使用同一枚举的 JSON 表达，设置 `minItems: 1`、`uniqueItems: true` 和 `additionalProperties: false`。运行时再验证 `targetFormat` 确实包含在声明范围内。

- [ ] **Step 4: 验证 GREEN 与类型检查**

```bash
pnpm --filter @autoforge/workflow-schema test -- validator.test.ts
node apps/desktop/scripts/run-vitest-electron.mjs run --config apps/desktop/vitest.node.config.ts packages/shared/src/conversion.test.ts packages/shared/src/contracts.test.ts
pnpm --filter @autoforge/shared typecheck
```

- [ ] **Step 5: 提交**

```bash
git add packages/shared packages/workflow-schema
git commit -m "feat: define file conversion contracts"
```

---

### Task 2: local-only 任务与产物持久化

**Files:**
- Create: `apps/desktop/resources/migrations/0016_conversion_jobs.sql`
- Create: `apps/desktop/electron/main/database/conversion-repositories.test.ts`
- Modify: `apps/desktop/electron/main/database/migrations.ts`
- Modify: `apps/desktop/electron/main/database/schema.ts`
- Modify: `apps/desktop/electron/main/database/repositories.ts`
- Modify: `apps/desktop/electron/main/sync/user-data-sync-engine.test.ts`

**Interfaces:**
- Consumes: owner user, execution, source reference, requested format and expected epoch/status.
- Produces: durable job transitions and owner-scoped artifact metadata; produces no sync mutation.

- [ ] **Step 1: 写仓储 RED 测试**

证明：跨用户读写返回空/拒绝；`claimNext` 原子领取；错误 epoch 或前置状态不能迁移；terminal 状态不可回退；重启把 `downloading_component|converting|verifying` 迁移为 `interrupted`；conversion 表变化不会写入 outbox。

- [ ] **Step 2: 运行并确认 RED**

```bash
node apps/desktop/scripts/run-vitest-electron.mjs run --config apps/desktop/vitest.node.config.ts apps/desktop/electron/main/database/conversion-repositories.test.ts apps/desktop/electron/main/sync/user-data-sync-engine.test.ts
```

- [ ] **Step 3: 建表并实现 CAS API**

```ts
export interface ConversionJobRepository {
  create(input: NewConversionJob): ConversionJob;
  getOwned(jobId: string, ownerUserId: string): ConversionJob | null;
  listForExecution(executionId: string, ownerUserId: string): ConversionJob[];
  claimNext(ownerUserId: string): ConversionJob | null;
  transition(input: {
    jobId: string;
    ownerUserId: string;
    expectedEpoch: number;
    expectedStatuses: ConversionJobStatus[];
    patch: ConversionJobTransition;
  }): boolean;
  interruptInFlight(ownerUserId: string): number;
}

export interface ConversionArtifactRepository {
  create(input: NewConversionArtifact): ConversionArtifact;
  getOwned(artifactId: string, ownerUserId: string): ConversionArtifact | null;
  listForJob(jobId: string, ownerUserId: string): ConversionArtifact[];
  markDeleted(artifactId: string, ownerUserId: string): boolean;
}
```

SQL 表只保存相对路径，`CHECK` 限制状态和 source kind，job 索引覆盖 `(owner_user_id, status, created_at)`，artifact 索引覆盖 `(owner_user_id, conversion_job_id)`。仓储使用现有本地数据库连接并通过 `owner_user_id` 隔离用户，但不加入 user-cache、outbox 或同步实体注册表。

- [ ] **Step 4: 运行 GREEN**

```bash
node apps/desktop/scripts/run-vitest-electron.mjs run --config apps/desktop/vitest.node.config.ts apps/desktop/electron/main/database/conversion-repositories.test.ts apps/desktop/electron/main/sync/user-data-sync-engine.test.ts
```

- [ ] **Step 5: 提交**

```bash
git add apps/desktop/electron/main/database apps/desktop/electron/main/sync/user-data-sync-engine.test.ts
git commit -m "feat: persist local conversion jobs"
```

---

### Task 3: 附件绑定、输入探测和托管产物原子提交

**Files:**
- Create: `apps/desktop/electron/main/conversion/conversion-catalog.ts`
- Create: `apps/desktop/electron/main/conversion/conversion-catalog.test.ts`
- Create: `apps/desktop/electron/main/conversion/conversion-artifact-service.ts`
- Create: `apps/desktop/electron/main/conversion/conversion-artifact-service.test.ts`
- Modify: `apps/desktop/electron/main/media/media-sniffer.ts`
- Modify: `apps/desktop/electron/main/media/user-media-root.ts`

**Interfaces:**
- Consumes: owner-scoped chat media ID or developer-import artifact ID plus requested target.
- Produces: stable input handle and verified managed artifact; never returns source absolute path to Worker/Renderer.

- [ ] **Step 1: 写路径逃逸、伪装格式和限额 RED 测试**

覆盖 MIME/扩展名与 magic bytes 冲突、symlink、`..`、跨用户 ID、超限文件、100 MP/frame、500 MP total、PDF 101 页、SVG 外部引用、非方形图标输入，以及失败时不存在可见产物。加入成功用例证明相对路径在用户结果根内且提交是 rename 后才可查询。

- [ ] **Step 2: 运行并确认 RED**

```bash
node apps/desktop/scripts/run-vitest-electron.mjs run --config apps/desktop/vitest.node.config.ts apps/desktop/electron/main/conversion/conversion-catalog.test.ts apps/desktop/electron/main/conversion/conversion-artifact-service.test.ts
```

- [ ] **Step 3: 实现输入绑定和输出 writer**

```ts
export type ConversionSourceRef =
  | { kind: 'media'; mediaAssetId: string }
  | { kind: 'artifact'; artifactId: string };

export interface ExecutionAttachmentBinding {
  attachmentIndex: number;
  ownerUserId: string;
  displayName: string;
  mimeType: string;
  byteSize: number;
  source: ConversionSourceRef;
}

export interface ManagedOutputWriter {
  readonly tempPath: string;
  commit(metadata: VerifiedConversionOutput): Promise<ConversionArtifact>;
  abort(): Promise<void>;
}
```

`resolveOwnedInput` 必须从 repository 重新校验 owner、realpath 和根目录；`commit` 先探测输出实际格式和大小，再计算 SHA-256，最后在同一文件系统内原子 rename。SVG 解析必须拒绝网络 URL、`file:`、脚本和外部实体。

- [ ] **Step 4: 实现明确格式矩阵**

静态图片互转：PNG/JPEG/WebP/AVIF/TIFF/BMP；GIF/WebP 动图互转或到 MP4，静态目标取首帧并记录 metadata；SVG 只到 PNG/JPEG/WebP/PDF；ICO/ICNS 可输入输出；Office/开放文档/RTF/CSV/HTML/Markdown/TXT 到 PDF，CSV 额外到 XLSX；PDF 到 PNG/JPEG；音频和视频按规格矩阵。矩阵之外一律返回 `CONVERSION_FORMAT_UNSUPPORTED`。

- [ ] **Step 5: 验证 GREEN**

```bash
node apps/desktop/scripts/run-vitest-electron.mjs run --config apps/desktop/vitest.node.config.ts apps/desktop/electron/main/conversion/conversion-catalog.test.ts apps/desktop/electron/main/conversion/conversion-artifact-service.test.ts
```

- [ ] **Step 6: 提交**

```bash
git add apps/desktop/electron/main/conversion apps/desktop/electron/main/media
git commit -m "feat: secure conversion artifacts"
```

---

### Task 4: 签名组件索引、下载和原子安装

**Files:**
- Create: `apps/desktop/electron/main/conversion/converter-pack-types.ts`
- Create: `apps/desktop/electron/main/conversion/converter-pack-verifier.ts`
- Create: `apps/desktop/electron/main/conversion/converter-pack-verifier.test.ts`
- Create: `apps/desktop/electron/main/conversion/converter-pack-manager.ts`
- Create: `apps/desktop/electron/main/conversion/converter-pack-manager.test.ts`
- Create: `apps/desktop/electron/main/conversion/fixtures/test-converter-root-public-key.pem`
- Create: `apps/desktop/scripts/converter-packs/create-test-pack.mjs`

**Interfaces:**
- Consumes: pinned root public key, signed canonical index, platform/arch pack archive.
- Produces: immutable verified pack lease `{ name, version, root, executables }`; partial downloads/installations remain invisible.

- [ ] **Step 1: 写供应链 RED 测试**

覆盖错误签名、索引回滚、错误 platform/arch、archive hash 不符、entry hash 不符、绝对/穿越路径、symlink、额外 executable、过大 archive、下载中断、两个并发 acquire，以及旧版本在活跃 lease 期间不能删除。

- [ ] **Step 2: 运行并确认 RED**

```bash
node apps/desktop/scripts/run-vitest-electron.mjs run --config apps/desktop/vitest.node.config.ts apps/desktop/electron/main/conversion/converter-pack-verifier.test.ts apps/desktop/electron/main/conversion/converter-pack-manager.test.ts
```

- [ ] **Step 3: 定义可签名的规范化索引**

```ts
export interface ConverterPackIndex {
  schemaVersion: 1;
  generatedAt: string;
  sequence: number;
  packs: Array<{
    name: 'image-icon' | 'document' | 'pdf' | 'media';
    version: string;
    platform: 'darwin' | 'win32';
    arch: 'arm64' | 'x64';
    archiveUrl: string;
    archiveSha256: string;
    archiveBytes: number;
    entries: Array<{ path: string; sha256: string; bytes: number; executable: boolean }>;
  }>;
}
```

使用稳定 key ordering 和 UTF-8 JSON bytes 验证 detached Ed25519 signature；拒绝低于本地最高 sequence 的索引。测试脚本生成纯 fixture 可执行文件和测试签名，不能生成或内嵌生产私钥。

- [ ] **Step 4: 实现下载、解包、安装和租约**

下载到明确的 `.partial-<uuid>`，限制重定向为 HTTPS、限制 Content-Length 和实际字节；解包逐 entry 校验；完整验证后 rename 到 `<pack>/<version>/<platform>-<arch>`。单飞锁合并相同 acquire；进程重启清理 `.partial-*`，但不清理当前或被 job 引用的版本。

- [ ] **Step 5: 验证 GREEN**

```bash
node apps/desktop/scripts/run-vitest-electron.mjs run --config apps/desktop/vitest.node.config.ts apps/desktop/electron/main/conversion/converter-pack-verifier.test.ts apps/desktop/electron/main/conversion/converter-pack-manager.test.ts
```

- [ ] **Step 6: 提交**

```bash
git add apps/desktop/electron/main/conversion apps/desktop/scripts/converter-packs
git commit -m "feat: verify converter component packs"
```

---

### Task 5: 固定 argv 转换适配器与安全进程运行器

**Files:**
- Create: `apps/desktop/electron/main/conversion/conversion-process-runner.ts`
- Create: `apps/desktop/electron/main/conversion/conversion-process-runner.test.ts`
- Create: `apps/desktop/electron/main/conversion/adapters/image-icon.ts`
- Create: `apps/desktop/electron/main/conversion/adapters/image-icon.test.ts`
- Create: `apps/desktop/electron/main/conversion/adapters/document.ts`
- Create: `apps/desktop/electron/main/conversion/adapters/document.test.ts`
- Create: `apps/desktop/electron/main/conversion/adapters/pdf.ts`
- Create: `apps/desktop/electron/main/conversion/adapters/pdf.test.ts`
- Create: `apps/desktop/electron/main/conversion/adapters/media.ts`
- Create: `apps/desktop/electron/main/conversion/adapters/media.test.ts`

**Interfaces:**
- Consumes: verified input, target/preset and verified pack lease.
- Produces: fixed executable/argv/env plan and expected output descriptors; accepts no free-form flag or executable from workflow input.

- [ ] **Step 1: 写注入、取消、超时和格式参数 RED 测试**

使用带空格、引号、换行、前导 `-` 的文件名验证从不经过 shell；验证 executable 必须位于 lease root，env 不继承代理/凭据变量，stderr 有上限且脱敏；取消和超时会终止进程树并等待退出。逐适配器 snapshot 固定 argv。

- [ ] **Step 2: 运行并确认 RED**

```bash
node apps/desktop/scripts/run-vitest-electron.mjs run --config apps/desktop/vitest.node.config.ts apps/desktop/electron/main/conversion/conversion-process-runner.test.ts apps/desktop/electron/main/conversion/adapters/*.test.ts
```

- [ ] **Step 3: 实现唯一进程计划入口**

```ts
export interface ConversionProcessPlan {
  executable: string;
  args: readonly string[];
  cwd: string;
  env: Readonly<Record<string, string>>;
  timeoutMs: number;
  outputPaths: readonly string[];
}

export interface ConverterAdapter {
  supports(input: ProbedConversionInput, target: ConversionTargetFormat): boolean;
  plan(input: ProbedConversionInput, request: ConversionRequest, lease: ConverterPackLease, outputRoot: string): ConversionProcessPlan;
}
```

运行器使用 `spawn(executable, args, { shell: false, windowsHide: true, cwd, env })`，env 只含 pack 需要的 `PATH`、临时目录和 locale；Windows 使用 Job Object 等价封装，macOS 终止进程组。错误对象只保留退出码、受限 stderr 摘要和稳定错误码。

- [ ] **Step 4: 实现四类确定性适配器**

图片/图标：非方形输入透明居中 pad，绝不 crop；ICO default 输出 16/24/32/48/64/128/256，favicon 输出 16/32/48；ICNS 输出 16 到 1024 及 Retina；ICO/ICNS 输入到普通图片时输出全部 representation。文档使用独立 LibreOffice profile；PDF 按页输出零填充文件名；媒体固定 MP4 H.264/AAC、WebM VP9/Opus、MOV H.264/AAC，并允许视频抽取音频。动画转静态时只取首帧并返回 `frameSelection: 'first'` metadata。

- [ ] **Step 5: 验证 GREEN**

```bash
node apps/desktop/scripts/run-vitest-electron.mjs run --config apps/desktop/vitest.node.config.ts apps/desktop/electron/main/conversion/conversion-process-runner.test.ts apps/desktop/electron/main/conversion/adapters/*.test.ts
```

- [ ] **Step 6: 提交**

```bash
git add apps/desktop/electron/main/conversion
git commit -m "feat: add fixed conversion engine plans"
```

---

### Task 6: durable 调度、并发、取消与重启恢复

**Files:**
- Create: `apps/desktop/electron/main/conversion/conversion-job-runner.ts`
- Create: `apps/desktop/electron/main/conversion/conversion-job-runner.test.ts`
- Modify: `apps/desktop/electron/main/application-shutdown-completion.ts`
- Modify: `apps/desktop/electron/main/application-shutdown-completion.test.ts`

**Interfaces:**
- Consumes: owned attachment binding, request, repositories, pack manager, adapter registry and artifact writer.
- Produces: immediate submission receipt plus monotonic job events; terminal state is exactly once.

- [ ] **Step 1: 先写竞态 RED 测试**

用 controllable promises 证明：全局最多 2；LibreOffice/视频各最多 1；取消 queued 立即 terminal；取消 converting 后 late success 不能覆盖；旧 epoch 的进度/失败/完成全部被丢弃；输出验证失败不提交；重启中断后显式 retry 创建新 epoch；shutdown 等待取消 drain；组件下载失败保持 fail-closed。

- [ ] **Step 2: 运行并确认 RED**

```bash
node apps/desktop/scripts/run-vitest-electron.mjs run --config apps/desktop/vitest.node.config.ts apps/desktop/electron/main/conversion/conversion-job-runner.test.ts apps/desktop/electron/main/application-shutdown-completion.test.ts
```

- [ ] **Step 3: 实现状态机和资源信号量**

```ts
const TRANSITIONS: Readonly<Record<ConversionJobStatus, readonly ConversionJobStatus[]>> = {
  queued: ['downloading_component', 'cancelled'],
  downloading_component: ['converting', 'failed', 'cancelled', 'interrupted'],
  converting: ['verifying', 'failed', 'cancelled', 'interrupted'],
  verifying: ['completed', 'failed', 'cancelled', 'interrupted'],
  completed: [],
  failed: [],
  cancelled: [],
  interrupted: ['queued']
};
```

每个运行槽保存 `{ jobId, epoch, AbortController, packLease }`。事件发布前和 artifact commit 前都通过 repository CAS 检查 epoch/status。retry 递增 epoch、清空进度和 terminal error，再排队同一逻辑 job；旧 async closure 仍持旧 epoch，因此无法穿越边界。

- [ ] **Step 4: 实现公平调度和关机顺序**

FIFO 领取 job；先占全局槽，再占 engine 槽，获取失败释放已有槽。`stop()` 停止领取、abort 活跃任务、等待进程退出与 writer abort、释放 pack lease，最后才允许数据库关闭。

- [ ] **Step 5: 验证 GREEN**

```bash
node apps/desktop/scripts/run-vitest-electron.mjs run --config apps/desktop/vitest.node.config.ts apps/desktop/electron/main/conversion/conversion-job-runner.test.ts apps/desktop/electron/main/application-shutdown-completion.test.ts
```

- [ ] **Step 6: 提交**

```bash
git add apps/desktop/electron/main/conversion apps/desktop/electron/main/application-shutdown-completion*
git commit -m "feat: schedule durable conversion jobs"
```

---

### Task 7: SDK、Worker 与 ExecutionService 的 `file.convert` 桥

**Files:**
- Modify: `packages/workflow-sdk/src/context.ts`
- Modify: `packages/workflow-sdk/src/define-workflow.test.ts`
- Modify: `apps/desktop/electron/workers/workflow-runner.ts`
- Modify: `apps/desktop/electron/main/workflows/execution-service.ts`
- Modify: `apps/desktop/electron/main/workflows/execution-service.test.ts`
- Modify: `apps/desktop/electron/main/workflows/workflow-security-fingerprint.test.ts`

**Interfaces:**
- Consumes: execution-scoped ordered attachment bindings and SDK submit request.
- Produces: provider-safe `{ accepted, status, outputs }` workflow result; internal path/job/artifact IDs remain Main-owned.

- [ ] **Step 1: 写越权和泄漏 RED 测试**

覆盖 attachment index 越界、跨用户 source、target 未声明、request scope 与 arguments 不一致、重复 submit、缺失授权；验证 Worker context 不含路径，workflow output 不含 `jobId`、`artifactId`、绝对路径或 source ID。

- [ ] **Step 2: 运行并确认 RED**

```bash
node apps/desktop/scripts/run-vitest-electron.mjs run --config apps/desktop/vitest.node.config.ts apps/desktop/electron/main/workflows/execution-service.test.ts
pnpm --filter @autoforge/workflow-sdk test -- define-workflow.test.ts
```

- [ ] **Step 3: 增加 SDK 能力**

```ts
export interface ConverterSubmitInput {
  attachmentIndex: number;
  targetFormat: ConversionTargetFormat;
  preset?: ConversionPreset;
  background?: boolean;
}

export interface ConverterCapability {
  submit(input: ConverterSubmitInput): Promise<
    | {
        accepted: true;
        status: 'queued' | 'completed';
        outputs: Array<{ name: string; format: ConversionTargetFormat; byteSize: number }>;
      }
    | {
        accepted: false;
        status: 'failed';
        error: { code: ConversionErrorCode; message: string };
      }
  >;
}
```

Worker shim 只把严格 request 发给宿主。ExecutionService 构建只读 execution attachment vault；能力分派时解析序号、重新检查 owner/manifest/authorization，然后调用 job runner。`background: false` 等待 terminal，但仍遵守 execution timeout；转换引擎的 terminal failure 作为稳定的 `accepted: false` 结果返回，使同批其他附件可以继续，授权/契约错误仍拒绝整个能力调用；`true` 或省略时返回 queued。

- [ ] **Step 4: 验证 GREEN**

```bash
node apps/desktop/scripts/run-vitest-electron.mjs run --config apps/desktop/vitest.node.config.ts apps/desktop/electron/main/workflows/execution-service.test.ts apps/desktop/electron/main/workflows/workflow-security-fingerprint.test.ts
pnpm --filter @autoforge/workflow-sdk test -- define-workflow.test.ts
```

- [ ] **Step 5: 提交**

```bash
git add packages/workflow-sdk apps/desktop/electron/workers/workflow-runner.ts apps/desktop/electron/main/workflows
git commit -m "feat: bridge file conversion capability"
```

---

### Task 8: 新增“万象转换”示例工作流

**Files:**
- Create: `examples/universal-file-converter/package.json`
- Create: `examples/universal-file-converter/tsconfig.json`
- Create: `examples/universal-file-converter/workflow.json`
- Create: `examples/universal-file-converter/src/index.ts`
- Create: `examples/universal-file-converter/src/index.test.ts`
- Create: `examples/universal-file-converter/dist/index.js`
- Create: `examples/universal-file-converter/manifest.json`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Consumes: `{ files: number[], targetFormat, preset?, background? }` where `files` are attachment indexes supplied by host UI/Agent.
- Produces: one result per attachment with sanitized output metadata; delegates all bytes to `ctx.converter`.

- [ ] **Step 1: 写工作流行为 RED 测试**

验证空 files、重复 index、超过 5 个、非法 preset/target 被输入 schema 拒绝；验证按输入顺序调用 converter；单个失败返回对应稳定错误，其他已提交结果保留；源码不能 import `node:fs`、`child_process` 或读取环境变量。

- [ ] **Step 2: 运行并确认 RED**

```bash
pnpm exec vitest run examples/universal-file-converter/src/index.test.ts
```

- [ ] **Step 3: 写 manifest 和最小工作流**

```ts
export default defineWorkflow(async (input, ctx) => {
  const results = [];
  for (const attachmentIndex of input.files) {
    results.push(await ctx.converter.submit({
      attachmentIndex,
      targetFormat: input.targetFormat,
      preset: input.preset,
      background: input.background
    }));
  }
  return { workflow: '万象转换', results };
});
```

`workflow.json` 使用 ID `file.convert.universal`，显示名“万象转换”，声明完整批准格式范围；`files` 字段带 `"x-autoforge-control": "file-picker"`、`maxItems: 5`、`uniqueItems: true`，该 annotation 只供开发者 UI 使用。

- [ ] **Step 4: 确定性构建并核对 hash**

```bash
pnpm --filter @autoforge/example-universal-file-converter build
pnpm --filter @autoforge/example-universal-file-converter test
git diff --exit-code -- examples/universal-file-converter/dist/index.js examples/universal-file-converter/manifest.json
```

构建脚本必须生成 canonical manifest 和 build hash；第二次构建无 diff。

- [ ] **Step 5: 提交**

```bash
git add examples/universal-file-converter pnpm-lock.yaml
git commit -m "feat: add universal file converter workflow"
```

---

### Task 9: 精确附件审批、Agent schema 投影和 Provider 零字节路由

**Files:**
- Create: `apps/desktop/electron/main/chat/local-conversion-intent.ts`
- Create: `apps/desktop/electron/main/chat/local-conversion-intent.test.ts`
- Modify: `apps/desktop/electron/main/agent/workflow-catalog.ts`
- Modify: `apps/desktop/electron/main/agent/workflow-catalog.test.ts`
- Modify: `apps/desktop/electron/main/agent/capability-risk.ts`
- Modify: `apps/desktop/electron/main/agent/capability-risk.test.ts`
- Modify: `apps/desktop/electron/main/agent/workflow-tool-executor.ts`
- Modify: `apps/desktop/electron/main/agent/workflow-tool-executor.test.ts`
- Modify: `apps/desktop/electron/main/agent/agent-orchestrator.ts`
- Modify: `apps/desktop/electron/main/agent/agent-orchestrator.test.ts`
- Modify: `apps/desktop/electron/main/application.ts`
- Modify: `apps/desktop/electron/main/application.test.ts`

**Interfaces:**
- Consumes: current-message attachment metadata, user text, candidate workflow and tool arguments.
- Produces: metadata-only provider content, exact one-run approval summary and execution bindings.

- [ ] **Step 1: 先写隐私与授权 RED 测试**

证明转换意图下 `media.modelInput` 不被调用，Provider payload 不含 `data:`、Base64、bytes、path、mediaAssetId；历史附件也不会被重新注入。证明 `x-autoforge-*` 从模型 tool schema 递归剥离。审批摘要必须列出净化文件名、附件序号和目标格式，`always` 即使伪造 IPC 也被 Main 拒绝；批准附件 0 后不能转换附件 1。

- [ ] **Step 2: 运行并确认 RED**

```bash
node apps/desktop/scripts/run-vitest-electron.mjs run --config apps/desktop/vitest.node.config.ts apps/desktop/electron/main/chat/local-conversion-intent.test.ts apps/desktop/electron/main/agent/workflow-catalog.test.ts apps/desktop/electron/main/agent/capability-risk.test.ts apps/desktop/electron/main/agent/workflow-tool-executor.test.ts apps/desktop/electron/main/agent/agent-orchestrator.test.ts apps/desktop/electron/main/application.test.ts
```

- [ ] **Step 3: 实现 metadata-only 路由**

```ts
export interface LocalAttachmentProjection {
  index: number;
  name: string;
  mimeType: string;
  byteSize: number;
}

export function projectLocalConversionPrompt(text: string, attachments: LocalAttachmentProjection[]): string {
  const lines = attachments.map((item) =>
    `[附件 ${item.index}: ${sanitizeDisplayName(item.name)}, ${item.mimeType}, ${item.byteSize} bytes]`
  );
  return [text, ...lines].filter(Boolean).join('\n');
}
```

仅在“有当前附件 + 文本可能是格式转换”时走本地 projection，作用是阻止字节上传并让 Agent 选择工作流，不是强制选择“万象转换”。没有转换意图的现有多模态路径保持不变。

- [ ] **Step 4: 实现精确批准对象**

```ts
export interface FileConvertAuthorization {
  capability: 'file.convert';
  executionNonce: string;
  attachments: Array<{ index: number; sourceFingerprint: string }>;
  formats: ConversionTargetFormat[];
  decision: 'once';
}
```

fingerprint 由 Main 以 owner + source ID + SHA-256 生成，不暴露给模型。Workflow tool executor 把已批准绑定传入 ExecutionService；风险级别标为 sensitive-read + managed-write。审批 UI 只能渲染“一次允许/拒绝”。

- [ ] **Step 5: 验证 GREEN**

```bash
node apps/desktop/scripts/run-vitest-electron.mjs run --config apps/desktop/vitest.node.config.ts apps/desktop/electron/main/chat/local-conversion-intent.test.ts apps/desktop/electron/main/agent/workflow-catalog.test.ts apps/desktop/electron/main/agent/capability-risk.test.ts apps/desktop/electron/main/agent/workflow-tool-executor.test.ts apps/desktop/electron/main/agent/agent-orchestrator.test.ts apps/desktop/electron/main/application.test.ts
```

- [ ] **Step 6: 提交**

```bash
git add apps/desktop/electron/main/chat apps/desktop/electron/main/agent apps/desktop/electron/main/application.ts apps/desktop/electron/main/application.test.ts
git commit -m "feat: authorize local attachment conversion"
```

---

### Task 10: Main 生命周期、IPC 和 preload 桥

**Files:**
- Modify: `apps/desktop/electron/main/application.ts`
- Modify: `apps/desktop/electron/main/application.test.ts`
- Modify: `apps/desktop/electron/main/ipc/register-ipc.ts`
- Modify: `apps/desktop/electron/main/ipc/register-ipc.test.ts`
- Modify: `apps/desktop/electron/preload/bridge.ts`
- Modify: `apps/desktop/electron/preload/bridge.test.ts`
- Modify: `packages/shared/src/desktop-api.ts`

**Interfaces:**
- Consumes: authenticated renderer commands and native file dialog results.
- Produces: owner-scoped job snapshots/events and save/reveal/delete actions; Renderer never receives managed absolute paths.

- [ ] **Step 1: 写 IPC 边界 RED 测试**

验证未认证、跨用户 job/artifact、任意路径参数、已删除 artifact、取消 terminal job、retry 非 retryable job 均拒绝。`saveCopy` 只能由 Main 打开保存对话框并复制到用户选择路径；`reveal` 只接受 artifactId。事件订阅在窗口销毁和登出时清理。

- [ ] **Step 2: 运行并确认 RED**

```bash
node apps/desktop/scripts/run-vitest-electron.mjs run --config apps/desktop/vitest.node.config.ts apps/desktop/electron/main/ipc/register-ipc.test.ts apps/desktop/electron/preload/bridge.test.ts apps/desktop/electron/main/application.test.ts
```

- [ ] **Step 3: 增加最小桌面 API**

```ts
conversion: {
  listForExecution(input: { executionId: string }): Promise<ConversionJobView[]>;
  cancel(input: { jobId: string }): Promise<void>;
  retry(input: { jobId: string }): Promise<void>;
  saveCopy(input: { artifactId: string }): Promise<{ saved: boolean }>;
  reveal(input: { artifactId: string }): Promise<void>;
  deleteArtifact(input: { artifactId: string }): Promise<void>;
  onEvent(listener: (event: ConversionJobEvent) => void): () => void;
};
```

Application 在登录用户数据库打开后创建 repos/artifact service/pack manager/runner；登出先 stop runner、清理 execution vault，再关闭数据库。启动恢复 `.partial-*`、标记 interrupted，并广播最新 snapshot。

- [ ] **Step 4: 验证 GREEN**

```bash
node apps/desktop/scripts/run-vitest-electron.mjs run --config apps/desktop/vitest.node.config.ts apps/desktop/electron/main/ipc/register-ipc.test.ts apps/desktop/electron/preload/bridge.test.ts apps/desktop/electron/main/application.test.ts
```

- [ ] **Step 5: 提交**

```bash
git add packages/shared/src/desktop-api.ts apps/desktop/electron/main/application* apps/desktop/electron/main/ipc apps/desktop/electron/preload
git commit -m "feat: expose managed conversion operations"
```

---

### Task 11: 开发者调试页原生文件选择器

**Files:**
- Modify: `apps/desktop/src/components/developer/DebugPanel.vue`
- Modify: `apps/desktop/src/stores/developer.ts`
- Modify: `apps/desktop/tests/components/developer.test.ts`
- Modify: `apps/desktop/tests/components/developer-hmr.test.ts`
- Modify: `packages/shared/src/desktop-api.ts`
- Modify: `apps/desktop/electron/main/ipc/register-ipc.ts`

**Interfaces:**
- Consumes: input schema field annotated `x-autoforge-control: file-picker` and native picker selection.
- Produces: numeric attachment indexes in workflow input plus opaque developer attachment IDs sent out-of-band.

- [ ] **Step 1: 写 UI/HMR RED 测试**

验证只有 annotation 字段显示文件选择器；最多 5 个；移除后 indexes 重新连续映射；同名文件可区分；切换项目、HMR 重载、登出会清理草稿 artifact；普通数组字段仍使用现有 JSON 控件。Developer run 请求不能包含路径。

- [ ] **Step 2: 运行并确认 RED**

```bash
node apps/desktop/scripts/run-vitest-electron.mjs run --config apps/desktop/vitest.config.ts apps/desktop/tests/components/developer.test.ts apps/desktop/tests/components/developer-hmr.test.ts
```

- [ ] **Step 3: 实现 picker 状态和 out-of-band 提交**

```ts
interface DeveloperAttachmentDraft {
  id: string;
  name: string;
  mimeType: string;
  byteSize: number;
}

const workflowInput = {
  ...formInput,
  files: selectedFiles.map((_file, index) => index)
};

await desktop.developer.run({
  projectId,
  input: workflowInput,
  attachmentIds: selectedFiles.map((file) => file.id)
});
```

Main picker 复用统一附件数量/字节限额，复制到用户专属 developer staging 区并返回 metadata；Renderer 不持有原始路径。运行结束后只有仍被 job 引用的输入保留，其余草稿删除。

- [ ] **Step 4: 验证 GREEN**

```bash
node apps/desktop/scripts/run-vitest-electron.mjs run --config apps/desktop/vitest.config.ts apps/desktop/tests/components/developer.test.ts apps/desktop/tests/components/developer-hmr.test.ts
```

- [ ] **Step 5: 提交**

```bash
git add apps/desktop/src/components/developer/DebugPanel.vue apps/desktop/src/stores/developer.ts apps/desktop/tests/components/developer* packages/shared/src/desktop-api.ts apps/desktop/electron/main/ipc/register-ipc.ts
git commit -m "feat: pick conversion files in developer mode"
```

---

### Task 12: 聊天转换卡片、产物操作和 payload-free 同步

**Files:**
- Create: `apps/desktop/src/stores/conversion.ts`
- Create: `apps/desktop/src/components/conversion/ConversionBlock.vue`
- Create: `apps/desktop/tests/components/conversion-block.test.ts`
- Modify: `apps/desktop/src/components/chat/MessageBlock.vue`
- Modify: `packages/shared/src/events.ts`
- Modify: `packages/shared/src/contracts.test.ts`
- Modify: `apps/desktop/electron/main/chat/conversation-context.test.ts`
- Modify: `apps/desktop/electron/main/sync/user-data-sync-engine.test.ts`

**Interfaces:**
- Consumes: payload-free chat block `{ type, blockId, executionId, state }` and local IPC snapshots/events.
- Produces: accessible progress/result UI; synced devices receive no file bytes/path/hash/job IDs.

- [ ] **Step 1: 写卡片和同步 RED 测试**

覆盖 queued/downloading/converting/verifying/completed/failed/cancelled/interrupted；进度条带文本和 ARIA；失败显示稳定中文建议；completed 显示每个 representation/page；保存副本、显示位置、删除；本机无 job 时显示“转换结果仅在发起转换的设备上可用”。同步 payload JSON 中不得出现 bytes、path、sha256、artifactId、jobId。

- [ ] **Step 2: 运行并确认 RED**

```bash
node apps/desktop/scripts/run-vitest-electron.mjs run --config apps/desktop/vitest.config.ts apps/desktop/tests/components/conversion-block.test.ts
node apps/desktop/scripts/run-vitest-electron.mjs run --config apps/desktop/vitest.node.config.ts packages/shared/src/contracts.test.ts apps/desktop/electron/main/chat/conversation-context.test.ts apps/desktop/electron/main/sync/user-data-sync-engine.test.ts
```

- [ ] **Step 3: 增加无载荷 block 和本地查询**

```ts
export const conversionBlockSchema = z.object({
  type: z.literal('conversion'),
  blockId: z.string().min(1),
  executionId: z.string().min(1),
  state: z.enum(['active', 'terminal'])
}).strict();
```

store 以 executionId 首次加载 snapshot，再订阅 Main event；组件不从消息 block 读取 artifact details。删除产物后保留“已删除”审计状态，不暴露原路径。

- [ ] **Step 4: 验证 GREEN**

```bash
node apps/desktop/scripts/run-vitest-electron.mjs run --config apps/desktop/vitest.config.ts apps/desktop/tests/components/conversion-block.test.ts
node apps/desktop/scripts/run-vitest-electron.mjs run --config apps/desktop/vitest.node.config.ts packages/shared/src/contracts.test.ts apps/desktop/electron/main/chat/conversation-context.test.ts apps/desktop/electron/main/sync/user-data-sync-engine.test.ts
```

- [ ] **Step 5: 提交**

```bash
git add apps/desktop/src/stores/conversion.ts apps/desktop/src/components/conversion apps/desktop/src/components/chat/MessageBlock.vue apps/desktop/tests/components/conversion-block.test.ts packages/shared/src/events.ts packages/shared/src/contracts.test.ts apps/desktop/electron/main/chat/conversation-context.test.ts apps/desktop/electron/main/sync/user-data-sync-engine.test.ts
git commit -m "feat: render local conversion results"
```

---

### Task 13: 真实引擎 fixture、ICO/ICNS/PDF/媒体验收与打包校验

**Files:**
- Create: `apps/desktop/tests/fixtures/conversion/README.md`
- Create: `apps/desktop/tests/integration/conversion-engines.test.ts`
- Create: `apps/desktop/scripts/converter-packs/build-index.mjs`
- Create: `apps/desktop/scripts/converter-packs/sign-index.mjs`
- Create: `apps/desktop/scripts/verify-converter-packs.mjs`
- Modify: `apps/desktop/package.json`
- Modify: `apps/desktop/electron-builder.yml`
- Modify: `apps/desktop/electron/main/build-config.test.ts`

**Interfaces:**
- Consumes: licensed engine binaries staged outside git and an explicitly supplied signing key path.
- Produces: deterministic archives, signed canonical index and packaging report; never logs or copies the private key.

- [ ] **Step 1: 写真实格式验收 RED 测试**

最小自制 fixture 覆盖：透明非方形 PNG→ICO default/favicon、PNG→ICNS、multi-representation ICO/ICNS→PNG、动画 WebP→GIF/MP4/PNG 首帧、DOCX/XLSX/PPTX/CSV→PDF、CSV→XLSX、PDF 3 页→PNG/JPEG、WAV→各音频目标、MP4→MP4/WebM/MOV/GIF/MP3。断言 magic bytes、尺寸/页数/帧数/codec 和 metadata，不只断言文件存在。

- [ ] **Step 2: 运行并确认 RED**

```bash
AUTOFORGE_TEST_CONVERTER_PACK_ROOT="$PWD/.test-artifacts/converter-packs" node apps/desktop/scripts/run-vitest-electron.mjs run --config apps/desktop/vitest.node.config.ts apps/desktop/tests/integration/conversion-engines.test.ts
```

Expected: 未提供测试 pack 时测试明确 skip 并打印外部门禁；提供无效/未签名 pack 时必须失败，不能回退到系统 PATH。

- [ ] **Step 3: 实现 pack 构建、签名和包装检查**

```bash
node apps/desktop/scripts/converter-packs/build-index.mjs --input /absolute/staged-pack-root --output /absolute/release-output
node apps/desktop/scripts/converter-packs/sign-index.mjs --index /absolute/release-output/index.json --private-key /absolute/secure/ed25519-private-key.pem
node apps/desktop/scripts/verify-converter-packs.mjs --root /absolute/release-output --public-key /absolute/release-root-public-key.pem
```

三个脚本拒绝相对路径、symlink、未知 executable、缺失 license、hash 不一致和不支持的平台组合。`electron-builder.yml` 只打包 pinned root public key、pack schema 和 bootstrap metadata，不内置生产私钥或未经签名的 engine。

- [ ] **Step 4: 用已签测试 pack 运行 GREEN**

```bash
AUTOFORGE_TEST_CONVERTER_PACK_ROOT="$PWD/.test-artifacts/converter-packs" node apps/desktop/scripts/run-vitest-electron.mjs run --config apps/desktop/vitest.node.config.ts apps/desktop/tests/integration/conversion-engines.test.ts
pnpm --filter @autoforge/desktop test -- electron/main/build-config.test.ts
pnpm --filter @autoforge/desktop dist:dir
pnpm --filter @autoforge/desktop verify:packaged-native
pnpm --filter @autoforge/desktop verify:converter-packs
```

- [ ] **Step 5: 记录正式发布外部门禁**

在测试输出和 `README.md` 明确分开：本地测试根通过不等于生产接受。正式发布需要由发布负责人提供生产 root public key、HTTPS CDN、四类 pack 对 macOS arm64/x64 与 Windows x64 的签名索引、第三方许可证清单和各平台真实运行证据；缺任一项，正式组件下载保持关闭。

- [ ] **Step 6: 提交**

```bash
git add apps/desktop/tests/fixtures/conversion apps/desktop/tests/integration/conversion-engines.test.ts apps/desktop/scripts/converter-packs apps/desktop/scripts/verify-converter-packs.mjs apps/desktop/package.json apps/desktop/electron-builder.yml apps/desktop/electron/main/build-config.test.ts
git commit -m "test: verify signed converter packs"
```

---

### Task 14: Electron 端到端、视觉检查和最终门禁

**Files:**
- Create: `apps/desktop/tests/e2e/universal-file-converter-fixture.ts`
- Create: `apps/desktop/tests/e2e/universal-file-converter.spec.ts`
- Modify: `apps/desktop/tests/integration/agent-workflow.test.ts`
- Modify: `docs/superpowers/specs/2026-08-28-universal-file-converter-design.md`

**Interfaces:**
- Consumes: signed test packs and running Electron application.
- Produces: Renderer → Preload → IPC → Main → Worker → converter process → durable artifact → visible card 的真实边界证据。

- [ ] **Step 1: 写端到端 RED 场景**

聊天场景：附加 PNG 和 DOCX，输入“把图片转成 favicon ico，把文档转成 PDF”，断言 Provider fixture 收到 metadata 而非 bytes，出现精确附件审批，批准后卡片完成，保存副本的 magic bytes 正确。开发者场景：打开“万象转换”，native picker 选择 MP4，运行到 WebM，取消后 late process event 不得恢复 completed。重启场景：转换中退出再启动，显示 interrupted，可 retry 完成。

- [ ] **Step 2: 运行并确认 RED**

```bash
pnpm build
AUTOFORGE_TEST_CONVERTER_PACK_ROOT="$PWD/.test-artifacts/converter-packs" pnpm exec playwright test apps/desktop/tests/e2e/universal-file-converter.spec.ts
```

- [ ] **Step 3: 补齐仅由 E2E 暴露的最小接线问题**

只修改失败证据直接指向的接线文件；不得改变已批准格式矩阵或引入新的 UI。每个修复先在 E2E 或相邻单元测试中保留失败断言，再验证通过。

- [ ] **Step 4: 视觉与可访问性检查**

在真实 Electron 窗口检查窄/宽聊天列、长文件名、多个分页产物、下载组件状态、错误态、暗色主题、键盘焦点、200% 缩放。截图保存到测试产物目录而非 `out/**`；确认卡片不挤压现有消息布局，操作按钮在 pending/terminal 状态下正确启停。

- [ ] **Step 5: 全量验证**

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
AUTOFORGE_TEST_CONVERTER_PACK_ROOT="$PWD/.test-artifacts/converter-packs" pnpm exec playwright test apps/desktop/tests/e2e/universal-file-converter.spec.ts
pnpm --filter @autoforge/desktop dist:dir
pnpm --filter @autoforge/desktop verify:packaged-native
pnpm --filter @autoforge/desktop verify:converter-packs
git status --short
```

Expected: 所有本地门禁通过，工作树只含本任务预期文件；任何生产 pack/CDN/Windows 真机门禁若未提供，必须在交付报告中列为未验证，不能用 fixture 结果替代。

- [ ] **Step 6: 规格一致性复核**

逐条核对设计规格中的名称、格式矩阵、ICO/ICNS 尺寸、限额、超时、授权、隐私、状态机、平台和 UI；运行以下扫描并人工确认每个命中都不是占位实现：

```bash
rg -n "TODO|TBD|FIXME|not implemented|throw new Error\(.*implement" examples/universal-file-converter apps/desktop/electron/main/conversion apps/desktop/src/components/conversion packages/shared/src/conversion.ts
git diff --check HEAD~14..HEAD
```

- [ ] **Step 7: 提交**

```bash
git add apps/desktop/tests/e2e apps/desktop/tests/integration/agent-workflow.test.ts docs/superpowers/specs/2026-08-28-universal-file-converter-design.md
git commit -m "test: verify universal file conversion end to end"
```

## Completion Criteria

- “万象转换”同时出现在 `examples/universal-file-converter`、开发者工作流列表和聊天工作流目录中，workflow ID 固定为 `file.convert.universal`。
- 规格中的每个允许转换方向至少有一个 catalog 测试；关键真实格式族有 engine integration 测试；禁止方向有明确拒绝测试。
- 聊天转换 Provider fixture 证明文件字节为零，授权绑定证明附件和目标格式不可越权。
- 取消、超时、重启、late success、组件下载失败和输出验证失败均有状态机测试，且无半成品可见。
- ICO、ICNS、favicon、PDF 多页、动画首帧、音视频 codec 的结果由内容探测验证，而非扩展名判断。
- Renderer、Preload、IPC、Main、Worker、子进程、持久化和可见结果的真实 Electron 链路通过。
- 本地 fixture 验证与生产组件发布验收在报告中严格分开；未提供生产签名基础设施时正式入口保持 fail-closed。
