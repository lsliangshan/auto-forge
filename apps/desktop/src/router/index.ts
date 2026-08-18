import { createRouter, createWebHashHistory, type NavigationGuard, type RouteRecordRaw } from 'vue-router'
import type { AuthSession } from '@autoforge/shared'
import WorkbenchLayout from '../layouts/WorkbenchLayout.vue'
import ChatView from '../views/ChatView.vue'
import DeveloperView from '../views/DeveloperView.vue'
import ExecutionsView from '../views/ExecutionsView.vue'
import LoginView from '../views/LoginView.vue'
import ProfileView from '../views/ProfileView.vue'
import RegisterView from '../views/RegisterView.vue'
import SettingsView from '../views/SettingsView.vue'
import WorkflowsView from '../views/WorkflowsView.vue'

interface AuthGuardState {
  initialized: boolean
  session: AuthSession | null
  restore(): Promise<void>
}

export function safeRedirect(value: unknown): string {
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') ? value : '/chat'
}

export function createAuthGuard(auth: AuthGuardState): NavigationGuard {
  return async (to) => {
    if (!auth.initialized) await auth.restore()
    if (to.meta.requiresAuth && !auth.session) {
      return { name: 'login', query: { redirect: to.fullPath } }
    }
    if (to.meta.guestOnly && auth.session) return '/chat'
  }
}

export const routes: RouteRecordRaw[] = [
  { path: '/login', name: 'login', component: LoginView, meta: { guestOnly: true } },
  { path: '/register', name: 'register', component: RegisterView, meta: { guestOnly: true } },
  {
    path: '/',
    component: WorkbenchLayout,
    meta: { requiresAuth: true },
    children: [
      { path: '', redirect: '/chat' },
      { path: 'chat', name: 'chat', component: ChatView, meta: { title: '聊天', inspector: true } },
      { path: 'workflows', name: 'workflows', component: WorkflowsView, meta: { title: '工作流', inspector: true } },
      { path: 'developer', name: 'developer', component: DeveloperView, meta: { title: '开发', inspector: true } },
      { path: 'executions', name: 'executions', component: ExecutionsView, meta: { title: '执行记录', inspector: true } },
      { path: 'settings', name: 'settings', component: SettingsView, meta: { title: '设置', inspector: false } },
      { path: 'profile', name: 'profile', component: ProfileView, meta: { title: '个人资料', inspector: false } },
    ],
  },
  { path: '/:pathMatch(.*)*', redirect: '/chat' },
]

export const router = createRouter({
  history: createWebHashHistory(),
  routes,
})
