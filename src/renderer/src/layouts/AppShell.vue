<template>
  <div class="app-shell">
    <header class="titlebar">
      <div class="brand" aria-label="AutoForge">
        <span class="brand-mark"><Promotion /></span>
        <span>AutoForge</span>
      </div>
      <div class="titlebar-spacer" />
      <button class="titlebar-action" type="button" aria-label="帮助"><QuestionFilled /></button>
    </header>

    <aside class="sidebar" aria-label="主导航">
      <nav class="primary-nav">
        <RouterLink
          v-for="item in navigation"
          :key="item.to"
          :to="item.to"
          class="nav-item"
          active-class="nav-item--active"
          data-testid="primary-nav-item"
        >
          <component :is="item.icon" class="nav-icon" />
          <span>{{ item.label }}</span>
        </RouterLink>
      </nav>
      <div class="sidebar-version">AutoForge v0.1.0</div>
    </aside>

    <main class="app-content">
      <RouterView />
    </main>
  </div>
</template>

<script setup lang="ts">
import { Compass, Promotion, QuestionFilled, Setting } from '@element-plus/icons-vue'

const navigation = [
  { label: '发现', to: '/', icon: Compass },
  { label: '设置', to: '/settings', icon: Setting }
]
</script>
