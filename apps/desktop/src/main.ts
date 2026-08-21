import { createApp } from 'vue'
import ElementPlus, { ElMessage } from 'element-plus'
import 'element-plus/dist/index.css'
import { createPinia } from 'pinia'
import App from './App.vue'
import { createAuthGuard, router } from './router'
import { useAuthStore } from './stores/auth'
import './styles/index.css'

async function bootstrap() {
  const app = createApp(App)
  const pinia = createPinia()
  const auth = useAuthStore(pinia)
  router.beforeEach(createAuthGuard(auth, () => { ElMessage.warning('无权访问用户管理') }))
  app.use(pinia).use(router).use(ElementPlus)
  await auth.restore()
  window.addEventListener('focus', () => { void auth.refreshAuthorization() })
  app.mount('#app')
}

void bootstrap()
