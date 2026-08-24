# AutoForge CloudBase 用户会话与模型消费持久化设计规格

日期：2026-08-24
状态：已确认，待分阶段实施

## 1. 目标

将当前仅保存在本机 SQLite 的会话、消息、模型用量与消费数据迁移为绑定 CloudBase 用户的远端持久化数据，同时保留可控的离线体验。CloudBase PostgreSQL 是登录用户数据的权威来源；Electron Main 管理按用户隔离的 SQLite 缓存与待同步队列。

本设计还建立可信计费边界：平台凭证调用由受信服务端执行并产生不可由客户端伪造的账本；用户自备凭证调用继续在 Electron Main 执行，其远端数据明确标记为 BYOK 自报与估算，不参与平台扣费。

## 2. 当前实现事实

- CloudBase 当前只承担认证、用户资料投影和业务角色；CloudBase UID 已作为本地用户主键。
- `conversations.user_id` 绑定 UID，消息通过 `conversation_id` 间接归属。
- 会话、消息、`conversation_contexts`、`chat_runs` 与 `provider_usage_events` 全部位于本机 `autoforge.sqlite`。
- `provider_usage_events` 已有 `operation_key` 与 generation identity 幂等语义，费用来自 OpenRouter 实际响应或 generation 回查。
- 当前 Token 从 `chat_runs` 聚合，删除会话后会消失；费用流水独立保留。远端化后必须统一为独立 usage ledger。
- 当前会话与消息 IPC 都全量返回；普通消息插入不会更新 `conversations.updated_at`。
- 当前 `claimLegacyAndListForUser()` 会把所有 `user_id IS NULL` 的旧会话认领给第一个列出会话的用户，不能用于自动上云。
- 媒体文件只在本地受控目录，SQLite 仅保存相对路径和安全元数据。
- Renderer 不接触 CloudBase token、Provider API Key、文件绝对路径或 Base64；该边界必须保留。

## 3. 已确认的产品决策

### 3.1 权威来源与数据范围

- CloudBase PostgreSQL 是远端主库；SQLite 是按 UID 隔离的缓存与 outbox。
- 远端保存会话元数据、完整原始消息、版本化消息块、生成偏好和服务端内部上下文 checkpoint。
- 内部摘要不出现在 Renderer、Preload、普通 IPC、聊天事件、日志或导出文件中。
- 附件与最终生成媒体进入私有对象存储；临时文件、中间帧和失败产物不上传。
- 原始历史附件进入模型上下文时仍只序列化安全元数据；只有当前消息附件可发送文件字节。

### 3.2 用户与权限

- 每条业务记录只有一个不可变 CloudBase UID owner；第一版不支持组织、团队或共享所有权。
- 云函数和 CloudBase Run 从认证上下文派生 UID，永不信任客户端 `userId`。
- `PUBLIC`、`anon`、`authenticated` 不直接操作业务表或 service RPC；`service_role` 只存在于云函数、CloudBase Run 和受控运维环境。
- 普通用户只能读取自己的记录。管理员可读取脱敏的用户、Provider、模型、用途与异常账目汇总，但不能读取正文、附件、API Key 或认证令牌。
- 管理员查询明细、导出和账目调整均写不可变审计事件。

### 3.3 同步与并发

- 消息不可变，使用客户端生成的全局唯一 ID；远端事务分配每会话递增 ordinal。
- 每个 mutation、导入批次、模型 operation、usage event 和 adjustment 都有幂等键。
- 会话元数据使用 revision 乐观并发控制；用户手动标题优先于迟到的 AI 标题。
- 每个会话全局最多一个活动 run；第二个请求在写入用户消息和调用 Provider 之前返回 `CONFLICT`。
- 删除使用 tombstone；普通删除进入 30 天“最近删除”，旧设备不能复活已删除记录。
- SQLite outbox 永远绑定 UID。登出、换账号或设备撤销时，其他 UID 不能读取或接管队列。
- 网络错误、超时和 5xx 指数退避；认证失效暂停；权限、schema 和非法数据进入可见隔离队列。
- outbox 超过 10,000 条或连续失败 24 小时必须显著告警。

### 3.4 离线与登出

- 成功在线验证用户和角色后签发 72 小时离线租约，绑定 UID、device ID、角色版本与到期时间。
- 租约内允许读取缓存、创建草稿和写 outbox；不允许平台模型调用、导出、额度调整或管理员操作。
- 有 pending mutation 时，正常登出必须先同步。用户可以等待，或二次确认放弃未同步数据并强制登出。
- 同步完成或强制放弃后，删除该 UID 的可读 SQLite 缓存和媒体缓存。
- 全局数据库只保存非敏感应用设置与公开身份投影；每个 UID 使用哈希命名的独立数据库和媒体目录。

