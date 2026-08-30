<template>
  <nav class="app-rail" aria-label="主导航">
    <div class="app-mark" aria-label="AutoForge">
      <img :src="logoUrl" alt="" data-testid="app-brand-logo" />
    </div>
    <RouterLink
      v-for="item in items"
      :key="item.to"
      :to="item.to"
      class="rail-item"
      :aria-label="item.label"
      data-testid="app-nav-item"
    >
      <el-icon class="rail-item-icon" :size="18" aria-hidden="true">
        <component :is="item.icon" />
      </el-icon>
      <span class="rail-item-label">{{ item.label }}</span>
    </RouterLink>
    <div class="rail-account">
      <div
        class="rail-account-divider"
        data-testid="rail-account-divider"
        aria-hidden="true"
      />
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
        />
        <span
          v-else
          data-testid="profile-avatar-fallback"
          class="rail-avatar rail-avatar-fallback"
          >{{ accountInitial }}</span
        >
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
      <span v-if="auth.error" class="rail-error" role="alert">{{
        auth.error
      }}</span>
    </div>
  </nav>
</template>

<script setup lang="ts">
import {
  ChatDotRound,
  Clock,
  Collection,
  Operation,
  Setting,
  SwitchButton,
  Tools,
  User,
} from "@element-plus/icons-vue";
import { computed, onMounted, watch } from "vue";
import { useRouter } from "vue-router";
import { ElMessageBox } from "element-plus";
import { useAuthStore } from "../stores/auth";
import { useProfileStore } from "../stores/profile";
import logoUrl from "../../resources/branding/autoforge-logo.png";

const auth = useAuthStore();
const profile = useProfileStore();
const router = useRouter();
const accountLabel = computed(
  () => profile.profile?.displayName ?? auth.session?.user.account ?? "",
);
const accountInitial = computed(() =>
  (auth.session?.user.account ?? "?").charAt(0).toUpperCase(),
);

const items = computed(() => [
  { to: "/chat", label: "聊天", icon: ChatDotRound },
  { to: "/knowledge", label: "知识库", icon: Collection },
  { to: "/workflows", label: "工作流", icon: Operation },
  { to: "/developer", label: "开发", icon: Tools },
  { to: "/executions", label: "执行记录", icon: Clock },
  ...(auth.canManageUsers
    ? [{ to: "/users", label: "用户管理", icon: User }]
    : []),
  { to: "/settings", label: "设置", icon: Setting },
]);

async function logout() {
  let loggedOut = await auth.logout();
  if (!loggedOut && auth.pendingLogoutCount > 0) {
    try {
      await ElMessageBox.confirm(
        `仍有 ${auth.pendingLogoutCount} 条本地修改未同步。放弃这些修改并退出登录？`,
        "未同步修改",
        { type: "warning", confirmButtonText: "放弃并退出", cancelButtonText: "继续等待" },
      );
      loggedOut = await auth.logout(true);
    } catch {
      return;
    }
  }
  if (loggedOut) {
    profile.reset();
    await router.replace("/login");
  }
}

onMounted(() => {
  if (auth.session) void profile.load(auth.session.user.id);
});
watch(
  () => auth.session?.user.id,
  (userId) => {
    if (userId) void profile.load(userId);
    else profile.reset();
  },
);
</script>

