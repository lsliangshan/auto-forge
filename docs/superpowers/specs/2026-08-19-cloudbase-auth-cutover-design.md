# AutoForge CloudBase 身份认证切换设计规格

日期：2026-08-19

状态：已确认，待书面复核

## 1. 目标

将 AutoForge 桌面应用的本地用户名密码认证替换为腾讯云 CloudBase 身份认证。用户从现有登录、注册页面提交用户名和密码；注册成功后，用户出现在 CloudBase 环境的身份用户列表中，并建立可跨应用重启恢复的 CloudBase 会话。

本次是直接切换，不迁移本机 `local_users` 中的历史账号。历史账号和会话表不删除，但不再参与认证。用户需要在 CloudBase 中重新注册。

## 2. 已确认环境

- CloudBase 环境 ID：`autoforge-d1gkhyfb419ba8455`
- 地域：`ap-shanghai`
- 环境状态：正常
- 用户名密码登录：已启用
- Publishable Key：已存在；实现中使用现有 Key，不创建或输出新的 Key
- CloudBase SDK：固定使用 `@cloudbase/js-sdk@3.8.0`
- 认证方法：`auth.signUp({ username, password, nickname })`、`auth.signInWithPassword({ username, password })`、`auth.getSession()`、`auth.refreshSession()`、`auth.signOut()`

CloudBase Provider 与 Publishable Key 已满足接入条件，本次不修改远端登录策略、Provider 或 API Key。

## 3. 成功标准

1. 注册页创建 CloudBase 用户并自动登录，用户出现在 CloudBase 身份用户列表中。
2. 登录页使用 CloudBase 用户名密码认证，错误凭证不会建立本地业务访问会话。
3. CloudBase UID 成为 `AuthUser.id`，Main 进程继续用有效认证会话保护所有现有业务 IPC。
4. 应用重启后可通过加密保存的 CloudBase 令牌恢复或刷新会话。
5. 登出成功后同时清除 CloudBase 会话和本机加密令牌；登出失败时不伪造已退出状态。
6. Refresh Token、Access Token 和密码不以明文写入 SQLite、日志、Renderer Store 或 DOM。
7. 现有聊天、工作流、执行、设置等设备级共享数据不受影响。
8. 登录、注册页面不再声称账号只保存在本机，并清楚表达 CloudBase 账号规则。
9. 认证相关单元测试、组件测试、类型检查、Lint 和生产构建通过。

## 4. 范围

### 4.1 包含

- Main 进程 CloudBase SDK 初始化与认证服务。
- CloudBase 注册、登录、会话恢复/刷新和退出。
- 使用 Electron `safeStorage` 加密保存 CloudBase 会话令牌。
- 调整用户名契约和认证错误映射。
- 更新登录、注册页面文案与字段提示。
- 保留 Router Guard、Pinia Auth Store、Preload 和 IPC 的现有公开接口。
- 更新认证服务、应用装配、IPC/组件和契约测试。

### 4.2 不包含

- 迁移本地账号、密码摘要或历史本地会话。
- 自动迁移以旧本地 UID 为键的个人资料。
- 邮箱验证码、短信验证码、OAuth、微信或匿名登录。
- 找回密码、修改密码、删除账号或设备管理。
- 把本地聊天、工作流、设置或个人资料迁移到 CloudBase 数据库。
- 修改 CloudBase 登录策略、Provider、Publishable Key 或 API Key。
- 部署静态站点、云函数或 CloudRun 服务。

## 5. 方案选择

### 5.1 采用：Main 进程运行 CloudBase SDK

CloudBase SDK v3 提供 Node.js 运行时入口。SDK 在 Electron Main 进程中执行，Renderer 继续通过类型化 Preload/IPC 调用认证服务。

选择原因：

- 保留现有安全边界，Renderer 不持有或直接维护认证令牌。
- 现有业务 IPC 的 `requireSession()` 门禁无需改为信任 Renderer 状态。
- 登录、注册页面与 Auth Store 的公开调用方式保持稳定。
- 可复用现有 `SecretStore` 和 Electron `safeStorage` 加密能力。

### 5.2 未采用：Renderer 直接运行 CloudBase SDK