### 3.5 分页、排序和搜索

- 会话列表每页 50 条，使用不透明 cursor。
- 消息首次加载最新 100 条，向上滚动按 cursor 加载历史。
- `last_activity_at` 在新消息和 run 终态时更新；`metadata_updated_at` 只跟踪标题、偏好等元数据。
- 会话按 `last_activity_at DESC, id` 排序。
- 第一版只提供标题搜索，不建立消息正文全文索引。

### 3.6 媒体

- 私有对象路径不含原始文件名，形式为 `<owner-scope>/<sha256-prefix>/<object-id>`。
- PostgreSQL 保存 object key、SHA-256、MIME、字节数、显示名、引用计数与生命周期状态，不保存本地路径或长期 URL。
- 客户端先取得绑定 UID、object key、大小和 MIME 的短期上传票据，再把字节直接上传 Storage API；完成后服务端验证元数据和哈希再标记 ready。
- 私有下载只使用短期签名 URL；签名请求仍执行 owner 权限校验。
- 按 SHA-256 去重但不跨 owner 暴露对象存在性。删除会话后对象进入 30 天回收期，无引用后清理。
- 安全默认值：单附件 50 MB、单账号对象存储 5 GB、单次同步 100 个 mutation 或 1 MB。

CloudBase 当前官方文档说明 PG 模式云存储通过 RLS 约束对象访问，私有文件使用临时链接，签名操作不绕过 `SELECT` 权限：

- <https://docs.cloudbase.net/storage/sdk>
- <https://docs.cloudbase.net/en/storage/pg/serving>

### 3.7 上下文 checkpoint

- 完整 transcript 始终保留；远端 `conversation_contexts` 只保存内部摘要、`through_ordinal`、估算 Token、Provider、模型、预算参数与 revision。
- checkpoint 更新使用 CAS；跨设备继续会话读取同一 checkpoint，避免重复压缩和重复费用。
- 摘要仍遵守既有 60% 聊天输入预算、90% 摘要输入预算和最多 2,048 输出 Token 规则。

### 3.8 用量与消费

- 所有实际调用都形成不可变 usage event：主回复、工具轮次、工作流路由、浏览器辅助、标题、上下文压缩和媒体生成。
- 每条事件记录 `purpose`、`credential_owner`、`billable`、Provider、模型、模态、状态、输入/输出 Token、发生时间、接收时间和幂等 identity。
- 金额严格分为 `provider_cost`、`charged_amount` 与 `estimated_cost`；第一版 `charged_amount` 为空，不做充值、扣款、退款或发票。
- 金额使用规范定点十进制字符串，保存原币种。统一展示金额另存汇率、来源和时间快照；没有可靠汇率时不得跨币种强行合计。
- 状态分为 `pending | reported | calculated | estimated | unavailable`。无法取得真实费用时不得伪装为已确认消费。
- 对账不修改旧事件；差异使用 adjustment 事件追加审计链。
- Token 与费用都从独立 usage ledger 聚合；删除会话不改变历史用量。内容物理删除后解除账本的会话引用。
- 账号存在期间保留账本；账号注销时删除该用户用量明细。数据库备份最长残留 30 天。
- 所有事件同时保存 UTC `occurred_at` 与服务端 `received_at`。账号保存 IANA 时区，日/周/月汇总按账号时区计算，星期一为周起点。

### 3.9 平台调用与 BYOK

- 平台 OpenRouter 请求通过 CloudBase Run HTTPS + SSE 网关执行；平台密钥只在服务端。
- 会话 CRUD、分页、同步和普通查询继续使用认证 CloudBase 云函数与 PostgreSQL RPC。
- 平台请求先事务性创建/确认用户消息与 run，再调用 Provider；assistant 消息、终态和账本均由服务端写入。
- SSE 是传输通道，不是唯一运行状态。客户端按 `run_id + event_cursor` 恢复；断线不自动取消，明确停止才调用取消接口。
- 同一 `operation_id` 重试只能返回原 run，不得重复调用或计费。
- BYOK 继续在 Electron Main 执行，API Key 只在本机 `safeStorage`；消息和估算 usage 通过 outbox 同步。
- 第一版平台网关只支持 OpenRouter。DeepSeek 保持 BYOK，费用为 estimated 或 unavailable。
- 平台新用户额度默认为 0；服务端执行每用户月度硬上限、单次输出上限、账号最多 3 个并发平台任务和全局预算。

