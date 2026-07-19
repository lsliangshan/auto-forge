<template>
  <section class="settings-page">
    <div
      v-if="settings.error"
      class="af-error"
      role="alert"
    >
      {{ settings.error }}
    </div>
    <div
      v-if="settings.loading"
      class="af-empty"
    >
      正在加载设置…
    </div>
    <template v-else>
      <section
        id="credential"
        class="settings-section"
      >
        <header>
          <div><h2>OpenRouter 凭证</h2><p>密钥由系统安全存储加密，本页面只显示状态。</p></div><span :class="['credential-status', credentialTone]"><i
            class="af-status-dot"
            :class="credentialTone"
          />{{ credentialLabel }}</span>
        </header>
        <div class="settings-form">
          <label for="openrouter-key">替换 API Key</label>
          <div class="inline-control">
            <el-input
              id="openrouter-key"
              v-model="apiKey"
              type="password"
              show-password
              autocomplete="new-password"
              placeholder="输入新的 OpenRouter API Key"
            /><el-button
              type="primary"
              :disabled="!apiKey.trim()"
              :loading="settings.saving"
              data-testid="save-api-key"
              @click="saveApiKey"
            >
              保存凭证
            </el-button>
          </div>
          <small>保存成功后输入框会立即清空；应用不会读取或回显已保存的密钥。</small>
          <el-button
            v-if="settings.credential?.configured"
            type="danger"
            plain
            :disabled="settings.saving"
            @click="clearCredential"
          >
            清除凭证
          </el-button>
        </div>
      </section>

      <section
        id="model"
        class="settings-section"
      >
        <header>
          <div><h2>默认模型</h2><p>模型列表直接来自 OpenRouter。</p></div><el-button
            :icon="Refresh"
            :loading="settings.modelsLoading"
            @click="settings.loadModels"
          >
            刷新模型
          </el-button>
        </header>
        <div class="settings-form">
          <label for="default-model">默认模型</label>
          <el-select
            id="default-model"
            v-model="selectedModel"
            filterable
            placeholder="选择模型"
            :loading="settings.modelsLoading"
            :disabled="!settings.credential?.configured"
            @change="saveModel"
          >
            <el-option
              v-for="model in settings.models"
              :key="model.id"
              :label="model.name"
              :value="model.id"
            >
              <span>{{ model.name }}</span><small class="model-id">{{ model.id }}</small>
            </el-option>
          </el-select>
          <p
            v-if="!settings.credential?.configured"
            class="field-message"
          >
            配置凭证后才能加载模型。
          </p>
          <p
            v-else-if="!settings.modelsLoading && !settings.models.length"
            class="field-message"
          >
            尚未加载模型列表。
          </p>
        </div>
      </section>

      <section
        id="appearance"
        class="settings-section"
      >
        <header><div><h2>外观与行为</h2><p>这些偏好仅保存在本机。</p></div></header>
        <div class="settings-grid">
          <label>主题<el-select
            :model-value="settings.settings?.theme"
            @change="settings.update({ theme: $event })"
          ><el-option
            label="跟随系统"
            value="system"
          /><el-option
            label="浅色"
            value="light"
          /><el-option
            label="深色"
            value="dark"
          /></el-select></label>
          <label>界面语言<el-select
            :model-value="settings.settings?.language"
            @change="settings.update({ language: $event })"
          ><el-option
            label="简体中文"
            value="zh-CN"
          /><el-option
            label="English"
            value="en-US"
          /></el-select></label>
          <label class="switch-row">显示用量成本<el-switch
            :model-value="settings.settings?.showCosts"
            @change="settings.update({ showCosts: Boolean($event) })"
          /></label>
          <label class="switch-row">开发者模式<el-switch
            :model-value="settings.settings?.developerMode"
            @change="settings.update({ developerMode: Boolean($event) })"
          /></label>
        </div>
      </section>

      <section
        id="data"
        class="settings-section danger-zone"
      >
        <header><div><h2>本地数据</h2><p>清理操作不可撤销，不会删除工作流开发项目。</p></div></header>
        <dl><dt>数据目录</dt><dd>{{ settings.settings?.dataDirectory }}</dd><dt>日志目录</dt><dd>{{ settings.settings?.logDirectory }}</dd></dl>
        <div class="danger-actions">
          <el-button @click="confirmClear('conversations')">
            清除会话
          </el-button><el-button @click="confirmClear('executions')">
            清除执行记录
          </el-button><el-button
            type="danger"
            plain
            @click="confirmClear('all')"
          >
            清除会话与执行记录
          </el-button>
        </div>
      </section>
      <section
        id="permissions"
        class="settings-section"
      >
        <header><div><h2>已保存授权</h2><p>始终允许的权限按工作流精确版本保存。</p></div></header>
        <div
          v-if="!settings.grants.length"
          class="field-message"
        >暂无已保存授权。</div>
        <div
          v-else
          class="grant-list"
        >
          <div
            v-for="grant in settings.grants"
            :key="grant.id"
            class="grant-row"
          ><div><strong>{{ grant.workflowId }} · {{ grant.workflowVersion }}</strong><small>{{ grant.capability }}</small><small>{{ formatScope(grant.scope) }}</small></div><el-button
            type="danger"
            text
            :disabled="settings.saving"
            @click="settings.revokeGrant(grant.id)"
          >撤销</el-button></div>
        </div>
      </section>
      <section
        id="about"
        class="settings-section"
      >
        <header><div><h2>关于 AutoForge</h2><p>本地优先的 AI 工作流桌面应用。</p></div></header>
        <dl class="app-info"><dt>版本</dt><dd>{{ settings.appInfo?.version ?? '—' }}</dd><dt>平台</dt><dd>{{ settings.appInfo?.platform === 'darwin' ? 'macOS' : settings.appInfo?.platform === 'win32' ? 'Windows' : '—' }}</dd></dl>
      </section>
    </template>
  </section>
