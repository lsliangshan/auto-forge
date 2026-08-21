# AutoForge CloudBase 与本地用户数据同步设计规格

日期：2026-08-21

状态：已确认，直接实施

## 1. 目标

将 CloudBase 身份用户投影到 AutoForge 本地 SQLite。每次注册、登录或启动恢复真实 CloudBase 会话后，应用必须以同一个 CloudBase UID 原子更新 `local_users`、`local_user_profiles` 和 `local_auth_session`。本地数据是业务关联与离线展示副本，CloudBase 会话仍是唯一认证依据。

用户资料采用混合同步：CloudBase 负责 UID、账号、昵称、头像、性别和已验证联系方式；登录时 CloudBase 覆盖对应本地字段。生日保留为本地字段。用户从资料页修改昵称、头像或性别时先更新 CloudBase，成功后写本地；邮箱和手机号只读，不在本次实现换绑验证码流程。

## 2. 已确认决策

1. CloudBase 是可映射身份字段的权威来源。
2. 首次同步发生冲突时，CloudBase 值优先；本地专属生日保留。
3. 历史本地账号不按用户名自动合并。CloudBase UID 对应独立本地用户投影。
4. CloudBase 登录成功但本地同步失败时，登录整体失败并清理刚建立的本地认证状态。
5. 邮箱和手机号在个人资料页只读；更换联系方式留给独立的验证码流程。
6. 不新增后台同步任务，不引入 CloudBase 数据库、云函数或 CloudRun。
7. 现有三张本地表已足以表达投影，本次不修改表结构。

## 3. 成功标准

1. 手机或邮箱验证码注册、手机或邮箱验证码登录、用户名密码登录及启动恢复会话后，三张本地表都指向同一个 CloudBase UID。
2. `local_auth_session` 固定只保留 `id = 1` 的当前会话投影，每次成功认证以 CloudBase `authenticatedAt` 替换。
3. 登录时 CloudBase 明确返回的账号、昵称、头像、性别、已验证邮箱和已验证手机号同步到本地；生日不被覆盖。
4. CloudBase 缺少某个字段或字段格式不可识别时保留本地值；CloudBase 明确返回空值时清空对应本地值。
5. 资料页修改昵称、头像或性别时先更新 CloudBase，云端失败则本地不变。
6. 邮箱和手机号在 Renderer 中只读，并且 Main 的普通资料更新契约不接受这两个字段。
7. 三表写入在一个 SQLite 事务中执行；失败时不留下部分用户、资料或会话数据。
8. 本地同步失败后不能进入主窗口；本地加密令牌和内存身份缓存被丢弃，CloudBase SDK 退出为尽力操作。
9. `local_auth_session` 不作为权限证明；所有业务权限判断继续依赖 CloudBase `getSession()` / `requireSession()`。
10. 认证、数据库、Profile、IPC、Renderer 组件测试、类型检查、Lint 和生产构建通过。

## 4. 范围

### 4.1 包含

- 扩充内部认证用户快照，使 Main 能取得 CloudBase 可同步资料。
- CloudBase Auth Port 的 `getUser`、`refreshUser`、`updateUser` 和本地会话丢弃边界。
- CloudBase 用户响应的安全解析、字段规范化和加密快照恢复。
- 本地用户、资料和会话的单事务投影。
- 所有成功注册、登录、恢复路径接入同一投影入口。
- 成功登出后清理 `local_auth_session`。
- Profile Service 的 CloudBase 优先更新顺序。
- Profile 页面邮箱和手机号只读。
- 相关共享契约、单元测试和集成测试。

### 4.2 不包含

- 历史本地账号与 CloudBase 用户的自动合并或外键迁移。
- 邮箱或手机号换绑验证码流程。
- 生日同步到 CloudBase 非标准元数据。
- 聊天、工作流、设置或用量数据上传 CloudBase。
- CloudBase 数据库、云函数、CloudRun 或后台同步队列。
- Provider、SMTP、短信通道或 Publishable Key 配置变更。

## 5. 方案选择

### 5.1 采用：应用层认证门面 + 数据库聚合事务

CloudBaseAuthService 负责 SDK、令牌和云端用户快照；Application 的认证门面负责在每次真实会话建立后调用数据库聚合事务；数据库聚合事务负责三张表的原子写入。ProfileService 通过认证领域的窄更新方法先写 CloudBase，再写本地资料。

这样可以保持三条边界：

