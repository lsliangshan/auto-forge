<template>
  <nav
    class="app-rail"
    aria-label="主导航"
  >
    <div
      class="app-mark"
      aria-label="AutoForge"
    >
      <img
        :src="logoUrl"
        alt=""
        data-testid="app-brand-logo"
      >
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
      <RouterLink
        to="/profile"
        data-testid="profile-entry"
        class="rail-profile-entry"
        aria-label="个人资料"
      >
        <img
          v-if="profile.profile?.avatarUrl"
          class="rail-avatar"
          :src="profile.profile.avatarUrl"
          alt=""
        >
        <span
          v-else
          data-testid="profile-avatar-fallback"
          class="rail-avatar rail-avatar-fallback"
        >{{ accountInitial }}</span>
        <span
          data-testid="current-account"
          class="rail-account-name"
          :title="accountLabel"
        >
          {{ accountLabel }}
        </span>
      </RouterLink>
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
import { ChatDotRound, Clock, Operation, Setting, SwitchButton, Tools, User } from '@element-plus/icons-vue'
import { computed, onMounted, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '../stores/auth'
import { useProfileStore } from '../stores/profile'
import logoUrl from '../../resources/branding/autoforge-logo.png'

const auth = useAuthStore()
const profile = useProfileStore()
const router = useRouter()
const accountLabel = computed(() => profile.profile?.displayName ?? auth.session?.user.account ?? '')
const accountInitial = computed(() => (auth.session?.user.account ?? '?').charAt(0).toUpperCase())

const items = computed(() => [
  { to: '/chat', label: '聊天', icon: ChatDotRound },
  { to: '/workflows', label: '工作流', icon: Operation },
  { to: '/developer', label: '开发', icon: Tools },
  { to: '/executions', label: '执行记录', icon: Clock },
  ...(auth.canManageUsers ? [{ to: '/users', label: '用户管理', icon: User }] : []),
  { to: '/settings', label: '设置', icon: Setting },
])

async function logout() {
  if (await auth.logout()) {
    profile.reset()
    await router.replace('/login')
  }
}

onMounted(() => {
  if (auth.session) void profile.load(auth.session.user.id)
})
watch(() => auth.session?.user.id, (userId) => {
  if (userId) void profile.load(userId)
  else profile.reset()
})
</script>

<style scoped>
.app-rail { z-index: 30; display: flex; width: 52px; min-width: 52px; height: 100%; flex-direction: column; align-items: center; gap: 4px; padding: 8px 4px; color: #c8d0dc; background: var(--af-rail); }
.app-mark { display: grid; width: 34px; height: 34px; margin-bottom: 10px; place-items: center; }
.app-mark img { display: block; width: 32px; height: 32px; object-fit: contain; }
.rail-item { display: flex; width: 44px; min-height: 62px; flex-direction: column; align-items: center; justify-content: center; gap: 4px; border-radius: 6px; color: inherit; font-size: 9px; line-height: 1.15; text-align: center; text-decoration: none; }
.rail-item:hover { color: white; background: #2c333d; }
.rail-item.router-link-active { color: white; background: #33445f; box-shadow: inset 2px 0 var(--af-cobalt); }
.rail-account { position: relative; display: grid; width: 44px; margin-top: auto; justify-items: center; gap: 5px; }
.rail-profile-entry { display: grid; width: 44px; justify-items: center; gap: 4px; color: inherit; text-decoration: none; }
.rail-avatar { display: grid; width: 32px; height: 32px; place-items: center; border: 1px solid #526073; border-radius: 50%; object-fit: cover; }
.rail-avatar-fallback { color: white; background: #33445f; font-size: 12px; font-weight: 750; }
.rail-account-name { width: 44px; overflow: hidden; color: #dce3ed; font-size: 9px; text-align: center; text-overflow: ellipsis; white-space: nowrap; }
.rail-account button { display: grid; width: 34px; height: 34px; place-items: center; border: 0; border-radius: 6px; color: #c8d0dc; background: transparent; cursor: pointer; }
.rail-account button:hover:not(:disabled) { color: white; background: #2c333d; }
.rail-account button:disabled { cursor: wait; opacity: .55; }
.rail-error { position: fixed; bottom: 12px; left: 64px; width: max-content; max-width: 320px; border: 1px solid var(--af-danger-border); border-radius: 7px; padding: 8px 10px; color: var(--af-danger); background: var(--af-danger-soft); font-size: 12px; box-shadow: 0 6px 20px rgb(32 36 43 / 12%); }
</style>
