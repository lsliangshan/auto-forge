# AutoForge 个人资料编辑页设计

## 1. 目标

为已登录的本机账号新增个人资料编辑页。用户可以编辑头像、显示名称、性别、生日、邮箱和手机号，资料保存到本机 SQLite，应用重启后仍然保留。头像从本地选择后由 Electron Main 上传到七牛云，数据库只保存返回的 HTTPS 图片 URL。

完成标准：

- 已登录用户可以从工作台左下角进入 `/profile`。
- 页面可以读取、编辑并保存当前用户的个人资料。
- 保存后的显示名称和头像立即同步到工作台入口，重启应用后仍可恢复。
- 头像上传使用 Main 进程中的七牛凭证，Renderer 无法读取凭证。
- 未配置或上传失败只影响头像更换，不阻止其他资料保存。
- 现有登录、注册、设置和其他工作台页面行为保持不变。

## 2. 范围与边界

本功能涉及以下层级：

- 展示层：个人资料页面和工作台左下角账号入口。
- 交互层：独立的 `ProfileStore`，负责资料加载、头像上传、保存和可展示错误。
- 共享契约与 Preload：新增资料结构、校验规则、IPC Channel 和固定 `DesktopAPI.profile` 方法。
- Main 业务层：资料服务、头像上传服务和认证门禁。
- 数据访问层：独立的一对一资料表和 Repository。
- 外部服务：七牛对象存储。

不在本次范围内：

- 修改登录账号或密码。
- 邮箱或手机号验证码验证。
- 头像裁剪、云端旧头像删除和未引用对象垃圾回收。
- 面向公开发行客户端的服务端上传凭证签发系统。
- 离开页面前的未保存更改提醒。

## 3. 方案选择

采用独立 `local_user_profiles` 表，不给 `local_users` 追加资料字段，也不使用 JSON 整体存储资料。

原因：

- `local_users` 继续只负责身份认证，避免密码和可编辑资料耦合。
- 资料字段保留 SQLite 列级约束、清晰的迁移路径和可测试查询。
- 独立 Profile Service/API 形成稳定边界，不复用设置 DTO、Service 或 Repository。

头像选择后立即上传七牛并取得待保存 URL；用户点击“保存资料”时，再将该 URL 与其他资料一起写入 SQLite。七牛上传和数据库写入不组成分布式事务。保存失败时保留页面草稿供用户重试，不自动删除已上传对象。

## 4. 页面与导航

新增受认证保护的 `/profile` 路由：

```ts
{
  path: 'profile',
  name: 'profile',
  component: ProfileView,
  meta: { title: '个人资料', inspector: false },
}
```

工作台左下角账号区域改为个人资料入口：

- 显示圆形头像和显示名称。
- 没有头像时显示账号首字母。
- 没有显示名称时回退显示账号。
- 点击入口导航到 `/profile`。
- 退出登录按钮继续独立保留。

个人资料页采用单栏资料卡：

- 顶部为头像预览、“更换头像”按钮和上传状态。
- “基本资料”包含只读账号、显示名称、性别和生日。
- “联系方式”包含邮箱和手机号。
- 底部提供主操作“保存资料”。

交互规则：

- 页面加载时读取当前用户资料。
- 只有草稿与已加载资料不同时才启用保存按钮。
- 头像上传中禁止重复选择，但其他字段仍可编辑。
- 保存成功显示“个人资料已保存”，清除 dirty 状态，并立即同步工作台入口。
- 保存失败保留当前草稿和已经上传的头像 URL。
- 加载失败显示可重试错误。

性别选项为“未设置、男、女、其他、不愿透露”。生日只能选择当天及以前的本地日历日期。

## 5. Renderer 状态

新增独立 `ProfileStore`，作为 Renderer 中个人资料的唯一状态来源。页面与工作台账号入口共享该 Store。

Store 负责：

- 去重加载当前用户资料。
- 保存完整资料草稿。
- 调用头像选择和上传接口。
- 跟踪 `loading`、`saving`、`uploadingAvatar` 和 `error`。
- 保存成功后用 Main 返回的完整资料替换当前资料。

`AuthStore` 仍只负责认证会话，不把可编辑资料并入 `AuthSession`。退出后清空 Profile Store；新用户登录后重新加载，避免同一应用进程内跨账号显示旧资料。

