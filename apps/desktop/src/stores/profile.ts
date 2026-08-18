import { acceptHMRUpdate, defineStore } from 'pinia'
import type { UserProfile, UserProfileUpdate } from '@autoforge/shared'
import { displayError, getDesktopApi } from '../services/desktop-api'

const loadPromises = new WeakMap<object, Promise<void>>()

function profileError(error: unknown, fallback: string): string {
  if (typeof error === 'object' && error && 'code' in error) {
    if (error.code === 'CREDENTIAL_UNAVAILABLE') return '头像上传服务尚未配置'
    if (error.code === 'PROFILE_AVATAR_UPLOAD_FAILED') return '头像上传失败，请稍后重试'
    if (error.code === 'INTERNAL_ERROR') return fallback
  }
  return displayError(error, fallback)
}

export const useProfileStore = defineStore('profile', {
  state: () => ({
    profile: null as UserProfile | null,
    loading: false,
    saving: false,
    uploadingAvatar: false,
    error: '',
    loadedUserId: '',
    _generation: 0,
  }),
  actions: {
    load(userId: string, force = false): Promise<void> {
      if (!force && this.loadedUserId === userId && this.profile?.userId === userId) return Promise.resolve()
      const pending = loadPromises.get(this)
      if (pending) return pending

      const generation = this._generation
      this.loading = true
      this.error = ''
      const operation = (async () => {
        try {
          const profile = await getDesktopApi().profile.get()
          if (generation === this._generation && profile.userId === userId) {
            this.profile = profile
            this.loadedUserId = userId
          }
        } catch (error) {
          if (generation === this._generation) this.error = displayError(error, '个人资料加载失败')
        } finally {
          if (generation === this._generation) this.loading = false
          loadPromises.delete(this)
        }
      })()
      loadPromises.set(this, operation)
      return operation
    },
    async update(input: UserProfileUpdate): Promise<UserProfile | undefined> {
      this.saving = true
      this.error = ''
      try {
        const profile = await getDesktopApi().profile.update(input)
        this.profile = profile
        this.loadedUserId = profile.userId
        return profile
      } catch (error) {
        this.error = profileError(error, '个人资料保存失败，请稍后重试')
        return undefined
      } finally {
        this.saving = false
      }
    },
    async pickAndUploadAvatar(): Promise<string | undefined> {
      this.uploadingAvatar = true
      this.error = ''
      try {
        return (await getDesktopApi().profile.pickAndUploadAvatar())?.url
      } catch (error) {
        this.error = profileError(error, '头像上传失败，请稍后重试')
        return undefined
      } finally {
        this.uploadingAvatar = false
      }
    },
    reset() {
      this._generation += 1
      this.profile = null
      this.loading = false
      this.saving = false
      this.uploadingAvatar = false
      this.error = ''
      this.loadedUserId = ''
      loadPromises.delete(this)
    },
  },
})

if (import.meta.hot) import.meta.hot.accept(acceptHMRUpdate(useProfileStore, import.meta.hot))
