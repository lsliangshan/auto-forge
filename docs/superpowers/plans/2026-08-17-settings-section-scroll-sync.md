# Settings Section Scroll Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为设置页左侧菜单增加选中态，并让点击菜单与右侧内容滚动始终更新同一个当前模块状态。

**Architecture:** `ContextSidebar.vue` 继续持有八项设置模块映射，并新增唯一的 `activeSettingsSection`。组件在 `settings` 路由中监听 `.workspace-content` 的滚动，根据内容区顶部下方 24px 判定线计算当前模块；点击菜单直接更新同一状态并保留现有平滑滚动。

**Tech Stack:** Vue 3 `<script setup>`、Vue Router 5、TypeScript、Vitest、Vue Test Utils、happy-dom

## Global Constraints

- 初次进入设置页时选中“大模型供应商”。
- 正常滚动时选中最后一个顶部越过内容区顶部下方 24px 判定线的模块。
- 滚动到底部时强制选中“关于 AutoForge”。
- 点击菜单先立即更新选中态，再调用 `scrollIntoView({ behavior: 'smooth', block: 'start' })`。
- 选中按钮必须同时使用 `active` 类和 `aria-current="location"`。
- 进入设置页绑定被动滚动监听，离开设置页或卸载组件时解绑。
- 不引入 `IntersectionObserver`、节流、跨组件状态或事件总线。
- 只修改设置侧栏和现有工作台组件测试，不改右侧模块、设置业务逻辑或路由配置。

---

## File Structure

- `apps/desktop/src/components/ContextSidebar.vue`：保存当前设置模块、渲染选中态、计算滚动位置并管理监听生命周期。
- `apps/desktop/tests/components/workbench.test.ts`：验证初始/点击选中态、手动滚动、底部规则和监听清理。

### Task 1: 设置菜单选中态与滚动同步

**Files:**
- Modify: `apps/desktop/src/components/ContextSidebar.vue:197-329`
- Test: `apps/desktop/tests/components/workbench.test.ts:909-960`

**Interfaces:**
- Consumes: `.workspace-content` 滚动容器，以及现有模块 ID `provider`、`model`、`billing`、`proxy`、`appearance`、`data`、`permissions`、`about`。
- Produces: `SettingsSectionId`、`activeSettingsSection`、`syncActiveSettingsSection()`、`setupSettingsScrollSync()` 和 `detachSettingsScrollSync()`，供组件模板和生命周期使用。

- [x] **Step 1: 编写初始选中与点击选中的失败测试**

在现有设置导航测试后加入：

```ts
it('keeps click selection and accessibility state in sync', async () => {
  const { wrapper } = await mountApp('/settings')
  await vi.waitFor(() => expect(wrapper.find('#proxy').exists()).toBe(true))
  const items = wrapper.findAll('[data-testid="settings-section-nav-item"]')

  expect(items[0]?.classes()).toContain('active')
  expect(items[0]?.attributes('aria-current')).toBe('location')

  const proxySection = wrapper.get('#proxy').element
  proxySection.scrollIntoView = vi.fn()
  const getElementById = vi.spyOn(document, 'getElementById').mockReturnValue(proxySection)
  try {
    await items[3]?.trigger('click')
    expect(items[0]?.classes()).not.toContain('active')
    expect(items[0]?.attributes('aria-current')).toBeUndefined()
    expect(items[3]?.classes()).toContain('active')
    expect(items[3]?.attributes('aria-current')).toBe('location')
  } finally {
    getElementById.mockRestore()
  }
})
```

- [x] **Step 2: 运行初始/点击选中测试并确认失败**

Run:

```bash
pnpm --filter @autoforge/desktop exec node scripts/run-vitest-electron.mjs run --config vitest.config.ts tests/components/workbench.test.ts -t "keeps click selection"
```

Expected: FAIL；第一个按钮尚无 `active` 类和 `aria-current`。

- [x] **Step 3: 编写手动滚动与底部规则的失败测试**

加入：

