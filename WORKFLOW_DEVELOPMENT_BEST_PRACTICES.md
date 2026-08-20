# AutoForge 工作流开发最佳实践

## 结论

这个项目的工作流体系已经形成了完整的本地闭环：

```text
创建/导入项目
    ↓
编辑 workflow.json + src/index.ts
    ↓
Manifest 校验 + TypeScript/esbuild 校验
    ↓
构建 dist/index.js + 写入 SHA-256
    ↓
开发态调试运行
    ↓
按 id@version 本地安装
    ↓
启用并参与聊天召回
    ↓
权限审批 → 隔离 Worker → 能力调用 → 执行记录
```

但要特别区分两个概念：

- 当前“工作流发布”实际是“发布到本机 AutoForge”，即本地安装。
- 当前没有工作流市场、远程 Registry、上传服务、定时任务/Cron、Webhook 调度或签名工作流包。
- 桌面应用本身也只有目录包构建能力，还不是完整的安装器/自动发布流水线。

因此，最小可验证结论是：项目已经具备较成熟的“本地开发—调试—安装—智能调用”体系，但还不是工作流分发平台或定时调度平台。

## 一、项目中的核心模块边界

| 模块 | 职责 |
|---|---|
| `workflow-schema` | 定义并校验 `workflow.json` 契约 |
| `workflow-sdk` | 向工作流暴露 `defineWorkflow`、`browser`、`logger` |
| `project-service` | 创建、导入、读写、校验、构建、安装项目 |
| `registry` | 管理开发态和安装态工作流，校验完整性 |
| `retriever` | 根据用户消息召回工作流 |
| `agent-orchestrator` | 将工作流转换成模型 Tool，负责审批和执行编排 |
| `execution-service` | 启动 Worker、超时、取消、日志、权限二次校验 |
| `workflow-runner` | 在隔离 VM 中加载并运行最终 JS |

信任边界设计比较合理：Renderer 不直接读文件或执行代码，Electron Main 是可信编排层，工作流在独立子进程和 VM 中执行，只能通过受控能力访问浏览器。

## 二、创建工作流

### 1. 推荐入口：开发工作台创建

应用会根据名称生成：

```text
<userData>/workflow-projects/<workflow-id>/
├── workflow.json
└── src/
    └── index.ts
```

创建逻辑位于 `apps/desktop/electron/main/application.ts` 和 `apps/desktop/electron/main/workflows/project-service.ts`。

默认值包括：

- ID：`local.autoforge.<slug>`
- 版本：`0.1.0`
- 超时：30 秒
- 权限：空
- 输入 Schema：允许任意附加字段
- `codeSha256`：占位值，构建时自动更新

应用数据位置：

- 开发项目：`<userData>/workflow-projects`
- 安装工作流：`<userData>/installed-workflows`
- 元数据和执行记录：`<userData>/autoforge.sqlite`

### 2. 外部项目导入

导入目录至少必须包含：

```text
my-workflow/
├── workflow.json
└── src/
    └── index.ts
```

注册时会：

1. 解析并校验 `workflow.json`。
2. 解析真实路径，拒绝越界和符号链接逃逸。
3. 确认 `src/index.ts` 是真实文件。
4. 将项目路径登记到 SQLite。

`package.json`、`manifest.json`、测试文件不是导入硬性要求。示例中的 `manifest.json` 是示例构建脚本使用的副本，不是运行时标准入口；运行时以 `workflow.json` 为准。

### 3. Manifest 最佳实践

完整契约见 `packages/workflow-schema/manifest.schema.json`。

建议：

- `id` 发布后保持不变，使用反向域名式命名，例如 `com.company.browser.search`。
- 每次行为、权限或契约变化都更新 SemVer。
- `description` 写清“做什么”，不要写实现细节。
- `inputSchema` 和 `outputSchema` 都使用明确对象结构。
- 输入对象推荐 `additionalProperties: false`，避免模型生成未声明字段。
- `activationExamples` 写用户真的会输入的完整句子。
- `activationNegativeExamples` 写容易误召回的完整句子。
- `permissions` 只声明实际使用的能力及最小域名范围。
- `codeSha256`、`entryPath` 视为构建生成字段，不要手工维护。
- `timeoutMs` 按真实执行时长设定，Schema 允许 1 秒到 5 分钟。

当前召回器对正负样例使用“完整短语相等”，不是模糊语义匹配，所以这类配置更有效：

