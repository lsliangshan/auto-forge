# Developer Run CSP Schema Validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让启用当前严格 CSP 的开发页可以运行未修改的新建项目，同时继续由主进程执行权威的输入 Schema 校验。

**Architecture:** 渲染进程只维护调试输入草稿、保存与运行编排，不再通过 Ajv 动态编译用户 Schema。现有 `developer.run({ projectId, input })` 接口及主进程 Ajv 校验保持不变，因此安全边界、DTO 和 IPC 契约均不变。

**Tech Stack:** Vue 3、Pinia、TypeScript、Vitest、Electron、Ajv 8

## Global Constraints

- 保留 `apps/desktop/index.html` 中 `script-src 'self'`，不得增加 `unsafe-eval`。
- 不新增 JSON Schema 校验依赖。
- 不新增或修改 DTO、IPC 通道及 `DesktopAPI['developer']` 契约。
- JSON 草稿语法错误仍必须在渲染进程立即阻止运行。
- 非法 Schema 输入仍必须由主进程 `developer.run` 拒绝。
- 只修改开发页 store、对应组件测试和本计划中列出的文档，不做相邻重构。

---

### Task 1: 移除 CSP 不兼容的渲染层重复校验

**Files:**
- Modify: `apps/desktop/tests/components/developer.test.ts`
- Modify: `apps/desktop/src/stores/developer.ts:1`
- Modify: `apps/desktop/src/stores/developer.ts:330-345`

**Interfaces:**
- Consumes: 现有 `DesktopAPI['developer']['run']`，签名为 `(input: { projectId: string; input: unknown }) => Promise<{ executionId: string }>`。
- Produces: `useDeveloperStore().runDebug(): Promise<void>` 在禁止动态函数构造时仍把合法输入传给现有 `developer.run`；不产生新接口。

- [ ] **Step 1: 写入能复现严格 CSP 行为的失败测试**

在 `apps/desktop/tests/components/developer.test.ts` 的调试输入测试附近增加：

```ts
it('runs a new project without dynamic code generation in the renderer', async () => {
  const { api, raw } = createApi()
  const manifest = JSON.parse(await raw.developer.readFile('project_1', 'workflow.json')) as Record<string, unknown>
  manifest.inputSchema = { type: 'object', additionalProperties: true }
  raw.developer.readFile.mockImplementation(async (_projectId: string, path: string) => path === 'workflow.json'
    ? JSON.stringify(manifest) : 'export default 1')
  Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
  const store = useDeveloperStore()
  await store.loadProjects()
  await store.selectFile('workflow.json')
  const nativeFunction = globalThis.Function
  Object.defineProperty(globalThis, 'Function', {
    configurable: true,
    writable: true,
    value: function blockedDynamicFunction() { throw new EvalError('Refused by Content Security Policy') },
  })

  try {
    await store.runDebug()
  } finally {
    Object.defineProperty(globalThis, 'Function', { configurable: true, writable: true, value: nativeFunction })
  }

  expect(store.debugError).toBe('')
  expect(raw.developer.run).toHaveBeenCalledWith({ projectId: 'project_1', input: {} })
})
```

- [ ] **Step 2: 运行单个回归测试并确认红灯原因准确**

Run:

```bash
pnpm --dir apps/desktop exec node scripts/run-vitest-electron.mjs run --config vitest.config.ts tests/components/developer.test.ts -t "runs a new project without dynamic code generation in the renderer"
```

Expected: FAIL；`raw.developer.run` 未被调用，且实际 `store.debugError` 为 `输入 Schema 无效，请先修复 workflow.json。`。这证明测试捕获的是截图中的原始症状，而不是测试装配错误。

- [ ] **Step 3: 写入最小生产代码修改**

在 `apps/desktop/src/stores/developer.ts` 中删除渲染进程 Ajv 导入：

```ts
import Ajv, { type AnySchema } from 'ajv'
```

并从 `runDebug` 删除以下完整校验块，使代码从输入快照直接进入 `this.resetDebug()`：

```ts
try {
  const validate = new Ajv({ allErrors: true, strict: false }).compile(manifest.inputSchema as AnySchema)
  if (!validate(input)) {
    this.debugError = `调试输入无效：${validate.errors?.map(({ instancePath, message }) => `${instancePath || '/'} ${message ?? ''}`).join('；')}`
    return
  }
} catch {
  this.debugError = '输入 Schema 无效，请先修复 workflow.json。'
  return
}
```

同时把输入快照代码收窄为只克隆后续实际使用的 `debugInput`：

```ts
let input: unknown
try {
  input = cloneJson(this.debugInput)
} catch {
  this.debugError = '调试输入必须是有效 JSON。'
  return
}
```

入口处的 `!this.currentManifest` 判断保持不变；不改 `developer.run({ projectId, input })` 调用。

- [ ] **Step 4: 运行单个回归测试并确认绿灯**

Run:

```bash
pnpm --dir apps/desktop exec node scripts/run-vitest-electron.mjs run --config vitest.config.ts tests/components/developer.test.ts -t "runs a new project without dynamic code generation in the renderer"
```

Expected: PASS；`developer.run` 收到 `{ projectId: 'project_1', input: {} }`，且 `debugError` 为空。

- [ ] **Step 5: 运行开发页组件测试**

Run:

```bash
pnpm --dir apps/desktop exec node scripts/run-vitest-electron.mjs run --config vitest.config.ts tests/components/developer.test.ts
```

Expected: `apps/desktop/tests/components/developer.test.ts` 全部 PASS，现有 JSON 草稿阻止运行、保存并发和项目切换测试不回归。

- [ ] **Step 6: 运行静态与构建验证**

Run:

```bash
pnpm --filter @autoforge/desktop typecheck
pnpm exec eslint apps/desktop/src/stores/developer.ts apps/desktop/tests/components/developer.test.ts
pnpm build
```

Expected: TypeScript、ESLint 和生产构建全部以退出码 0 完成；不出现由本次改动引入的新警告。

- [ ] **Step 7: 在 Electron 中复测用户流程**

启动桌面应用，执行“开发 → 创建项目 → 不修改任何文件 → 输入保持 `{}` → 运行”。Expected: 不再出现“输入 Schema 无效”，页面进入启动/排队/运行状态；检查 DevTools 控制台没有新增 CSP 或未捕获异常。随后输入非法 JSON 草稿 `{`，Expected: 页面显示“请输入有效 JSON”且不调用运行。

若当前自动化环境无法驱动 Electron 窗口，记录阻塞条件，并以回归测试、生产构建和 CSP 未放宽的静态检查作为已完成验证，不声称已完成桌面交互复测。

- [ ] **Step 8: 提交实现**

```bash
git add apps/desktop/src/stores/developer.ts apps/desktop/tests/components/developer.test.ts
git commit -m "fix: avoid renderer schema compilation under CSP"
```

提交前运行 `git diff --check`，确认提交中不包含 `.pnpm-store/` 或其他用户文件。
