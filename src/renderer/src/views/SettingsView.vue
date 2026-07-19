<template>
  <div class="page settings-page">
    <section class="settings-intro"><span class="eyebrow">PREFERENCES</span><h1>设置</h1><p>管理 AutoForge 的外观、下载位置和开发服务。</p></section>

    <div v-if="loading" class="loading-stack"><el-skeleton :rows="6" animated /></div>
    <div v-else class="settings-surface">
      <section class="setting-section">
        <div class="setting-copy"><span class="setting-icon"><Brush /></span><div><h2>外观</h2><p>选择应用的显示主题。</p></div></div>
        <el-segmented v-model="settings.theme" :options="themeOptions" @change="saveTheme" />
      </section>

      <section class="setting-section">
        <div class="setting-copy"><span class="setting-icon"><FolderOpened /></span><div><h2>下载目录</h2><p>最近选择的工具模板保存位置。</p></div></div>
        <div class="path-value">{{ settings.downloadDirectory || '尚未选择' }}</div>
      </section>

      <section class="setting-section setting-section--template">
        <div class="setting-copy"><span class="setting-icon setting-icon--blue"><Connection /></span><div><h2>开发模式 API</h2><p>本地开发默认连接 127.0.0.1:4310；正式构建由环境变量固定为 HTTPS 地址。</p></div></div>
        <div class="api-setting"><el-input v-model="settings.apiBaseUrl" placeholder="http://127.0.0.1:4310" /><el-button type="primary" @click="saveApi">保存</el-button></div>
      </section>

      <section class="setting-section">
        <div class="setting-copy"><span class="setting-icon"><InfoFilled /></span><div><h2>关于 AutoForge</h2><p>版本 0.1.0 · Electron + Vue 3</p></div></div>
        <el-button link type="primary">查看开源许可</el-button>
      </section>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { Brush, Connection, FolderOpened, InfoFilled } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import type { AppSettings, ThemePreference } from '../../../shared/contracts'
import { getDesktopApi } from '../services/desktop-api'

const loading = ref(true)
const settings = reactive<AppSettings>({ theme: 'light', downloadDirectory: '', apiBaseUrl: 'http://127.0.0.1:4310' })
const themeOptions = [
  { label: '浅色', value: 'light' },
  { label: '深色', value: 'dark' },
  { label: '跟随系统', value: 'system' }
]

function applyTheme(theme: ThemePreference) {
  document.documentElement.dataset.theme = theme
}

async function saveTheme(value: string | number | boolean) {
  const theme = value as ThemePreference
  try {
    Object.assign(settings, await getDesktopApi().updateSettings({ theme }))
    applyTheme(theme)
  } catch {
    ElMessage.error('主题设置保存失败。')
  }
}

async function saveApi() { try { Object.assign(settings, await getDesktopApi().updateSettings({ apiBaseUrl: settings.apiBaseUrl })); ElMessage.success('API 地址已保存') } catch (error) { ElMessage.error(error instanceof Error ? error.message : 'API 地址保存失败') } }

onMounted(async () => {
  try {
    Object.assign(settings, await getDesktopApi().getSettings())
    applyTheme(settings.theme)
  } catch {
    ElMessage.error('设置加载失败。')
  } finally {
    loading.value = false
  }
})
</script>
