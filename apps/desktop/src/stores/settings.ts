import { defineStore } from 'pinia'
import type {
  AppInfo,
  AppSettings,
  AppSettingsPatch,
  ModelInfo,
  ModelProviderId,
  PermissionGrant,
  ProviderCredentialStatus,
  TokenUsageSnapshot,
} from '@autoforge/shared'
import { displayError, getDesktopApi } from '../services/desktop-api'
import { useChatStore } from './chat'
import { useExecutionStore } from './execution'
import { useWorkflowStore } from './workflow'

const updateQueues = new WeakMap<object, Promise<AppSettings | undefined>>()
type ModelOutput = 'text' | 'image' | 'audio' | 'video'

function supportsOutput(model: ModelInfo, output: ModelOutput): boolean {
  return model.inputModalities.includes('text')
    && model.outputModalities.includes(output)
    && (output === 'text' || model.generation[output] !== undefined)
}

function savedModelOption(id: string, output: ModelOutput): ModelInfo {
  return {
    id,
    name: `${id}（已保存模型）`,
    inputModalities: ['text'],
    outputModalities: [output],
    supportsTools: false,
    generation: {
      ...(output === 'image' ? {
        image: { resolutions: [], aspectRatios: [], formats: [], maxCount: 1 },
      } : {}),
      ...(output === 'audio' ? {
        audio: { voices: [], formats: [] },
      } : {}),
      ...(output === 'video' ? {
        video: { resolutions: [], aspectRatios: [], durations: [], supportsAudio: false, frameImages: [] },
      } : {}),
    },
  }
}

