# AutoForge 本地账号登录与注册设计规格

日期：2026-08-07

状态：已确认，待书面复核

## 1. 目标

为 AutoForge 桌面 APP 增加账号、密码注册和登录能力。账号与认证会话暂时只保存在本机 SQLite 中；未登录用户不能进入或调用现有业务功能。

本阶段保留清晰的认证领域接口，使未来可以将本地实现替换为真实后端，并扩展手机号验证码、邮箱验证码和微信扫码等登录方式。当前不提前实现远程认证协议或未使用的登录方式。

## 2. 成功标准

1. 用户可以用符合规则的账号和密码在本机注册，注册成功后自动登录。
2. 用户可以退出后使用已注册账号重新登录；账号匹配忽略大小写。
3. APP 重启后恢复有效登录状态，直到用户主动退出。
4. 未登录访问任何业务路由时进入登录页；登录成功后返回原目标页面。
5. 未登录绕过 Renderer 直接调用业务 IPC 时，Main 进程拒绝请求。
6. SQLite 中不保存或记录明文密码，现有业务数据在数据库升级后保持不变。
7. 现有聊天记录、工作流、执行记录、授权和设置继续按设备共享，不按本地账号隔离。
8. 相关测试、全量类型检查、Lint 和生产构建通过。

## 3. 范围

### 3.1 包含

- 本地账号注册、账号密码登录、持久会话恢复和退出登录。
- 独立登录页与注册页。
- 认证 Pinia Store 和 Vue Router 访问控制。
- 类型化认证 IPC、Preload Bridge 和共享 Zod 契约。
- Main 进程认证服务、SQLite 用户仓储和会话仓储。
- Main 进程业务 IPC 认证门禁。
- 工作台展示当前账号和退出入口。
- 从现有数据库无损升级的迁移。

### 3.2 不包含

- 远程账号服务、跨设备登录或云同步。
- 手机号、邮箱验证码、微信扫码、OAuth 或第三方登录。
- 找回密码、修改密码、删除账号、头像或账号资料编辑。
- 多因素认证、登录设备管理或远程会话吊销。
- 按账号隔离聊天、工作流、执行、权限、凭证或设置数据。
- Renderer 持久化认证状态或密码。

## 4. 已确认的产品规则

### 4.1 账号

- 注册和登录输入先去除账号首尾空格。
- 账号长度为 3–32 个字符。
- 账号只允许 ASCII 字母、数字和下划线，表达式为 `^[A-Za-z0-9_]{3,32}$`。
- 唯一性使用去除首尾空格后的 ASCII 小写值判断；`Alice` 和 `alice` 属于同一账号。
- UI 展示用户注册时的账号大小写。
- 同一台设备允许注册多个本地账号。

### 4.2 密码

- 密码长度为 8–72 个 Unicode code point。
- 密码不做首尾空格移除，也不做 Unicode 规范化，注册和登录必须逐字一致。
- 当前不强制大小写、数字或特殊字符组合。
- 注册页包含确认密码；确认值仅在 Renderer 中校验，不发送到 Main。

### 4.3 会话和业务数据

- 注册成功后自动建立会话。
- 会话在 APP 重启后继续有效，用户主动退出时才清除。
- 本机同时只保存一个当前会话。
- 所有本地账号共享现有业务数据。账号在本阶段只承担 APP 访问门禁作用。
- 退出登录不取消已开始的聊天生成或工作流执行；重新登录后仍可查看设备级共享结果。
- 设置页现有“清除会话与执行记录”操作不删除本地账号，也不改变当前认证会话。

## 5. 架构与职责边界

### 5.1 Renderer 展示层

- `LoginView` 只负责登录表单、字段提示、提交状态和页面跳转。
- `RegisterView` 只负责注册表单、确认密码、字段提示、提交状态和页面跳转。
- 认证页不直接访问 SQLite、Node.js、Electron 或密码哈希实现。
- `WorkbenchLayout` 继续承载现有业务页面，并在功能栏底部提供当前账号和退出入口。

