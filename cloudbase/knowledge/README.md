# AutoForge 个人知识库 CloudBase 工件

目标环境为 `autoforge-d1gkhyfb419ba8455`（`ap-shanghai`）。本目录只包含待部署工件；提交或运行测试不会连接、迁移或删除真实 CloudBase 数据。

## 发布前置条件

1. 在隔离的 CloudBase PostgreSQL 预发布环境应用 `migrations/0001_personal_knowledge.sql`，执行跨用户 RLS、并发发布、游标过期、作业租约和回滚演练。
2. 建立私有 PG Storage 空间，并只允许 `autoforge-knowledge` 云函数根据数据库中的 `storage_reference` 执行数据面操作。Electron 不配置 COS 密钥、Service Role 密钥或永久对象 URL。
3. 为云函数配置 `AUTOFORGE_PG_RPC_BASE_URL` 和 `AUTOFORGE_PG_SERVICE_KEY`，然后部署 CommonJS 入口：

   ```sh
   tcb functions:deploy autoforge-knowledge \
     --dir cloudbase/knowledge/function \
     --runtime Nodejs18.15 \
     --install-dependency false
   ```

4. 验证用户 JWT 由 CloudBase 运行时映射到 `context.auth.uid`；事件体中的用户字段始终被忽略。
5. 只有完成迁移、私有存储、RLS、会员签名密钥、杀开关和集成测试后，才可在服务端打开 Cloud 功能。当前桌面端继续返回 `kill_switch_enabled`。

## 生命周期边界

- 上传授权、同步变更、原子发布、删除、取消和孤儿清理由云函数/RPC 执行。
- `knowledge_versions` 和 `knowledge_index_generations` 是不可变生成；仅 ready 生成可原子切换为 published。
- 作业使用 token、过期租约、CAS 与幂等 request/mutation id；仅瞬时错误最多重试三次。
- 增量游标基于单调 sequence；墓碑保留 90 天，过期游标必须全量同步。
- 暂停不会删除云数据；转本地必须先完整下载并校验，再请求云端删除。

## 回滚

先保持桌面 Cloud kill switch 关闭并撤回云函数，再执行 `migrations/0001_personal_knowledge.rollback.sql`。该回滚会删除个人知识库云端表和函数，必须先完成可恢复备份，并在已批准的维护窗口执行。
