# AutoForge 个人知识库 CloudBase 工件

目标环境为 `autoforge-d1gkhyfb419ba8455`（`ap-shanghai`）。本目录只包含待部署工件；提交或运行测试不会连接、迁移或删除真实 CloudBase 数据。

## 发布前置条件

1. 在隔离的 CloudBase PostgreSQL 预发布环境依次应用 `migrations/0001_personal_knowledge.sql` 和 additive `migrations/0002_personal_knowledge_workers.sql`，确保 user-data foundation 到 `0003_privacy_consent_revocation.sql` 的完整链已应用，再应用 `migrations/0003_owner_knowledge_catalog.sql`；执行跨用户 RLS、authoritative `cloud_sync` revoke/regrant、并发发布、游标过期、owner catalog 分页、作业租约和回滚演练。若 consent current-state 表或当前 `cloud-sync-2026-08` acceptance 不存在，普通 Knowledge RPC 必须 fail closed。
2. 建立私有 PG Storage 空间，并只允许 `autoforge-knowledge` 云函数和 `autoforge-knowledge-worker` 根据数据库中的 `storage_reference` 执行数据面操作。上传使用可消费、15 分钟过期的 PG Storage 授权；Electron 不配置 COS 密钥、Service Role 密钥或永久对象 URL。
3. 为云函数配置 `AUTOFORGE_PG_RPC_BASE_URL`、`AUTOFORGE_PG_STORAGE_BASE_URL`、精确 HTTPS 上传路径前缀 `AUTOFORGE_PG_STORAGE_UPLOAD_URL_PREFIX` 和 `AUTOFORGE_PG_SERVICE_KEY`。上传授权只允许该前缀下绑定 ticket 的 URL，以及 `content-type`、`content-length`、`x-content-sha256`、`x-upload-ticket` 四个客户端头；禁止返回 Authorization、Cookie 或服务凭据。Storage 适配器需要提供幂等的 `POST /upload-authorizations`、`POST /objects/stat` 与 `POST /objects/delete` 私有服务端接口。`/objects/delete` 必须在每次删除紧前用请求中的 worker/job/lease/opaque permit 调用 `autoforge_knowledge_validate_job_mutation_permit(..., 'storage_delete')`，只有结果严格为 `{"authorized":true}` 才可产生副作用，并回传 `x-autoforge-mutation-permit-validated: db-job-v1`。参考边界实现为 `worker/mutation-permit-port.js`。未实现并验收这个服务端检查时不得配置 permit port 版本，然后部署 CommonJS 入口：

   ```sh
   tcb functions:deploy autoforge-knowledge \
     --dir cloudbase/knowledge/function \
     --runtime Nodejs18.15 \
     --install-dependency false
   ```