该方案更接近普通 Web 应用，但 Main 进程不能直接信任 Renderer 报告的登录状态。若保留现有 IPC 安全边界，还需增加令牌传输、校验、刷新同步和吊销处理，改动范围更大。

### 5.3 未采用：云函数或 CloudRun 认证代理

CloudBase 已提供原生身份认证，额外认证代理不会增加本阶段所需能力，反而引入部署、密钥管理和服务可用性边界。

## 6. 架构与职责边界

### 6.1 Renderer 展示层

- `LoginView` 和 `RegisterView` 继续只负责输入、前端校验、提交状态、错误展示和导航。
- 页面不导入 CloudBase SDK，不接触令牌或 Publishable Key。
- 登录页说明改为使用 AutoForge 云端账号登录。
- 注册页说明改为账号将注册到 CloudBase 并在成功后自动登录。

### 6.2 Renderer 交互层

- `AuthStore` 仍是 Renderer 中唯一认证状态来源。
- Store 继续调用 `DesktopAPI.auth.getSession/login/register/logout`。
- Store 只保存公开 `AuthSession`，不保存 CloudBase Access Token 或 Refresh Token。
- Router Guard 继续负责导航体验，不作为唯一安全边界。

### 6.3 Preload、IPC 与共享契约

- 现有四个认证 IPC Channel 和 `DesktopAPI.auth` 方法保持兼容。
- `AuthCredentials` 字段继续为 `{ account, password }`，避免把 CloudBase SDK 参数泄漏到 UI 契约。
- `AuthSession` 继续只返回 `{ user, authenticatedAt }`。
- 所有业务 IPC 继续在调用服务前执行 Main 进程 `requireSession()`。

### 6.4 Main 认证领域

- 保留现有 `AuthService` 接口，将运行时实现从 `LocalAuthService` 切换为 `CloudBaseAuthService`。
- `CloudBaseAuthService` 独占 SDK 用户认证调用、CloudBase 响应解析、安全错误映射、令牌保存和会话恢复。
- CloudBase SDK 通过可替换端口注入服务测试，测试不访问真实 CloudBase 环境。
- `LocalAuthService`、密码哈希器和本地认证仓储可暂时保留，避免扩大迁移和数据库清理范围；生产装配不再使用它们。

### 6.5 本机会话令牌存储

- 复用现有 `SecretStore`，使用专用键保存序列化的 CloudBase 会话令牌。
- 序列化内容仅包含恢复所需的 Access Token、Refresh Token 和必要到期信息，不包含密码。
- `SecretStore` 通过 Electron `safeStorage` 加密后写入现有 `encrypted_secrets` 表。
- 恢复、刷新产生旋转后的 Refresh Token 时，立即覆盖旧密文。
- 登出确认成功后删除令牌；发现无效或已吊销令牌时删除令牌并返回未登录状态。

## 7. 配置

建立单一 CloudBase 认证配置入口，包含：

```ts
interface CloudBaseAuthConfig {
  env: string
  region: string
  accessKey: string
}
```

- `env` 固定为已确认的完整环境 ID，不使用环境别名。
- `region` 固定为 `ap-shanghai`。
- `accessKey` 使用现有 Publishable Key。它是面向客户端的公开 Key，不是 SecretId、SecretKey 或服务端 API Key。
- 配置只在 Main 进程认证装配中使用，不通过 Preload 暴露。
- 任何日志和错误均不得输出完整 Key 或令牌。

## 8. 输入规则

### 8.1 用户名

- UI 字段仍称为“账号”，内部映射到 CloudBase `username`。
- 提交前去除首尾空格并转换为 ASCII 小写，以保留现有忽略大小写的登录体验。
- 长度调整为 5–24 个字符，与 CloudBase 用户名注册约束一致。
- 字符集保持项目原有较窄规则：只允许 ASCII 字母、数字和下划线。
- CloudBase 中保存规范化小写用户名；注册时把用户原始大小写形式作为 `nickname` 提交，用于会话展示。
- `AuthUser.account` 优先使用 CloudBase 用户元数据中的昵称；不存在时回退到规范化用户名。

### 8.2 密码

- 继续要求 8–72 个 Unicode code point。
- 不去除首尾空格，不执行 Unicode 规范化。
- 确认密码仍只在 Renderer 校验，不发送到 Main。

## 9. 认证数据流

### 9.1 注册

