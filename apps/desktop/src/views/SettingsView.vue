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
        id="provider"
        class="settings-section"
      >
        <header>
          <div><h2>大模型供应商</h2><p>不同供应商的密钥独立加密保存，本页面只显示当前供应商的状态。</p></div><span :class="['credential-status', credentialTone]"><i
            class="af-status-dot"
            :class="credentialTone"
          />{{ credentialLabel }}</span>
        </header>
        <div class="settings-form">
          <label for="model-provider">供应商</label>
          <el-select
            id="model-provider"
            v-model="selectedProvider"
            data-testid="provider-select"
            :disabled="settings.saving"
            @change="changeProvider"
          >
            <el-option
              label="DeepSeek"
              value="deepseek"
            />
            <el-option
              label="OpenRouter"
              value="openrouter"
            />
          </el-select>
          <label for="provider-api-key">替换 API Key</label>
          <div class="inline-control">
            <el-input
              id="provider-api-key"
              v-model="apiKey"
              type="password"
              show-password
              autocomplete="new-password"
              :placeholder="`输入新的 ${providerLabel} API Key`"
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
          <p
            v-if="settings.credential?.validation === 'denied'"
            class="field-message"
          >
            供应商拒绝了凭证验证请求，请检查模型权限、内容策略或 Guardrail 设置。
          </p>
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
          <div><h2>默认模型</h2><p>模型列表来自当前选择的 {{ providerLabel }}。</p></div><el-button
            :icon="Refresh"
            :loading="settings.modelsLoading"
            :disabled="!settings.credential?.configured"
            @click="settings.loadModels"
          >
            刷新模型
          </el-button>
        </header>
        <div class="settings-form">
          <div
            v-for="output in modelOutputs"
            :key="output"
            class="model-field"
          >
            <label :for="`default-model-${output}`">{{ modelOutputLabels[output] }}</label>
            <el-select
              :id="`default-model-${output}`"
              :data-testid="`default-model-${output}`"
              :model-value="settings.defaultModelFor(output)"
              filterable
              :clearable="settings.activeProvider === 'openrouter'"
              :placeholder="settings.activeProvider === 'openrouter' ? '未设置' : '选择模型'"
              :loading="settings.modelsLoading"
              :disabled="!settings.credential?.configured"
              @change="saveModel(output, $event)"
            >
              <el-option
                v-for="model in settings.modelOptionsFor(output)"
                :key="model.id"
                :label="modelSelectLabel(model)"
                :value="model.id"
                :data-output="output"
              >
                <span>{{ modelSelectLabel(model) }}</span><small class="model-id">{{ model.id }}</small>
              </el-option>
            </el-select>
          </div>
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

      <BillingUsagePanel
        :usage="settings.tokenUsage"
        :remote-usage="settings.remoteUsage"
        :loading="settings.tokenUsageLoading"
        :error="settings.tokenUsageError || settings.remoteUsageError"
        @refresh="refreshUsage"
      />

      <section
        id="proxy"
        class="settings-section"
      >
        <header>
          <div><h2>VPN 代理</h2><p>为 AutoForge 内的网络请求设置本机 VPN 代理。</p></div><span class="proxy-status">{{ proxyStatusLabel }}</span>
        </header>
        <div class="settings-form">
          <label class="switch-row">启用 VPN 代理<el-switch
            v-model="proxyDraft.enabled"
            data-testid="proxy-enabled"
            @change="saveChangedProxyDraft"
          /></label>
          <label for="http-proxy">http_proxy</label>
          <div data-testid="http-proxy">
            <el-input
              id="http-proxy"
              v-model="proxyDraft.httpProxy"
              :disabled="settings.saving"
              placeholder="http://127.0.0.1:7890"
              @input="markProxyDraftDirty"
              @blur="saveProxyDraft"
            />
          </div>
          <label for="https-proxy">https_proxy</label>
          <div data-testid="https-proxy">
            <el-input
              id="https-proxy"
              v-model="proxyDraft.httpsProxy"
              :disabled="settings.saving"
              placeholder="https://127.0.0.1:7890"
              @input="markProxyDraftDirty"
              @blur="saveProxyDraft"
            />
          </div>
          <label for="socket-proxy">socket_proxy</label>
          <div data-testid="socket-proxy">
            <el-input
              id="socket-proxy"
              v-model="proxyDraft.socketProxy"
              :disabled="settings.saving"
              placeholder="socks5://127.0.0.1:7890"
              @input="markProxyDraftDirty"
              @blur="saveProxyDraft"
            />
          </div>
          <label for="proxy-bypass">代理忽略的域名</label>
          <div data-testid="proxy-bypass">
            <el-input
              id="proxy-bypass"
              v-model="proxyDraft.bypassText"
              type="textarea"
              :rows="3"
              :disabled="settings.saving"
              placeholder="example.com, *.internal.example"
              @input="markProxyDraftDirty"
              @blur="saveProxyDraft"
            />
          </div>
          <p
            v-if="proxyValidationError"
            class="field-message proxy-validation-error"
            role="alert"
          >
            {{ proxyValidationError }}
          </p>
          <small>AutoForge 始终绕过 &lt;local&gt;（localhost、127.0.0.1 和 ::1）；系统外部浏览器和其他外部应用不受此设置控制。</small>
          <small>代理可观察请求的目标地址，并可能读取明文 HTTP 内容。</small>
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
        class="settings-section data-section"
      >
        <header><div><h2>本地数据</h2><p>管理账户偏好、历史会话迁移与本机存储。</p></div></header>
        <div class="cloud-data-panel">
          <div class="settings-grid cloud-data-controls">
            <div class="account-preference">
              <span class="preference-label">账户时区</span>
              <div
                class="fixed-preference"
                data-testid="account-timezone"
              >
                <el-icon><Clock /></el-icon>
                <div><strong>中国上海</strong><small>Asia/Shanghai · UTC+08:00</small></div>
              </div>
            </div>
            <label>消费显示币种<el-select
              data-testid="account-display-currency"
              :model-value="settings.accountDataPreferences?.displayCurrency"
              placeholder="选择显示币种"
              @change="saveDisplayCurrency"
            ><el-option
              label="人民币 (CNY)"
              value="CNY"
            /><el-option
              label="美元 (USD)"
              value="USD"
            /></el-select></label>
          </div>
          <div
            class="cloud-sync-consent-control"
            data-testid="cloud-sync-consent-state"
          >
            <div>
              <strong>账户云同步授权</strong>
              <small v-if="settings.cloudSyncConsentState?.state === 'accepted'">已同意 · 修订 {{ settings.cloudSyncConsentState.revision }}。知识库云上传、跨设备发现与云检索可按账户权益启用。</small>
              <small v-else-if="settings.cloudSyncConsentState?.state === 'revoked'">已撤回 · 云上传、跨设备发现与云检索已暂停；本地知识库仍可使用。</small>
              <small v-else>尚未同意 · 本地知识库仍可使用，不会开始云端工作。</small>
            </div>
            <el-button
              v-if="settings.cloudSyncConsentState?.state === 'accepted'"
              type="danger"
              plain
              data-testid="revoke-cloud-sync-consent"
              :loading="settings.saving"
              :disabled="settings.saving"
              @click="confirmRevokeCloudSyncConsent"
            >
              撤回云同步授权
            </el-button>
          </div>
          <div class="legacy-import-control">
            <div>
              <strong>迁移本机历史会话</strong>
              <small v-if="settings.legacyImportPreview">当前账户 {{ settings.legacyImportPreview.ownedCount }} 条；未归属 {{ settings.legacyImportPreview.unownedCount }} 条。其他账户的会话不会显示或上传。</small>
              <small v-else>正在读取可迁移的本机会话…</small>
            </div>
            <el-button
              type="primary"
              plain
              data-testid="legacy-import-button"
              :loading="legacyImporting"
              :disabled="!canImportLegacyData"
              @click="confirmLegacyImport"
            >
              {{ hasLegacyData ? '确认并迁移' : '暂无可迁移会话' }}
            </el-button>
          </div>
          <p
            v-if="settings.cloudDataError"
            class="field-message cloud-data-error"
            role="alert"
          >
            {{ settings.cloudDataError }}
          </p>
        </div>
        <div class="local-storage-block">
          <div class="local-storage-heading">
            <strong>本机存储</strong>
            <small>清理操作不可撤销，不会删除工作流开发项目。</small>
          </div>
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
        </div>
        <div class="browser-data-action">
          <div><strong>浏览器站点数据</strong><small>仅清除 AutoForge 浏览器中的 Cookie、缓存和站点数据，不会删除会话与执行记录。</small></div>
          <el-button
            type="danger"
            plain
            data-testid="clear-browser-data"
            :disabled="settings.saving"
            @click="confirmClearBrowserData"
          >
            清除浏览器数据
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
          <el-tabs
            v-model="grantView"
            class="grant-view-tabs"
            data-testid="grant-view-tabs"
          >
            <el-tab-pane
              label="按工作流"
              name="workflow"
            />
            <el-tab-pane
              label="按功能"
              name="capability"
            />
          </el-tabs>
          <div class="grant-filter-bar">
            <label v-if="grantView === 'workflow'">
              <span>工作流筛选</span><el-select
                v-model="workflowFilter"
                data-testid="grant-workflow-filter"
              >
                <el-option
                  label="全部工作流"
                  value=""
                />
                <el-option
                  v-for="option in workflowOptions"
                  :key="option.value"
                  :label="option.label"
                  :value="option.value"
                />
              </el-select>
            </label>
            <label v-else>
              <span>功能筛选</span><el-select
                v-model="capabilityFilter"
                data-testid="grant-capability-filter"
              >
                <el-option
                  label="全部功能"
                  value=""
                />
                <el-option
                  v-for="option in capabilityOptions"
                  :key="option.value"
                  :label="option.label"
                  :value="option.value"
                />
              </el-select>
            </label><span class="grant-result-count">显示 {{ filteredGrants.length }} / {{ settings.grants.length }} 项</span>
          </div>
          <div class="grant-table-wrap">
            <table class="grant-table">
              <thead class="grant-table-head">
                <tr>
                  <template v-if="grantView === 'workflow'">
                    <th scope="col">
                      工作流
                    </th><th scope="col">
                      功能
                    </th>
                  </template>
                  <template v-else>
                    <th scope="col">
                      功能
                    </th><th scope="col">
                      工作流
                    </th>
                  </template>
                  <th scope="col">
                    授权范围
                  </th><th scope="col">
                    操作
                  </th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="grant in filteredGrants"
                  :key="grant.id"
                  class="grant-row"
                >
                  <template v-if="grantView === 'workflow'">
                    <td class="grant-workflow-cell">
                      <div class="grant-workflow-value">
                        <strong>{{ grant.workflowId }}</strong><span>v{{ grant.workflowVersion }}</span>
                      </div>
                    </td>
                    <td class="grant-capability-cell">
                      <div class="grant-capability-value">
                        <strong>{{ capabilityLabels[grant.capability] }}</strong><code>{{ grant.capability }}</code>
                      </div>
                    </td>
                  </template>
                  <template v-else>
                    <td class="grant-capability-cell">
                      <div class="grant-capability-value">
                        <strong>{{ capabilityLabels[grant.capability] }}</strong><code>{{ grant.capability }}</code>
                      </div>
                    </td>
                    <td class="grant-workflow-cell">
                      <div class="grant-workflow-value">
                        <strong>{{ grant.workflowId }}</strong><span>v{{ grant.workflowVersion }}</span>
                      </div>
                    </td>
                  </template>
                  <td class="grant-scope-cell">
                    <div class="grant-scope-values">
                      <code
                        v-for="value in scopeValues(grant.scope)"
                        :key="value"
                      >{{ value }}</code>
                    </div>
                  </td>
                  <td class="grant-action-cell">
                    <el-button
                      type="danger"
                      text
                      :disabled="settings.saving"
                      :aria-label="`撤销 ${capabilityLabels[grant.capability]}：${scopeValues(grant.scope).join('、')}`"
                      @click="settings.revokeGrant(grant.id)"
                    >
                      撤销
                    </el-button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
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
import { Clock, Refresh } from '@element-plus/icons-vue'
import {
  normalizeProxySettings,
  parseProxyBypassText,
  type ModelInfo,
  type ModelProviderId,
  type PermissionGrant,
  type ProxySettings,
} from '@autoforge/shared'
import { ElMessage, ElMessageBox } from 'element-plus'
import { computed, onMounted, reactive, ref, watch } from 'vue'
import BillingUsagePanel from '../components/settings/BillingUsagePanel.vue'
import { displayError } from '../services/desktop-api'
import { useSettingsStore } from '../stores/settings'

