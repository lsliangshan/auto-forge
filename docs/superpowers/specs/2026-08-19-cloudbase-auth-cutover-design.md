# AutoForge CloudBase 身份认证切换设计规格

日期：2026-08-19

状态：已确认，待书面复核

## 1. 目标

将 AutoForge 桌面应用的本地认证替换为腾讯云 CloudBase 身份认证。登录页按“手机验证码、邮箱验证码、用户名密码”的顺序提供三种方式；注册页按“手机验证码、邮箱验证码”的顺序提供两种方式。两种注册方式都同时设置用户名和密码，使注册后的同一 CloudBase 用户可以继续使用用户名密码登录。

本次直接切换，不迁移本机 `local_users` 中的历史账号。历史账号和会话表不删除，但不再参与认证；用户需要在 CloudBase 中重新注册。

## 2. 已确认环境

- CloudBase 环境 ID：`autoforge-d1gkhyfb419ba8455`
- 地域：`ap-shanghai`
- 环境状态：正常
- 手机验证码登录：已启用，默认短信通道就绪
- 邮箱验证码登录：已启用
- 用户名密码登录：已启用
- 邮箱 Provider：已启用 126 自定义 SMTP，`smtp.126.com:465`，SSL
- Publishable Key：已存在；实现中使用现有 Key，不创建或输出新的 Key
- CloudBase SDK：固定使用 `@cloudbase/js-sdk@3.8.0`
- 已完成真实通道验证：手机验证码请求成功；邮箱验证码请求成功；126 SMTP 直连返回 `250`

SMTP 授权码、Publishable Key、验证码和认证令牌不得写入本规格、源码、日志或测试快照。

## 3. 成功标准

1. 登录页默认显示手机验证码登录，并可依次切换到邮箱验证码和用户名密码登录。
2. 注册页默认显示手机验证码注册，并可切换到邮箱验证码注册。
3. 验证码登录只允许已有 CloudBase 用户登录，不得隐式创建用户。
4. 两种注册方式都创建包含已验证手机号或邮箱、用户名和密码的 CloudBase 用户，并在成功后自动登录。
5. 新用户出现在 CloudBase 身份用户列表中；CloudBase UID 成为 `AuthUser.id`。
6. Main 进程继续用真实 CloudBase 会话保护所有现有业务 IPC。
7. 应用重启后可通过加密保存的 CloudBase 令牌恢复或刷新会话。
8. Refresh Token、Access Token、密码、验证码和 SMTP 授权码不以明文写入 SQLite、日志、Renderer Store 或 DOM。
9. 现有聊天、工作流、执行、设置等设备级共享数据不受影响。
10. 认证相关单元测试、组件测试、类型检查、Lint 和生产构建通过。

## 4. 范围

### 4.1 包含

- Main 进程 CloudBase SDK 初始化与认证服务。
- 手机验证码登录、邮箱验证码登录和用户名密码登录。
- 手机验证码注册和邮箱验证码注册，同时设置用户名和密码。
- Main 进程内存中的验证码挑战管理。
- CloudBase 会话恢复、刷新和退出。
- 使用 Electron `safeStorage` 加密保存 CloudBase 会话令牌。
- 调整共享认证契约、Pinia Auth Store、Preload 和 IPC。
- 更新登录、注册页面的方式切换、验证码交互、文案和校验。
- 更新认证服务、应用装配、IPC、共享契约和组件测试。

### 4.2 不包含

- 迁移本地账号、密码摘要或历史本地会话。
- 自动迁移以旧本地 UID 为键的个人资料。
- OAuth、微信或匿名登录。
- 找回密码、修改密码、删除账号、换绑手机号或邮箱。
- 注册后补绑另一种验证码身份。例如手机号注册用户不会在本阶段自动绑定邮箱。
- 把本地聊天、工作流、设置或个人资料迁移到 CloudBase 数据库。
- 新增云函数、CloudRun 认证代理或自建验证码服务。
- 部署静态站点、云函数或 CloudRun 服务。

## 5. 方案选择

### 5.1 采用：单页分段切换 + Main 进程 CloudBase SDK

登录页和注册页各自保留单一路由，在卡片内用分段控件切换认证方式。CloudBase SDK 在 Electron Main 进程中执行，Renderer 继续通过类型化 Preload/IPC 调用认证服务。

选择原因：

- 默认选项和视觉顺序可以直接表达产品优先级。
- 不把多个完整表单同时堆叠在页面中。
- 不增加独立路由、返回导航和重复页面状态。
- Renderer 不持有认证令牌或 CloudBase 验证回调。
- 现有业务 IPC 的 `requireSession()` 门禁仍由 Main 进程控制。