```ts
it('selects the current section while scrolling and the final section at the bottom', async () => {
  const scrollContainer = document.createElement('div')
  Object.defineProperties(scrollContainer, {
    clientHeight: { configurable: true, value: 400 },
    scrollHeight: { configurable: true, value: 1000 },
  })
  scrollContainer.scrollTop = 100
  scrollContainer.getBoundingClientRect = () => ({ top: 50 } as DOMRect)
  const tops: Record<string, number> = {
    provider: 20, model: 40, billing: 100, proxy: 160,
    appearance: 220, data: 280, permissions: 340, about: 400,
  }
  const sectionElements = Object.fromEntries(Object.entries(tops).map(([id]) => {
    const element = document.createElement('section')
    element.getBoundingClientRect = () => ({ top: tops[id] } as DOMRect)
    return [id, element]
  }))
  const querySelector = vi.spyOn(document, 'querySelector').mockReturnValue(scrollContainer)
  const getElementById = vi.spyOn(document, 'getElementById')
    .mockImplementation((id) => sectionElements[id] ?? null)

  try {
    const { wrapper } = await mountApp('/settings')
    await vi.waitFor(() => expect(wrapper.findAll('[data-testid="settings-section-nav-item"]')[1]?.classes())
      .toContain('active'))

    tops.billing = 70
    scrollContainer.dispatchEvent(new Event('scroll'))
    await wrapper.vm.$nextTick()
    expect(wrapper.findAll('[data-testid="settings-section-nav-item"]')[2]?.classes()).toContain('active')

    scrollContainer.scrollTop = 600
    scrollContainer.dispatchEvent(new Event('scroll'))
    await wrapper.vm.$nextTick()
    expect(wrapper.findAll('[data-testid="settings-section-nav-item"]')[7]?.classes()).toContain('active')
  } finally {
    querySelector.mockRestore()
    getElementById.mockRestore()
  }
})
```

The container top is 50, so the decision line is 74. Initially `model` at 40 is the last section above the line; after moving `billing` to 70 it becomes current. At `scrollTop = 600`, `scrollTop + clientHeight === scrollHeight`, so `about` becomes current.

- [x] **Step 4: 运行滚动同步测试并确认失败**

Run:

```bash
pnpm --filter @autoforge/desktop exec node scripts/run-vitest-electron.mjs run --config vitest.config.ts tests/components/workbench.test.ts -t "selects the current section while scrolling"
```

Expected: FAIL；现有组件没有绑定 `.workspace-content` 的滚动监听，也不会更新 `active` 类。

- [x] **Step 5: 编写监听生命周期的失败测试**

加入：

```ts
it('removes settings scroll listeners on route changes and unmount', async () => {
  const scrollContainer = document.createElement('div')
  const addEventListener = vi.spyOn(scrollContainer, 'addEventListener')
  const removeEventListener = vi.spyOn(scrollContainer, 'removeEventListener')
  const querySelector = vi.spyOn(document, 'querySelector').mockReturnValue(scrollContainer)

  try {
    const { wrapper, router } = await mountApp('/settings')
    await vi.waitFor(() => expect(addEventListener)
      .toHaveBeenCalledWith('scroll', expect.any(Function), { passive: true }))

    await router.push('/chat')
    await wrapper.vm.$nextTick()
    expect(removeEventListener).toHaveBeenCalledWith('scroll', expect.any(Function))

    await router.push('/settings')
    await vi.waitFor(() => expect(addEventListener).toHaveBeenCalledTimes(2))
    wrapper.unmount()
    expect(removeEventListener).toHaveBeenCalledTimes(2)
  } finally {
    querySelector.mockRestore()
  }
})
```

- [x] **Step 6: 运行生命周期测试并确认失败**

Run:

```bash
pnpm --filter @autoforge/desktop exec node scripts/run-vitest-electron.mjs run --config vitest.config.ts tests/components/workbench.test.ts -t "removes settings scroll listeners"
```

Expected: FAIL；滚动容器尚未收到 `addEventListener('scroll', ...)`。

- [x] **Step 7: 实现唯一选中状态和模板语义**

给菜单按钮增加：