const settings = useSettingsStore()
const apiKey = ref('')
const legacyImporting = ref(false)
const selectedProvider = ref<ModelProviderId>('deepseek')
type ProxyDraft = {
  enabled: ProxySettings['enabled']
  httpProxy: string
  httpsProxy: string
  socketProxy: string
  bypassText: string
}
const proxyDraft = reactive<ProxyDraft>({
  enabled: false,
  httpProxy: '',
  httpsProxy: '',
  socketProxy: '',
  bypassText: '',
})
const proxyDraftRevision = ref(0)
let appliedProxyRevision = 0
const proxyValidationError = ref('')
type ModelOutput = 'text' | 'image' | 'audio' | 'video'
const modelOutputLabels: Record<ModelOutput, string> = {
  text: '默认文本模型',
  image: '默认图片模型',
  audio: '默认音频模型',
  video: '默认视频模型',
}
const modelOutputs = computed<ModelOutput[]>(() =>
  settings.activeProvider === 'deepseek'
    ? ['text']
    : ['text', 'image', 'audio', 'video'])
const providerLabel = computed(() => settings.activeProvider === 'deepseek' ? 'DeepSeek' : 'OpenRouter')
const modelPriceNumberFormatter = new Intl.NumberFormat('en-US', {
  maximumSignificantDigits: 6,
})
function formatModelPrice(price: number | undefined): string {
  return price === undefined
    ? '—'
    : `$${modelPriceNumberFormatter.format(price)}/M`
}
function modelPriceLabel(model: ModelInfo): string {
  return `输入 ${formatModelPrice(model.inputCostPerMillion)} · 输出 ${formatModelPrice(model.outputCostPerMillion)}`
}
function modelSelectLabel(model: ModelInfo): string {
  return settings.activeProvider === 'openrouter'
    ? `${model.name} · ${modelPriceLabel(model)}`
    : model.name
}
const proxyStatusLabel = computed(() => settings.settings?.proxy.enabled
  ? '已启用，APP 内网络请求使用此代理'
  : '已关闭，网络请求直连')
