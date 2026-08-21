# AutoForge CloudBase 用户角色

目标环境：`autoforge-d1gkhyfb419ba8455`（`ap-shanghai`），数据库模式：CloudBase PostgreSQL。

本目录包含可部署工件；提交代码本身不会修改 CloudBase。推荐发布顺序：

1. 通过 CloudBase PG 迁移工具应用 `../../migrations/20260821105102_user_roles.sql`；`migrations/0001_user_roles.sql` 保留为功能目录内的可读副本，两者由测试保证一致。
2. 为云函数配置 `AUTOFORGE_PG_RPC_BASE_URL` 与 `AUTOFORGE_PG_SERVICE_KEY`。服务密钥只能存在于云函数和受控运维环境，不得进入 Electron/Renderer。
3. 将 `function/` 作为事件型 Node.js 18.15 云函数 `autoforge-user-roles` 部署。例如，在已确认目标环境和变量后使用：

   ```sh
   tcb functions:deploy autoforge-user-roles \
     --dir cloudbase/user-roles/function \
     --runtime Nodejs18.15 \
     --install-dependency false
   ```

4. 先预览现有非匿名用户回填，再显式应用：

   ```sh
   node cloudbase/user-roles/scripts/backfill-users.mjs
   node cloudbase/user-roles/scripts/backfill-users.mjs --apply
   ```

5. 使用明确的 CloudBase UID 预览首个超级管理员，再显式应用：

   ```sh
   node cloudbase/user-roles/scripts/bootstrap-super-admin.mjs --user-id '<CloudBase UID>'
   node cloudbase/user-roles/scripts/bootstrap-super-admin.mjs --user-id '<CloudBase UID>' --apply
   ```

6. 最后发布依赖角色功能的桌面版本。

## 安全边界

- 云函数只从平台 `context.auth.uid`（兼容 `context.userInfo.uid`/`context.UID`）取得调用者，拒绝 event 中的 userId。
- `PUBLIC`、`anon`、`authenticated` 对角色表、审计表和 RPC 均无权限；只有 `service_role` 可执行公开 RPC。
- `listUsers` 只返回脱敏联系方式，不返回 token、密码或其他用户的大模型用量/消费。
- `updateUserRole` 仅接受 `user`/`super_admin`，使用 requestId 幂等、expectedVersion 乐观锁，禁止自改并串行保护最后一个活跃超级管理员。
- 新角色可在 `app_user_roles.role` 中扩展，但必须先在云端 capability 映射和可分配角色策略中显式启用。

## 回滚

先撤回桌面功能，再执行 `migrations/0001_user_roles.rollback.sql`。回滚脚本撤销并删除 RPC，但故意保留角色与审计表，以便恢复和取证；确认不再需要数据后才可另行审批删除表。