```vue
:class="{ active: activeSettingsSection === section.id }"
:aria-current="activeSettingsSection === section.id ? 'location' : undefined"
```

在 `settingsSections` 后加入类型和状态，并让点击先更新状态：

```ts
type SettingsSectionId = typeof settingsSections[number]['id']
const activeSettingsSection = ref<SettingsSectionId>(settingsSections[0].id)

function scrollToSettingsSection(id: SettingsSectionId) {
  activeSettingsSection.value = id
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}
```

- [x] **Step 8: 实现滚动判定和监听生命周期**

把 Vue import 扩展为：

```ts
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
```

加入：

```ts
let settingsScrollContainer: HTMLElement | null = null

function syncActiveSettingsSection() {
  if (!settingsScrollContainer) return
  const { scrollTop, scrollHeight, clientHeight } = settingsScrollContainer
  if (scrollTop > 0 && scrollTop + clientHeight >= scrollHeight - 1) {
    activeSettingsSection.value = settingsSections[settingsSections.length - 1].id
    return
  }
  const decisionLine = settingsScrollContainer.getBoundingClientRect().top + 24
  let activeId: SettingsSectionId = settingsSections[0].id
  for (const section of settingsSections) {
    const element = document.getElementById(section.id)
    if (!element) continue
    if (element.getBoundingClientRect().top > decisionLine) break
    activeId = section.id
  }
  activeSettingsSection.value = activeId
}

function detachSettingsScrollSync() {
  settingsScrollContainer?.removeEventListener('scroll', syncActiveSettingsSection)
  settingsScrollContainer = null
}

function setupSettingsScrollSync() {
  detachSettingsScrollSync()
  activeSettingsSection.value = settingsSections[0].id
  if (route.name !== 'settings') return
  void nextTick(() => {
    if (route.name !== 'settings') return
    settingsScrollContainer = document.querySelector<HTMLElement>('.workspace-content')
    settingsScrollContainer?.addEventListener('scroll', syncActiveSettingsSection, { passive: true })
    syncActiveSettingsSection()
  })
}
```

在现有生命周期附近调用：

```ts
onMounted(() => {
  if (route.name === 'chat' && !chat.conversations.length && !chat.loading) void chat.loadConversations()
  setupSettingsScrollSync()
})
watch(() => route.name, setupSettingsScrollSync)
onBeforeUnmount(detachSettingsScrollSync)
```

- [x] **Step 9: 增加选中样式**

将菜单状态样式更新为：

```css
.settings-section-link:hover, .settings-section-link.active { color: var(--af-cobalt); background: var(--af-cobalt-soft); }
.settings-section-link.active { font-weight: 650; }
```

- [x] **Step 10: 运行五个设置导航测试并确认通过**

Run:

```bash
pnpm --filter @autoforge/desktop exec node scripts/run-vitest-electron.mjs run --config vitest.config.ts tests/components/workbench.test.ts -t "settings sidebar item|settings section without leaving|click selection|current section while scrolling|settings scroll listeners"
```

Expected: PASS；5 tests passed。

- [x] **Step 11: 运行完整相关验证**

Run:

```bash
pnpm --filter @autoforge/desktop exec node scripts/run-vitest-electron.mjs run --config vitest.config.ts tests/components/workbench.test.ts --testTimeout=10000
pnpm --filter @autoforge/desktop typecheck
pnpm --filter @autoforge/desktop build
git diff --check
```

Expected: 工作台组件测试全部通过，类型检查和构建退出码为 0，差异无空白错误。构建允许依赖包现有的 Rollup `#__PURE__` 注释警告。

- [x] **Step 12: 核对范围并提交**

Run:

```bash
git status --short
git diff -- apps/desktop/src/components/ContextSidebar.vue apps/desktop/tests/components/workbench.test.ts
git add apps/desktop/src/components/ContextSidebar.vue apps/desktop/tests/components/workbench.test.ts docs/superpowers/plans/2026-08-17-settings-section-scroll-sync.md
git commit -m "feat: sync settings navigation selection"
```

Expected: 实现差异仅包含设置侧栏、对应测试和本计划文档，提交成功。