const credentialLabel = computed(() => {
  const credential = settings.credential
  if (!credential?.configured) return '未设置 API Key'
  if (credential.validation === 'valid') return '已设置 API Key · 已验证'
  if (credential.validation === 'invalid') return '已设置 API Key · 验证失败'
  if (credential.validation === 'denied') return '已设置 API Key · 访问受限'
  if (credential.validation === 'unavailable') return '已设置 API Key · 暂时无法验证'
  return '已设置 API Key · 尚未验证'
})
const credentialTone = computed(() => settings.credential?.validation === 'valid'
  ? 'success'
  : settings.credential?.configured ? 'warning' : '')
const hasLegacyData = computed(() => Boolean(settings.legacyImportPreview
  && settings.legacyImportPreview.ownedCount + settings.legacyImportPreview.unownedCount > 0))
const canImportLegacyData = computed(() => Boolean(
  hasLegacyData.value && settings.appInfo?.version && !legacyImporting.value,
))
watch(() => settings.activeProvider, (value) => { selectedProvider.value = value }, { immediate: true })
function applyProxyDraft(proxy: ProxySettings) {
  proxyDraft.enabled = proxy.enabled
  proxyDraft.httpProxy = proxy.httpProxy ?? ''
  proxyDraft.httpsProxy = proxy.httpsProxy ?? ''
  proxyDraft.socketProxy = proxy.socketProxy ?? ''
  proxyDraft.bypassText = proxy.bypassDomains.join('\n')
}
watch(() => settings.settings?.proxy, (proxy) => {
  if (!proxy || proxyDraftRevision.value !== appliedProxyRevision) return
  applyProxyDraft(proxy)
}, { immediate: true, deep: true })

