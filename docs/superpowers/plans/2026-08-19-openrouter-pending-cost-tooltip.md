# OpenRouter Pending Cost Tooltip Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在待确认费用警示后增加可悬停、可键盘聚焦的问号 Tooltip，解释当前金额未包含这些费用且无需手动确认。

**Architecture:** 只修改现有费用摘要展示层，使用项目已安装的 Element Plus `ElTooltip` 和 `QuestionFilled` 图标。提示内容使用组件内常量，计费数据、回查流程和接口契约保持不变。

**Tech Stack:** Vue 3、TypeScript、Element Plus 2.14、Vitest、Vue Test Utils

## Global Constraints

- Tooltip 固定文案为：“这表示部分 OpenRouter 调用暂未取得准确费用。当前显示的消费金额不包含这些费用，无需手动确认，系统会自动尝试查询。”
- 仅在 `openRouterUnknownCostCount > 0` 时显示警示、问号图标和 Tooltip。
- 同时支持鼠标悬停和键盘聚焦。
- 不修改计费统计、自动回查、数据库或 IPC 逻辑。
- 不新增通用 Tooltip 封装。

---

### Task 1: 待确认费用说明 Tooltip

**Files:**
- Modify: `apps/desktop/tests/components/workbench.test.ts:1057-1115`
- Modify: `apps/desktop/src/components/settings/BillingUsagePanel.vue:103-115,201,247-260,357-363`

**Interfaces:**
- Consumes: `TokenUsagePeriod.openRouterUnknownCostCount: number` 和全局注册的 Element Plus `ElTooltip`。
- Produces: `data-testid="billing-cost-help"` 的可聚焦问号图标；组件内 `pendingCostExplanation: string`。

- [ ] **Step 1: 写入失败的组件测试**

在 `shows exact OpenRouter spend, confirmation state and provider-scoped model rows` 用例中，把现有待确认警示断言扩展为：

```ts
const warning = wrapper.get('[data-testid="billing-cost-warning"]')
expect(warning.text()).toBe('有 2 笔费用待确认')
const help = warning.get('[data-testid="billing-cost-help"]')
expect(help.attributes('tabindex')).toBe('0')
expect(help.attributes('role')).toBe('img')
expect(help.attributes('aria-label')).toBe('查看待确认费用说明')
const tooltip = wrapper.getComponent({ name: 'ElTooltip' })
expect(tooltip.props('trigger')).toEqual(['hover', 'focus'])
expect(tooltip.props('content')).toBe(
  '这表示部分 OpenRouter 调用暂未取得准确费用。当前显示的消费金额不包含这些费用，无需手动确认，系统会自动尝试查询。',
)
```

切换到无待确认费用的周期后补充：

```ts
expect(wrapper.find('[data-testid="billing-cost-warning"]').exists()).toBe(false)
expect(wrapper.find('[data-testid="billing-cost-help"]').exists()).toBe(false)
```

- [ ] **Step 2: 运行单个测试并确认因功能缺失而失败**

Run:

```bash
pnpm --filter @autoforge/desktop exec node scripts/run-vitest-electron.mjs run --config vitest.config.ts tests/components/workbench.test.ts -t "shows exact OpenRouter spend"
```

Expected: FAIL，错误指出找不到 `[data-testid="billing-cost-help"]`。

- [ ] **Step 3: 实现最小 Tooltip 交互**

在 `BillingUsagePanel.vue` 中导入图标：

```ts
import { QuestionFilled, Refresh } from '@element-plus/icons-vue'
```

定义固定文案：

```ts
const pendingCostExplanation = '这表示部分 OpenRouter 调用暂未取得准确费用。当前显示的消费金额不包含这些费用，无需手动确认，系统会自动尝试查询。'
```

在警示文案后加入 Tooltip：

```vue
有 {{ formatTokens(activeUsage.openRouterUnknownCostCount) }} 笔费用待确认
<el-tooltip
  :content="pendingCostExplanation"
  :trigger="['hover', 'focus']"
  placement="top"
>
  <el-icon
    class="billing-cost-help"
    data-testid="billing-cost-help"
    tabindex="0"
    role="img"
    aria-label="查看待确认费用说明"
  >
    <QuestionFilled />
  </el-icon>
</el-tooltip>
```

让警示文案与图标对齐，并为图标提供清晰的焦点样式：

```css
.billing-summary .billing-cost-warning {
  display: flex;
  align-items: center;
  gap: 4px;
  color: var(--af-danger);
}

.billing-cost-help {
  flex: 0 0 auto;
  cursor: help;
  outline-offset: 2px;
}
```

- [ ] **Step 4: 运行目标测试并确认通过**

Run:

```bash
pnpm --filter @autoforge/desktop exec node scripts/run-vitest-electron.mjs run --config vitest.config.ts tests/components/workbench.test.ts -t "shows exact OpenRouter spend"
```

Expected: PASS，目标用例 1 个通过且无失败。

- [ ] **Step 5: 运行完整组件测试与类型检查**

Run:

```bash
pnpm --filter @autoforge/desktop exec node scripts/run-vitest-electron.mjs run --config vitest.config.ts tests/components/workbench.test.ts
pnpm --filter @autoforge/desktop typecheck
```

Expected: 两条命令均以退出码 0 完成，无测试失败、TypeScript 或 Vue 类型错误。

- [ ] **Step 6: 检查差异并提交功能改动**

Run:

```bash
git diff --check -- apps/desktop/src/components/settings/BillingUsagePanel.vue apps/desktop/tests/components/workbench.test.ts
git diff -- apps/desktop/src/components/settings/BillingUsagePanel.vue apps/desktop/tests/components/workbench.test.ts
git add apps/desktop/src/components/settings/BillingUsagePanel.vue apps/desktop/tests/components/workbench.test.ts
git commit -m "feat: explain pending OpenRouter costs"
```

Expected: `git diff --check` 无输出；差异只包含 Tooltip、图标、样式和对应测试；提交成功。