```json
{
  "activationExamples": [
    "用百度搜索今日天气",
    "百度一下 AutoForge",
    "在百度查找上海景点"
  ],
  "activationNegativeExamples": [
    "用谷歌搜索今日天气",
    "读取本地天气文件"
  ]
}
```

## 三、开发工作流

### 1. 工作流代码契约

当前 SDK 很小，只提供：

- `ctx.browser`
- `ctx.logger`

推荐代码结构：

```ts
import { defineWorkflow } from '@autoforge/workflow-sdk'

interface Input {
  keyword: string
}

interface Output {
  success: true
  url: string
}

export default defineWorkflow<Input, Output>({
  async run(ctx, input) {
    if (!input || typeof input.keyword !== 'string' || !input.keyword.trim()) {
      throw new Error('keyword must be a non-empty string')
    }

    await ctx.browser.open('https://www.baidu.com')
    await ctx.browser.fill('role=textbox', input.keyword.trim())
    await ctx.browser.click('role=button[name="百度一下"]')

    return {
      success: true,
      url: await ctx.browser.url(),
    }
  },
})
```

完整参考是 `examples/browser-search-baidu/src/index.ts`。

### 2. 推荐编码原则

- 即使主进程已经按 `inputSchema` 校验，工作流入口仍做关键业务校验。
- 浏览器定位器优先使用 `role` 和可访问名称，不依赖易变 CSS 层级。
- 每一步等待宿主能力 Promise，避免“点击后立即返回”的竞态。
- 日志记录阶段和业务结果，不记录 Cookie、Token、密码和完整敏感输入。
- 不直接使用 Node 文件系统、网络、进程或环境变量。
- 对失败抛出明确、稳定的错误，不用返回 `{ success: false }` 混淆成功终态。
- 保持 `run()` 单一职责；当前没有原生子工作流编排能力。

虽然 Manifest Schema 列出了网络、文件、剪贴板、通知等能力，但当前 SDK 和 Worker 实际只暴露浏览器与日志。因此现阶段只应开发浏览器类工作流；不能因为 Manifest 校验通过就假定其他能力已经可用。

### 3. 构建行为

构建由应用内置 esbuild 完成，规则是：

- 输入：`src/index.ts`
- 输出：`dist/index.js`
- 格式：ESM
- 平台：browser
- Target：ES2022
- 只外部化 `@autoforge/workflow-sdk`
- 自动计算产物 SHA-256
- 自动回写 `workflow.json`

构建后的项目至少是：

```text
my-workflow/
├── workflow.json
├── src/index.ts
└── dist/index.js
```

任何源码或 Manifest 改动后都应重新构建，因为 Registry 会同时验证：

- `dist/index.js` 是否匹配 `codeSha256`
- 当前源码和 Manifest 是否匹配最近一次 `buildHash`

## 四、本地调度与调试

### 1. 显式调试运行

开发工作台的“运行”实际上执行：

```text
保存所有编辑
→ 构建
→ 刷新构建后的 Manifest
→ 再次校验 Manifest
→ AJV 校验输入
→ 绑定当前开发项目
→ 启动 Execution
```

调试运行使用明确的开发项目选择器，所以即使本机已经安装了同 ID、同版本工作流，也会运行当前选中的开发项目，不会误调度到安装副本。

### 2. 聊天自动调度

聊天入口不是定时调度，而是自然语言 Tool 调度：

1. 获取已启用且完整性通过的工作流。
2. 开发者模式开启时加入构建有效的开发版本。
3. 按名称、正向样例、描述、类别、负向样例评分。
4. 最多向模型暴露 8 个候选工作流。
5. 模型生成 Tool Call。
6. AJV 校验 Tool 参数。
7. 检查权限。
8. 执行工作流。
9. 将结果回传给模型生成最终回复。

当前没有：

- Cron/定时任务
- Webhook 触发
- 事件总线触发
- 持久任务队列
- 自动重试策略
- DAG/多节点工作流
- 并发数或资源配额配置

如果“本地调度”指周期性自动运行，这部分需要作为新模块设计，不能直接复用当前聊天召回逻辑。

### 3. 执行隔离

每次执行都会：

- 创建独立临时目录。
- 启动独立子进程。
- 传入极少量环境变量。
- 以 `vm.SourceTextModule` 加载产物。
- 禁止字符串代码生成和 WASM。
- 除 Workflow SDK 外拒绝其他运行时 import。
- 设置 Manifest 超时。
- 记录状态、日志、步骤、结果。
- 取消或失败时终止 Worker 并清理浏览器上下文。