onMounted(async () => {
  await Promise.all([
    settings.settings
      ? settings.refreshGrants()
      : !settings.loading ? settings.load() : Promise.resolve(),
    settings.loadTokenUsage(),
    settings.loadCloudData(),
  ])
})
async function refreshUsage() {
  await Promise.all([settings.loadTokenUsage(), settings.loadCloudData()])
}
async function confirmRevokeCloudSyncConsent() {
  const accountGeneration = settings.captureAccountGeneration()
  try {
    await ElMessageBox.confirm(
      '撤回后将暂停知识库云上传、跨设备发现与云检索；本地知识库与本地检索仍可继续使用。',
      '撤回账户云同步授权',
      { type: 'warning', confirmButtonText: '确认撤回', cancelButtonText: '取消' },
    )
    if (!settings.isAccountGenerationCurrent(accountGeneration)) return
    const result = await settings.revokeCloudSyncConsent(accountGeneration)
    if (result !== 'applied' || !settings.isAccountGenerationCurrent(accountGeneration)) return
    ElMessage.success('账户云同步授权已撤回')
  } catch (error) {
    if (error !== 'cancel' && error !== 'close'
      && settings.isAccountGenerationCurrent(accountGeneration)
      && !settings.cloudDataError) {
      settings.cloudDataError = `云同步授权撤回失败：${displayError(error)}`
    }
  }
}
function saveDisplayCurrency(value: unknown) {
  if (value !== 'CNY' && value !== 'USD') return
  void settings.updateAccountDataPreferences({
    timezone: 'Asia/Shanghai',
    displayCurrency: value,
  })
}
async function confirmLegacyImport() {
  const preview = settings.legacyImportPreview
  const clientVersion = settings.appInfo?.version
  if (!preview || !clientVersion || !hasLegacyData.value) return
  const accountGeneration = settings.captureAccountGeneration()
  legacyImporting.value = true
  settings.cloudDataError = ''
  try {
    await ElMessageBox.confirm(
      '开启云同步后，新会话和确认迁移的历史会话会保存到当前 AutoForge 账户。',
      '开启账户云同步',
      { type: 'warning', confirmButtonText: '同意并继续', cancelButtonText: '取消' },
    )
    if (!settings.isAccountGenerationCurrent(accountGeneration)) return
    if (preview.requiresUnownedConfirmation) {
      await ElMessageBox.confirm(
        '这些未归属的本机会话可能由其他本机使用者创建。确认后会将它们迁移到当前账户。',
        '确认迁移未归属会话',
        { type: 'warning', confirmButtonText: '确认迁移', cancelButtonText: '取消' },
      )
      if (!settings.isAccountGenerationCurrent(accountGeneration)) return
    }
    const consentedAt = new Date().toISOString()
    const cloudSyncConsent = {
      purpose: 'cloud_sync' as const,
      documentVersion: 'cloud-sync-2026-08',
      consentedAt,
      clientVersion,
    }
    const result = await settings.importLegacyData({
      includeUnowned: preview.requiresUnownedConfirmation,
      cloudSyncConsent,
      ...(preview.requiresUnownedConfirmation ? {
        unownedImportConsent: {
          purpose: 'legacy_unowned_import' as const,
          documentVersion: 'legacy-unowned-import-2026-08',
          consentedAt,
          clientVersion,
        },
      } : {}),
    }, accountGeneration)
    if (result !== 'applied' || !settings.isAccountGenerationCurrent(accountGeneration)) return
    ElMessage.success('历史会话迁移完成')
    await settings.loadCloudData()
  } catch (error) {
    if (error !== 'cancel' && error !== 'close'
      && settings.isAccountGenerationCurrent(accountGeneration)
      && !settings.cloudDataError) {
      settings.cloudDataError = `历史会话迁移失败：${displayError(error)}`
    }
  } finally {
    legacyImporting.value = false
  }
}
async function changeProvider(provider: ModelProviderId) {
  const previous = settings.activeProvider
  await settings.switchProvider(provider)
  if (settings.activeProvider === provider) apiKey.value = ''
  else selectedProvider.value = previous
}
async function saveApiKey() {
  const key = apiKey.value.trim()
  if (!key) return
  const provider = settings.activeProvider
  try {
    await settings.saveCredential(key)
    apiKey.value = ''
    ElMessage.success('API Key 已保存到本地数据库')
    void settings.validateCredential(provider).then((credential) => {
      if (credential?.validation === 'valid') void settings.loadModels(provider)
    })
  } catch { /* Store renders the safe error. */ }
}
async function clearCredential() {
  try {
    await ElMessageBox.confirm(`清除后将无法继续调用 ${providerLabel.value}，确认清除？`, '清除凭证', { type: 'warning', confirmButtonText: '确认清除', cancelButtonText: '取消' })
    await settings.clearCredential()
  } catch (error) { if (error !== 'cancel' && error !== 'close') return }
}
function saveModel(output: ModelOutput, value: unknown) {
  void settings.saveDefaultModel(output, typeof value === 'string' && value ? value : undefined)
}
function markProxyDraftDirty() {
  proxyDraftRevision.value += 1
}
function saveChangedProxyDraft() {
  markProxyDraftDirty()
  void saveProxyDraft()
}
async function saveProxyDraft() {
  proxyValidationError.value = ''
  const bypassEntries = proxyDraft.bypassText
    .split(/[,\n]/u)
    .map((entry) => entry.trim())
    .filter(Boolean)
  const bypassDomains = parseProxyBypassText(proxyDraft.bypassText)
  if (bypassDomains.length > 256
    || bypassEntries.some((entry) => parseProxyBypassText(entry).length !== 1)) {
    proxyValidationError.value = '代理忽略域名格式不正确'
    return
  }
  let proxy: ProxySettings
  try {
    proxy = normalizeProxySettings({
      enabled: proxyDraft.enabled,
      ...(proxyDraft.httpProxy.trim() ? { httpProxy: proxyDraft.httpProxy } : {}),
      ...(proxyDraft.httpsProxy.trim() ? { httpsProxy: proxyDraft.httpsProxy } : {}),
      ...(proxyDraft.socketProxy.trim() ? { socketProxy: proxyDraft.socketProxy } : {}),
      bypassDomains,
    })
  } catch {
    proxyValidationError.value = proxyDraft.enabled
      && !proxyDraft.httpProxy.trim()
      && !proxyDraft.httpsProxy.trim()
      && !proxyDraft.socketProxy.trim()
      ? '启用代理时至少填写一个代理地址'
      : '请输入不包含用户名、密码和路径的有效代理地址'
    return
  }
  const revision = proxyDraftRevision.value
  const updated = await settings.update({ proxy })
  if (!updated || revision !== proxyDraftRevision.value) return
  appliedProxyRevision = revision
  applyProxyDraft(updated.proxy)
}
async function confirmClear(scope: 'conversations' | 'executions' | 'all') {
  const accountGeneration = settings.captureAccountGeneration()
  try {
    const clearToken = await settings.captureDataClearToken(accountGeneration)
    if (!clearToken || !settings.isAccountGenerationCurrent(accountGeneration)) return
    const message = scope === 'all'
      ? '此操作会永久删除本机的会话与执行记录，无法撤销。凭证、设置、授权和工作流将保留。'
      : '此操作会永久删除所选本地数据，无法撤销。'
    await ElMessageBox.confirm(message, '确认清理本地数据', { type: 'warning', confirmButtonText: '确认清理', cancelButtonText: '取消' })
    if (!settings.isAccountGenerationCurrent(accountGeneration)) return
    const result = await settings.clearLocalData(scope, accountGeneration, clearToken)
    if (result !== 'applied' || !settings.isAccountGenerationCurrent(accountGeneration)) return
    ElMessage.success('本地数据已清理')
  } catch (error) { if (error !== 'cancel' && error !== 'close') return }
}
async function confirmClearBrowserData() {
  const accountGeneration = settings.captureAccountGeneration()
  try {
    const clearToken = await settings.captureDataClearToken(accountGeneration)
    if (!clearToken || !settings.isAccountGenerationCurrent(accountGeneration)) return
    await ElMessageBox.confirm(
      '此操作会清除 AutoForge 浏览器中的 Cookie、缓存和站点数据，站点登录状态将被移除，需要重新登录。会话与执行记录不会被删除。此操作不可撤销。',
      '清除浏览器数据',
      { type: 'warning', confirmButtonText: '确认清除', cancelButtonText: '取消' },
    )
    if (!settings.isAccountGenerationCurrent(accountGeneration)) return
    const result = await settings.clearBrowserData(accountGeneration, clearToken)
    if (result !== 'applied' || !settings.isAccountGenerationCurrent(accountGeneration)) return
    ElMessage.success('浏览器数据已清除')
  } catch (error) { if (error !== 'cancel' && error !== 'close') return }
}
const capabilityLabels: Record<PermissionGrant['capability'], string> = {
  'browser.open': '打开网页',
  'browser.fill': '填写网页内容',
  'browser.click': '操作网页',
  'browser.url': '读取网页地址',
  'browser.close': '关闭网页',
  'network.fetch': '访问网络',
  'filesystem.read': '读取文件',
  'filesystem.write': '写入文件',
  'clipboard.read': '读取剪贴板',
  'clipboard.write': '写入剪贴板',
  'notification.send': '发送通知',
  'artifact.create': '创建产物',
}

