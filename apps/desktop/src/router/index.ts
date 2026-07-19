import { createRouter, createWebHashHistory, type RouteRecordRaw } from 'vue-router'
import ChatView from '../views/ChatView.vue'
import DeveloperView from '../views/DeveloperView.vue'
import ExecutionsView from '../views/ExecutionsView.vue'
import SettingsView from '../views/SettingsView.vue'
import WorkflowsView from '../views/WorkflowsView.vue'

export const routes: RouteRecordRaw[] = [
  { path: '/', redirect: '/chat' },
  { path: '/chat', name: 'chat', component: ChatView, meta: { title: '聊天', inspector: true } },
  { path: '/workflows', name: 'workflows', component: WorkflowsView, meta: { title: '工作流', inspector: true } },
  { path: '/developer', name: 'developer', component: DeveloperView, meta: { title: '开发', inspector: true } },
  { path: '/executions', name: 'executions', component: ExecutionsView, meta: { title: '执行记录', inspector: true } },
  { path: '/settings', name: 'settings', component: SettingsView, meta: { title: '设置', inspector: false } },
  { path: '/:pathMatch(.*)*', redirect: '/chat' },
]

export const router = createRouter({
  history: createWebHashHistory(),
  routes,
})
