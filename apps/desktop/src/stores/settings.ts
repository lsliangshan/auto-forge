import { defineStore } from 'pinia'
import type { AppInfo, AppSettings, AppSettingsPatch, CredentialStatus, ModelInfo, PermissionGrant } from '@autoforge/shared'
import { displayError, getDesktopApi } from '../services/desktop-api'
import { useChatStore } from './chat'
import { useExecutionStore } from './execution'
import { useWorkflowStore } from './workflow'

const updateQueues = new WeakMap<object, Promise<AppSettings | undefined>>()

export const useSettingsStore = defineStore('settings', {
  state: () => ({
    settings: undefined as AppSettings | undefined, credential: undefined as CredentialStatus | undefined,
    models: [] as ModelInfo[], grants: [] as PermissionGrant[], appInfo: undefined as AppInfo | undefined,
    loading: false, modelsLoading: false, saving: false, error: '', _loadVersion: 0, _modelVersion: 0,
  }),
  actions: {
    async load() {
      const version = ++this._loadVersion
      this.loading = true
      this.error = ''
      try {
        const [settings, credential, grants, appInfo] = await Promise.all([
          getDesktopApi().settings.get(), getDesktopApi().settings.validateOpenRouterKey(),
          getDesktopApi().permissions.listGrants(), getDesktopApi().system.getAppInfo(),
        ])
        if (version !== this._loadVersion) return
        this.settings = settings
        this.credential = credential
        this.grants = grants
        this.appInfo = appInfo
      } catch (error) { if (version === this._loadVersion) this.error = displayError(error, '设置加载失败') }
      finally { if (version === this._loadVersion) this.loading = false }
    },
    async update(patch: AppSettingsPatch) {
      this.saving = true
      this.error = ''
      const operation = (updateQueues.get(this) ?? Promise.resolve(undefined))
        .then(() => getDesktopApi().settings.update(patch))
      const settled = operation.catch(() => undefined)
      updateQueues.set(this, settled)
      try { this.settings = await operation }
      catch (error) { this.error = displayError(error, '设置保存失败') }
      finally { if (updateQueues.get(this) === settled) this.saving = false }
    },
    async saveCredential(apiKey: string) {
      this.saving = true
      this.error = ''
      try { this.credential = await getDesktopApi().settings.saveOpenRouterKey(apiKey.trim()) }
      catch (error) { this.error = displayError(error, '凭证保存失败'); throw error }
      finally { this.saving = false }
    },
    async clearCredential() {
      this.saving = true
      try {
        await getDesktopApi().settings.clearOpenRouterKey()
        this.credential = { configured: false, valid: false }
      } catch (error) { this.error = displayError(error, '凭证清除失败') }
      finally { this.saving = false }
    },
    async revokeGrant(grantId: string) {
      this.saving = true
      this.error = ''
      try {
        await getDesktopApi().permissions.revoke(grantId)
        this.grants = this.grants.filter(({ id }) => id !== grantId)
      } catch (error) { this.error = displayError(error, '撤销授权失败') }
      finally { this.saving = false }
    },
    async loadModels() {
      const version = ++this._modelVersion
      this.modelsLoading = true
      this.error = ''
      try {
        const models = await getDesktopApi().settings.listModels()
        if (version === this._modelVersion) this.models = models
      } catch (error) { if (version === this._modelVersion) this.error = displayError(error, '模型列表加载失败') }
      finally { if (version === this._modelVersion) this.modelsLoading = false }
    },
    async clearLocalData(scope: 'conversations' | 'executions' | 'all') {
      this.saving = true
      this.error = ''
      try {
        await getDesktopApi().settings.clearLocalData(scope)
        if (scope === 'conversations' || scope === 'all') useChatStore().resetLocalData()
        if (scope === 'executions' || scope === 'all') useExecutionStore().resetLocalData()
        if (scope === 'all') await Promise.all([useWorkflowStore().load(), this.load()])
      }
      catch (error) { this.error = displayError(error, '本地数据清理失败'); throw error }
      finally { this.saving = false }
    },
  },
})
