# Business Role and User Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 AutoForge 增加可扩展的业务角色投影与用户管理能力：注册默认普通用户，登录/恢复会话时取得权威角色，只有具备 `manage_users` 能力的 `super_admin` 可以查询用户和修改角色。

**Architecture:** CloudBase PostgreSQL 是角色真相源，私有 Cloud Function 是桌面端唯一角色入口；Electron Main 复用已认证的 CloudBase SDK 会话调用函数，校验响应后把当前用户角色与本地身份、资料、会话一起事务化投影到 SQLite。Renderer 只消费严格 IPC 契约，以 capability 控制菜单和路由体验；Cloud Function 与 PostgreSQL 函数再次做服务端授权、并发控制、审计和最后管理员保护。

**Tech Stack:** TypeScript, Electron Main/Preload, Vue 3, Pinia, Vue Router, Element Plus, Zod, better-sqlite3/Drizzle schema declarations, CloudBase JavaScript SDK 3.8, CloudBase PostgreSQL, PostgreSQL SQL/PLpgSQL, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-21-business-roles-user-management-design.md`

## Global Constraints

- CloudBase 环境保持 `autoforge-d1gkhyfb419ba8455`、区域保持 `ap-shanghai`，数据库模式为 PostgreSQL。
- CloudBase PostgreSQL 是角色唯一真相源；SQLite 仅保存当前登录用户投影，不能给本机提权。
- 首期可分配角色只有 `user`、`super_admin`，但客户端 role 使用受限字符串而不是封闭枚举；未知未来角色可读取、不可在首期 UI 中分配。
- 首期 capability 只有 `manage_users`；授权判断使用 capability，不在菜单或路由里散落 `role === 'super_admin'`。
- Cloud Function 不接受调用方 userId；调用方身份必须来自 CloudBase 可信 context/token。
- PostgreSQL 表、RPC 对 `PUBLIC`、`anon`、`authenticated` 全部拒绝，仅服务角色可访问。
- Renderer、Electron、日志、仓库和测试快照不得包含 CloudBase API Key、数据库凭据、access token 或 refresh token。
- 用户管理不包含封禁、删除、修改联系方式/密码、批量操作、导出、审计 UI，以及查询其他用户的大模型用量或消费。
- 不打开可见浏览器；验证使用单元、集成、构建与 headless 测试。
- 不执行云端写操作或部署；本分支只提交可部署工件并执行只读环境预检，实际应用迁移/部署等待单独确认。

---

### Task 1: 共享角色、会话和用户管理契约

**Files:**
- Modify: `packages/shared/src/desktop-api.ts`
- Modify: `packages/shared/src/contracts.test.ts`

**Contract:** `AuthSession` 增加 `authorization`；用户管理 IPC 输入输出严格校验；角色字符串允许未来扩展，但分配输入只允许 `user | super_admin`。

- [ ] 写失败测试：默认/超级管理员授权快照、未知合法角色、非法 role、分页/字段检索、角色更新乐观锁和额外字段拒绝。
- [ ] 运行 `pnpm exec vitest run packages/shared/src/contracts.test.ts`，确认 RED。
- [ ] 实现 `roleIdSchema`、`capabilitySchema`、`authorizationSnapshotSchema`、`userAdminListRequest/ResponseSchema`、`userAdminUpdateRoleRequestSchema` 与对应 Desktop API/IPC channel。
- [ ] 运行共享契约测试与 `pnpm --filter @autoforge/shared typecheck`，确认 GREEN。

### Task 2: SQLite 当前用户角色投影

**Files:**
- Create: `apps/desktop/resources/migrations/0008_local_user_roles.sql`
- Modify: `apps/desktop/electron/main/database/schema.ts`
- Modify: `apps/desktop/electron/main/database/client.ts`
- Modify: `apps/desktop/electron/main/auth/cloudbase-identity-repository.ts`
- Modify: `apps/desktop/electron/main/auth/cloudbase-identity-repository.test.ts`

**Contract:** `syncAuthenticatedIdentity(identity, authorization)` 单事务 upsert `local_users`、`local_user_profiles`、`local_user_roles` 并替换 `local_auth_session`。

- [ ] 写失败测试：角色行初建、版本更新、事务失败回滚四张表、未知未来角色可投影。
- [ ] 运行目标 repository 测试并确认 RED。
- [ ] 增加带 FK、role 格式约束、版本和云端时间的 migration/schema；扩展 repository 聚合事务。
- [ ] 运行 repository 测试、迁移测试和 desktop main typecheck。

### Task 3: CloudBase 角色调用端口与认证编排

**Files:**
- Create: `apps/desktop/electron/main/auth/cloudbase-role-port.ts`
- Create: `apps/desktop/electron/main/auth/cloudbase-role-service.ts`
- Create: `apps/desktop/electron/main/auth/cloudbase-role-service.test.ts`
- Modify: `apps/desktop/electron/main/auth/cloudbase-auth-port.ts`
- Modify: `apps/desktop/electron/main/application.ts`
- Modify: `apps/desktop/electron/main/application.test.ts`

**Contract:** 同一个 CloudBase app/auth 会话调用 `ensureMyRole`；登录、注册、OTP 验证与启动恢复必须先取得权威角色再提交本地投影。刷新失败将 authorization 标成未确认并清除 capabilities，不沿用过期管理员能力。

- [ ] 写失败测试：函数响应解析、稳定错误映射、登录成功同步角色、角色获取失败关闭登录、恢复失败不恢复管理员授权、刷新降权。
- [ ] 运行目标测试并确认 RED。
- [ ] 复用单一 CloudBase app 初始化，增加严格 unknown 响应解析的 RoleService，并把 authorization 合并到 AuthSession。
- [ ] 在应用启动恢复和认证完成链路接入角色确认与原子本地投影；提供 session authorization refresh 服务。
- [ ] 运行 auth/application 目标测试并 typecheck。

### Task 4: 用户管理 Main 服务、IPC 与 Preload

**Files:**
- Create: `apps/desktop/electron/main/user-admin/user-admin-service.ts`
- Create: `apps/desktop/electron/main/user-admin/user-admin-service.test.ts`
- Modify: `apps/desktop/electron/main/ipc/register-ipc.ts`
- Modify: `apps/desktop/electron/main/ipc/register-ipc.test.ts`
- Modify: `apps/desktop/electron/preload/bridge.ts`
- Modify: `apps/desktop/electron/preload/bridge.test.ts`
- Modify: `apps/desktop/electron/main/application.ts`

**Contract:** Main service 只透传严格的 `listUsers`/`updateUserRole` Cloud Function action；更新成功后若目标是当前用户则刷新本地 authorization。Cloud Function 授权仍是安全边界。

- [ ] 写失败测试：两个 IPC channel、输入严格校验、未登录拒绝、函数错误稳定传递、preload API 形状。
- [ ] 运行目标测试并确认 RED。
- [ ] 实现最小 service、注册 IPC、扩展 preload bridge 和 application service graph。
- [ ] 运行 IPC/preload/user-admin 测试与 desktop typecheck。

### Task 5: Renderer capability、路由与用户管理页面

**Files:**
- Modify: `apps/desktop/src/stores/auth.ts`
- Modify: `apps/desktop/src/router/index.ts`
- Modify: `apps/desktop/src/components/AppRail.vue`
- Create: `apps/desktop/src/views/UserManagementView.vue`
- Create: `apps/desktop/src/stores/user-admin.ts`
- Modify: `apps/desktop/tests/components/auth.test.ts`
- Create: `apps/desktop/tests/components/user-management.test.ts`

**Contract:** `manage_users` 决定菜单与 `/users` 访问。未知角色只读展示；仅 `user`、`super_admin` 可被选择；自己不可编辑；更新带 `requestId` 与 `expectedVersion`，冲突后刷新列表。

- [ ] 写失败组件测试：普通用户无菜单、管理员有菜单、直接访问无权跳 `/chat`、字段检索/分页、脱敏展示、确认修改、自己禁用、冲突刷新、页面没有用量消费入口。
- [ ] 运行两个组件测试并确认 RED。
- [ ] 实现 auth capability getter、路由 meta 守卫、导航项、store 与 Element Plus 页面。
- [ ] 运行组件测试、renderer typecheck 和构建。

### Task 6: PostgreSQL 迁移、事务函数与 Cloud Function 工件

**Files:**
- Create: `cloudbase/user-roles/migrations/0001_user_roles.sql`
- Create: `cloudbase/user-roles/migrations/0001_user_roles.rollback.sql`
- Create: `cloudbase/user-roles/function/package.json`
- Create: `cloudbase/user-roles/function/index.js`
- Create: `cloudbase/user-roles/function/user-role-handler.js`
- Create: `cloudbase/user-roles/function/user-role-handler.test.ts`
- Create: `cloudbase/user-roles/scripts/backfill-users.mjs`
- Create: `cloudbase/user-roles/scripts/bootstrap-super-admin.mjs`
- Create: `cloudbase/user-roles/README.md`

**Contract:** SQL 创建私有表与 `ensure/list/update` 事务函数。Function 从可信 context 提取 uid，使用仅云函数环境变量中的服务凭据调用 PG RPC。Bootstrap 默认 dry-run、要求显式 UID、幂等；backfill 仅补缺失普通角色。

- [ ] 写失败 handler 测试：无身份、ensure、分页查询、角色更新、未知 action、PG 错误映射；写 SQL 结构测试覆盖 revoke、审计唯一 request_id、乐观锁、自改禁止和最后管理员保护。
- [ ] 运行 cloud artifact 测试并确认 RED。
- [ ] 实现 migration：表、索引、权限回收、`SECURITY DEFINER` + 固定 `search_path` 的事务函数；列表从 `auth.users` 读取并在服务端脱敏。
- [ ] 实现薄 Function handler、PG RPC client、dry-run 脚本与部署/回滚说明，不写入真实密钥。
- [ ] 运行 handler/SQL 工件测试和脚本 `--help`/dry-run 校验。

### Task 7: 回归、CloudBase 审查与只读预检

**Files:**
- Modify only if a failing check identifies a task-related defect.

- [ ] 运行 CloudBase code review 的静态检查，并逐项人工确认：客户端无服务密钥、表/RPC 无公共权限、客户端 role 不作为服务端安全边界。
- [ ] 使用现有 CloudBase CLI/配置执行只读预检：确认登录环境、目标 env/region、PostgreSQL 能力与待部署函数名称；不创建表、不部署函数、不 bootstrap 管理员。
- [ ] 运行 `pnpm test`、`pnpm typecheck`、`pnpm lint`、`pnpm build`；区分新增失败与既有失败。
- [ ] 检查 `git diff --check`、敏感信息扫描和最终 diff，确认无用量/消费跨用户查询能力。
- [ ] 提交完成的实现，推送 `codex/business-role-management` 到 `origin`。

## Completion Gate

- 新用户首次成功认证获得 `user`，登录/恢复 session 携带已确认 authorization。
- 本地四表同步原子完成，离线/错误状态不会保留管理员 capability。
- `manage_users` 用户可以分页查询并修改他人 `user`/`super_admin` 角色；普通用户在 UI、IPC 与云端均不能越权。
- 角色更新具备 requestId 幂等、expectedVersion 冲突、禁止自改、保护最后一个超级管理员和审计记录。
- 未来 role 字符串可以被存储和展示而不崩溃，但首期不能从 UI 分配。
- 云工件可部署且有回滚/初始化文档；本任务没有未经确认地修改真实 CloudBase 资源。
- 全量测试、类型检查、lint、构建和 CloudBase 安全审查通过，分支已推送远端。