### 5.2 未采用：所有认证表单同时展示

该方案无需切换控件，但会让登录页同时出现手机号、邮箱、用户名和多个验证码按钮，信息密度过高，主次不清晰。

### 5.3 未采用：每种认证方式独立路由

该方案隔离最彻底，但会增加路由、返回行为、重定向恢复和重复表单代码，不符合本次最小切换范围。

## 6. 架构与职责边界

### 6.1 Renderer 展示层

- `LoginView` 默认选择 `phone`，分段顺序固定为 `phone -> email -> password`。
- `RegisterView` 默认选择 `phone`，分段顺序固定为 `phone -> email`。
- 验证码登录表单只展示目标地址、验证码、发送按钮和提交按钮。
- 验证码注册表单展示目标地址、用户名、密码、确认密码、验证码、发送按钮和提交按钮。
- 用户名密码登录继续展示账号和密码。
- 页面只负责输入、前端校验、60 秒发送倒计时、提交状态、错误展示和导航。
- 页面不导入 CloudBase SDK，不接触认证令牌或 SDK `verifyOtp` 回调。

### 6.2 Renderer 交互层

- `AuthStore` 仍是 Renderer 中唯一认证状态来源。
- Store 调用 `DesktopAPI.auth.getSession`、`sendOtp`、`verifyOtp`、`cancelOtp`、`loginWithPassword` 和 `logout`。
- Store 只保存公开 `AuthSession` 和当前页面所需的临时 `challengeId`，不保存 Access Token、Refresh Token 或密码。
- 切换认证方式时清除验证码、挑战 ID、错误和倒计时。
- 修改挑战相关的手机号、邮箱、用户名或密码时，使当前挑战失效并要求重新发送。
- Router Guard 继续负责导航体验，不作为唯一安全边界。

### 6.3 Preload、IPC 与共享契约

认证契约采用判别联合，明确登录与注册的不同输入：

```ts
type AuthOtpChannel = 'phone' | 'email'

type AuthOtpRequest =
  | {
      intent: 'login'
      channel: AuthOtpChannel
      target: string
    }
  | {
      intent: 'register'
      channel: AuthOtpChannel
      target: string
      account: string
      password: string
    }

interface AuthOtpChallenge {
  challengeId: string
  expiresIn: number
}

interface AuthOtpVerification {
  challengeId: string
  code: string
}
```

- `DesktopAPI.auth.sendOtp(request)` 返回 `AuthOtpChallenge`。
- `DesktopAPI.auth.verifyOtp(request)` 返回 `AuthSession`。
- `DesktopAPI.auth.cancelOtp(challengeId)` 使未完成挑战失效并返回 `void`。
- `DesktopAPI.auth.loginWithPassword(credentials)` 返回 `AuthSession`。
- `DesktopAPI.auth.getSession()` 和 `logout()` 保持原语义。
- 旧的通用 `login/register` 调用由新契约替代，不保留无调用方的兼容包装。
- 所有业务 IPC 继续在调用服务前执行 Main 进程 `requireSession()`。

### 6.4 Main 认证领域

- 保留 `AuthService` 作为 Main 进程认证边界，将运行时实现从 `LocalAuthService` 切换为 `CloudBaseAuthService`。
- `CloudBaseAuthService` 独占 SDK 认证调用、验证码挑战、安全错误映射、令牌保存和会话恢复。
- 验证码登录调用 `auth.signInWithOtp({ phone|email, options: { shouldCreateUser: false } })`，确保登录页不会创建用户。
- 验证码注册调用 `auth.signUp({ phone|email, username, password, nickname })`。SDK 在验证码验证通过后把已验证身份、用户名和密码提交到同一个 CloudBase 用户。
- 用户名密码登录调用 `auth.signInWithPassword({ username, password })`。
- 只有 SDK 返回真实 `session` 时才建立本地业务访问会话。
- CloudBase SDK 通过可替换端口注入服务测试；自动化测试不访问真实 CloudBase 环境。
- `LocalAuthService`、密码哈希器和本地认证仓储暂时保留，生产装配不再使用它们。

### 6.5 验证码挑战管理

