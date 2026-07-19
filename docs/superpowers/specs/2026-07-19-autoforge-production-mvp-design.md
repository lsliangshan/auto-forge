# AutoForge 生产级桌面 MVP 设计规格

日期：2026-07-19

状态：已确认
目标平台：macOS、Windows

## 1. 产品目标

AutoForge 是一个本地优先的 AI 工作流桌面应用。用户可以通过 OpenRouter 与大模型聊天；模型可以根据用户意图匹配已安装工作流，并在获得必要授权后执行工作流。开发者可以在应用内使用 Monaco 编辑器创建、校验、调试和安装 TypeScript 工作流。

本阶段必须形成以下真实闭环：

1. 用户配置自己的 OpenRouter API Key 和模型。
2. 用户与模型进行流式聊天。
3. 模型根据工作流元信息选择合适的本地工作流。
4. 应用校验参数和权限，并向用户展示可理解的授权卡片。
5. 工作流在独立 Worker 中运行，并通过宿主能力驱动可见的独立 Chromium 窗口。
6. 工作流结果回传给模型，模型生成最终回复。
7. 用户可以查看执行步骤、日志、结果和历史记录。
8. 开发者可以在内置工作台完成工作流的创建、编辑、校验、调试和本地安装。

运行时不得使用 Mock 数据或 Mock 服务回退。测试可以使用受控的本地测试 Provider 和固定工作流夹具。

## 2. 首版范围

### 包含

- OpenRouter API Key 的安全存储、凭证验证和模型选择。
- 会话创建、重命名、删除、持久化和流式聊天。
- 中止生成、有限重试、Token 与费用展示。
- 已安装工作流的搜索、分类、启停、详情、权限、版本和完整性状态。
- 本地工作流项目的创建、目录注册、文件监听、构建、Manifest 实时校验和调试。
- Monaco 文件树、代码编辑器、输入参数、权限模拟、日志和结果面板。
- 确定性工作流召回、OpenRouter Tool Calling、参数校验和权限审批。
- 独立 Worker、JSON Lines RPC、超时、取消、日志和执行历史。
- 可见的独立 Chromium 自动化窗口和临时隔离浏览器配置。
- macOS 与 Windows 的生产构建配置。
- 一个可真实运行的“百度搜索”示例工作流。

### 不包含

- 账号系统、云同步和团队协作。
- 远程工作流大厅、提交审核、管理员后台、支付和评论。
- 云端向量检索或本地嵌入模型。
- 任意 Node.js 模块、Shell 脚本或未声明环境变量访问。
- Linux 支持。
- 自动更新服务端和真实发布签名凭证。

## 3. 技术架构

项目采用 pnpm workspace，分为桌面应用、共享契约、工作流 SDK 和 Manifest 校验器。

```text
auto-forge/
├── apps/
│   └── desktop/
│       ├── electron/
│       │   ├── main/
│       │   ├── preload/
│       │   └── workers/
│       ├── src/
│       ├── resources/
│       └── index.html
├── packages/
│   ├── shared/
│   ├── workflow-sdk/
│   └── workflow-schema/
├── examples/
│   └── browser-search-baidu/
├── docs/
├── tests/
├── package.json
├── pnpm-workspace.yaml
└── tsconfig.base.json
```

### 进程边界

#### Renderer

Vue Renderer 只负责 UI、瞬时交互状态和经 Preload 暴露的类型化 API。Renderer 不导入 Electron、Node.js、文件系统、SQLite、Playwright 或 OpenRouter 凭证。

#### Preload

Preload 只暴露按领域命名的固定 API。禁止暴露通用 `invoke(channel, payload)`、任意文件读取、任意命令执行或原始 `ipcRenderer`。

#### Main

Main 是受信任编排层，负责：

- OpenRouter 请求和流事件转换。
- 会话、工作流和执行状态编排。
- SQLite 迁移和数据访问。
- `safeStorage` 凭证加密与解密。
- 工作流召回、参数校验和权限策略。
- Worker 生命周期和 JSON Lines RPC。
- 浏览器能力实现和 Playwright 生命周期。
- 脱敏审计日志、窗口生命周期和外部链接策略。

#### Worker

每次工作流执行启动一个独立 Node Worker。Worker 只加载经过构建和完整性校验的工作流入口，并通过 JSON Lines 调用宿主能力。Worker 不获得 OpenRouter Key、应用数据库、完整环境变量、Playwright、Shell 或任意文件系统权限。

### Electron 安全配置

- `nodeIntegration: false`
- `contextIsolation: true`
- `sandbox: true`
- `webSecurity: true`
- 严格 CSP
- 禁止任意导航和窗口打开
- 外部 HTTPS 链接交给系统浏览器
- IPC 请求和响应使用 Zod 校验
- Manifest、输入和输出 Schema 使用 AJV 校验
- 敏感值只在 Main 内解密，并在日志中脱敏

