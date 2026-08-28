# 个人知识库发布门禁

## 当前裁决

个人知识库本地功能可进入最终分支审查；云能力不可开启。生产入口 `apps/desktop/electron/main/index.ts` 当前固定返回关闭的云杀开关，CloudBase entitlement 默认也为 `kill_switch_enabled = true`。任何发布脚本、桌面配置或 Renderer 开关都无权改变这一状态。

本分支没有授权访问 staging，因此以下证据仍是“未验证”：上海 CloudBase/PostgreSQL 强制 RLS 与 GRANT、PG Storage 私有票据和先删字节顺序、跨设备并发、广州 TokenHub 实际请求与撤销、云检索 p95 不超过 2 秒。不得把本地模拟、回环 HTTP 或静态 SQL 检查写成这些边界已通过。

Task 7 的 deterministic/local 撤销状态机测试只证明本地协议语义；它不等于真实广州
TokenHub 的嵌入请求、撤销、在途结算、向量删除或云端执行证据。没有获批 staging
记录时，这些子门禁必须逐项保持 `unverified`。

## 本地发布门禁

在 macOS arm64、Electron 43、pnpm 11.15.0 的干净依赖状态运行：

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm lint
pnpm test
pnpm test:knowledge:evaluation
pnpm exec playwright test apps/desktop/tests/e2e/knowledge-smoke.spec.ts
git diff --check
```

必须满足：

- 评估语料版本固定且机器可读；Recall@8 不低于 90%，引用支持、事实落地、无证据拒绝各不低于 95%，100 个受支持文档样本成功率不低于 99%。
- 10,000 分片本地 FTS p95 不超过 300 ms；持久导入确认 p95 不超过 1 秒；100 页文本层 PDF p95 不超过 2 分钟。
- 100 页 PDF 必须在真实 Electron 边界采样：加密对象落盘 → `synchronous=FULL`
  的 SQLite 作业提交 → 生产 `ParserSupervisor` 沙箱 `BrowserWindow` → blocks/FTS
  发布 → `ready` 后搜索。不得用直接 parser 调用、人工状态或 mock 数字代替。
- Alice/Bob 交叉矩阵为零泄漏，数据库、WAL、journal、临时、恢复和对象产物中不得出现随机明文 sentinel。
- 真实 Electron 流程必须经过 Renderer、生产 Preload、IPC、Application 和加密知识服务，覆盖本地创建、导入、ready、选择、授权、检索、引用；同一运行还要证明云关闭、聊天 Provider 片段授权撤销后实际 ask 拒绝且零新增披露、会员到期以及 Provider 切换后授权隔离。
- macOS x64 和 Windows x64 在独立 native/打包证明前继续 fail closed。

## 隐私与数据处理核对

发布评审必须逐项对照
`docs/privacy/personal-knowledge-base-data-flow.md`，且不得用一个授权替代另一个：

- 用户设备保存按 UID 分离的加密原文件、块和本地索引，用于本地导入与检索；
  用户回收、永久删除或清理本地数据时删除。
- 上海 CloudBase（`autoforge-d1gkhyfb419ba8455` / `ap-shanghai`）可选保存私有源对象、
  版本、分片、索引代次、同步/作业/删除状态及向量，用于多设备同步和云检索；
  需会员、Beta、云授权和杀开关共同允许。到期后是 30 天导出/转本地窗口加
  30 天回收期，也可立即永久删除，且必须先删 Storage 字节再确认元数据删除。
- 广州 TokenHub 可选处理有界文本分片或查询，使用
  `kinfra-text-embedding-0.6b` 生成 1024 维向量；需独立嵌入授权。撤销后停止新发送、
  等待在途请求结算、删除向量并退化为关键词检索；TokenHub 临时处理/日志期限以其条款为准。
- 用户选择的聊天 Provider（例如 OpenRouter 或 DeepSeek）只在按 UID+Provider 分开授权后
  接收当前问题、最多 8 条清洗证据和最小坐标，用于生成带引用回答；切换 Provider
  必须重新授权且零片段泄漏。AutoForge 历史仅保存最小引用，Provider 保存期限以用户配置和其条款为准。

用户始终可导出或删除资料。会员失效时仅保留 1 个本地库+1 个有效文件可写/可检索，
其他内容加密只读、可导出/删除、不可检索；云操作停止，本地功能继续。

当前 v2 基线仍可能复现三个非知识库失败：Renderer `createdAt` 预期、legacy-import 临时目录 `ENOTEMPTY`、context-summary 计费状态。只有在干净 `origin/v2@a2bd28dd4da10aec6aa68113484ba480991fc672` 上复现且知识库改动不重叠时才能标为基线；新增或变化的失败必须阻止发布。

## 获批 staging 云门禁

只有获得明确环境授权后，才按 `docs/runbooks/cloudbase-personal-knowledge.md` 执行。除该文档的 RLS、票据、代次、游标、作业、取消竞态和先删 Storage 门禁外，还必须记录：

1. 环境 `autoforge-d1gkhyfb419ba8455`、区域 `ap-shanghai`、提交、迁移/函数校验和、操作者和回滚负责人；
2. 匿名、Alice、Bob 的跨 owner 读写/票据/发布/删除结果为零泄漏；
3. TokenHub 广州处理的独立同意、拒绝、撤销、在途结算、向量删除和关键词退化；
4. 实际云检索 p95 不超过 2 秒，并附样本量、窗口和服务版本；没有该记录时结果必须显示 `unverified`；
5. 产品、安全、数据库、CloudBase、Storage、桌面和回滚负责人共同签字。

全部通过后，也只能由获批控制面按变更单打开服务端杀开关；桌面客户端不提供自助开启路径。

## 停止与回滚

出现任何跨 owner 泄漏、凭据/正文日志、越权票据、游标漏页、旧代次发布、取消后本地写入、元数据先于 Storage 删除或延迟门禁失败时立即停止：

1. 保持或恢复云杀开关关闭，停止云检索、上传、同步、worker 和清理；
2. 保留本地 outbox、加密数据库和转换/删除 journal；
3. 撤回 `autoforge-knowledge` 函数，再执行数据保留型 rollback；
4. 不 drop、truncate 或擅自清除已接收数据；
5. 本地管理、导出、删除和获准的本地检索继续可用。