- CloudBase SDK 不直接依赖 SQLite。
- Application 只编排“认证成功后同步”，不拼装 SQL。
- SQLite 事务不访问网络，能可靠回滚本地三表。

### 5.2 未采用：CloudBaseAuthService 直接写数据库

该方案会让认证 SDK 与 SQLite 生命周期、事务和业务外键耦合，使认证服务难以独立测试或替换 Provider。

### 5.3 未采用：认证事件异步投影

异步投影允许先进入主窗口再补写本地数据，会产生半登录状态，与已确认的失败关闭语义冲突。

## 6. 数据契约

共享的 `AuthUser` 保留现有 `id` 和 `account`，增加可选的 Provider 快照：

```ts
interface AuthUser {
  id: string
  account: string
  profile?: {
    displayName?: string | null
    avatarUrl?: string | null
    gender?: 'male' | 'female' | 'other' | 'prefer_not_to_say' | null
    email?: string | null
    phone?: string | null
  }
}
```

`undefined`、`null` 和有效值有不同语义：

- `undefined`：CloudBase 未提供或值不可识别，本地保留原值。
- `null`：CloudBase 明确表示为空，本地清空。
- 有效值：覆盖本地。

`AuthSession` 继续包含 `user` 和 `authenticatedAt`。Renderer 可以读取当前用户自己的公开资料，但任何 Access Token、Refresh Token、密码和验证码都不进入该契约。

`UserProfileUpdate` 只保留：

```ts
interface UserProfileUpdate {
  avatarUrl?: string
  displayName?: string
  gender?: ProfileGender
  birthDate?: string
}
```

邮箱和手机号继续存在于 `UserProfile` 输出中，但从普通更新输入移除。

## 7. CloudBase 字段映射

### 7.1 用户

- `local_users.id` 使用 CloudBase `user.id`。
- `local_users.account` 优先使用 CloudBase username，其次使用注册 nickname。
- `local_users.account_normalized` 使用 `cloudbase:<uid>`，不参与历史本地账号的用户名唯一性空间。
- `local_users.password_digest` 使用现有不可登录标记 `!external-identity:<uid>`，不保存或派生 CloudBase 密码。
- `created_at` 首次投影时写当前时间；后续投影保留。
- `updated_at` 每次成功投影更新。

### 7.2 资料

- `display_name`：nickname、nickName 或 name。
- `avatar_url`：avatarUrl、avatar_url 或 picture；非规范 HTTPS URL 视为不可识别并保留本地。
- `gender`：大小写无关地映射 MALE/FEMALE/OTHER/PREFER_NOT_TO_SAY 到本地枚举；未知值保留本地。
- `email`：只有 CloudBase 同时返回邮箱与确认时间时同步；未验证值不进入本地资料。
- `phone`：只有 CloudBase 同时返回手机号与确认时间时同步；规范化后必须符合本地手机号输出约束。
- `birth_date`：始终保留本地值。

CloudBase 明确返回字段为 `null` 或空字符串时转换为 `null`；完全缺少字段时转换为 `undefined`。

## 8. 本地事务

数据库暴露一个领域专用方法：

```ts
syncCloudBaseIdentity(
  session: AuthSession,
  timestamp: number,
): LocalAuthSessionRecord
```

该方法在一个 better-sqlite3 事务中：

1. 按 CloudBase UID upsert `local_users`，并验证该 UID 没有被历史本地身份占用。
2. 读取现有 `local_user_profiles`。
3. 按三态字段规则合并 CloudBase Profile 快照，保留 `birth_date`。
4. upsert 合并后的 `local_user_profiles`。即使 CloudBase 没有资料字段，也建立与当前 UID 对应的资料行，保证同步完成后两张用户表已打通。
5. upsert `local_auth_session(id = 1)`，`user_id` 为 CloudBase UID，`authenticated_at` 使用 `AuthSession.authenticatedAt` 转换的毫秒值。
6. 回读并验证会话指向当前 UID；任一步失败整体回滚。

`clearSession()` 保持幂等。历史本地用户和其资料不删除、不改写。

## 9. 认证数据流

### 9.1 登录、注册和恢复

1. CloudBaseAuthService 完成 OTP 验证、密码登录或会话恢复。
2. 服务解析 CloudBase 用户并返回带公开 Profile 快照的 `AuthSession`。
3. Application 认证门面调用 `syncCloudBaseIdentity`。
4. 本地事务成功后才把会话返回 Renderer，Renderer 才能进入主窗口。
5. 后续同进程 `requireSession()` 可重复调用同步入口；upsert 必须幂等。

