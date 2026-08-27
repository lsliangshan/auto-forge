# AutoForge 个人知识库 CloudBase 工件

目标环境为 `autoforge-d1gkhyfb419ba8455`（`ap-shanghai`）。本目录只包含待部署工件；提交或运行测试不会连接、迁移或删除真实 CloudBase 数据。

## 发布前置条件

1. 在隔离的 CloudBase PostgreSQL 预发布环境应用 `migrations/0001_personal_knowledge.sql`，执行跨用户 RLS、并发发布、游标过期、作业租约和回滚演练。
2. 建立私有 PG Storage 空间，并只允许 `autoforge-knowledge` 云函数根据数据库中的 `storage_reference` 执行数据面操作。上传使用可消费、15 分钟过期的 PG Storage 授权；Electron 不配置 COS 密钥、Service Role 密钥或永久对象 URL。
3. 为云函数配置 `AUTOFORGE_PG_RPC_BASE_URL`、`AUTOFORGE_PG_STORAGE_BASE_URL`、精确 HTTPS 上传路径前缀 `AUTOFORGE_PG_STORAGE_UPLOAD_URL_PREFIX` 和 `AUTOFORGE_PG_SERVICE_KEY`。上传授权只允许该前缀下绑定 ticket 的 URL，以及 `content-type`、`content-length`、`x-content-sha256`、`x-upload-ticket` 四个客户端头；禁止返回 Authorization、Cookie 或服务凭据。Storage 适配器需要提供幂等的 `POST /upload-authorizations`、`POST /objects/stat` 与 `POST /objects/delete` 私有服务端接口，然后部署 CommonJS 入口：

   ```sh
   tcb functions:deploy autoforge-knowledge \
     --dir cloudbase/knowledge/function \
     --runtime Nodejs18.15 \
     --install-dependency false
   ```

4. 验证用户 JWT 由 CloudBase 运行时映射到 `context.auth.uid`；事件体中的用户字段会被严格拒绝，不能参与所有权判定。
5. 只有完成迁移、私有存储、RLS、会员签名密钥、杀开关和集成测试后，才可在服务端打开 Cloud 功能。当前桌面端继续返回 `kill_switch_enabled`。
6. 由受信任 worker 领取 token/expiry 租约。对于 purge job，依次调用 `autoforge_knowledge_prepare_base_purge`、幂等删除返回的全部私有 Storage 字节、再用完全相同的引用集合调用 `autoforge_knowledge_complete_base_purge`；不得把这两个 worker RPC 暴露给 Electron。worker 还需定时调用 `autoforge_knowledge_cleanup_retention(worker_id, change_limit, snapshot_limit)`；`change_limit` 必须为 1..10000，`snapshot_limit` 必须为 1..1000。函数先按复合 owner/id 键有界删除全局过期 snapshot head（item 由复合外键级联删除），再持久提高每个知识库的 retention floor，并清理满 90 天且不再受墓碑保护的 change。验证第三次过期租约进入 `failed`，仅 `TRANSIENT_FAILURE` 可以重新排队。

本地 migration 测试只检查关键 SQL 文本片段，并用彼此独立的 TypeScript 模型验证预期状态转换；它们没有执行 PostgreSQL。发布前必须在隔离预发布环境补齐实际 PostgreSQL 解析/迁移、RLS 跨 owner 拒绝、并发事务/租约竞争、snapshot retention 级联与 purge、CloudBase Function 和 PG Storage 关联漂移测试。这些预发布门禁未完成前不得把本地静态检查称为数据库行为证明。

## 生命周期边界

- 上传授权、对象元数据校验、同步变更、原子发布、删除、取消和孤儿清理由云函数/RPC 执行。孤儿清理先幂等删除私有 Storage 字节，再提交数据库删除。
- `knowledge_versions` 和 `knowledge_index_generations` 是不可变生成；仅 ready 生成可原子切换为 published。
- 作业使用绑定 worker ID 的 token、过期租约、CAS 与幂等 request/mutation id；仅瞬时错误最多重试三次。
- 增量游标基于单调 sequence；每页同时受 512 行和 768 KiB 预算约束，`nextSequence` 只能等于该页最后一条，`hasMore` 驱动继续拉取。新客户端、过期游标以及保留窗口内无 change 的知识库使用同一事务物化的稳定 snapshot，并按相同预算分页；墓碑与 change 的清理下限持久保留。
- 暂停不会删除云数据；转本地必须先完整下载并校验，再请求云端删除。

## 回滚

先保持桌面 Cloud kill switch 关闭并撤回云函数，再执行 `migrations/0001_personal_knowledge.rollback.sql`。该回滚只撤销服务角色权限和 RPC 函数，保留表、行、RLS、复合外键与不可变约束，供审计、对账和后续恢复；禁止把删表、截断或删除已接收数据当作回滚。