type GrantView = 'workflow' | 'capability'
const grantView = ref<GrantView>('workflow')
const workflowFilter = ref('')
const capabilityFilter = ref<PermissionGrant['capability'] | ''>('')

const workflowOptions = computed(() => {
  const options = new Map<string, string>()
  for (const grant of settings.grants) {
    const value = JSON.stringify([grant.workflowId, grant.workflowVersion])
    if (!options.has(value)) options.set(value, `${grant.workflowId} · v${grant.workflowVersion}`)
  }
  return [...options].map(([value, label]) => ({ value, label }))
})

const capabilityOptions = computed(() => {
  const capabilities = new Set(settings.grants.map(({ capability }) => capability))
  return [...capabilities].map((value) => ({ value, label: `${capabilityLabels[value]} · ${value}` }))
})

const filteredGrants = computed(() => settings.grants.filter((grant) => {
  if (grantView.value === 'workflow') {
    return !workflowFilter.value
      || JSON.stringify([grant.workflowId, grant.workflowVersion]) === workflowFilter.value
  }
  return !capabilityFilter.value || grant.capability === capabilityFilter.value
}))

watch(workflowOptions, (options) => {
  if (workflowFilter.value && !options.some(({ value }) => value === workflowFilter.value)) {
    workflowFilter.value = ''
  }
})
watch(capabilityOptions, (options) => {
  if (capabilityFilter.value && !options.some(({ value }) => value === capabilityFilter.value)) {
    capabilityFilter.value = ''
  }
})