export const useSettingsStore = defineStore('settings', {
  state: () => ({
    settings: undefined as AppSettings | undefined,
    credentials: {
      deepseek: undefined,
      openrouter: undefined,
    } as Record<ModelProviderId, ProviderCredentialStatus | undefined>,
    providerModels: {
      deepseek: [],
      openrouter: [],
    } as Record<ModelProviderId, ModelInfo[]>,
    grants: [] as PermissionGrant[],
    appInfo: undefined as AppInfo | undefined,
    tokenUsage: undefined as TokenUsageSnapshot | undefined,
    loading: false,
    modelsLoading: false,
    tokenUsageLoading: false,
    saving: false,
    error: '',
    tokenUsageError: '',
    _loadVersion: 0,
    _tokenUsageVersion: 0,
    _credentialVersions: { deepseek: 0, openrouter: 0 } as Record<ModelProviderId, number>,
    _modelVersions: { deepseek: 0, openrouter: 0 } as Record<ModelProviderId, number>,
  }),
  getters: {
    activeProvider: (state): ModelProviderId => state.settings?.activeProvider ?? 'deepseek',
    credential(): ProviderCredentialStatus | undefined {
      return this.credentials[this.activeProvider]
    },
    models(): ModelInfo[] {
      return this.providerModels[this.activeProvider]
    },
    defaultModelFor(): (output: ModelOutput) => string {
      return (output) => {
        const defaults = this.settings?.defaultModels
        if (!defaults) return ''
        if (this.activeProvider === 'deepseek') {
          return output === 'text' ? defaults.deepseek.text : ''
        }
        return defaults.openrouter[output] ?? ''
      }
    },
    modelOptionsFor(): (output: ModelOutput) => ModelInfo[] {
      return (output) => {
        const models = this.models.filter((model) => supportsOutput(model, output))
        const saved = this.defaultModelFor(output)
        if (!saved || this.models.some(({ id }) => id === saved)) return models
        return [savedModelOption(saved, output), ...models]
      }
    },
  },
  actions: {
    async loadTokenUsage() {
      const version = ++this._tokenUsageVersion
      this.tokenUsageLoading = true
      this.tokenUsageError = ''
      try {
        const usage = await getDesktopApi().settings.getTokenUsage()
        if (version === this._tokenUsageVersion) this.tokenUsage = usage
      } catch (error) {
        if (version === this._tokenUsageVersion) {
          this.tokenUsageError = displayError(error, 'Token 用量加载失败')
        }
      } finally {
        if (version === this._tokenUsageVersion) this.tokenUsageLoading = false
      }
    },
    async load() {
      const version = ++this._loadVersion
      this.loading = true
      this.error = ''
      try {
        const [settings, grants, appInfo] = await Promise.all([
          getDesktopApi().settings.get(),
          getDesktopApi().permissions.listGrants(),
          getDesktopApi().system.getAppInfo(),
        ])
        if (version !== this._loadVersion) return
        this.settings = settings
        this.grants = grants
        this.appInfo = appInfo
        const credential = await this.validateCredential(settings.activeProvider)
        if (version !== this._loadVersion) return
        if (credential?.configured) await this.loadModels(settings.activeProvider)
        else this.providerModels[settings.activeProvider] = []
      } catch (error) {
        if (version === this._loadVersion) this.error = displayError(error, '设置加载失败')
      } finally {
        if (version === this._loadVersion) this.loading = false
      }
    },
    async _queueUpdate(
      createPatch: () => AppSettingsPatch | undefined,
    ): Promise<AppSettings | undefined> {
      this.saving = true
      this.error = ''
      const operation = (updateQueues.get(this) ?? Promise.resolve(undefined))
        .then(() => {
          const patch = createPatch()
          return patch ? getDesktopApi().settings.update(patch) : this.settings
        })
      const settled = operation.catch(() => undefined)
      updateQueues.set(this, settled)
      try {
        this.settings = await operation
        return this.settings
      } catch (error) {
        this.error = displayError(error, '设置保存失败')
        return undefined
      } finally {
        if (updateQueues.get(this) === settled) this.saving = false
      }
    },
    async update(patch: AppSettingsPatch): Promise<AppSettings | undefined> {
      return this._queueUpdate(() => patch)
    },
    async switchProvider(provider: ModelProviderId) {
      if (provider === this.activeProvider) return
      const updated = await this.update({ activeProvider: provider })
      if (!updated || updated.activeProvider !== provider) return
      this.modelsLoading = false
      const credential = await this.validateCredential(provider)
      if (credential?.configured) await this.loadModels(provider)
      else this.providerModels[provider] = []
    },
    async saveCredential(apiKey: string) {
      const provider = this.activeProvider
      const version = ++this._credentialVersions[provider]
      this.saving = true
      this.error = ''
      try {
        const status = await getDesktopApi().settings.saveProviderApiKey(provider, apiKey.trim())
        if (version === this._credentialVersions[provider]) this.credentials[provider] = status
      } catch (error) {
        if (version === this._credentialVersions[provider] && provider === this.activeProvider) {
          this.error = displayError(error, '凭证保存失败')
        }
        throw error
      } finally {
        this.saving = false
      }
    },
    async clearCredential() {
      const provider = this.activeProvider
      ++this._credentialVersions[provider]
      ++this._modelVersions[provider]
      this.saving = true
      this.error = ''
      try {
        await getDesktopApi().settings.clearProviderApiKey(provider)
        this.credentials[provider] = { provider, configured: false, validation: 'unchecked' }
        this.providerModels[provider] = []
        if (provider === this.activeProvider) this.modelsLoading = false
      } catch (error) {
        if (provider === this.activeProvider) this.error = displayError(error, '凭证清除失败')
      } finally {
        this.saving = false
      }
    },
    async validateCredential(provider?: ModelProviderId) {
      const target = provider ?? this.activeProvider
      const version = ++this._credentialVersions[target]
      try {
        const status = await getDesktopApi().settings.validateProviderCredential(target)
        if (version !== this._credentialVersions[target]) return undefined
        this.credentials[target] = status
        return status
      } catch (error) {
        if (version === this._credentialVersions[target] && target === this.activeProvider) {
          this.error = displayError(error, '凭证验证失败')
        }
        return undefined
      }
    },
    async revokeGrant(grantId: string) {
      this.saving = true
      this.error = ''
      try {
        await getDesktopApi().permissions.revoke(grantId)
        this.grants = this.grants.filter(({ id }) => id !== grantId)
      } catch (error) {
        this.error = displayError(error, '撤销授权失败')
      } finally {
        this.saving = false
      }
    },
    async loadModels(provider?: ModelProviderId, refresh = false): Promise<ModelInfo[] | undefined> {
      const target = provider ?? this.activeProvider
      const version = ++this._modelVersions[target]
      this.modelsLoading = target === this.activeProvider
      this.error = ''
      try {
        const models = await getDesktopApi().settings.listProviderModels(target, refresh)
        if (version !== this._modelVersions[target]) return undefined
        this.providerModels[target] = models
        return models
      } catch (error) {
        if (version === this._modelVersions[target] && target === this.activeProvider) {
          this.error = displayError(error, '模型列表加载失败')
        }
        return undefined
      } finally {
        if (version === this._modelVersions[target] && target === this.activeProvider) this.modelsLoading = false
      }
    },
    async saveDefaultModel(output: ModelOutput, model: string | undefined) {
      if (!this.settings) return
      const provider = this.activeProvider
      const value = model?.trim() || undefined
      if (provider === 'deepseek' && (output !== 'text' || !value)) return
      await this._queueUpdate(() => {
        if (!this.settings) return undefined
        const defaultModels = {
          deepseek: { ...this.settings.defaultModels.deepseek },
          openrouter: { ...this.settings.defaultModels.openrouter },
        }
        if (provider === 'deepseek') {
          defaultModels.deepseek.text = value!
        } else if (value) {
          defaultModels.openrouter[output] = value
        } else {
          delete defaultModels.openrouter[output]
        }
        return { defaultModels }
      })
    },
    async clearLocalData(scope: 'conversations' | 'executions' | 'all') {
      this.saving = true
      this.error = ''
      try {
        await getDesktopApi().settings.clearLocalData(scope)
        if (scope === 'conversations' || scope === 'all') useChatStore().resetLocalData()
        if (scope === 'executions' || scope === 'all') useExecutionStore().resetLocalData()
        if (scope === 'all') {
          await Promise.all([useWorkflowStore().load(), this.load(), this.loadTokenUsage()])
        } else if (scope === 'conversations') {
          await this.loadTokenUsage()
        }
      } catch (error) {
        this.error = displayError(error, '本地数据清理失败')
        throw error
      } finally {
        this.saving = false
      }
    },
  },
})