## 6. 共享接口契约

```ts
type ProfileGender = 'male' | 'female' | 'other' | 'prefer_not_to_say'

interface UserProfile {
  userId: string
  account: string
  avatarUrl?: string
  displayName?: string
  gender?: ProfileGender
  birthDate?: string
  email?: string
  phone?: string
  updatedAt?: string
}

interface UserProfileUpdate {
  avatarUrl?: string
  displayName?: string
  gender?: ProfileGender
  birthDate?: string
  email?: string
  phone?: string
}

interface ProfileAPI {
  get(): Promise<UserProfile>
  update(input: UserProfileUpdate): Promise<UserProfile>
  pickAndUploadAvatar(): Promise<{ url: string } | null>
}
```

契约规则：

- `userId` 和 `account` 只来自当前认证会话，不出现在更新输入中。
- 所有可编辑字段均可为空；空字符串在 Main 标准化为数据库 `NULL`。
- 显示名称去除首尾空格，非空时最多 50 个 Unicode 字符。
- `avatarUrl` 必须是规范的 HTTPS URL，禁止用户名、密码、非默认端口和片段。
- `birthDate` 使用 `YYYY-MM-DD`，且不得晚于 Main 进程认定的本机今天。
- 邮箱去除首尾空格，非空时必须通过邮箱格式校验且不超过 254 个字符。
- 手机号保存前移除空格和连字符，非空时只允许可选前导 `+` 与 6–20 位数字。
- Renderer 可做即时字段提示，但 Main 必须再次执行完整校验。

新增三个受保护 IPC：

- `profile:get`
- `profile:update`
- `profile:pick-and-upload-avatar`

所有请求和响应都通过共享 Zod Schema 严格校验。三个 IPC 均执行可信 Renderer 检查和 `requireSession()`。

## 7. 数据模型与 Repository

新增迁移 `0005_user_profile.sql`：

```sql
CREATE TABLE local_user_profiles (
  user_id TEXT PRIMARY KEY
    REFERENCES local_users(id) ON DELETE CASCADE,
  avatar_url TEXT,
  display_name TEXT,
  gender TEXT,
  birth_date TEXT,
  email TEXT,
  phone TEXT,
  updated_at INTEGER NOT NULL
);
```

Repository 接口保持资料领域专用：

```ts
interface UserProfileRepository {
  findByUserId(userId: string): UserProfileRecord | undefined
  upsert(profile: UserProfileRecord): UserProfileRecord
}
```

读取流程：

1. Profile Service 从认证服务取得当前会话。
2. Repository 按当前 `userId` 查询资料。
3. 没有资料行时返回包含 `userId`、`account` 的空资料，不写入空行。

更新流程：

1. Profile Service 从认证服务取得当前会话，不接受 Renderer 提供用户 ID。
2. Main 校验并标准化更新输入。
3. Repository 使用 `INSERT ... ON CONFLICT(user_id) DO UPDATE` 写入全部可编辑字段和 `updated_at`。
4. Service 将数据库记录与当前账号组合成完整 `UserProfile` 返回。

资料表以用户 ID 隔离记录；删除本地用户时通过外键级联删除资料。

## 8. 七牛头像上传

根目录 `.env` 配置：

```dotenv
QINIU_ACCESS_KEY=
QINIU_SECRET_KEY=
QINIU_BUCKET=
QINIU_DOMAIN=https://cdn.example.com
QINIU_REGION=
```

仓库提交不含密钥的 `.env.example`。现有 `.gitignore` 已忽略 `.env*` 并放行 `.env.example`。Main 启动时加载并校验配置；七牛凭证不得进入共享契约、Preload、Renderer、日志或用户可见错误。

上传流程：

1. Renderer 调用 `profile.pickAndUploadAvatar()`，不传文件路径或凭证。
2. Main 使用系统文件选择器选择单个图片；用户取消时返回 `null`。
3. Main 读取文件并校验真实内容类型，只接受 JPEG、PNG、WebP，最大 5 MiB。扩展名与识别出的内容类型不一致时拒绝上传。
4. Main 使用七牛官方 Node SDK，根据 AccessKey、SecretKey、Bucket 和对象键生成短期上传凭证。
5. 小体积头像使用表单上传。对象键为 `profiles/<userId>/<randomUUID>.<ext>`。
6. 上传成功后验证七牛返回的对象键，并使用已校验的 HTTPS `QINIU_DOMAIN` 构造规范图片 URL。
7. 返回 `{ url }` 给 Renderer；用户保存资料前 URL 只存在于页面草稿中。