1. 注册页校验账号、密码和确认密码。
2. Auth Store 通过 IPC 调用 `AuthService.register`。
3. Main 校验共享契约并规范化用户名。
4. `CloudBaseAuthService` 调用 `auth.signUp({ username, password, nickname })`。
5. 服务检查 SDK 返回的 `error`、`user` 和真实 `session`。
6. 服务加密保存令牌并返回只含 CloudBase UID、展示账号和认证时间的 `AuthSession`。
7. Renderer 进入 `/chat`。

### 9.2 登录

1. 登录页校验输入。
2. Main 调用 `auth.signInWithPassword({ username, password })`。
3. 只有返回真实 `session` 时才加密保存令牌并建立本地业务访问会话。
4. Renderer 按现有安全 redirect 规则进入目标页面。

### 9.3 启动恢复

1. Auth Store 调用 `getSession`。
2. Main 首先检查 SDK 内存会话；没有会话时读取加密令牌。
3. 对仍有效的令牌调用 `setSession`；需要刷新时使用 Refresh Token 调用 `refreshSession`。
4. 刷新成功后保存旋转令牌并返回公开会话。
5. 无效、过期、吊销或用户不存在时删除本地令牌并返回 `null`。
6. 临时网络故障不伪造成有效登录，按恢复失败处理并保留可诊断的安全错误。

### 9.4 登出

1. Main 调用 CloudBase `auth.signOut()`。
2. 成功后删除加密令牌并返回。
3. CloudBase 明确表示本来就没有会话时，按幂等成功处理并删除本地令牌。
4. 网络或未分类错误时保留令牌和当前 Renderer 会话，页面展示退出失败。

## 10. 用户与本地数据

- CloudBase UID 替代本地 UUID 成为认证用户 ID。
- 新用户的本地个人资料记录以 CloudBase UID 为键按需创建。
- 旧 `local_user_profiles` 仍以旧本地 UID 保存，不自动关联到新 CloudBase UID。
- 旧 `local_users`、`local_auth_session` 和密码摘要不删除，生产认证不再读取它们。
- 聊天、媒体、工作流、执行、权限、设置和模型凭证继续按设备共享，不按 CloudBase 用户隔离。

## 11. 页面设计规格

### 11.1 Purpose Statement

登录与注册页面需要清楚传达账号已从单机身份变为 AutoForge 云端身份，同时保持现有用户熟悉的表单操作、可访问性和紧凑桌面布局。页面不增加未实现的邮箱、短信或第三方登录入口。

### 11.2 Aesthetic Direction

沿用现有“工业化极简”方向。认证页面已有批准的 AutoForge Logo 和品牌视觉，本次只做必要文案与状态调整，不引入新的视觉概念。

### 11.3 Color Palette

- 画布、Surface、石墨文字、钴蓝主操作色和危险色全部沿用现有 CSS Token。
- 品牌设计系统属于明确约束，因此覆盖 CloudBase `ui-design` 技能的默认颜色选择规则。
- 不新增渐变、装饰色或视觉噪声。

### 11.4 Typography

- 沿用项目现有字体 Token 和 Element Plus 字体继承策略。
- 现有品牌设计系统属于明确约束，因此覆盖 `ui-design` 技能默认的字体禁用规则。
- 不增加远程字体或新的字体依赖。

### 11.5 Layout Strategy

- 保留现有认证卡片尺寸、字段顺序、Logo 位置和响应式行为。
- 布局不重新设计，避免认证基础设施切换与视觉改版耦合。
- 更新标题下说明、账号规则提示和“本地账号”相关切换文案。

## 12. 错误处理

CloudBase SDK 错误映射为现有稳定 `AppError`：

- 用户名已存在、重复注册 → `AUTH_ACCOUNT_EXISTS`
- 用户名或密码错误 → `AUTH_INVALID_CREDENTIALS`
- 无真实 CloudBase 会话 → `AUTH_REQUIRED`
- 客户端输入违反项目契约 → `INVALID_INPUT`
- 网络、超时、CloudBase 暂时不可用或未分类 SDK 错误 → `INTERNAL_ERROR`

约束：

