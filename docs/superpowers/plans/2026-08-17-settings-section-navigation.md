# Settings Section Navigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让设置页左侧菜单完整对应右侧八个模块，并在点击时平滑滚动到模块且不离开 `/settings`。

**Architecture:** 保留 `SettingsView.vue` 和 `BillingUsagePanel.vue` 已有模块 ID，在 `ContextSidebar.vue` 内用一个静态映射同时生成菜单文本和滚动目标。菜单改用普通按钮，点击后直接查找目标元素并调用 `scrollIntoView`，完全绕开 Hash 路由。

**Tech Stack:** Vue 3 `<script setup>`、Vue Router 5、TypeScript、Vitest、Vue Test Utils、happy-dom

## Global Constraints

- 菜单顺序必须是：大模型供应商、默认模型、Token 账单、VPN 代理、外观与行为、本地数据、已保存授权、关于 AutoForge。
- 点击菜单不得修改 URL 或触发 Vue Router 导航。
- 滚动参数固定为 `{ behavior: 'smooth', block: 'start' }`。
- 不增加滚动监听、当前模块高亮、路由查询参数或跨组件状态。
- 目标模块尚未渲染时保持无操作，不显示错误。
- 只修改设置侧栏组件及现有工作台组件测试，不改设置业务逻辑和路由配置。

---

## File Structure

- `apps/desktop/src/components/ContextSidebar.vue`：维护设置模块菜单映射、渲染设置菜单按钮、执行模块内滚动。
- `apps/desktop/tests/components/workbench.test.ts`：验证菜单与右侧模块的对应关系，以及点击滚动时路由保持不变。

### Task 1: 设置模块菜单与页内滚动

**Files:**
- Modify: `apps/desktop/src/components/ContextSidebar.vue:196-205,229-247,294-310`
- Test: `apps/desktop/tests/components/workbench.test.ts`

**Interfaces:**
- Consumes: `SettingsView.vue` 和 `BillingUsagePanel.vue` 已存在的元素 ID：`provider`、`model`、`billing`、`proxy`、`appearance`、`data`、`permissions`、`about`。
- Produces: `settingsSections: readonly { id: string; label: string }[]` 和 `scrollToSettingsSection(id: string): void`，供 `ContextSidebar.vue` 模板生成按钮并处理点击。

- [ ] **Step 1: 编写菜单一一对应的失败测试**

在 `workbench` 测试组中加入：

```ts
it('matches every settings sidebar item to the rendered section order', async () => {
  const { wrapper } = await mountApp('/settings')
  await vi.waitFor(() => expect(wrapper.find('#about').exists()).toBe(true))

  const menuLabels = wrapper.findAll('[data-testid="settings-section-nav-item"]')
    .map((item) => item.text())
  const sectionLabels = wrapper.findAll('.settings-page .settings-section h2')
    .map((heading) => heading.text())

  expect(menuLabels).toEqual([
    '大模型供应商',
    '默认模型',
    'Token 账单',
    'VPN 代理',
    '外观与行为',
    '本地数据',
    '已保存授权',
    '关于 AutoForge',
  ])
  expect(menuLabels).toEqual(sectionLabels)
})
```

- [ ] **Step 2: 运行测试并确认因菜单按钮尚不存在而失败**

Run:

```bash
pnpm --filter @autoforge/desktop exec node scripts/run-vitest-electron.mjs run --config vitest.config.ts tests/components/workbench.test.ts -t "matches every settings sidebar item"
```

Expected: FAIL；`menuLabels` 为 `[]`，与八项期望不一致。

- [ ] **Step 3: 编写滚动且不导航的失败测试**

在同一测试组中加入：

```ts
it('scrolls to a settings section without leaving the settings route', async () => {
  const { wrapper, router } = await mountApp('/settings')
  await vi.waitFor(() => expect(wrapper.find('#proxy').exists()).toBe(true))
  const scrollIntoView = vi.fn()
  wrapper.get('#proxy').element.scrollIntoView = scrollIntoView

  const proxyButton = wrapper.findAll('[data-testid="settings-section-nav-item"]')
    .find((item) => item.text() === 'VPN 代理')
  expect(proxyButton).toBeDefined()
  await proxyButton?.trigger('click')

  expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' })
  expect(router.currentRoute.value.fullPath).toBe('/settings')
})
```

- [ ] **Step 4: 运行测试并确认因设置菜单按钮尚不存在而失败**

Run:

```bash
pnpm --filter @autoforge/desktop exec node scripts/run-vitest-electron.mjs run --config vitest.config.ts tests/components/workbench.test.ts -t "scrolls to a settings section"
```

Expected: FAIL；找不到文本为“VPN 代理”的 `settings-section-nav-item`，滚动函数未被调用。

- [ ] **Step 5: 实现静态映射和最小滚动函数**

在 `ContextSidebar.vue` 的设置模板中用按钮替换六个锚点：

```vue
<button
  v-for="section in settingsSections"
  :key="section.id"
  class="settings-section-link"
  type="button"
  data-testid="settings-section-nav-item"
  @click="scrollToSettingsSection(section.id)"
>
  {{ section.label }}
</button>
```

在 `<script setup>` 的状态定义区域加入：

```ts
const settingsSections = [
  { id: 'provider', label: '大模型供应商' },
  { id: 'model', label: '默认模型' },
  { id: 'billing', label: 'Token 账单' },
  { id: 'proxy', label: 'VPN 代理' },
  { id: 'appearance', label: '外观与行为' },
  { id: 'data', label: '本地数据' },
  { id: 'permissions', label: '已保存授权' },
  { id: 'about', label: '关于 AutoForge' },
] as const

function scrollToSettingsSection(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}
```

将原有 `a` 样式替换为保持现有视觉效果的按钮样式：

```css
.settings-section-link { width: 100%; border: 0; border-radius: 5px; padding: 8px 9px; color: var(--af-text); background: transparent; font: inherit; font-size: 13px; cursor: pointer; text-align: left; }
.settings-section-link:hover { color: var(--af-cobalt); background: var(--af-cobalt-soft); }
```

- [ ] **Step 6: 运行两个针对性测试并确认通过**

Run:

```bash
pnpm --filter @autoforge/desktop exec node scripts/run-vitest-electron.mjs run --config vitest.config.ts tests/components/workbench.test.ts -t "settings sidebar item|scrolls to a settings section"
```

Expected: PASS；2 tests passed。

- [ ] **Step 7: 运行工作台组件测试和桌面端类型检查**

Run:

```bash
pnpm --filter @autoforge/desktop exec node scripts/run-vitest-electron.mjs run --config vitest.config.ts tests/components/workbench.test.ts
pnpm --filter @autoforge/desktop typecheck
git diff --check
```

Expected: 所有命令退出码为 0；组件测试无失败，类型检查无错误，差异无空白问题。

- [ ] **Step 8: 核对范围并提交实现**

Run:

```bash
git status --short
git diff -- apps/desktop/src/components/ContextSidebar.vue apps/desktop/tests/components/workbench.test.ts
git add apps/desktop/src/components/ContextSidebar.vue apps/desktop/tests/components/workbench.test.ts docs/superpowers/plans/2026-08-17-settings-section-navigation.md
git commit -m "fix: keep settings section navigation in page"
```

Expected: 实现差异只涉及侧栏菜单、对应测试和本计划文档；提交成功。