CloudBase 官方将 SSE 作为 AI 流式输出场景，并说明普通 Web 云函数连接受运行时长和并发限制；CloudBase Run 适合完整流式服务：

- <https://docs.cloudbase.net/cloud-function/develop/sse>
- <https://docs.cloudbase.net/products/functions>

### 3.10 生命周期、备份与导出

- “最近删除”展示剩余天数并允许 30 天内恢复；永久删除需要二次确认。
- 注销账号要求 CloudBase 重新认证验证码。服务端先把业务数据变为不可访问并创建不依赖用户外键的对象清理任务，再调用 CloudBase 当前用户删除接口；身份删除成功后清理本地会话与缓存，对象清理任务可在身份外键级联后继续完成。
- 如果身份删除失败，业务数据保持不可访问，用户可在重新认证后重试；系统不得为了“回滚注销”恢复已进入清理流程的正文。
- 加密备份最多保留 30 天，不用于普通查询；灾难恢复后重放删除 tombstone。
- 用户可导出版本化 JSON transcript、附件目录与 SHA-256 清单，以及不含内部密钥指纹的 usage CSV/JSON。
- 导出要求重新验证在线身份，下载链接短期一次性有效，操作写审计日志。
- 首次启用云同步记录隐私条款版本、同意时间和客户端版本；旧本地历史导入需要独立确认。

## 4. 远端数据模型

### 4.1 核心表

| 表 | 核心职责 | 关键约束 |
| --- | --- | --- |
| `app_conversations` | 会话元数据、标题状态、偏好、活动时间、revision、删除状态 | `(owner_user_id, id)` 唯一；owner 不可变 |
| `app_messages` | 不可变消息与版本化 blocks JSONB | `(conversation_id, ordinal)`、`(owner_user_id, id)` 唯一 |
| `app_conversation_contexts` | 内部摘要 checkpoint | 会话唯一；CAS revision |
| `app_media_objects` | 私有对象元数据与生命周期 | owner + sha256 去重；不存长期 URL |
| `app_message_media` | 消息与对象引用 | 引用必须同 owner、同会话 |
| `app_model_runs` | 平台/BYOK run 状态、lease、恢复 cursor | operation id 幂等；每会话最多一个 active |
| `app_usage_events` | 不可变用量与费用事件 | operation/provider identity 幂等 |
| `app_usage_adjustments` | 账目调整 | 只追加；引用原事件 |
| `app_daily_usage_rollups` | 按账号时区生成的可重建日汇总 | owner/date/provider/model/purpose 唯一 |
| `app_sync_devices` | 安装投影、撤销、最后同步、协议版本 | owner + device id 唯一 |
| `app_sync_mutations` | 服务端幂等 mutation 收据与同步 cursor | owner + mutation id 唯一 |
| `app_privacy_consents` | 版本化同意 | owner + document version 唯一 |
| `app_user_data_preferences` | 账号时区与展示币种 | owner 唯一；IANA 时区、`CNY`/`USD` |
| `app_data_exports` | 导出任务与一次性下载状态 | owner 隔离、过期时间 |
| `app_account_deletion_jobs` | 注销清理收据与对象清理进度 | UID 文本快照，不依赖被删除的 auth 外键 |

### 4.2 时间与删除

- `owner_user_id` 使用现有 CloudBase `auth.users.id` 的 `bigint` 外键类型；云函数和 Electron contract 继续把 UID 表示为经过长度与数字格式校验的字符串。
- 所有数据库时间使用 `timestamptz`，客户端 contract 使用 ISO 8601 UTC。
- 软删除使用 `deleted_at` 与单调 revision；物理清理由服务端计划任务执行。
- cursor 是服务端签名或不可解释编码，客户端不能构造 offset 或 owner。
- mutation 的服务端接收时间决定同步顺序；客户端时间只用于展示和 BYOK occurred time。

## 5. API 边界

### 5.1 数据云函数

统一认证 handler 支持严格 action union：

- `syncPush`
- `syncPull`
- `listConversations`
- `listMessages`
- `createConversation`
- `renameConversation`
- `deleteConversation`
- `restoreConversation`
- `listDeletedConversations`
- `importLegacyBatch`
- `getUsageSnapshot`
- `listUsageEvents`
- `registerDevice`
- `revokeDevice`
- `createExport`
- `getExportStatus`

