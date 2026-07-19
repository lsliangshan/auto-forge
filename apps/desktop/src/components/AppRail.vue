<template>
  <nav
    class="app-rail"
    aria-label="主导航"
  >
    <div
      class="app-mark"
      aria-label="AutoForge"
    >
      AF
    </div>
    <RouterLink
      v-for="item in items"
      :key="item.to"
      :to="item.to"
      class="rail-item"
      :aria-label="item.label"
      data-testid="app-nav-item"
    >
      <component
        :is="item.icon"
        :size="18"
        aria-hidden="true"
      />
      <span>{{ item.label }}</span>
    </RouterLink>
  </nav>
</template>

<script setup lang="ts">
import { ChatDotRound, Clock, Operation, Setting, Tools } from '@element-plus/icons-vue'

const items = [
  { to: '/chat', label: '聊天', icon: ChatDotRound },
  { to: '/workflows', label: '工作流', icon: Operation },
  { to: '/developer', label: '开发', icon: Tools },
  { to: '/executions', label: '执行记录', icon: Clock },
  { to: '/settings', label: '设置', icon: Setting },
]
</script>

<style scoped>
.app-rail { z-index: 30; display: flex; width: 52px; min-width: 52px; height: 100%; flex-direction: column; align-items: center; gap: 4px; padding: 8px 4px; color: #c8d0dc; background: var(--af-graphite); }
.app-mark { display: grid; width: 34px; height: 34px; margin-bottom: 10px; place-items: center; border: 1px solid #526073; border-radius: 8px; color: white; font-size: 11px; font-weight: 800; letter-spacing: .08em; }
.rail-item { display: flex; width: 44px; min-height: 62px; flex-direction: column; align-items: center; justify-content: center; gap: 4px; border-radius: 6px; color: inherit; font-size: 9px; line-height: 1.15; text-align: center; text-decoration: none; }
.rail-item:hover { color: white; background: #2c333d; }
.rail-item.router-link-active { color: white; background: #33445f; box-shadow: inset 2px 0 var(--af-cobalt); }
</style>