const scopeValues = (scope: PermissionGrant['scope']): string[] => {
  if ('origins' in scope) return scope.origins
  if ('paths' in scope) return scope.paths
  return ['无需额外范围']
}
</script>

<style scoped>
.settings-page { max-width: 880px; margin: 0 auto; padding: 20px 24px 60px; }.settings-section { scroll-margin-top: 16px; border: 1px solid var(--af-border); padding: 18px; background: var(--af-surface); }.settings-section + .settings-section { margin-top: 14px; }.settings-section header { display: flex; align-items: flex-start; justify-content: space-between; gap: 18px; border-bottom: 1px solid var(--af-border); padding-bottom: 13px; }.settings-section h2 { margin: 0; color: var(--af-graphite); font-size: 15px; }.settings-section header p { margin: 4px 0 0; color: var(--af-text-muted); font-size: 12px; }
.credential-status, .proxy-status { display: flex; align-items: center; gap: 7px; white-space: nowrap; color: var(--af-text-muted); font-size: 12px; }.credential-status.success { color: var(--af-success); }.credential-status.warning { color: var(--af-warning); }
.settings-form { display: grid; gap: 8px; padding-top: 14px; }.settings-form > label, .settings-grid > label, .model-field > label { color: var(--af-text-muted); font-size: 11px; font-weight: 700; }.inline-control { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; }.settings-form small, .field-message { margin: 0; color: var(--af-text-muted); font-size: 11px; }.settings-form > .el-button { justify-self: start; }.model-field { display: grid; gap: 8px; }
.proxy-validation-error { color: var(--af-danger); }
.settings-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px 24px; padding-top: 15px; }.settings-grid label:not(.switch-row) { display: grid; gap: 7px; }.switch-row { display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid var(--af-border); padding: 8px 0; }.model-id { float: right; margin-left: 18px; color: var(--af-text-muted); }
.cloud-data-panel { margin-top: 15px; border: 1px solid var(--af-border); background: var(--af-surface-muted); }.cloud-data-controls { padding: 14px; }.account-preference { display: grid; gap: 7px; }.preference-label { color: var(--af-text-muted); font-size: 11px; font-weight: 700; }.fixed-preference { display: flex; min-height: 30px; align-items: center; gap: 10px; border: 1px solid var(--af-border); border-radius: 4px; padding: 0 11px; color: var(--af-graphite); background: var(--af-surface); }.fixed-preference .el-icon { color: var(--el-color-primary); }.fixed-preference > div { display: flex; min-width: 0; align-items: baseline; gap: 8px; }.fixed-preference strong { font-size: 12px; }.fixed-preference small { color: var(--af-text-muted); font-size: 10px; }.cloud-sync-consent-control, .legacy-import-control { display: flex; align-items: center; justify-content: space-between; gap: 18px; border-top: 1px solid var(--af-border); padding: 13px 14px; background: var(--af-surface); }.cloud-sync-consent-control > div, .legacy-import-control > div, .local-storage-heading { display: grid; gap: 4px; }.cloud-sync-consent-control small, .legacy-import-control small, .local-storage-heading small { color: var(--af-text-muted); font-size: 11px; line-height: 1.5; }.cloud-data-error { margin: 0; border-top: 1px solid var(--af-danger-border); padding: 9px 14px; color: var(--af-danger); background: var(--af-surface); }.local-storage-block { margin-top: 18px; border-top: 1px solid var(--af-border); padding-top: 15px; }.data-section dl { display: grid; grid-template-columns: 76px minmax(0, 1fr); gap: 7px 12px; font-size: 12px; }.data-section dt { color: var(--af-text-muted); }.data-section dd { margin: 0; overflow-wrap: anywhere; }.danger-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 15px; }.browser-data-action { display: flex; align-items: center; justify-content: space-between; gap: 18px; margin-top: 15px; border-top: 1px solid var(--af-danger-border); padding-top: 15px; }.browser-data-action > div { display: grid; gap: 4px; }.browser-data-action small { color: var(--af-text-muted); font-size: 11px; line-height: 1.5; }
@media (max-width: 720px) { .cloud-data-controls { grid-template-columns: 1fr; }.fixed-preference > div { align-items: flex-start; flex-direction: column; gap: 2px; }.cloud-sync-consent-control, .legacy-import-control, .browser-data-action { align-items: stretch; flex-direction: column; }.cloud-sync-consent-control .el-button, .legacy-import-control .el-button, .browser-data-action .el-button { align-self: flex-start; } }
.grant-list { margin-top: 12px; }.grant-view-tabs :deep(.el-tabs__header) { margin-bottom: 10px; }.grant-filter-bar { display: flex; align-items: end; justify-content: space-between; gap: 16px; border: 1px solid var(--af-border); border-bottom: 0; padding: 10px 12px; background: var(--af-surface-muted); }.grant-filter-bar label { display: grid; width: min(360px, 65%); gap: 5px; color: var(--af-text-muted); font-size: 10px; font-weight: 700; }.grant-result-count { flex: none; padding-bottom: 7px; color: var(--af-text-muted); font-size: 10px; }.grant-table-wrap { overflow-x: auto; border: 1px solid var(--af-border); }.grant-table { width: 100%; min-width: 680px; border-collapse: collapse; table-layout: fixed; background: var(--af-surface); }.grant-table th { padding: 8px 10px; color: var(--af-text-muted); background: var(--af-surface-muted); font-size: 10px; font-weight: 700; text-align: left; }.grant-table th:last-child { width: 58px; text-align: right; }.grant-table td { border-top: 1px solid var(--af-border); padding: 10px; vertical-align: middle; }.grant-workflow-cell, .grant-capability-cell { width: 23%; }.grant-scope-cell { width: auto; }.grant-action-cell { width: 58px; text-align: right; }.grant-workflow-value, .grant-capability-value { display: grid; gap: 3px; }.grant-workflow-value strong, .grant-capability-value strong { overflow-wrap: anywhere; color: var(--af-graphite); font-size: 11px; }.grant-workflow-value span, .grant-capability-value code { color: var(--af-text-muted); font-family: ui-monospace, monospace; font-size: 10px; }.grant-scope-values { display: flex; min-width: 0; flex-wrap: wrap; gap: 5px; }.grant-scope-values code { max-width: 100%; overflow-wrap: anywhere; border: 1px solid var(--af-border); border-radius: 4px; padding: 3px 6px; color: var(--af-text); background: var(--af-surface-muted); font-size: 10px; }.app-info { display: grid; grid-template-columns: 60px 1fr; gap: 8px 12px; margin: 14px 0 0; font-size: 12px; }.app-info dt { color: var(--af-text-muted); }.app-info dd { margin: 0; }
</style>
