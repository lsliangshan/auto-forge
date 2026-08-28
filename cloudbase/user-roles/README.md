# AutoForge CloudBase 用户角色

目标环境：`autoforge-d1gkhyfb419ba8455`（`ap-shanghai`），数据库模式：CloudBase PostgreSQL。

本目录包含可部署工件；提交代码本身不会修改 CloudBase。推荐发布顺序：

1. 通过 CloudBase PG 迁移工具应用已发布的基础迁移 `../../migrations/20260821105102_user_roles.sql`；`migrations/0001_user_roles.sql` 保留为功能目录内的可读副本，两者由测试保证一致。
2. 再应用 additive 迁移 `../../migrations/20260828200000_user_role_knowledge_entitlement.sql`；`migrations/0002_knowledge_entitlement.sql` 是与之逐字节一致的功能目录副本。
3. 为云函数配置 `AUTOFORGE_PG_RPC_BASE_URL` 与 `AUTOFORGE_PG_SERVICE_KEY`。服务密钥只能存在于云函数和受控运维环境，不得进入 Electron/Renderer。
4. 将 `function/` 作为事件型 Node.js 18.15 云函数 `autoforge-user-roles` 部署。例如，在已确认目标环境和变量后使用：

   ```sh
   tcb functions:deploy autoforge-user-roles \
     --dir cloudbase/user-roles/function \
     --runtime Nodejs18.15 \
     --install-dependency false
   ```

5. 先预览现有非匿名用户回填，再显式应用：

   ```sh
   node cloudbase/user-roles/scripts/backfill-users.mjs
   node cloudbase/user-roles/scripts/backfill-users.mjs --apply
   ```

6. 使用明确的 CloudBase UID 预览首个超级管理员，再显式应用：

   ```sh
   node cloudbase/user-roles/scripts/bootstrap-super-admin.mjs --user-id '<CloudBase UID>'
   node cloudbase/user-roles/scripts/bootstrap-super-admin.mjs --user-id '<CloudBase UID>' --apply
   ```

7. 最后发布依赖角色功能的桌面版本。

## 验证顺序

1. 本地测试先确认基础迁移与 `migrations/0001_user_roles.sql` 的字节和固定哈希未变化，再确认 additive 迁移与 `migrations/0002_knowledge_entitlement.sql` 逐字节一致，并扫描回滚脚本不存在 `DROP`、`TRUNCATE` 或 `DELETE`。
2. 在隔离的 CloudBase PostgreSQL 预发布环境依次解析并执行基础迁移和 additive 迁移，验证既有角色行未变化、entitlement 约束有效、RPC 只对 `service_role` 可执行。
3. 写入一个合规的测试 entitlement，确认 RPC 返回其不透明 `payload`/`signature`；然后按下述顺序演练回滚和重新应用，确认同一值始终保留且重新出现在 RPC 投影中。

本地扫描不是实际 PostgreSQL 行为证明；预发布解析、权限和数据保留演练未通过前，不得部署云函数或打开桌面 Cloud kill switch。

## 安全边界

- 云函数只从平台 `context.auth.uid`（兼容 `context.userInfo.uid`/`context.UID`）取得调用者，拒绝 event 中的 userId。
- `PUBLIC`、`anon`、`authenticated` 对角色表、审计表和 RPC 均无权限；只有 `service_role` 可执行公开 RPC。
- `listUsers` 只返回脱敏联系方式，不返回 token、密码或其他用户的大模型用量/消费。
- `updateUserRole` 仅接受 `user`/`super_admin`，使用 requestId 幂等、expectedVersion 乐观锁，禁止自改并串行保护最后一个活跃超级管理员。
- 新角色可在 `app_user_roles.role` 中扩展，但必须先在云端 capability 映射和可分配角色策略中显式启用。

## 回滚

按以下顺序演练 entitlement 回滚和恢复：

1. 保持桌面 Cloud kill switch 关闭，并先撤回依赖 entitlement 投影的桌面功能。
2. 执行 `migrations/0002_knowledge_entitlement.rollback.sql`。该脚本只把 `autoforge_ensure_my_role` 恢复为上一版投影并重申最小权限；它保留 `knowledge_entitlement` 列、约束和已有值。
3. 验证 RPC 不再返回 entitlement，同时数据库中的测试 entitlement 值仍存在。
4. 重新应用 `../../migrations/20260828200000_user_role_knowledge_entitlement.sql`，验证同一 entitlement 值重新出现在 RPC 投影中，再恢复依赖该投影的功能。
5. 只有在确定撤销整个用户角色 RPC 面、而非演练 entitlement 回滚时，才可另行执行 `migrations/0001_user_roles.rollback.sql`。基础回滚同样保留角色表、审计表和已接收数据，供审计、对账与恢复。

禁止把删列、删表、截断或删除已接收数据当作回滚。
