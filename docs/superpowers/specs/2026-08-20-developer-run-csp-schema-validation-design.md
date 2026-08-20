# 开发页运行时 Schema 误报修复设计

## 问题与目标

新建项目生成的 `workflow.json` 包含合法的对象型 `inputSchema`，但开发页点击“运行”后提示“输入 Schema 无效”。目标是在不放宽渲染进程安全策略的前提下，让未修改的新建项目可以进入现有构建与运行流程，同时保留主进程对调试输入的权威校验。

## 已证实原因

开发页的 Pinia store 在渲染进程中使用 Ajv 动态编译 `inputSchema`。页面 CSP 的 `script-src 'self'` 不允许 Ajv 所需的运行时代码生成，异常随后被统一转换为“输入 Schema 无效”。同一份输入在主进程的 `developer.run` 中已经使用 Ajv 再次校验，因此渲染层校验既重复又无法在当前安全策略下可靠执行。

## 方案选择

采用最小方案：删除 `runDebug` 中渲染层的 Ajv Schema 编译及输入校验，继续由现有 `developer.run({ projectId, input })` 在主进程构建完成后执行权威校验。

不采用以下方案：

- 不在 CSP 中增加 `unsafe-eval`，避免削弱整个渲染进程的安全边界。
- 不引入新的 JSON Schema 校验库，避免为重复校验增加依赖和兼容性风险。
- 不新增 IPC 校验接口，因为当前缺陷只要求恢复新建项目的运行路径，主进程已有完整校验入口。

## 层级、数据流与契约

- 展示层和调试输入编辑逻辑不变，仍负责 JSON 草稿语法检查。
- 交互层 `runDebug` 继续快照输入、保存文件、构建、校验项目并发起运行，但不再解释 JSON Schema。
- 主进程 `developer.run` 仍是调试输入 Schema 校验的权威边界；输入和返回结构均不变化。
- 非法输入由现有桌面 API 错误路径返回，不扩大可接受输入范围。

本方案不修改 DTO、IPC 通道、Service、Repository、DataSource、数据库或权限配置，也不影响旧接口兼容性。

## 最小改动范围

- `apps/desktop/src/stores/developer.ts`：删除 Ajv 导入和运行前重复校验块。
- `apps/desktop/tests/components/developer.test.ts`：增加启用 CSP 等价限制时，合法默认 Schema 仍会发起运行的回归测试。

## 验证与风险

回归测试会在禁止动态函数构造的环境中执行真实 `runDebug` 路径：修复前应出现原报错且不会构建，修复后应调用主进程运行 API。随后执行开发页单测、桌面端类型检查、lint 和构建，并尽可能在 Electron 页面复测“新建项目 → 运行”。

主要风险是渲染层不再展示 Ajv 生成的逐字段错误文本。该风险受限于调试运行路径：主进程仍拒绝非法输入，JSON 草稿语法错误仍会在页面中立即阻止运行。若后续需要即时、结构化的 Schema 错误，应单独设计主进程校验接口，而不是放宽 CSP。
