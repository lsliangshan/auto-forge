import { defineStore } from 'pinia'
import type { AuthCredentials, AuthOtpChallenge, AuthOtpRequest, AuthSession } from '@autoforge/shared'
import { displayError, getDesktopApi } from '../services/desktop-api'

const restorePromises = new WeakMap<object, Promise<void>>()

export const useAuthStore = defineStore('auth', {
  state: () => ({
    session: null as AuthSession | null,
    initialized: false,
    restoring: false,
    submitting: false,
    challenge: null as AuthOtpChallenge | null,
    sendingOtp: false,
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
    async sendOtp(request: AuthOtpRequest): Promise<AuthOtpChallenge | undefined> {
      if (this.sendingOtp) return undefined

      const previousChallenge = this.challenge
      this.challenge = null
      this.sendingOtp = true
      this.error = ''
      try {
        if (previousChallenge) {
          try {
            await getDesktopApi().auth.cancelOtp(previousChallenge.challengeId)
          } catch {
            // A failed cancellation must not prevent replacing the local challenge.
          }
        }
        const challenge = await getDesktopApi().auth.sendOtp(request)
        this.challenge = challenge
        return challenge
      } catch (error) {
        this.error = displayError(error, '验证码发送失败')
        return undefined
      } finally {
        this.sendingOtp = false
      }
    },
    async verifyOtp(code: string): Promise<AuthSession | undefined> {
      const challenge = this.challenge
      if (!challenge) {
        this.error = '请先发送验证码'
        return undefined
      }

      this.submitting = true
      this.error = ''
      try {
        const session = await getDesktopApi().auth.verifyOtp({ challengeId: challenge.challengeId, code })
        this.session = session
        this.initialized = true
        return session
      } catch (error) {
        this.error = displayError(error, '验证码验证失败')
        return undefined
      } finally {
        this.challenge = null
        this.submitting = false
      }
    },
    async cancelOtp(): Promise<void> {
      const challenge = this.challenge
      this.challenge = null
      if (!challenge) return

      try {
        await getDesktopApi().auth.cancelOtp(challenge.challengeId)
      } catch (error) {
        this.error = displayError(error, '取消验证码失败')
      }
    },
    async loginWithPassword(credentials: AuthCredentials): Promise<AuthSession | undefined> {
      this.submitting = true
      this.error = ''
      try {
        const session = await getDesktopApi().auth.loginWithPassword(credentials)
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
    async logout(): Promise<boolean> {
      this.submitting = true
      this.error = ''
      try {
        await this.cancelOtp()
        await getDesktopApi().auth.logout()
        this.session = null
        this.initialized = true
        this.error = ''
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