### 9.2 同步失败

1. SQLite 事务回滚。
2. Application 调用认证服务的本地失效方法，删除加密令牌、内存身份缓存和待处理挑战。
3. 认证服务尽力调用 CloudBase `signOut()`；远端退出失败不得阻止本地凭据删除。
4. 返回固定 `INTERNAL_ERROR`，不得把 SQL、SDK 响应、令牌或用户联系方式写入错误。

### 9.3 登出

1. CloudBase 明确退出成功或报告已经退出后，认证服务删除加密令牌。
2. Application 清除 `local_auth_session` 并更新内存认证状态。
3. CloudBase 网络/服务错误时保留云端凭据和本地会话并返回失败。

## 10. 资料更新数据流

ProfileService 将输入拆分为云端字段和本地字段：

- 云端字段：`displayName`、`avatarUrl`、`gender`。
- 本地字段：`birthDate`。

流程：

1. `requireSession()` 确认真实 CloudBase 会话。
2. 输入包含云端字段时调用 CloudBase `updateUser()`，参数映射为 nickname、avatar_url、gender。
3. CloudBase 返回成功后解析最新用户快照；返回错误时本地不写入。
4. 将云端快照与生日一起写入当前用户的本地资料。
5. 如果 CloudBase 成功而本地写入失败，返回固定错误；下一次登录以 CloudBase 快照修复云端字段，本次生日输入不自动重放。

只有生日变化时不调用 CloudBase。邮箱和手机号不出现在更新 DTO；Main 的严格 Schema 会拒绝带这两个键的请求。

## 11. UI

个人资料页面保留邮箱和手机号的展示位置，但改为只读文本或 disabled 输入，并显示“来自 CloudBase 账号，修改需验证码”的说明。保存草稿和 dirty 判断不再包含这两个字段。

本次不改变登录、注册和主窗口导航。

## 12. 安全

- 真实鉴权只依赖 CloudBase session；本地 `local_auth_session` 不恢复或授权 CloudBase 会话。
- CloudBase UID 是唯一外部身份关联键，不按 username、email 或 phone 自动合并。
- 未验证邮箱和手机号不进入本地资料。
- 密码、验证码、令牌、Publishable Key 和 SMTP 授权码不进入本地用户表、Profile、Renderer Store、日志或测试快照。
- Provider 原始错误、SQL 文本和联系方式不得进入 Renderer 错误。
- 所有 CloudBase 响应先检查 `error`，再解析 `data`。
- 匿名用户继续被拒绝，不创建本地投影。

## 13. 测试

### 13.1 契约

- `AuthUser.profile` 三态字段和严格 Schema。
- `UserProfileUpdate` 拒绝 email、phone 和未知键。

### 13.2 CloudBase 认证

- 登录/注册响应解析 username、nickname、头像、性别、已验证联系方式。
- 未验证联系方式不进入快照。
- 空值、缺失值和畸形值保持不同语义。
- 加密会话恢复携带 Profile 快照；SDK 函数字段回归仍使用加密快照。
- `updateUser` 错误映射和本地凭据强制失效不泄漏敏感数据。

### 13.3 数据库

- 新 CloudBase UID 原子创建用户、资料和会话。
- 重复同步更新账号和云端资料、保留生日和 created_at。
- 明确空值清空，缺失/畸形值保留。
- 历史同名本地账号不合并。
- UID 冲突、资料写入或会话写入失败时三表整体回滚。
- 登出清理会话幂等。

### 13.4 Application 与 Profile

- OTP、密码登录、恢复会话都触发同一个同步入口。
- 本地同步失败会清理认证状态并返回固定错误。
- 登出成功清除 `local_auth_session`，登出失败保留。
- Profile 云端更新先于本地写入；云端失败时本地不变。
- 生日更新不调用 CloudBase。

### 13.5 Renderer

- 邮箱和手机号只读且不进入保存输入。
- 云端同步资料能正常加载和显示。
- 现有登录、注册和 Profile Store 行为无回归。

### 13.6 验证命令

- 相关 Vitest node/component 测试。
- `pnpm typecheck`。
- 改动文件限定 ESLint。
- `pnpm build`。
- CloudBase Code Review 的 AUTH001、SEC001 和 SDK 语义审查。
- 不打开可见浏览器；如需运行端到端检查，使用 headless 模式。
