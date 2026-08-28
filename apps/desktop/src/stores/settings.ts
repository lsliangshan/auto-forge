import { defineStore } from 'pinia'
import type {
  AppInfo,
  AppSettings,
  AppSettingsPatch,
  AccountDataPreferences,
  LegacyImportPreview,
  LegacyImportRequest,
  ModelInfo,
  ModelProviderId,
  PermissionGrant,
  PrivacyConsent,
  PrivacyConsentState,
  ProviderCredentialStatus,
  TokenUsageSnapshot,
  RemoteUsageSnapshot,
} from '@autoforge/shared'
import { displayError, getDesktopApi } from '../services/desktop-api'
import { useChatStore } from './chat'
import { useExecutionStore } from './execution'
import { useWorkflowStore } from './workflow'

const updateQueues = new WeakMap<object, Promise<AppSettings | undefined>>()
type ModelOutput = 'text' | 'image' | 'audio' | 'video'
declare const accountGenerationBrand: unique symbol
export type AccountGenerationToken = number & { readonly [accountGenerationBrand]: true }
declare const accountOperationAttemptBrand: unique symbol
export type AccountOperationAttemptToken = number & {
  readonly [accountOperationAttemptBrand]: true
}
export type AccountMutationResult = 'applied' | 'stale'
export type AccountRecoveryResult = 'success' | 'failure' | 'stale'

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
    remoteUsage: undefined as RemoteUsageSnapshot | undefined,
    accountDataPreferences: undefined as AccountDataPreferences | undefined,
    legacyImportPreview: undefined as LegacyImportPreview | undefined,
    cloudSyncConsentState: undefined as PrivacyConsentState | null | undefined,
    loading: false,
    modelsLoading: false,
    tokenUsageLoading: false,
    saving: false,
    error: '',
    tokenUsageError: '',
    remoteUsageError: '',
    cloudDataError: '',
    _cloudDataOwnerId: undefined as string | undefined,
    _accountGeneration: 0,
    _accountOperationAdmissionOpen: false,
    _cloudDataReadVersion: 0,
    _cloudConsentMutationVersion: 0,
    _cloudConsentMutationPending: false,
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
    captureAccountGeneration(): AccountGenerationToken {
      return this._accountGeneration as AccountGenerationToken
    },
    isAccountGenerationCurrent(token: AccountGenerationToken): boolean {
      return this._accountOperationAdmissionOpen
        && this._cloudDataOwnerId !== undefined
        && token === this.captureAccountGeneration()
    },
    isAccountOperationAttemptCurrent(token: AccountOperationAttemptToken): boolean {
      return !this._accountOperationAdmissionOpen
        && token === (this._accountGeneration as AccountOperationAttemptToken)
    },
    suspendAccountOperationAdmission(): AccountOperationAttemptToken {
      const consentMutationPending = this._cloudConsentMutationPending
      this._accountGeneration += 1
      this._accountOperationAdmissionOpen = false
      this._cloudDataReadVersion += 1
      this._cloudConsentMutationVersion += 1
      this._tokenUsageVersion += 1
      this._cloudConsentMutationPending = false
      this.tokenUsageLoading = false
      if (consentMutationPending) this.saving = false
      return this._accountGeneration as AccountOperationAttemptToken
    },
    bindAccountOwner(
      ownerId: string | undefined,
      attempt: AccountOperationAttemptToken,
    ): AccountMutationResult {
      if (!this.isAccountOperationAttemptCurrent(attempt)) return 'stale'
      const ownerChanged = ownerId !== this._cloudDataOwnerId
      const consentMutationPending = this._cloudConsentMutationPending
      this._accountGeneration += 1
      this._accountOperationAdmissionOpen = ownerId !== undefined
      this._cloudDataReadVersion += 1
      this._cloudConsentMutationVersion += 1
      this._cloudConsentMutationPending = false
      if (consentMutationPending) this.saving = false
      if (ownerChanged) this.saving = false
      if (!ownerChanged) return 'applied'
      this._cloudDataOwnerId = ownerId
      this._tokenUsageVersion += 1
      this.tokenUsage = undefined
      this.remoteUsage = undefined
      this.accountDataPreferences = undefined
      this.legacyImportPreview = undefined
      this.cloudSyncConsentState = undefined
      this.tokenUsageError = ''
      this.remoteUsageError = ''
      this.cloudDataError = ''
      return 'applied'
    },
    closeAccountOwner() {
      const attempt = this.suspendAccountOperationAdmission()
      return this.bindAccountOwner(undefined, attempt)
    },
    async refreshGrants() {
      this.error = ''
      try {
        this.grants = await getDesktopApi().permissions.listGrants()
      } catch (error) {
        this.error = displayError(error, '授权列表加载失败')
      }
    },
    async loadTokenUsage() {
      const accountGeneration = this.captureAccountGeneration()
      if (!this.isAccountGenerationCurrent(accountGeneration)) return
      const version = ++this._tokenUsageVersion
      this.tokenUsageLoading = true
      this.tokenUsageError = ''
      try {
        const usage = await getDesktopApi().settings.getTokenUsage()
        if (version === this._tokenUsageVersion
          && this.isAccountGenerationCurrent(accountGeneration)) this.tokenUsage = usage
      } catch (error) {
        if (version === this._tokenUsageVersion
          && this.isAccountGenerationCurrent(accountGeneration)) {
          this.tokenUsageError = displayError(error, 'Token 用量加载失败')
        }
      } finally {
        if (version === this._tokenUsageVersion
          && this.isAccountGenerationCurrent(accountGeneration)) this.tokenUsageLoading = false
      }
    },
    async loadCloudData(
      recoveryAttempt?: AccountOperationAttemptToken,
    ): Promise<AccountRecoveryResult> {
      const ownerId = this._cloudDataOwnerId
      const accountGeneration = this._accountGeneration
      const admissionIsCurrent = () => recoveryAttempt === undefined
        ? this._accountOperationAdmissionOpen && accountGeneration === this._accountGeneration
        : this.isAccountOperationAttemptCurrent(recoveryAttempt)
          && accountGeneration === this._accountGeneration
      if (!ownerId || !admissionIsCurrent()) return 'stale'
      const readVersion = ++this._cloudDataReadVersion
      const consentMutationVersion = this._cloudConsentMutationVersion
      const consentMutationWasPending = this._cloudConsentMutationPending
      this.cloudDataError = ''
      this.remoteUsageError = ''
      const [remoteUsage, accountDataPreferences, legacyImportPreview, cloudSyncConsentState]
        = await Promise.allSettled([
        Promise.resolve().then(() => getDesktopApi().settings.getRemoteUsage()),
        Promise.resolve().then(() => getDesktopApi().settings.getAccountDataPreferences()),
        Promise.resolve().then(() => getDesktopApi().settings.previewLegacyImport()),
        Promise.resolve().then(() => getDesktopApi().settings.getCloudSyncConsentState()),
      ])
      if (ownerId !== this._cloudDataOwnerId
        || readVersion !== this._cloudDataReadVersion
        || !admissionIsCurrent()) return 'stale'
      if (remoteUsage.status === 'fulfilled') {
        this.remoteUsage = remoteUsage.value
      } else {
        this.remoteUsageError = displayError(remoteUsage.reason, '云端消费数据加载失败')
      }
      if (accountDataPreferences.status === 'fulfilled') {
        this.accountDataPreferences = accountDataPreferences.value
      } else {
        this.cloudDataError = displayError(accountDataPreferences.reason, '账户偏好加载失败')
      }
      if (legacyImportPreview.status === 'fulfilled') {
        this.legacyImportPreview = legacyImportPreview.value
      } else if (!this.cloudDataError) {
        this.cloudDataError = displayError(legacyImportPreview.reason, '历史会话迁移信息加载失败')
      }
      if (!consentMutationWasPending
        && consentMutationVersion === this._cloudConsentMutationVersion) {
        if (cloudSyncConsentState.status === 'fulfilled') {
          this.cloudSyncConsentState = cloudSyncConsentState.value
          return 'success'
        } else {
          this.cloudSyncConsentState = undefined
          if (!this.cloudDataError) {
            this.cloudDataError = displayError(
              cloudSyncConsentState.reason,
              '云同步授权状态加载失败',
            )
          }
        }
      }
      return cloudSyncConsentState.status === 'rejected' ? 'failure' : 'stale'
    },
    async recoverAccountOperationAdmission(
      ownerId: string,
      attempt: AccountOperationAttemptToken,
    ): Promise<AccountRecoveryResult> {
      if (ownerId !== this._cloudDataOwnerId
        || !this.isAccountOperationAttemptCurrent(attempt)) return 'stale'
      const result = await this.loadCloudData(attempt)
      if (result === 'stale'
        || ownerId !== this._cloudDataOwnerId
        || !this.isAccountOperationAttemptCurrent(attempt)) return 'stale'
      if (result === 'failure') this.cloudSyncConsentState = undefined
      return this.bindAccountOwner(ownerId, attempt) === 'applied' ? result : 'stale'
    },
    async updateAccountDataPreferences(input: AccountDataPreferences) {
      const accountGeneration = this.captureAccountGeneration()
      if (!this.isAccountGenerationCurrent(accountGeneration)) return
      this.cloudDataError = ''
      try {
        const updated = await getDesktopApi().settings
          .updateAccountDataPreferences(input)
        if (!this.isAccountGenerationCurrent(accountGeneration)) return
        this.accountDataPreferences = updated
        await this.loadCloudData()
      } catch (error) {
        if (this.isAccountGenerationCurrent(accountGeneration)) {
          this.cloudDataError = displayError(error, '账户数据偏好保存失败')
        }
      }
    },
    async importLegacyData(
      input: LegacyImportRequest,
      accountGeneration?: AccountGenerationToken,
    ): Promise<AccountMutationResult> {
      const capturedGeneration = accountGeneration ?? this.captureAccountGeneration()
      if (!this.isAccountGenerationCurrent(capturedGeneration)) return 'stale'
      this.cloudDataError = ''
      try {
        const consentResult = await this.recordPrivacyConsent(
          input.cloudSyncConsent,
          capturedGeneration,
        )
        if (consentResult !== 'applied') return 'stale'
        await getDesktopApi().settings.importLegacyData(input)
        if (!this.isAccountGenerationCurrent(capturedGeneration)) return 'stale'
        return 'applied'
      } catch (error) {
        if (!this.isAccountGenerationCurrent(capturedGeneration)) return 'stale'
        this.cloudDataError = `历史会话迁移失败：${displayError(error)}`
        throw error
      }
    },
    async recordPrivacyConsent(
      input: PrivacyConsent,
      accountGeneration: AccountGenerationToken,
    ): Promise<AccountMutationResult> {
      if (!this.isAccountGenerationCurrent(accountGeneration)) return 'stale'
      try {
        await getDesktopApi().settings.recordPrivacyConsent(input)
        return this.isAccountGenerationCurrent(accountGeneration) ? 'applied' : 'stale'
      } catch (error) {
        if (!this.isAccountGenerationCurrent(accountGeneration)) return 'stale'
        throw error
      }
    },
    async revokeCloudSyncConsent(
      accountGeneration?: AccountGenerationToken,
    ): Promise<AccountMutationResult> {
      const capturedGeneration = accountGeneration ?? this.captureAccountGeneration()
      if (!this.isAccountGenerationCurrent(capturedGeneration)
        || this.cloudSyncConsentState?.state !== 'accepted') return 'stale'
      const mutationVersion = ++this._cloudConsentMutationVersion
      this._cloudDataReadVersion += 1
      this._cloudConsentMutationPending = true
      this.saving = true
      this.cloudDataError = ''
      try {
        const revoked = await getDesktopApi().settings
          .revokeCloudSyncConsent({ confirmed: true })
        if (!this.isAccountGenerationCurrent(capturedGeneration)
          || mutationVersion !== this._cloudConsentMutationVersion) return 'stale'
        this.cloudSyncConsentState = revoked
        return 'applied'
      } catch (error) {
        if (!this.isAccountGenerationCurrent(capturedGeneration)
          || mutationVersion !== this._cloudConsentMutationVersion) return 'stale'
        this.cloudDataError = displayError(error, '云同步授权撤回失败')
        throw error
      } finally {
        if (this.isAccountGenerationCurrent(capturedGeneration)
          && mutationVersion === this._cloudConsentMutationVersion) {
          this._cloudConsentMutationPending = false
          this.saving = false
        }
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
    async clearBrowserData() {
      this.saving = true
      this.error = ''
      try {
        await getDesktopApi().settings.clearBrowserData()
      } catch (error) {
        this.error = displayError(error, '浏览器数据清除失败')
        throw error
      } finally {
        this.saving = false
      }
    },
  },
})
