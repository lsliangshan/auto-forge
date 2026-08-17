# OpenRouter 默认模型价格展示 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在设置页选择 OpenRouter 时，让默认模型下拉选项与收起后的已选值同时显示模型输入、输出的美元/百万 Tokens 价格。

**Architecture:** 继续使用现有 `ModelInfo.inputCostPerMillion` 与 `ModelInfo.outputCostPerMillion` 数据，不修改 Main、IPC、Store 或共享契约。`SettingsView.vue` 增加纯展示格式化函数，并把生成的完整标签交给 Element Plus `el-option`，使展开和收起状态共享同一文案。

**Tech Stack:** Vue 3 `<script setup>`、TypeScript 6、Element Plus 2.14、Pinia、Vitest、Vue Test Utils、happy-dom。

## Global Constraints

- 仅 OpenRouter 显示价格；DeepSeek 的模型名称与模型 ID 展示保持不变。
- 价格单位固定为美元/百万 Tokens，文案为 `输入 $x/M · 输出 $y/M`。
- 免费价格显示 `$0/M`；缺失价格显示 `—`，不能把未知价格显示为免费。
- 数字最多显示六位有效数字，并保证极小非零价格不会显示成零。
- 已保存但不在当前目录中的模型显示 `输入 — · 输出 —`。
- 不新增网络请求，不修改 IPC、Store、共享 Schema、设置持久化或模型选择值。
- 只修改与本功能直接相关的设置页和组件测试，不做无关重构或格式化。

---

## File Structure

- Modify: `apps/desktop/tests/components/workbench.test.ts` — 用真实 `ModelInfo` 价格字段验证 OpenRouter 展开、收起、免费、极小非零、缺失价格及 DeepSeek 回归行为。
- Modify: `apps/desktop/src/views/SettingsView.vue` — 格式化模型价格，并在默认模型选择器的展开与收起标签中展示。

共享契约和 Provider 解析已经提供每百万 Tokens 价格，本实现不创建新文件或新抽象。

### Task 1: 在默认模型选择器中显示 OpenRouter 输入输出价格

**Files:**
- Modify: `apps/desktop/tests/components/workbench.test.ts:594-651`
- Modify: `apps/desktop/src/views/SettingsView.vue:104-124,308-352`

**Interfaces:**
- Consumes: `ModelInfo.inputCostPerMillion?: number`、`ModelInfo.outputCostPerMillion?: number`、`settings.activeProvider: ModelProviderId`。
- Produces: `formatModelPrice(price: number | undefined): string`、`modelPriceLabel(model: ModelInfo): string`、`modelSelectLabel(model: ModelInfo): string`，仅供 `SettingsView.vue` 模板使用。

- [ ] **Step 1: 写入失败的组件测试**

在 `renders only the provider-specific default-model slots and marks empty optional slots as unset` 用例中，先确认 DeepSeek 的选项标签不含价格：

```ts
const deepseekOptions = deepseek.wrapper.findAllComponents({ name: 'ElOption' })
expect(deepseekOptions.map((option) => option.props('label'))).toEqual(['deepseek-chat'])
```

将 OpenRouter 模型响应改为包含有价、免费、极小非零、单侧缺失和双侧缺失的模型：

```ts
vi.mocked(openrouterApi.settings.listProviderModels).mockResolvedValue([
  {
    ...modelInfo('text/default', ['text']),
    name: 'Text Default',
    inputCostPerMillion: 0.4,
    outputCostPerMillion: 1.6,
  },
  {
    ...modelInfo('image/usable', ['image']),
    inputCostPerMillion: 0,
    outputCostPerMillion: 0.0000001,
  },
  modelInfo('audio/usable', ['audio']),
  {
    ...modelInfo('video/usable', ['video']),
    inputCostPerMillion: 0.25,
  },
])
```

把该用例末尾的选项标签断言改为：

```ts
expect(optionsFor('text')).toEqual([
  'Text Default · 输入 $0.4/M · 输出 $1.6/M',
])
expect(optionsFor('image')).toEqual([
  'image/usable · 输入 $0/M · 输出 $0.0000001/M',
])
expect(optionsFor('audio')).toEqual([
  'audio/saved-missing（已保存模型） · 输入 — · 输出 —',
  'audio/usable · 输入 — · 输出 —',
])
expect(optionsFor('video')).toEqual([
  'video/usable · 输入 $0.25/M · 输出 —',
])
```

