# AutoForge 个人知识库 CloudBase 工件

目标环境为 `autoforge-d1gkhyfb419ba8455`（`ap-shanghai`）。本目录只包含待部署工件；提交或运行测试不会连接、迁移或删除真实 CloudBase 数据。

## 发布前置条件

1. 在隔离的 CloudBase PostgreSQL 预发布环境依次应用 `migrations/0001_personal_knowledge.sql`、additive `migrations/0002_personal_knowledge_workers.sql` 和 `migrations/0003_owner_knowledge_catalog.sql`，执行跨用户 RLS、并发发布、游标过期、owner catalog 分页、作业租约和回滚演练。
2. 建立私有 PG Storage 空间，并只允许 `autoforge-knowledge` 云函数和 `autoforge-knowledge-worker` 根据数据库中的 `storage_reference` 执行数据面操作。上传使用可消费、15 分钟过期的 PG Storage 授权；Electron 不配置 COS 密钥、Service Role 密钥或永久对象 URL。
3. 为云函数配置 `AUTOFORGE_PG_RPC_BASE_URL`、`AUTOFORGE_PG_STORAGE_BASE_URL`、精确 HTTPS 上传路径前缀 `AUTOFORGE_PG_STORAGE_UPLOAD_URL_PREFIX` 和 `AUTOFORGE_PG_SERVICE_KEY`。上传授权只允许该前缀下绑定 ticket 的 URL，以及 `content-type`、`content-length`、`x-content-sha256`、`x-upload-ticket` 四个客户端头；禁止返回 Authorization、Cookie 或服务凭据。Storage 适配器需要提供幂等的 `POST /upload-authorizations`、`POST /objects/stat` 与 `POST /objects/delete` 私有服务端接口，然后部署 CommonJS 入口：

   ```sh
   tcb functions:deploy autoforge-knowledge \
     --dir cloudbase/knowledge/function \
     --runtime Nodejs18.15 \
     --install-dependency false
   ```

4. 验证用户 JWT 由 CloudBase 运行时映射到 `context.auth.uid`；事件体中的用户字段会被严格拒绝，不能参与所有权判定。
5. 只有完成迁移、私有存储、RLS、会员签名密钥、杀开关和集成测试后，才可在服务端打开 Cloud 功能。当前桌面端继续返回 `kill_switch_enabled`。
6. 将本目录作为完整 CommonJS 部署包（根 `index.js` 是 worker 入口），安装根 `package.json` 锁定的依赖，再创建定时调用的 `autoforge-knowledge-worker`。它需要 `AUTOFORGE_PG_RPC_BASE_URL`、`AUTOFORGE_PG_STORAGE_BASE_URL`、`AUTOFORGE_PG_SERVICE_KEY`、`AUTOFORGE_TOKENHUB_EMBEDDING_URL` 和 `AUTOFORGE_TOKENHUB_API_KEY`；可选的 `AUTOFORGE_KNOWLEDGE_WORKER_ID` 只允许 1..96 位字母、数字、下划线或连字符。这些变量只能由服务端 secret manager 注入。
7. worker 每次最多领取 8 个作业，租约绑定 worker/token/expiry，仅 `TRANSIENT_FAILURE` 可在后续调度中重试，第三次失败终止。Embedding 每次只处理 2 个 chunk，已持久进度用 lease-CAS yield 重新排队且不消耗瞬时失败预算。Upload 依次读取并校验私有对象、解析、在同一 SQL 事务中写入 block/chunk/generation membership 并置 ready。Purge 必须先删除 `prepare` 返回的精确 Storage 集合，再提交 metadata complete。
8. worker 还会定时调用 `autoforge_knowledge_cleanup_retention(worker_id, limit, snapshot_limit)`；`limit` 必须为 1..10000，`snapshot_limit` 必须为 1..1000。函数先按复合 owner/id 键有界删除全局过期 snapshot head（item 由复合外键级联删除），再持久提高每个知识库的 retention floor，并清理满 90 天且不再受墓碑保护的 change。
9. 新设备通过 `listKnowledgeBases` 获取由可信 CloudBase UID 派生的 15 分钟稳定 owner catalog；每页最多 512 个 ID、768 KiB，总数最多 10000。后续页必须沿用相同 snapshot ID 和 ordinal，过期 snapshot 返回稳定错误。worker 应定时调用 `autoforge_knowledge_cleanup_owner_catalog(worker_id, limit)`，其中 `limit` 为 1..1000；函数只做有界过期清理。

本地 migration 测试只检查关键 SQL 文本片段，并用彼此独立的 TypeScript 模型验证预期状态转换；它们没有执行 PostgreSQL。发布前必须在隔离预发布环境补齐实际 PostgreSQL 解析/迁移、RLS 跨 owner 拒绝、并发事务/租约竞争、snapshot retention 级联与 purge、CloudBase Function 和 PG Storage 关联漂移测试。这些预发布门禁未完成前不得把本地静态检查称为数据库行为证明。

## 生命周期边界

- 上传授权、对象元数据校验、同步变更、原子发布、删除、取消和孤儿清理由云函数/RPC 执行。孤儿清理先幂等删除私有 Storage 字节，再提交数据库删除。
- `knowledge_versions` 和 `knowledge_index_generations` 是不可变生成；仅 ready 生成可原子切换为 published。
- 作业使用绑定 worker ID 的 token、过期租约、CAS 与幂等 request/mutation id；仅瞬时错误最多重试三次。
- 增量游标基于单调 sequence；每页同时受 512 行和 768 KiB 预算约束，`nextSequence` 只能等于该页最后一条，`hasMore` 驱动继续拉取。新客户端先完整取得稳定 owner catalog，再逐库使用同一事务物化的稳定 snapshot；任一 catalog 页或知识库同步失败都不能据此裁剪本地 remote-only projection。墓碑与 change 的清理下限持久保留。
- 暂停不会删除云数据；转本地必须先完整下载并校验，再请求云端删除。

## 回滚

先保持桌面 Cloud kill switch 关闭并停止 worker/云函数，依次执行 `migrations/0003_owner_knowledge_catalog.rollback.sql`、`migrations/0002_personal_knowledge_workers.rollback.sql` 和 `migrations/0001_personal_knowledge.rollback.sql`。回滚只撤销服务角色权限和 RPC 函数；owner catalog rollback 也保留 snapshot/item 表及其审计数据。所有已接收的表、行、RLS、复合外键与不可变约束继续供审计、对账和后续恢复；禁止把删表、截断或删除数据当作回滚。