## 4. UI 与信息架构

应用使用工作台式四区布局：固定功能栏、页面上下文栏、中央主工作区和可折叠右侧检查器。主导航固定为：聊天、工作流、开发、执行记录、设置。

### 聊天

- 上下文栏：新会话、会话搜索、日期分组和会话列表。
- 主工作区：结构化消息块、流式文本、工作流建议、授权卡片、执行卡片、结果和错误。
- 检查器：当前任务、工作流、参数、步骤、实时日志、结果和取消操作。
- 输入区：多行输入、发送、停止、模型选择和快捷键提示。
- 消息只引用 `executionId`，不复制完整执行状态。

支持的消息块：

- `text`
- `reasoning_status`
- `workflow_proposal`
- `approval`
- `workflow_execution`
- `execution_result`
- `error`

### 工作流

- 上下文栏：搜索、类别、启用状态和来源筛选。
- 主工作区：已安装和开发中工作流列表。
- 检查器：Manifest、版本、作者、权限、文件 Hash、最近执行和启停操作。
- 完整性失败的工作流明确标记并自动禁用。

### 开发

- 上下文栏：工作流项目列表和文件树。
- 主工作区：Monaco 编辑器与可切换的问题、输出和日志面板。
- 检查器：输入参数、权限模拟、运行、停止、超时和结果。
- 开发者模式开启时持续显示醒目标识。
- 保存后触发构建和校验；校验通过的开发版本才可进入聊天召回。

### 执行记录

- 上下文栏：状态、工作流、日期和关键词筛选。
- 主工作区：执行列表或时间线。
- 检查器：步骤、日志、结果、错误、重试和关联会话。

### 设置

- OpenRouter API Key、凭证状态和模型。
- 默认模型参数和费用展示开关。
- 权限默认值与已保存授权管理。
- 开发者模式开关。
- 主题、语言、数据目录和日志目录。
- 本地数据清理与应用信息。
- 设置页不显示右侧检查器。

## 5. 工作流格式

首版只支持 TypeScript 工作流。每个项目至少包含：

```text
workflow-project/
├── manifest.json
├── package.json
├── tsconfig.json
├── README.md
├── src/index.ts
└── dist/index.js
```

Manifest 包含：

- `id`
- `name`
- `description`
- `author`
- `version`
- `category`
- `entry`
- `inputSchema`
- `outputSchema`
- `permissions`
- `execution.timeoutMs`
- `execution.concurrency`
- `execution.riskLevel`
- `activation.examples`
- `activation.negativeExamples`
- `files[].path`
- `files[].sha256`

工作流通过 `defineWorkflow()` 声明 `run(ctx, input)`。`ctx` 只提供宿主能力：

- `logger`
- `signal`
- `browser`
- `network`
- `filesystem`
- `clipboard`
- `notification`
- `emitProgress`
- `createArtifact`

首个真实示例只使用 `browser` 和 `logger`。其他能力保留接口和拒绝策略；没有完成安全实现的能力不向工作流暴露可用实现。

## 6. 工作流召回与 Agent 数据流

首版不引入嵌入模型。召回器对以下字段做确定性加权评分：

- 精确工作流名称。
- 描述和类别关键词。
- `activation.examples` 正向匹配。
- `activation.negativeExamples` 负向排除。
- 已启用状态、完整性状态和来源。

召回范围包含已启用且完整性通过的安装版本；开发者模式开启时额外包含构建和校验通过的开发版本。候选集合被裁剪后转换为 OpenRouter tools。

一次运行按以下顺序执行：

1. Renderer 通过类型化 IPC 提交消息。
2. Main 持久化用户消息并创建 `chat_run`。
3. 召回器筛选候选工作流并生成 tool schema。
4. OpenRouter Provider 发起流式请求。
5. 普通文本持续发送给 Renderer 并保存。
6. Tool call 由 Zod 和 AJV 校验。
7. Policy Engine 检查 Manifest 权限和已有授权。
8. 缺少授权时发送 `approval` 消息块并暂停执行。
9. 用户授权后启动 Worker 和临时执行目录。
10. Worker 的每次能力调用由 Main 再次校验能力与 scope。
11. 浏览器能力启动可见的独立 Chromium 与临时隔离配置。
12. 步骤、日志、结果和错误实时持久化并发送给 Renderer。
13. Tool result 回传 OpenRouter，模型生成最终回复。
14. `chat_run` 和 `execution` 进入终态。

取消操作同时中止 OpenRouter 流、终止 Worker，并关闭当前执行创建的临时浏览器上下文。

## 7. 权限模型

权限由能力和精确 scope 组成。例如：

```json
{
  "capability": "browser.open",
  "scope": {
    "origins": ["https://www.baidu.com"]
  }
}
```

授权选项：