### 5.2 Renderer 交互层

- `AuthStore` 是 Renderer 中唯一认证状态来源。
- Store 负责恢复会话、登录、注册、退出、加载状态和可展示错误。
- Store 不写入 localStorage、sessionStorage 或其他 Renderer 持久化介质。
- Router Guard 负责导航体验；它不是唯一安全边界。

### 5.3 共享契约与 Preload

- `@autoforge/shared` 定义认证输入、会话输出、错误码、IPC Channel 和 `DesktopAPI.auth`。
- Preload 只暴露固定的 `auth` 方法，不暴露通用 IPC 调用能力。
- 所有认证 IPC 请求和响应继续使用 Zod 严格校验。

### 5.4 Main 认证领域

定义稳定的认证端口：

```ts
interface AuthService {
  getSession(): Promise<AuthSession | null>
  login(input: AuthCredentials): Promise<AuthSession>
  register(input: AuthCredentials): Promise<AuthSession>
  logout(): Promise<void>
  requireSession(): Promise<AuthSession>
}
```

`LocalAuthService` 使用 SQLite 用户仓储、会话仓储和密码哈希器实现该端口。未来远程认证实现必须维持页面实际使用的会话语义；验证码和扫码等非密码流程以新增认证方法或独立流程接口扩展，不改变现有业务模块。

### 5.5 Main IPC 门禁

- `auth:get-session`、`auth:login`、`auth:register`、`auth:logout` 在未登录时可调用。
- 现有聊天、媒体、工作流、开发、执行、权限、设置和系统 IPC 在执行具体服务前调用 `requireSession()`。
- Renderer 来源可信校验和 Zod 请求校验仍先执行；认证门禁不替代现有安全检查。
- 登出后不再向 Renderer 转发聊天和执行事件，直到重新建立会话。

## 6. 接口契约

```ts
interface AuthCredentials {
  account: string
  password: string
}

interface AuthUser {
  id: string
  account: string
}

interface AuthSession {
  user: AuthUser
  authenticatedAt: string
}

interface AuthAPI {
  getSession(): Promise<AuthSession | null>
  login(input: AuthCredentials): Promise<AuthSession>
  register(input: AuthCredentials): Promise<AuthSession>
  logout(): Promise<void>
}
```

行为约束：

- `getSession`：返回当前有效会话；用户记录已不存在时原子清理失效会话并返回 `null`。
- `login`：验证账号和密码，成功时覆盖本机当前会话并返回新会话。
- `register`：在单个数据库事务中创建用户和当前会话；账号重复时不创建用户或会话。
- `logout`：幂等删除当前会话；没有会话时仍成功。
- 所有响应只包含公开用户字段和会话时间，不返回密码摘要、盐或算法参数。

## 7. 数据模型与迁移

新增迁移 `0004_local_auth.sql`，包含以下表：

```sql
CREATE TABLE local_users (
  id TEXT PRIMARY KEY,
  account TEXT NOT NULL,
  account_normalized TEXT NOT NULL UNIQUE,
  password_digest TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE local_auth_session (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  user_id TEXT NOT NULL REFERENCES local_users(id) ON DELETE CASCADE,
  authenticated_at INTEGER NOT NULL
);
```

约束：

- 用户 ID 使用 Main 进程生成的 UUID。
- `account_normalized` 是唯一性和登录查询字段，绝不由 Renderer 直接提供给仓储。
- `password_digest` 保存自描述的版本化摘要，格式为 `scrypt$v=1$N=32768,r=8,p=3$<salt-base64>$<derived-key-base64>`。
- 迁移只新增表，不修改现有业务表，不为现有记录填充用户 ID。
- 新数据库和从 schema v3 升级的数据库最终 schema version 均为 4。

## 8. 密码存储与验证

