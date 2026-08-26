# 个人知识库发布门禁

个人知识库采用 fail-closed 发布。仓库内的本地合成夹具只能验证门禁和本地实现，不能替代批准语料、真实预发布基础设施或目标平台矩阵，也不能直接开启 beta 或 cloud。

## 必须全部满足的门禁

1. 在批准且脱敏的评估集上：Recall@8 不低于 90%；引用支持率、grounded-answer rate、正确无证据行为均不低于 95%；支持文档处理成功率不低于 99%。
2. 在批准的 benchmark profile 上：10,000 chunks 本地 FTS p95 不高于 300 ms；云检索（不含最终 LLM）p95 不高于 2 秒；导入确认不高于 1 秒；100 页文本 PDF 到 ready 的 p95 不高于 2 分钟。
3. CloudBase 上海预发布环境通过真实 PostgreSQL/RLS、PG Storage、用户 JWT、并发、租约、同步、冲突、回收和清理验证；不得使用真实生产数据完成该门禁。
4. TokenHub 广州通过真实同意、撤回、超时、漂移、向量删除和 keyword-only 降级验证。
5. 当前聊天供应商逐供应商通过首次披露、拒绝、切换后重新同意、最小片段和引用校验验证。
6. 生产 Ed25519 公钥经过批准并嵌入桌面 Main；匹配的 KMS signer、密钥轮换、撤销、时钟和反回滚流程通过预发布审计。
7. macOS arm64、macOS x64 和 Windows x64 均通过真实 Electron runtime 与打包应用内的加密 SQLite、FTS5、safe storage 和解析器验证。存在预编译文件不等于目标平台通过。
8. 内部遥测评审确认正常日志不包含正文、查询、chunks、文件名、本地路径、供应商 payload、签名 URL、凭据或密钥。

## 仓库默认状态

- `PRODUCTION_KNOWLEDGE_ENTITLEMENT_TRUSTED_KEYS` 为空。
- `PRODUCTION_KNOWLEDGE_RELEASE_EVIDENCE` 的外部、批准语料和平台字段全部为 `false`。
- 默认签名器不存在；Cloud Function 必须返回权限不可用，而不是自行生成或信任客户端提供的键和状态。
- beta、cloud 和新的 Agent 知识工具授权均不能由 Renderer、环境中的任意布尔值或本地合成测量开启。

`assessKnowledgeRelease()` 只有在上述批准证据和三平台矩阵全部满足且数值达到阈值时才同时返回 `betaEnabled: true` 与 `cloudEnabled: true`。任何非有限数值、阈值近失、缺失证据或平台缺口都会返回显式 blocker。

## Task 10 本地证据的解释

本地门禁使用运行时生成的非敏感合成内容，不提交真实文档、查询或 chunks。报告只保留 case ID、计数、比率和时延。它验证：

- 每用户加密数据库的隔离和明文 sentinel 工件扫描；
- 10,000 chunks 的真实加密 FTS5 检索、Recall@8 计算和当前主机 p95 测量；
- 独立的 Unicode 完整句子引用支持判定和无证据拒绝计分；
- 支持格式解析测试与成功率计分；
- 真实 Electron Renderer → Preload → IPC → Main → 受限解析器 → 加密持久化的导入、ready、聊天检索、引用预览、导出、回收/永久删除和 cloud-disabled 降级；
- 当前主机的真实 Electron 与打包 native 模块加载。

这些结果始终标记为 `fixtureClass: synthetic_local` 和 `officialAcceptanceEligible: false`。macOS x64、Windows x64、批准语料、真实聊天供应商、TokenHub、CloudBase 预发布、生产公钥/KMS signer 和内部遥测评审在各自所有者提供证据前保持外部门禁。

## 2026-08-26 当前主机记录

| 检查 | 当前证据 | 发布含义 |
| --- | --- | --- |
| 本地加密/隔离 | 运行时随机 sentinel 在 DB/WAL/checkpoint 前后工件中命中 0；跨用户结果 0 | 仅证明本机合成 harness |
| 合成检索 | 10,000 chunks，20/20 Recall@8；40 次检索的最近一次根级全套 p95 为 0.92 ms | 不替代批准语料和批准 benchmark profile |
| 合成 grounding | 引用支持、grounded answer、无证据拒绝均为 100% | 不替代批准的回答评估集或真实供应商 |
| 支持格式 | TXT、Markdown、HTML、PDF、DOCX 合成/包内安全 fixture 为 5/5 | 不替代批准文档集的 99% 门禁 |
| 真实 Electron smoke | 本地导入到 ready、聊天检索、引用预览、导出、回收/永久删除、云关闭降级通过 | 证明当前本地应用边界，不证明云或真实聊天供应商 |
| macOS arm64 打包 | `dist:dir` 与打包应用内 Electron 43.1.1 加密 SQLite/FTS5 探针通过 | 当前主机证据通过；不外推到其他平台 |
| macOS x64 | 未运行 | 外部门禁，保持关闭 |
| Windows x64 | 未运行 | 外部门禁，保持关闭 |