- 不通过错误文本区分用户名不存在和密码错误。
- 不把 CloudBase 原始错误对象、请求头、Key、Token、密码或 SDK 堆栈透传给 Renderer。
- 只基于稳定错误码、HTTP 状态或明确错误字段分类；未知错误安全降级为 `INTERNAL_ERROR`。
- 会话恢复时的失效凭证返回 `null`；基础设施故障返回安全错误，避免把远端故障误报为用户主动登出。

## 13. 测试策略

### 13.1 共享契约与页面

- 接受 5–24 位合法账号并规范化空格。
- 拒绝长度和字符集不符合 CloudBase 约束的账号。
- 登录、注册页面展示云端账号文案和新的规则提示。
- 保留确认密码、重复提交抑制、安全 redirect、成功导航和错误展示测试。
- 保留用户未提交的品牌 Logo 测试和实现。

### 13.2 CloudBase 认证服务

- 注册使用规范化用户名和原始昵称，保存令牌并返回 CloudBase UID。
- 登录调用用户名密码方法并保存真实 session。
- SDK `{ data, error }` 中的错误优先被处理，缺失 session 不能视为成功。
- 重复账号、错误凭证和未知错误映射正确。
- 恢复有效会话、刷新过期会话、保存旋转令牌。
- 无效令牌被清除，基础设施故障不伪造成登录成功。
- 登出成功和幂等无会话会清除令牌；失败保留令牌。
- `requireSession` 只接受真实 CloudBase session。

### 13.3 加密存储与应用装配

- 数据库中不出现明文 Access Token、Refresh Token 或密码。
- 加密不可用时拒绝持久化会话，不降级为明文。
- 运行时装配使用 `CloudBaseAuthService`，不再使用 `LocalAuthService`。
- 现有 IPC 门禁仍在业务服务执行前调用 `requireSession()`。
- 新 CloudBase UID 能读取和写入其本地个人资料，不影响设备级业务数据。

### 13.4 验证命令

- 先运行认证相关测试，按测试驱动开发完成红—绿循环。
- 运行 `pnpm typecheck`。
- 运行 `pnpm lint`。
- 运行 `pnpm test`。
- 运行 `pnpm build`。
- 启动桌面应用，使用测试账号验证注册、CloudBase 用户列表、退出、重新登录和重启恢复；不在自动化测试中使用真实用户凭证。

## 14. 风险与控制

### 14.1 历史账号不可直接登录

直接切换后，旧本地账号必须重新注册。页面文案需要明确账号已改为云端账号，避免用户误以为历史密码失效。

### 14.2 历史个人资料不自动关联

旧个人资料保留但不迁移。该影响局限于头像、显示名、性别、出生日期、邮箱和手机号；设备级业务数据仍可见。

### 14.3 网络依赖

登录、注册、刷新和登出依赖 CloudBase 可用性。所有提交状态必须防止重复请求，并提供不泄漏内部信息的错误提示。

### 14.4 令牌泄漏

令牌只存在于 Main 进程内存和 `safeStorage` 加密密文中。Renderer、日志、错误对象和测试快照不得包含令牌。

### 14.5 用户名约束变化

账号长度从 3–32 调整为 5–24。页面与共享契约必须同步，避免 Renderer 和 Main 的规则不一致。

## 15. 实施边界

预计只修改或新增以下直接相关区域：

- `apps/desktop/package.json` 与锁文件：CloudBase SDK 依赖。
- `apps/desktop/electron/main/auth/`：CloudBase 认证服务及测试。
- `apps/desktop/electron/main/application.ts`：运行时装配与加密会话存储注入。
- `packages/shared/src/desktop-api.ts` 及契约测试：账号约束。
- `apps/desktop/src/views/LoginView.vue`、`RegisterView.vue`：文案和校验提示。
- 认证、应用装配、组件相关测试。

不做无关重构、数据库表删除、页面视觉重做或业务数据迁移。

## 16. 参考资料

- [CloudBase Web SDK v3 身份认证](https://docs.cloudbase.net/en/api-reference/webv3/authentication)
- [CloudBase 用户名密码登录 HTTP API](https://docs.cloudbase.net/http-api/auth/auth-sign-in)
- [CloudBase 身份认证概述与会话持久化](https://docs.cloudbase.net/authentication/auth/introduce)
- CloudBase Skills：`cloudbase`、`auth-tool-cloudbase`、`auth-web-cloudbase`、`ui-design`、`web-development`