4. 验证用户 JWT 由 CloudBase 运行时映射到 `context.auth.uid`；事件体中的用户字段会被严格拒绝，不能参与所有权判定。
5. 只有完成迁移、私有存储、RLS、会员签名密钥、杀开关和集成测试后，才可在服务端打开 Cloud 功能。当前桌面端继续返回 `kill_switch_enabled`。
6. 将本目录作为完整 CommonJS 部署包（根 `index.js` 是 worker 入口），在 Node `>=22.13.0 <27` 下使用清单锁定的 pnpm 11.15.0 执行 `pnpm install --frozen-lockfile --ignore-scripts --no-optional`，以禁安装脚本并排除 optional native addons。确认 `worker/package.json` 的 parser 依赖版本与根清单一致，再创建定时调用的 `autoforge-knowledge-worker`。它需要 `AUTOFORGE_PG_RPC_BASE_URL`、`AUTOFORGE_PG_STORAGE_BASE_URL`、`AUTOFORGE_PG_SERVICE_KEY`、`AUTOFORGE_TOKENHUB_EMBEDDING_URL`、`AUTOFORGE_TOKENHUB_API_KEY` 和严格值 `AUTOFORGE_KNOWLEDGE_MUTATION_PERMIT_PORT_VERSION=db-job-v1`；可选的 `AUTOFORGE_KNOWLEDGE_WORKER_ID` 只允许 1..96 位字母、数字、下划线或连字符。这些变量只能由服务端 secret manager 注入。TokenHub 的 embedding handler 必须在每次发送紧前调用同一 validator，mutation kind 为 `tokenhub_embedding`，并仅在验证成功的响应中回传 `mutationPermitValidated: true`。仓库不包含真实 PG Storage/TokenHub 服务实现；在两个 handler 都通过预发布验收前，目标 worker 会因 permit port 配置缺失而 fail closed，该环境变量不得仅为绕过启动检查而设置。发布包必须保留 `worker/parser-process.js`、`worker/parser-child.js`、专用 lockfile 和 PDF.js patch，并用干净的发布运行时完成真实 TXT/DOCX/PDF child 与入口 smoke。当前 hard sandbox 只批准 macOS `/usr/bin/sandbox-exec` 加 Node permission model；Linux/其他运行时会在 spawn 前 fail closed。CloudBase worker 未提供独立 UID/container、禁网 namespace、只读依赖挂载和父进程隔离前，不得部署/运行 worker 或打开 kill switch。
7. worker 每次最多领取 8 个作业，租约绑定 worker/token/expiry，仅 `TRANSIENT_FAILURE` 可在后续调度中重试，第三次失败终止。Claim 在 PostgreSQL 内由 `clock_timestamp()` 生成并存储 120 秒 mutation deadline 和不透明 permit，绑定 owner/job/worker/lease；返回的只是本地 monotonic 剩余预算和 capability。任何 SQL、Storage 或 TokenHub mutation 都不得接受 client epoch/deadline，必须在副作用紧前按 DB clock 重新验证 permit、lease 与 CAS。Embedding 每次只处理 2 个 chunk，已持久进度用 lease-CAS yield 重新排队且不消耗瞬时失败预算。Upload 依次读取并校验私有对象，再为每个请求启动一个无凭据、禁网、环境清空的 parser child；credentialed scheduler 保留 RPC、Storage 和 TokenHub 网络访问。父子只交换有界长度帧：输入最多 64 MiB，DOCX 展开总量最多 16 MiB 且压缩比最多 100，PDF 最多 1000 页、100000 个文本 item，累计文本最多 16 MiB，block/chunk 各最多 10000，索引结果最多 768 KiB（含 envelope 的响应 frame 最多 832 KiB）。PDF.js 的 Brotli 16 KiB 输出块、合并缓冲及普通 decoded-stream 增长都必须在分配前消费同一预算；文本解析不需要的 DCT/JPEG、CCITT、JBIG2、JPX direct decoder 一律拒绝。child 使用 128 MiB V8 old-space；父进程的 192 MiB RSS 轮询只是额外的事后 kill guard，并非 kernel/cgroup hard limit。单次 child wall-time 最多 119 秒；worker 为权威结算预留 5 秒，所有 RPC、Storage、parser 和 completion 共用同一 monotonic 剩余预算，早于 600 秒租约。取消、超时、崩溃、畸形或迟到 frame 都必须杀死/关闭该 child、清零源字节并 fail closed，不能结算其他租约。Parser/Storage/TokenHub 必须在 reserve 内回传原始 operation 的 abort acknowledgement；若任何 operation 忽略 abort 或无法确认 quiescence，必须终止当前 scheduled worker execution containment，不得返回并留下后台 Promise。解析成功后才在同一 SQL 事务中写入 block/chunk/generation membership 并置 ready。Purge 必须先删除 `prepare` 返回的精确 Storage 集合，再提交 metadata complete。真实 Cloud worker 在没有 cgroup、rlimit 或等价 kernel memory boundary 前仍是未满足的发布门禁，必须 fail closed 且保持 kill switch 关闭。
8. worker 还会定时调用 `autoforge_knowledge_cleanup_retention(worker_id, limit, snapshot_limit)`；`limit` 必须为 1..10000，`snapshot_limit` 必须为 1..1000。函数先按复合 owner/id 键有界删除全局过期 snapshot head（item 由复合外键级联删除），再持久提高每个知识库的 retention floor，并清理满 90 天且不再受墓碑保护的 change。
9. 新设备通过 `listKnowledgeBases` 获取由可信 CloudBase UID 派生的 15 分钟稳定 owner catalog；每页最多 512 个 ID、768 KiB，总数最多 10000。后续页必须沿用相同 snapshot ID 和 ordinal，过期 snapshot 返回稳定错误。worker 应定时调用 `autoforge_knowledge_cleanup_owner_catalog(worker_id, limit)`，其中 `limit` 为 1..1000；函数只做有界过期清理。

本地 migration 测试只检查关键 SQL 文本片段，并用彼此独立的 TypeScript 模型验证预期状态转换；它们没有执行 PostgreSQL。发布前必须在隔离预发布环境补齐实际 PostgreSQL 解析/迁移、RLS 跨 owner 拒绝、并发事务/租约竞争、snapshot retention 级联与 purge、CloudBase Function 和 PG Storage 关联漂移测试。这些预发布门禁未完成前不得把本地静态检查称为数据库行为证明。

## 生命周期边界

- 上传授权、对象元数据校验、同步变更、原子发布、删除、取消和孤儿清理由云函数/RPC 执行。孤儿清理先幂等删除私有 Storage 字节，再提交数据库删除。
- 普通知识 RPC 在可信 UID 边界读取 `app_privacy_consent_states` 的当前 `cloud_sync` revision/document version；事件体中的 consent boolean 或 owner 永不参与授权。删除、取消、孤儿清理和 embedding revoke 保留为隐私安全的 cleanup 路径。
- `knowledge_versions` 和 `knowledge_index_generations` 是不可变生成；仅 ready 生成可原子切换为 published。
- 作业使用绑定 worker ID 的 token、过期租约、CAS 与幂等 request/mutation id；仅瞬时错误最多重试三次。
- 增量游标基于单调 sequence；每页同时受 512 行和 768 KiB 预算约束，`nextSequence` 只能等于该页最后一条，`hasMore` 驱动继续拉取。新客户端先完整取得稳定 owner catalog，再逐库使用同一事务物化的稳定 snapshot；任一 catalog 页或知识库同步失败都不能据此裁剪本地 remote-only projection。墓碑与 change 的清理下限持久保留。
- 暂停不会删除云数据；转本地必须先完整下载并校验，再请求云端删除。

## 回滚

先保持桌面 Cloud kill switch 关闭并停止 worker/云函数，依次执行 `migrations/0003_owner_knowledge_catalog.rollback.sql`、user-data `0003_privacy_consent_revocation.rollback.sql`、`migrations/0002_personal_knowledge_workers.rollback.sql` 和 `migrations/0001_personal_knowledge.rollback.sql`。Knowledge 0003 rollback 先撤销 current-consent assertion RPC 并恢复 entitlement-only 的旧 `require_cloud` 定义；user-data rollback 随后禁用 revoke mutation surface。回滚只撤销服务角色权限和 RPC 函数；owner catalog rollback 也保留 snapshot/item 表及其审计数据。所有已接收的表、行、RLS、复合外键与不可变约束继续供审计、对账和后续恢复；禁止把删表、截断或删除数据当作回滚。