- Main 进程维护仅存在于内存的挑战表：`challengeId -> verifyOtp 回调、意图、过期时间`。
- `challengeId` 使用密码学安全随机值，不包含手机号、邮箱、用户名或 CloudBase `verification_id`。
- 注册挑战中的 SDK 回调会在内存中临时捕获注册参数；挑战验证、过期、主动失效或应用退出后立即删除。
- 同一 Renderer 会话只保留当前有效挑战；重新发送会删除旧挑战。
- 挑战本地生存时间固定为 5 分钟；即使邮箱验证码远端有效期更长，Main 也不接受超过本地期限的挑战。
- 应用重启后挑战不可恢复，用户必须重新发送验证码。
- Renderer 传入未知、过期或已消费的挑战 ID 时返回稳定的验证码失效错误。

### 6.6 本机会话令牌存储

- 复用现有 `SecretStore`，使用专用键保存序列化的 CloudBase 会话令牌。
- 序列化内容只包含恢复所需的 Access Token、Refresh Token 和必要到期信息，不包含密码或验证码。
- `SecretStore` 通过 Electron `safeStorage` 加密后写入现有 `encrypted_secrets` 表。
- 刷新产生旋转后的 Refresh Token 时立即覆盖旧密文。
- 登出成功后删除令牌；发现无效或已吊销令牌时删除令牌并返回未登录状态。

## 7. 配置

```ts
interface CloudBaseAuthConfig {
  env: string
  region: string
  accessKey: string
}
```

- `env` 固定为完整环境 ID，不使用环境别名。
- `region` 固定为 `ap-shanghai`。
- `accessKey` 使用现有 Publishable Key；它不是 SecretId、SecretKey 或服务端 API Key。
- 配置只在 Main 进程认证装配中使用，不通过 Preload 暴露。
- 任何日志和错误均不得输出完整 Key、Token、密码、验证码或 SMTP 授权码。

## 8. 输入规则

### 8.1 手机号

- UI 接受 11 位中国大陆手机号，去除首尾空格。
- Main 再次校验后转换为 CloudBase 需要的 `+86` 格式。
- 页面展示脱敏后的目标地址，不在错误日志中输出完整手机号。

### 8.2 邮箱

- 去除首尾空格并转换为 ASCII 小写。
- Renderer 与 Main 都执行基础格式和长度校验。
- 不限制为 126 邮箱；126 地址只用于当前 SMTP 发件人和通道测试。

### 8.3 用户名

- 注册页字段称为“用户名”，用户名密码登录页字段称为“账号”。
- 提交前去除首尾空格并转换为 ASCII 小写，以保留现有忽略大小写体验。
- 长度为 5–24 个字符。
- 只允许 ASCII 字母、数字和下划线。
- CloudBase 中保存规范化小写用户名；原始大小写形式作为 `nickname`。
- `AuthUser.account` 优先使用昵称，不存在时回退到规范化用户名，再回退到脱敏手机号或邮箱。

### 8.4 密码与验证码

- 密码要求 8–72 个 Unicode code point，不去除首尾空格，不执行 Unicode 规范化。
- 确认密码只在 Renderer 比较，不发送到 Main。
- 验证码必须是 6 位数字。
- 密码和验证码不得写入日志、Store 持久化或错误对象。

## 9. 认证数据流

### 9.1 手机或邮箱验证码登录

1. 页面校验手机号或邮箱，调用 `sendOtp({ intent: 'login', ... })`。
2. Main 调用 `signInWithOtp`，显式设置 `shouldCreateUser: false`。
3. Main 保存 SDK 验证回调并返回不含身份信息的 `challengeId` 和本地 300 秒有效期。
4. 页面提交验证码，Main 消费挑战并调用 SDK `verifyOtp({ token })`。
5. 只有真实 session 返回时才加密保存令牌并返回公开 `AuthSession`。
6. Renderer 按现有安全 redirect 规则进入目标页面。

### 9.2 手机或邮箱验证码注册

1. 页面校验目标地址、用户名、密码和确认密码。
2. 页面调用 `sendOtp({ intent: 'register', channel, target, account, password })`。
3. Main 规范化输入并调用 `signUp({ phone|email, username, password, nickname })` 发送验证码。
4. Main 保存注册验证回调；Renderer 只收到 `challengeId` 和有效期。
5. 用户提交验证码后，Main 消费挑战并调用 SDK `verifyOtp({ token })`。
6. CloudBase 创建或确认用户，返回真实 session；Main 加密保存令牌并返回公开会话。
7. CloudBase 报告重复用户名或重复身份时返回 `AUTH_ACCOUNT_EXISTS`，不得覆盖已有用户密码或资料。
8. Renderer 进入 `/chat`。

### 9.3 用户名密码登录

1. 页面校验账号和密码。
2. Main 规范化用户名并调用 `signInWithPassword({ username, password })`。
3. 只有真实 session 返回时才加密保存令牌并建立本地业务访问会话。
4. Renderer 按现有安全 redirect 规则进入目标页面。

