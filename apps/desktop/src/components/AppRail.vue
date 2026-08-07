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
    <div class="rail-account">
      <span
        data-testid="current-account"
        class="rail-account-name"
        :title="auth.session?.user.account"
      >
        {{ auth.session?.user.account }}
      </span>
      <button
        type="button"
        aria-label="退出登录"
        :disabled="auth.submitting"
        @click="logout"
      >
        <el-icon><SwitchButton /></el-icon>
      </button>
      <span
        v-if="auth.error"
        class="rail-error"
        role="alert"
      >{{ auth.error }}</span>
    </div>
  </nav>
</template>

<script setup lang="ts">
import { ChatDotRound, Clock, Operation, Setting, SwitchButton, Tools } from '@element-plus/icons-vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '../stores/auth'

const auth = useAuthStore()
const router = useRouter()

const items = [
  { to: '/chat', label: '聊天', icon: ChatDotRound },
  { to: '/workflows', label: '工作流', icon: Operation },
  { to: '/developer', label: '开发', icon: Tools },
  { to: '/executions', label: '执行记录', icon: Clock },
  { to: '/settings', label: '设置', icon: Setting },
]

async function logout() {
  if (await auth.logout()) await router.replace('/login')
}
</script>

<style scoped>
.app-rail { z-index: 30; display: flex; width: 52px; min-width: 52px; height: 100%; flex-direction: column; align-items: center; gap: 4px; padding: 8px 4px; color: #c8d0dc; background: var(--af-graphite); }
.app-mark { display: grid; width: 34px; height: 34px; margin-bottom: 10px; place-items: center; border: 1px solid #526073; border-radius: 8px; color: white; font-size: 11px; font-weight: 800; letter-spacing: .08em; }
.rail-item { display: flex; width: 44px; min-height: 62px; flex-direction: column; align-items: center; justify-content: center; gap: 4px; border-radius: 6px; color: inherit; font-size: 9px; line-height: 1.15; text-align: center; text-decoration: none; }
.rail-item:hover { color: white; background: #2c333d; }
.rail-item.router-link-active { color: white; background: #33445f; box-shadow: inset 2px 0 var(--af-cobalt); }
.rail-account { position: relative; display: grid; width: 44px; margin-top: auto; justify-items: center; gap: 5px; }
.rail-account-name { width: 44px; overflow: hidden; color: #dce3ed; font-size: 9px; text-align: center; text-overflow: ellipsis; white-space: nowrap; }
.rail-account button { display: grid; width: 34px; height: 34px; place-items: center; border: 0; border-radius: 6px; color: #c8d0dc; background: transparent; cursor: pointer; }
.rail-account button:hover:not(:disabled) { color: white; background: #2c333d; }
.rail-account button:disabled { cursor: wait; opacity: .55; }
.rail-error { position: fixed; bottom: 12px; left: 64px; width: max-content; max-width: 320px; border: 1px solid #f2b8b5; border-radius: 7px; padding: 8px 10px; color: var(--af-danger); background: #fff5f5; font-size: 12px; box-shadow: 0 6px 20px rgb(32 36 43 / 12%); }
</style>
