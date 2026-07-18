import { createRouter, createWebHashHistory } from 'vue-router'
import DiscoverView from '../views/DiscoverView.vue'
import SettingsView from '../views/SettingsView.vue'

export default createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', name: 'discover', component: DiscoverView },
    { path: '/settings', name: 'settings', component: SettingsView }
  ]
})