- 允许本次：只绑定当前 `executionId`。
- 始终允许：绑定工作流 ID、精确版本、能力和规范化 scope。
- 拒绝：当前执行失败，不创建持久授权。

工作流版本变化、权限声明变化、完整性失败或用户主动撤销时，持久授权失效。高风险能力不能通过全局设置无条件放行。

## 8. 本地数据模型

SQLite 使用 Drizzle ORM 和版本化迁移，至少包含：

- `conversations`
- `messages`
- `chat_runs`
- `workflow_projects`
- `installed_workflows`
- `workflow_files`
- `executions`
- `execution_steps`
- `execution_logs`
- `permission_grants`
- `app_settings`
- `encrypted_secrets`
- `schema_migrations`

执行状态为：

- `queued`
- `awaiting_approval`
- `running`
- `completed`
- `failed`
- `cancelled`
- `interrupted`

应用启动时先执行迁移，再创建主窗口。迁移失败时显示恢复窗口。启动恢复会把遗留 `running` 记录标记为 `interrupted`。

## 9. 错误处理与恢复

- OpenRouter 429、5xx 和网络中断执行有限次数退避重试。
- 401、无效请求、Schema 错误和用户取消不重试。
- 流式回答中断时保留已生成文本，标记“生成中断”，并提供重试。
- Worker 崩溃、超时或协议非法时终止 Worker 和浏览器上下文，保存失败状态与脱敏日志。
- 文件 Hash 与安装记录不一致时自动禁用工作流。
- IPC 错误统一转换为 `{ code, message, details? }`，不向 Renderer 暴露堆栈、敏感路径或密钥。
- 日志脱敏 `authorization`、API Key、Cookie、Token 和 Manifest 指定的敏感输入。
- OpenRouter Key、工作流或浏览器运行环境不可用时展示真实错误，不回退到演示数据。

## 10. 构建与平台支持

- macOS 和 Windows 共用应用逻辑、数据库 Schema、Worker 协议和工作流格式。
- `safeStorage` 是两平台统一的凭证接口。
- 路径、子进程入口、浏览器资源和 Monaco worker 使用打包后可解析的资源定位方法。
- electron-builder 配置 macOS DMG/ZIP 与 Windows NSIS/portable 目标。
- 浏览器运行资源必须进入打包产物并在首次真实执行前完成可用性检查。
- 代码签名、公证和 Windows 证书配置保留环境变量入口；仓库不包含发布私钥。

## 11. 测试策略

### 契约测试

- IPC DTO。
- Manifest Schema。
- Worker JSON Lines 消息。
- 错误码与安全错误转换。

### 单元测试

- 工作流召回与 negative examples。
- 权限 scope 与版本失效。
- 文件 Hash 校验。
- 数据库迁移和启动恢复。
- OpenRouter 流事件转换。
- Chat Run 与 Execution 状态机。

### 组件测试

- 五项导航。
- 会话列表与流式消息块。
- 授权卡片和执行检查器。
- 工作流筛选和完整性状态。
- Monaco 调试工作台。
- 错误、空状态和恢复操作。

### 集成测试

使用本地测试 Provider 和固定工作流夹具验证：

`用户消息 → Tool Call → 授权 → Worker → 宿主能力 → Tool Result → 最终回复`

测试 Provider 只存在于测试入口，不进入生产构建和运行时。

### Electron E2E

- 首次启动和 API Key 设置。
- 创建会话和重启后恢复。
- 示例工作流校验、调试和安装。
- 授权后打开可见自动化窗口。
- 取消生成和取消执行。
- 中断记录的启动恢复。

## 12. 验收标准

- macOS 和 Windows 的应用逻辑与打包配置完整。
- Renderer 无 Node.js、文件系统、数据库或密钥直连能力。
- 用户能够完成“配置 OpenRouter → 聊天 → 匹配百度搜索 → 授权 → 可见浏览器执行 → 最终回复”的真实闭环。
- 用户能够完成“创建工作流 → Monaco 编辑 → 实时校验 → 调试 → 本地安装”的真实闭环。
- 会话、设置、工作流、授权和执行历史重启后可恢复。
- Hash 不匹配的工作流不会执行。
- 取消和失败不会留下运行中的 Worker、浏览器上下文或错误状态。
- 生产运行时不包含 Mock 数据回退。
- lint、类型检查、单元测试、组件测试、集成测试、Electron E2E 和生产构建通过。
- macOS 目录包可以启动；Windows 构建配置可以在 Windows CI 或签名环境产出安装包。

## 13. 交付物

- 完整 workspace 目录与源文件。
- 数据库 Schema 与迁移。
- OpenRouter Provider 与安全凭证设置。
- 工作流 SDK、Manifest Schema 和 Worker 协议。
- 五个桌面页面和工作台式四区布局。
- 百度搜索示例工作流。
- 自动化测试、构建配置、环境变量示例和开发文档。
- 不包含任何发布私钥、真实 API Key 或用户数据。