</template>

<script setup lang="ts">
import { Refresh } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { computed, onMounted, ref, watch } from 'vue'
import { useSettingsStore } from '../stores/settings'

const settings = useSettingsStore()
const apiKey = ref('')
const selectedModel = ref('')
const credentialLabel = computed(() => !settings.credential?.configured ? '未配置' : settings.credential.valid ? '已配置并验证' : '已配置，验证失败')
const credentialTone = computed(() => settings.credential?.valid ? 'success' : settings.credential?.configured ? 'warning' : '')
watch(() => settings.settings?.defaultModel, (value) => { selectedModel.value = value ?? '' }, { immediate: true })

onMounted(async () => {
  if (!settings.settings && !settings.loading) await settings.load()
  if (settings.credential?.configured && !settings.models.length) void settings.loadModels()
})
async function saveApiKey() {
  const key = apiKey.value.trim()
  if (!key) return
  try {
    await settings.saveCredential(key)
    apiKey.value = ''
    ElMessage.success('凭证已安全保存')
    void settings.loadModels()
  } catch { /* Store renders the safe error. */ }
}
async function clearCredential() {
  try {
    await ElMessageBox.confirm('清除后将无法继续调用 OpenRouter，确认清除？', '清除凭证', { type: 'warning', confirmButtonText: '确认清除', cancelButtonText: '取消' })
    await settings.clearCredential()
    settings.models = []
  } catch (error) { if (error !== 'cancel' && error !== 'close') return }
}
function saveModel(value: string) { if (value) void settings.update({ defaultModel: value }) }
async function confirmClear(scope: 'conversations' | 'executions' | 'all') {
  try {
    const message = scope === 'all'
      ? '此操作会永久删除本机的会话与执行记录，无法撤销。凭证、设置、授权和工作流将保留。'
      : '此操作会永久删除所选本地数据，无法撤销。'
    await ElMessageBox.confirm(message, '确认清理本地数据', { type: 'warning', confirmButtonText: '确认清理', cancelButtonText: '取消' })
    await settings.clearLocalData(scope)
    ElMessage.success('本地数据已清理')
  } catch (error) { if (error !== 'cancel' && error !== 'close') return }
}
const formatScope = (scope: { origins?: string[]; paths?: string[] }) => JSON.stringify(scope)
</script>

<style scoped>
.settings-page { max-width: 880px; margin: 0 auto; padding: 20px 24px 60px; }.settings-section { scroll-margin-top: 16px; border: 1px solid var(--af-border); padding: 18px; background: var(--af-surface); }.settings-section + .settings-section { margin-top: 14px; }.settings-section header { display: flex; align-items: flex-start; justify-content: space-between; gap: 18px; border-bottom: 1px solid var(--af-border); padding-bottom: 13px; }.settings-section h2 { margin: 0; color: var(--af-graphite); font-size: 15px; }.settings-section header p { margin: 4px 0 0; color: var(--af-text-muted); font-size: 12px; }
.credential-status { display: flex; align-items: center; gap: 7px; white-space: nowrap; color: var(--af-text-muted); font-size: 12px; }.credential-status.success { color: var(--af-success); }.credential-status.warning { color: var(--af-warning); }
.settings-form { display: grid; gap: 8px; padding-top: 14px; }.settings-form > label, .settings-grid > label { color: var(--af-text-muted); font-size: 11px; font-weight: 700; }.inline-control { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; }.settings-form small, .field-message { margin: 0; color: var(--af-text-muted); font-size: 11px; }.settings-form > .el-button { justify-self: start; }
.settings-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px 24px; padding-top: 15px; }.settings-grid label:not(.switch-row) { display: grid; gap: 7px; }.switch-row { display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid var(--af-border); padding: 8px 0; }.model-id { float: right; margin-left: 18px; color: var(--af-text-muted); }
.danger-zone { border-color: #efc6c2; }.danger-zone dl { display: grid; grid-template-columns: 76px minmax(0, 1fr); gap: 7px 12px; font-size: 12px; }.danger-zone dt { color: var(--af-text-muted); }.danger-zone dd { margin: 0; overflow-wrap: anywhere; }.danger-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 15px; }
.grant-list { margin-top: 12px; }.grant-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; border-bottom: 1px solid var(--af-border); padding: 10px 0; }.grant-row div { display: grid; gap: 3px; }.grant-row strong { font-size: 12px; }.grant-row small { color: var(--af-text-muted); font-family: ui-monospace, monospace; font-size: 11px; }.app-info { display: grid; grid-template-columns: 60px 1fr; gap: 8px 12px; margin: 14px 0 0; font-size: 12px; }.app-info dt { color: var(--af-text-muted); }.app-info dd { margin: 0; }
</style>