<style scoped>
.app-rail {
  z-index: 30;
  display: flex;
  width: 64px;
  min-width: 64px;
  height: 100%;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  border-right: 1px solid rgb(255 255 255 / 4%);
  padding: 9px 4px 8px;
  color: #aeb8c7;
  background: #151b25;
}
.app-mark {
  display: grid;
  width: 40px;
  height: 40px;
  margin-bottom: 10px;
  place-items: center;
  border: 1px solid rgb(255 255 255 / 72%);
  border-radius: 6px;
  background: #f8fafc;
  box-shadow: 0 4px 14px rgb(0 0 0 / 18%);
}
.app-mark img {
  display: block;
  width: 28px;
  height: 28px;
  object-fit: contain;
  filter: drop-shadow(0 2px 4px rgb(15 23 42 / 14%));
}
.rail-item {
  position: relative;
  display: flex;
  width: 56px;
  min-height: 60px;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 5px;
  overflow: hidden;
  border-radius: 7px;
  color: inherit;
  font-size: 0.5625rem;
  line-height: 1.15;
  text-align: center;
  text-decoration: none;
  transition:
    color 160ms ease,
    background-color 160ms ease;
}
.rail-item::before {
  position: absolute;
  top: 4px;
  bottom: 4px;
  left: 0;
  width: 2px;
  border-radius: 0 2px 2px 0;
  background: transparent;
  content: "";
  transition: background-color 160ms ease;
}
.rail-item:hover {
  color: #f4f7fb;
  background: #222a36;
}
.rail-item.router-link-active {
  color: white;
  background: #273246;
}
.rail-item.router-link-active::before {
  background: var(--af-cobalt);
}
.rail-item:focus-visible {
  box-shadow:
    inset 0 0 0 1px #7da2f8,
    var(--af-focus);
}
.rail-item-icon {
  width: 18px;
  height: 18px;
  flex: none;
  font-size: 1.125rem;
  filter: drop-shadow(0 1px 1px rgb(0 0 0 / 16%));
}
.rail-item-label {
  max-width: 40px;
  font-weight: 560;
  letter-spacing: 0.01em;
}
.rail-item.router-link-active .rail-item-label {
  font-weight: 680;
}
.rail-account {
  position: relative;
  display: grid;
  width: 56px;
  margin-top: auto;
  justify-items: center;
  gap: 5px;
}
.rail-account-divider {
  width: 30px;
  height: 1px;
  margin: 0 0 7px;
  background: rgb(207 217 232 / 20%);
}
.rail-profile-entry {
  display: grid;
  width: 56px;
  justify-items: center;
  gap: 4px;
  border-radius: 7px;
  padding: 4px 0;
  color: inherit;
  text-decoration: none;
  transition:
    color 160ms ease,
    background-color 160ms ease;
}
.rail-profile-entry:hover,
.rail-profile-entry.router-link-active {
  color: white;
  background: #222a36;
}
.rail-profile-entry:focus-visible {
  box-shadow: var(--af-focus);
}
.rail-avatar {
  display: grid;
  width: 30px;
  height: 30px;
  place-items: center;
  border: 1px solid #536175;
  border-radius: 50%;
  object-fit: cover;
  box-shadow: 0 2px 8px rgb(0 0 0 / 20%);
}
.rail-profile-entry.router-link-active .rail-avatar {
  border-color: #7da2f8;
  box-shadow: 0 0 0 2px rgb(37 99 235 / 20%);
}
.rail-avatar-fallback {
  color: white;
  background: #334158;
  font-size: 0.75rem;
  font-weight: 750;
}
.rail-account-name {
  width: 40px;
  overflow: hidden;
  color: #d7deea;
  font-size: 0.5625rem;
  font-weight: 560;
  text-align: center;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.rail-account button {
  display: grid;
  width: 32px;
  height: 32px;
  place-items: center;
  border: 0;
  border-radius: 7px;
  color: #aeb8c7;
  background: transparent;
  cursor: pointer;
  transition:
    color 160ms ease,
    background-color 160ms ease;
}
.rail-account button:hover:not(:disabled) {
  color: white;
  background: #222a36;
}
.rail-account button:focus-visible {
  box-shadow: var(--af-focus);
}
.rail-account button:disabled {
  cursor: wait;
  opacity: 0.55;
}
.rail-error {
  position: fixed;
  bottom: 12px;
  left: 64px;
  width: max-content;
  max-width: 320px;
  border: 1px solid var(--af-danger-border);
  border-radius: 7px;
  padding: 8px 10px;
  color: var(--af-danger);
  background: var(--af-danger-soft);
  font-size: 0.75rem;
  box-shadow: 0 6px 20px rgb(32 36 43 / 12%);
}
</style>