并断言已选文本模型的收起状态使用同一完整标签：

```ts
expect(
  openrouter.wrapper
    .get('[data-testid="default-model-text"] .el-select__placeholder')
    .text(),
).toBe('Text Default · 输入 $0.4/M · 输出 $1.6/M')
```

- [ ] **Step 2: 运行聚焦测试并验证 RED**

从 `apps/desktop` 目录运行：

```bash
node scripts/run-vitest-electron.mjs run --config vitest.config.ts tests/components/workbench.test.ts
```

Expected: FAIL。OpenRouter `ElOption` 的实际 `label` 仍只是模型名称，收起状态也没有价格；DeepSeek 断言应继续通过。

- [ ] **Step 3: 添加最小价格格式化实现**

在 `SettingsView.vue` 的共享类型导入中加入 `ModelInfo`：

```ts
import {
  normalizeProxySettings,
  parseProxyBypassText,
  type ModelInfo,
  type ModelProviderId,
  type ProxySettings,
} from '@autoforge/shared'
```

在 `providerLabel` 附近加入三个局部纯函数：

```ts
const modelPriceNumberFormatter = new Intl.NumberFormat('en-US', {
  maximumSignificantDigits: 6,
})

function formatModelPrice(price: number | undefined): string {
  return price === undefined
    ? '—'
    : `$${modelPriceNumberFormatter.format(price)}/M`
}

function modelPriceLabel(model: ModelInfo): string {
  return `输入 ${formatModelPrice(model.inputCostPerMillion)} · 输出 ${formatModelPrice(model.outputCostPerMillion)}`
}

function modelSelectLabel(model: ModelInfo): string {
  return settings.activeProvider === 'openrouter'
    ? `${model.name} · ${modelPriceLabel(model)}`
    : model.name
}
```

`maximumSignificantDigits: 6` 会保留 `0.0000001` 为非零文本，同时去除整数和常规小数中不必要的尾零。

- [ ] **Step 4: 让展开与收起状态复用完整标签**

将默认模型 `el-option` 改为：

```vue
<el-option
  v-for="model in settings.modelOptionsFor(output)"
  :key="model.id"
  :label="modelSelectLabel(model)"
  :value="model.id"
  :data-output="output"
>
  <span>{{ modelSelectLabel(model) }}</span><small class="model-id">{{ model.id }}</small>
</el-option>
```

Element Plus 使用 `el-option.label` 作为收起后的选中标签，因此同一函数覆盖两种状态；`value` 仍是原始模型 ID。

- [ ] **Step 5: 运行聚焦测试并验证 GREEN**

从 `apps/desktop` 目录运行：

```bash
node scripts/run-vitest-electron.mjs run --config vitest.config.ts tests/components/workbench.test.ts
```

Expected: PASS，`workbench.test.ts` 全部通过且无新增警告。

- [ ] **Step 6: 运行 Desktop 回归验证**

从仓库根目录依次运行：

```bash
pnpm --filter @autoforge/desktop typecheck
pnpm exec eslint apps/desktop/src/views/SettingsView.vue apps/desktop/tests/components/workbench.test.ts
```

再从 `apps/desktop` 目录运行完整 Renderer 组件测试：

```bash
node scripts/run-vitest-electron.mjs run --config vitest.config.ts
```

最后从仓库根目录运行：

```bash
git diff --check
```

Expected: 所有命令退出码均为 `0`；若出现无关旧失败，记录具体命令和失败用例，不修改无关代码。

- [ ] **Step 7: 检查改动范围并提交**

```bash
git status --short
git diff -- apps/desktop/src/views/SettingsView.vue apps/desktop/tests/components/workbench.test.ts
git add apps/desktop/src/views/SettingsView.vue apps/desktop/tests/components/workbench.test.ts
git commit -m "feat: show OpenRouter model prices in settings"
```

Expected: 功能提交只包含上述两个文件，所有改动都能追溯到价格展示或其自动化验证。