权限还有第二道运行时检查：Worker 每次请求能力时，Execution Service 都会确认该能力与 scope 精确存在于 Manifest 中。

## 五、本地发布/安装

当前发布流程是：

```text
注册项目
→ 构建
→ 校验
→ 检查源码构建指纹
→ 检查产物 SHA-256
→ 创建 id/version 安装目录
→ 复制 workflow.json 和 dist/index.js
→ SQLite 登记
→ 默认启用
```

重要规则：

- 安装身份是精确的 `id@version`。
- 同一版本绝不覆盖，重复安装会返回冲突。
- 更新工作流时应先提升版本号。
- 安装只复制 Manifest 和构建产物，不复制源码。
- 安装后发现文件 Hash 改变，会自动标记完整性失败并禁用。
- 移除安装版本不会删除开发项目。
- 持久授权绑定精确版本；升级版本后需要重新授权，这是正确的安全行为。

在当前实现下，建议同一个工作流 ID 同时只启用一个版本。虽然存储允许多版本并存，但模型 Tool 名称只有工作流 ID；多个启用版本可能产生候选和 Tool 名冲突。

## 六、推荐的日常开发命令

项目要求 Node `>=22.12.0 <27`、pnpm `11.15.0`。

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm dev
```

提交前建议依次运行：

```bash
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
```

如果 E2E 基础设施补齐，再加入：

```bash
corepack pnpm test:e2e
```

生成桌面目录包：

```bash
corepack pnpm dist:dir
```

当前应从仓库根目录运行测试。直接在 `workflow-sdk`、`workflow-schema` 或示例子包执行 `pnpm test`，会因为根 Vitest 配置中的相对路径按子包目录解析而启动失败；这是测试入口配置问题，不是测试断言失败。

## 七、正式发布前的推荐门禁

建议把工作流发布门禁固定为：

1. `id` 稳定、版本已提升。
2. Manifest Schema 通过。
3. 输入、输出 Schema 明确。
4. 权限经过人工最小化审查。
5. 单元测试覆盖成功、无效输入和宿主能力调用顺序。
6. 构建可重复，产物 Hash 与 Manifest 一致。
7. 限制 Worker 中可正常加载。
8. 调试输入真实执行通过。
9. 权限允许、拒绝、取消、超时路径通过。
10. 本地安装后通过聊天实际召回一次。
11. 完整性破坏时能自动禁用。
12. 只保留一个启用版本。

示例测试 `examples/browser-search-baidu/src/index.test.ts` 已经较好地展示了这套模式。

## 八、当前主要缺口和建议优先级

### P0：发布前应补齐

- `outputSchema` 当前被保存和展示，但执行结果没有运行时校验。工作流返回错误结构仍可能进入 `completed`。
- Schema 声明的能力多于 SDK 实际能力，应统一契约，或把未实现能力从公开 Schema 移除。
- 多版本同时启用的工作流 Tool 名冲突需要明确仲裁策略。
- 缺少 CI 工作流、README、开发文档和工作流发布文档。
- `test:e2e` 脚本存在，但当前仓库没有 Playwright 配置和 E2E 用例。
- 子包独立测试入口需要修复。

### P1：准备团队开发时补齐

- 增加标准工作流模板或 CLI scaffold。
- 增加 `workflow validate/build/test/pack/install` CLI。
- 只保留一个 Manifest 源文件，避免示例中的 `manifest.json` 和 `workflow.json` 漂移。
- 增加安装前权限变化对比。
- 增加同 ID 版本升级、回滚和授权迁移策略。
- 为执行日志定义结构化字段和敏感输入路径。

### P2：如果目标是真正的“调度与发布平台”

- 定义 Cron、Webhook、手动、聊天四种 Trigger。
- 增加持久任务队列、并发限制、重试、幂等键和失败补偿。
- 设计签名工作流包及可信发布者。
- 建立远程 Registry、上传、审核、下载和撤回协议。
- 桌面应用增加 DMG/ZIP、NSIS/portable 目标、签名、公证、版本发布和自动更新。

当前 `apps/desktop/electron-builder.yml` 只配置了图标、文件和额外资源；`dist:dir` 也只生成未安装目录包，不能视为完整公开发布流程。

## 九、本次分析验证结果

- Workflow Project、Registry、Execution、Retriever、Agent 集成定向测试：`70/70` 通过。
- Manifest Schema、Workflow SDK、百度示例及受限 Runner 测试：`13/13` 通过。
- 子包独立 `pnpm test` 存在 Vitest 相对路径启动问题，已与工作流逻辑测试失败明确区分。