- 使用异步 `node:crypto.scrypt`，不使用同步版本阻塞 Electron Main 事件循环。
- 每次注册使用 `randomBytes(16)` 生成独立随机盐。
- 参数固定为 `N=32768`、`r=8`、`p=3`、`keylen=32`、`maxmem=64 MiB`。
- 使用 `timingSafeEqual` 比较等长摘要。
- 账号不存在时仍对固定的进程内假摘要执行同参数 scrypt 验证，减少存在性查询的耗时差异。
- 摘要格式携带版本与参数；以后提高工作因子时可在成功登录后重新计算并替换旧摘要。
- 密码、盐和摘要不得写入日志、应用错误、Renderer Store、DOM 属性或开发调试输出。

参数选择依据：

- [OWASP Password Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html) 将 `N=2^15, r=8, p=3` 列为 scrypt 的可接受组合。
- [Node.js Crypto 文档](https://nodejs.org/api/crypto.html) 支持显式 scrypt 成本、块大小、并行度和内存上限，并建议使用至少 16 字节的随机盐。

## 9. 路由与页面行为

### 9.1 启动

1. APP 启动后，`AuthStore` 通过 `getSession` 恢复会话。
2. 恢复完成前显示全屏启动状态，不渲染工作台或认证表单。
3. 有会话时继续目标导航；无会话时按 Router Guard 进入登录页。

### 9.2 路由

- `/login` 和 `/register` 使用独立认证布局。
- 现有业务路由使用工作台布局并标记为需要认证。
- 未登录访问业务路由时跳转到 `/login?redirect=<原内部路径>`。
- 仅接受以 `/` 开始且不以 `//` 开始的内部 redirect；其他值忽略并回退 `/chat`。
- 登录成功后进入合法原路径；没有合法原路径时进入 `/chat`。
- 注册成功后进入 `/chat`。
- 已登录访问 `/login` 或 `/register` 时进入 `/chat`。
- 退出成功后进入 `/login`。

### 9.3 登录页

- 显示 AutoForge 品牌、登录标题和简短说明。
- 提供带可见标签的账号与密码字段。
- 账号使用 `autocomplete="username"`，密码使用 `autocomplete="current-password"`。
- 提供可访问的显示/隐藏密码按钮、登录按钮和“去注册”入口。
- 支持 Enter 提交；提交中禁用输入和重复提交。

### 9.4 注册页

- 提供账号、密码、确认密码字段。
- 账号使用 `autocomplete="username"`；两个密码字段使用 `autocomplete="new-password"`。
- 确认密码不一致时在 Renderer 阻止提交并显示字段错误。
- 提供可访问的显示/隐藏密码按钮、注册按钮和“返回登录”入口。
- 支持 Enter 提交；提交中禁用输入和重复提交。

### 9.5 工作台

- 左侧功能栏底部显示当前账号。
- 提供明确的“退出登录”按钮。
- 退出失败时保留当前页面和会话，并显示可理解错误；仅在 Main 确认清除后跳转。

### 9.6 视觉与可访问性

- 沿用现有白色 Surface、石墨色文字、钴蓝主操作和现有 Element Plus 组件。
- 认证页不显示工作台功能栏、上下文栏或检查器。
- 错误文本使用 `role="alert"`，字段与错误说明建立可访问关联。
- 键盘焦点样式沿用全局 `--af-focus`。
- 不显示尚未支持的手机号、邮箱、微信或找回密码占位入口。

## 10. 错误处理

新增安全错误码：

- `AUTH_REQUIRED`：无有效会话调用受保护 IPC。
- `AUTH_INVALID_CREDENTIALS`：账号不存在或密码错误。UI 统一显示“账号或密码错误”。
- `AUTH_ACCOUNT_EXISTS`：注册的规范化账号已经存在。UI 显示“该账号已存在”。

复用错误码：

- `INVALID_INPUT`：账号或密码不符合契约。
- `INTERNAL_ERROR`：数据库、哈希或其他未分类故障。

错误规则：

- Main 不通过错误文本区分账号不存在与密码错误。
- SQLite 约束错误仅映射为稳定 AppError，不透传 SQL、路径或摘要信息。
- 页面先显示确定性的字段错误；IPC 返回的业务错误显示为表单级错误。
- 不提供 Mock 登录、默认账号或失败后的认证绕过。

## 11. 测试与验证

### 11.1 共享契约

- 接受合法账号密码请求和合法会话响应。
- 拒绝账号长度、字符集和密码长度越界。
- 验证四个认证 Channel、请求 Schema、响应 Schema 和新增错误码。

### 11.2 数据库迁移与仓储

- 新数据库创建两张认证表，schema version 为 4。
- 已有 v3 数据升级后保留会话、消息、媒体、工作流、执行、设置和密钥记录。
- 规范化账号唯一约束拒绝大小写重复。
- 当前会话只能有一条；替换和幂等删除行为正确。

### 11.3 认证服务

- 注册保存版本化摘要且数据库中不包含明文密码。
- 注册自动登录并返回公开会话。
- 正确密码登录成功；错误密码和不存在账号返回相同错误码。
- 大小写不同的账号输入可以登录同一账号。
- 重复账号注册返回 `AUTH_ACCOUNT_EXISTS` 且不改变当前会话。
- 重启服务实例后可恢复持久会话。
- 用户缺失时清除失效会话。
- 多次退出均成功。

### 11.4 IPC 与 Preload

- Preload 将四个认证方法映射到正确 Channel 和输入。
- 不可信 Renderer 仍在认证判断前被拒绝。
- 未登录调用任一业务 IPC 返回 `AUTH_REQUIRED`。
- 未登录可以调用四个认证 IPC。
- 登录后原有业务 IPC 行为不变。
- 登出状态下不向 Renderer 转发业务事件。

### 11.5 Store、Router 与组件

- 启动期间不闪现工作台。
- 无会话访问业务页跳转登录，并保留安全的内部目标路径。
- 登录成功返回原目标；恶意或外部 redirect 回退聊天页。
- 注册成功进入聊天页。
- 已登录访问认证页进入聊天页。
- 登录、注册客户端校验和确认密码行为正确。
- 提交期间不能重复调用 API。
- 当前账号和退出流程正确显示与导航。

### 11.6 最终验证命令

```bash
pnpm test
pnpm typecheck
pnpm lint
pnpm build
```

生产构建完成后手动检查：首次启动注册、退出、不同大小写登录、重启恢复、受保护路由回跳，以及现有聊天数据在多个本地账号间可见。

## 12. 风险与控制

- **本地门禁不是远程身份保证：** 能直接控制用户操作系统账户或修改本地数据库的人仍可能绕过单机认证。本功能不宣称防御已控制设备的攻击者。
- **业务数据共享可能造成误解：** 规格和后续 UI 不使用“个人空间”等暗示隔离的文案；未来引入远程账号前必须单独设计数据归属与迁移。
- **scrypt 消耗资源：** 使用异步 API 和明确内存上限，避免阻塞 Main；测试覆盖失败映射。
- **未来认证方式不同：** 页面依赖会话结果和认证 Store，不依赖 SQLite 表或密码摘要；远程实现通过认证领域接口接入。
- **遗留数据升级：** 迁移只新增表，并以现有数据库迁移测试验证不丢数据。

## 13. 最小改动范围

预计只修改以下直接相关区域：

- `packages/shared`：认证契约和错误码。
- `apps/desktop/resources/migrations` 与 `electron/main/database`：认证表和仓储。
- `apps/desktop/electron/main/auth`：密码哈希与本地认证服务。
- `apps/desktop/electron/main/ipc`、`electron/preload`、应用运行时装配：认证 API 和门禁。
- `apps/desktop/src/router`、`stores`、`views`、`layouts`、`components/AppRail.vue`：认证页面、状态和导航。
- 对应测试文件。

不重构无关业务服务，不调整现有业务数据归属，不清理用户已有修改。