### 9.4 启动恢复

1. Auth Store 调用 `getSession`。
2. Main 首先检查 SDK 内存会话；没有会话时读取加密令牌。
3. 对仍有效的令牌调用 `setSession`；需要刷新时使用 Refresh Token 调用 `refreshSession`。
4. 刷新成功后保存旋转令牌并返回公开会话。
5. 无效、过期、吊销或用户不存在时删除本地令牌并返回 `null`。
6. 临时网络故障不伪造成有效登录，返回安全的基础设施错误。

### 9.5 登出

1. Main 使所有未完成验证码挑战失效。
2. Main 调用 CloudBase `auth.signOut()`。
3. 成功或 CloudBase 明确表示本来就没有会话时，删除加密令牌并返回。
4. 网络或未分类错误时保留令牌和当前 Renderer 会话，页面展示退出失败。

## 10. 用户与本地数据

- CloudBase UID 替代本地 UUID 成为认证用户 ID。
- 新用户的本地个人资料记录以 CloudBase UID 为键按需创建。
- 旧 `local_user_profiles` 仍以旧本地 UID 保存，不自动关联到新 UID。
- 旧 `local_users`、`local_auth_session` 和密码摘要不删除，生产认证不再读取它们。
- 聊天、媒体、工作流、执行、权限、设置和模型凭证继续按设备共享，不按 CloudBase 用户隔离。

## 11. 页面设计规格

### 11.1 Purpose Statement

登录与注册页面需要清楚传达 AutoForge 云端身份，并把已验证的手机号或邮箱作为首选入口，同时保留用户名密码作为低优先级登录方式。页面保持现有桌面认证卡片的熟悉结构和可访问性。

### 11.2 Aesthetic Direction

沿用现有“工业化极简”方向。认证页面已有批准的 AutoForge Logo 和品牌视觉，本次只增加必要的方式切换、验证码字段和状态，不引入新的视觉概念。

### 11.3 Color Palette 与 Typography

- 画布、Surface、石墨文字、钴蓝主操作色、危险色和字体全部沿用现有 CSS Token。
- 现有品牌设计系统是明确约束，因此覆盖通用 UI 技能的默认颜色和字体建议。
- 不增加渐变、装饰色、远程字体或新的字体依赖。

### 11.4 Layout Strategy

- 保留现有 Logo、认证卡片、主按钮和响应式行为。
- 标题下方放置等宽分段控件；选项顺序即产品优先级，第一项为默认值。
- 切换只替换卡片内部字段，不跳转路由。
- 验证码输入和发送按钮在同一行；发送成功后按钮展示 60 秒倒计时。
- 注册页在验证码区域之前展示用户名、密码和确认密码，确保发送注册验证码前注册参数已通过校验。
- 不重新设计页面背景或品牌区域。

## 12. 错误处理

CloudBase SDK 错误映射为稳定 `AppError`：

- 用户名、手机号或邮箱已存在 → `AUTH_ACCOUNT_EXISTS`
- 用户名或密码错误 → `AUTH_INVALID_CREDENTIALS`
- 验证码错误 → `AUTH_INVALID_OTP`
- 验证码挑战过期、被替换或已消费 → `AUTH_OTP_EXPIRED`
- 发送频率过高 → `AUTH_OTP_RATE_LIMITED`
- 登录目标不存在 → `AUTH_ACCOUNT_NOT_FOUND`
- 无真实 CloudBase 会话 → `AUTH_REQUIRED`
- 客户端输入违反项目契约 → `INVALID_INPUT`
- 网络、超时、CloudBase 暂时不可用或未分类 SDK 错误 → `INTERNAL_ERROR`

约束：

- 用户名密码登录不通过错误文本区分用户名不存在和密码错误。
- 未登录用户的验证码登录使用 CloudBase `target=USER` 语义，不自动创建账号。
- 不把 CloudBase 原始错误对象、请求头、Key、Token、密码、验证码或 SDK 堆栈透传给 Renderer。
- 未知错误安全降级为 `INTERNAL_ERROR`。
- 会话恢复时的失效凭证返回 `null`；基础设施故障返回安全错误。

## 13. 测试策略

### 13.1 共享契约与页面

- 登录页分段顺序和默认项为手机、邮箱、用户名密码。
- 注册页分段顺序和默认项为手机、邮箱。
- 切换方式会清理挑战、验证码、倒计时和错误。
- 手机号、邮箱、用户名、密码、确认密码和验证码校验正确。
- 修改挑战相关字段后要求重新发送验证码。
- 保留重复提交抑制、安全 redirect、成功导航和错误展示测试。
- 保留用户已有品牌 Logo 测试和实现。