所有 action 使用精确输入键、协议版本、幂等 ID、批量上限和稳定错误码。错误不得返回 SQL、Provider body、token 或正文。

### 5.2 平台网关

- `POST /v1/runs` 创建或返回幂等 run。
- `GET /v1/runs/:id/events?after=<cursor>` 返回 SSE。
- `POST /v1/runs/:id/cancel` 明确取消。
- `GET /v1/runs/:id` 返回脱敏状态。

网关验证 CloudBase access token、设备撤销状态、协议版本、额度、并发 lease 与 conversation owner。客户端不得直接传平台 API Key。

## 6. 用户界面

- 会话列表显示轻量 `synced | pending | syncing | failed` 状态，支持 cursor 加载和“最近删除”。
- 设置页显示已确认平台消费、待确认笔数、BYOK 估算、Token、后台辅助占比、统计时区、币种说明和最后同步时间。
- 删除、强制登出、旧数据导入、导出与永久删除都有清晰确认边界。
- `estimated/unavailable/pending` 永不显示为已确认金额。
- 同步隔离队列、额度 80%/100%、对象配额和 24 小时失败均提供可操作提示。

## 7. 安全与日志

- 不记录 prompt、回复正文、附件内容、签名 URL、access token、Refresh Token、API Key 或原始认证头。
- 允许记录内部不可逆 UID 映射、run ID、Provider、模型、用途、状态、耗时、Token、金额和稳定错误码。
- 对象上传完成前校验大小、MIME、哈希和 owner；对象 key 不接受客户端任意路径。
- 日志保留 30 天；审计日志保留至账号注销。
- 客户端构建固定绑定 development、staging 或 production 环境之一，运行时不可随意切换生产 endpoint。

## 8. 可用性目标

- 服务端已确认会话 mutation：RPO 不超过 5 分钟。
- 平台 usage ledger：成功响应后的 RPO 为 0；账本事务未提交不得确认。
- 核心会话服务：RTO 不超过 4 小时。
- 网关故障不影响历史读取和 BYOK；对象存储故障不影响文本读取。
- 每季度演练数据库恢复、对象引用校验和删除 tombstone 重放。

## 9. 发布策略

### 9.1 里程碑一：远端数据基础

远端 schema、权限、会话/消息同步、分页、删除 tombstone、显式 legacy 导入、按用户本地缓存、BYOK 自报 usage 与新统计口径。

### 9.2 里程碑二：媒体与可靠性

私有对象存储、上下文 checkpoint、离线租约、设备管理、最近删除/恢复、导出、备份与恢复演练。

### 9.3 里程碑三：可信平台计费

CloudBase Run SSE 网关、平台 OpenRouter、额度预占/结算、可信 ledger、adjustment、管理员脱敏汇总。

每个里程碑依次经历 schema/RPC 部署、shadow write、内部导入、远端读取、真实 Electron 验证和独立回滚门。回滚读取路径不删除已写入远端的数据。

## 10. 明确不包含

- 团队、组织、共享会话或 ACL。
- 单条消息编辑或删除。
- 端到端加密。
- 消息正文全文搜索。
- 跨地域复制与海外数据驻留。
- 平台 DeepSeek 网关。
- 余额充值、实际扣款、发票、退款。
- 匿名用户云同步。
- 远程擦除离线设备文件。
- 上传用户现有 API Key。
- 静默认领或上传 `user_id IS NULL` 的历史会话。

## 11. 验收标准

1. 两个 CloudBase 用户在同一台电脑上数据库、媒体缓存和 outbox 严格隔离。
2. 同一用户两台设备可以创建、分页、改名、删除、恢复并最终得到一致 transcript。
3. 离线 mutation、崩溃与重复重试不重复消息、对象、run 或 usage。
4. 同一会话并发 run 在 Provider 调用前稳定返回 `CONFLICT`。
5. 平台 SSE 断线后可以按 run/cursor 恢复，明确取消可终止 run。
6. BYOK usage 始终标记为估算或不可用，不能进入平台已确认消费。
7. 删除会话后内容按规则消失而历史消费不变；注销后在线用户数据清除。
8. Renderer 无法读取其他 UID、平台密钥、用户 API Key、CloudBase token、本地路径或长期对象 URL。
9. 自动化覆盖 schema/RPC/handler/Main/IPC/Renderer；最终在 staging CloudBase、CloudBase Run 和真实 Electron 双设备路径验证可见结果。