Main 依赖一个窄接口，便于测试和以后替换为服务端签发上传凭证：

```ts
interface AvatarUploader {
  pickAndUpload(userId: string): Promise<{ url: string } | null>
}
```

七牛 SDK 的原始错误只用于内部分类，不记录请求头、上传凭证、SecretKey 或完整服务端响应。

`.env` 方案只面向当前本机开发和内部部署。若以后向不受信任用户公开分发客户端，必须改为可信服务端签发短期、受限上传凭证，客户端安装包不再持有 SecretKey。

## 9. 错误处理

- `INVALID_INPUT`：资料字段不符合共享契约或生日晚于今天。
- `CREDENTIAL_UNAVAILABLE`：七牛必要配置缺失，UI 显示“头像上传服务尚未配置”。
- `MEDIA_TYPE_UNSUPPORTED`：选择的文件不是 JPEG、PNG 或 WebP。
- `MEDIA_SIZE_LIMIT_EXCEEDED`：图片超过 5 MiB。
- `MEDIA_MIME_MISMATCH`：文件扩展名与嗅探结果不一致。
- `PROFILE_AVATAR_UPLOAD_FAILED`：新增安全错误码，表示七牛上传失败；不透传供应商原始错误。
- `AUTH_REQUIRED`：没有有效会话时调用资料接口。
- `INTERNAL_ERROR`：数据库或其他未分类故障。

用户取消选择文件返回 `null`，不作为错误。上传失败只保留原头像草稿，不影响其他资料字段编辑和保存。

## 10. 测试与验证

共享契约测试：

- 可选字段和严格对象结构。
- 显示名称长度、规范 HTTPS 头像 URL、邮箱、手机号和生日格式。
- 更新输入不能包含 `userId` 或 `account`。

数据库与 Repository 测试：

- v4 数据库升级到 v5 后资料表存在且旧数据保留。
- 空资料查询、首次 upsert 和重复更新。
- 不同用户资料隔离。
- 删除用户时级联删除资料。

Profile Service 测试：

- 始终使用当前会话用户 ID。
- 空值、显示名称、邮箱和手机号标准化。
- 未来生日和非法头像 URL 被拒绝。
- 返回资料包含当前只读账号。

头像上传测试：

- 缺少 `.env` 配置映射为安全错误。
- 文件选择取消返回 `null`。
- 内容类型嗅探、扩展名一致性和 5 MiB 限制。
- 对象键包含当前用户 ID 和随机 UUID，不使用原始文件名。
- 成功时只返回规范 HTTPS CDN URL。
- 七牛失败映射为 `PROFILE_AVATAR_UPLOAD_FAILED`，日志不包含密钥。

IPC 与 Preload 测试：

- 三个新增 Channel 的请求和响应校验。
- 未登录调用被拒绝。
- 非可信窗口不能读取、更新资料或触发文件选择。
- Preload 只暴露固定 Profile API，不暴露任意路径读取或任意 IPC。

Renderer 测试：

- `/profile` 的认证保护和页面标题。
- 初始资料加载、空值回退和字段渲染。
- 字段即时校验、dirty 状态、保存成功与失败保留草稿。
- 头像上传状态、取消、失败和成功预览。
- 工作台入口导航、账号首字母回退、显示名称/头像即时同步。
- 退出和切换账号后不会显示上一用户资料。

实现完成后运行相关 Vitest、全仓类型检查、Lint 和构建。当前工作区已有聊天与视频模块的未提交改动，实施时只修改个人资料功能直接相关文件，不覆盖、清理或提交这些既有改动。

## 11. 风险与后续事项

- 七牛上传成功但资料未保存会产生未引用对象；首版接受该风险，通过随机对象键避免覆盖。云端垃圾回收不在本次范围。
- `.env` 中的 SecretKey 不适合随公开客户端分发；公开发行前必须迁移到服务端签发上传凭证。
- 手机号和邮箱只做格式校验，不表示所有权已验证；本次不新增“已验证”状态。
- 当前只支持静态 JPEG、PNG、WebP 头像，不支持 GIF 动画、裁剪或服务端图片处理。