### 13.2 CloudBase 认证服务

- OTP 登录总是传入 `shouldCreateUser: false`。
- 手机和邮箱登录发送、验证并保存真实 session。
- 手机和邮箱注册传入规范化用户名、原始昵称和密码。
- Main 只向 Renderer 返回随机 challenge ID，不返回 SDK 回调或 verification ID。
- 挑战重发替换、过期、一次性消费和登出清理正确。
- 缺失真实 session 不能视为成功。
- 重复账号、错误验证码、限频、错误凭证和未知错误映射正确。
- 恢复有效会话、刷新过期会话并保存旋转令牌。
- 登出成功和幂等无会话会清除令牌；失败保留令牌。
- `requireSession` 只接受真实 CloudBase session。

### 13.3 加密存储与应用装配

- 数据库中不出现明文 Access Token、Refresh Token、密码或验证码。
- 加密不可用时拒绝持久化会话，不降级为明文。
- 运行时装配使用 `CloudBaseAuthService`，不再使用 `LocalAuthService`。
- 现有 IPC 门禁仍在业务服务执行前调用 `requireSession()`。
- 新 CloudBase UID 能读取和写入其本地个人资料，不影响设备级业务数据。

### 13.4 验证命令

- 按测试驱动开发完成认证相关红—绿循环。
- 运行认证服务、共享契约和认证组件定向测试。
- 运行 `pnpm typecheck`。
- 运行 `pnpm lint`。
- 运行 `pnpm test`。
- 运行 `pnpm build`。
- 启动桌面应用，手动验证五条流程：手机登录、邮箱登录、用户名密码登录、手机注册、邮箱注册。
- 在 CloudBase 控制台确认新用户进入身份用户列表；自动化测试不使用真实用户凭证。

## 14. 风险与控制

### 14.1 历史账号不可直接登录

直接切换后，旧本地账号必须重新注册。页面文案明确账号已改为云端账号，避免用户误以为历史密码失效。

### 14.2 验证码成本与滥用

发送按钮执行 60 秒倒计时并禁止并发请求；CloudBase 限频错误映射为稳定提示。登录流程禁止自动注册，避免通过登录页消耗用户列表配额。

### 14.3 注册挑战临时持有密码

CloudBase `signUp` 返回的验证回调会在 Main 进程内存中短暂捕获注册参数。挑战验证、主动取消、失效或最迟 5 分钟后立即删除；不序列化到磁盘、不返回 Renderer、不记录日志。

### 14.4 网络依赖

登录、注册、验证码发送、刷新和登出依赖 CloudBase 可用性。所有提交状态防止重复请求，并提供不泄漏内部信息的错误提示。

### 14.5 令牌泄漏

令牌只存在于 Main 进程内存和 `safeStorage` 加密密文中。Renderer、日志、错误对象和测试快照不得包含令牌。

## 15. 最小改动范围

预计只修改或新增以下直接相关区域：

- `apps/desktop/package.json` 与锁文件：CloudBase SDK 依赖。
- `apps/desktop/electron/main/auth/`：CloudBase 认证服务、挑战管理及测试。
- `apps/desktop/electron/main/application.ts`：运行时装配与加密会话存储注入。
- `packages/shared/src/desktop-api.ts` 及契约测试：认证判别联合与错误码。
- Preload 与认证 IPC：发送验证码、验证验证码和密码登录通道。
- `apps/desktop/src/stores/auth.ts`：新的认证交互方法。
- `apps/desktop/src/views/LoginView.vue`、`RegisterView.vue`：方式切换、验证码交互和文案。
- 认证、应用装配、IPC 和组件相关测试。

不做无关重构、数据库表删除、页面视觉重做或业务数据迁移。

## 16. 参考资料

- [CloudBase Web SDK v3 身份认证](https://docs.cloudbase.net/en/api-reference/webv3/authentication)
- [CloudBase 注册新用户 HTTP API](https://docs.cloudbase.net/http-api/auth/auth-sign-up)
- [CloudBase 发送短信、邮箱验证码 HTTP API](https://docs.cloudbase.net/http-api/auth/auth-send-verification)
- [CloudBase 修改第三方认证源](https://cloud.tencent.com/document/product/876/129350)
- CloudBase Skills：`cloudbase`、`auth-tool-cloudbase`、`auth-web-cloudbase`、`ui-design`、`web-development`
