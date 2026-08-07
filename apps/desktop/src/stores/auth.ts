import { defineStore } from 'pinia'
import type { AuthCredentials, AuthSession } from '@autoforge/shared'
import { displayError, getDesktopApi } from '../services/desktop-api'

const restorePromises = new WeakMap<object, Promise<void>>()

export const useAuthStore = defineStore('auth', {
  state: () => ({
    session: null as AuthSession | null,
    initialized: false,
    restoring: false,
    submitting: false,
    error: '',
  }),
  actions: {
    restore(): Promise<void> {
      if (this.initialized) return Promise.resolve()
      const pending = restorePromises.get(this)
      if (pending) return pending

      this.restoring = true
      this.error = ''
      const operation = (async () => {
        try {
          this.session = await getDesktopApi().auth.getSession()
        } catch (error) {
          this.session = null
          this.error = displayError(error, '登录状态恢复失败')
        } finally {
          this.initialized = true
          this.restoring = false
          restorePromises.delete(this)
        }
      })()
      restorePromises.set(this, operation)
      return operation
    },
    async login(credentials: AuthCredentials): Promise<AuthSession | undefined> {
      this.submitting = true
      this.error = ''
      try {
        const session = await getDesktopApi().auth.login(credentials)
        this.session = session
        this.initialized = true
        return session
      } catch (error) {
        this.error = displayError(error, '登录失败')
        return undefined
      } finally {
        this.submitting = false
      }
    },
    async register(credentials: AuthCredentials): Promise<AuthSession | undefined> {
      this.submitting = true
      this.error = ''
      try {
        const session = await getDesktopApi().auth.register(credentials)
        this.session = session
        this.initialized = true
        return session
      } catch (error) {
        this.error = displayError(error, '注册失败')
        return undefined
      } finally {
        this.submitting = false
      }
    },
    async logout(): Promise<boolean> {
      this.submitting = true
      this.error = ''
      try {
        await getDesktopApi().auth.logout()
        this.session = null
        this.initialized = true
        return true
      } catch (error) {
        this.error = displayError(error, '退出登录失败')
        return false
      } finally {
        this.submitting = false
      }
    },
  },
})
