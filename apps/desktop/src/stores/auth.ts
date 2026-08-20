import { defineStore } from 'pinia'
import type { AuthCredentials, AuthOtpChallenge, AuthOtpRequest, AuthSession } from '@autoforge/shared'
import { displayError, getDesktopApi } from '../services/desktop-api'

const restorePromises = new WeakMap<object, Promise<void>>()
const otpGenerations = new WeakMap<object, number>()
const submittingCounts = new WeakMap<object, number>()

function otpGeneration(store: object): number {
  return otpGenerations.get(store) ?? 0
}

function nextOtpGeneration(store: object): number {
  const generation = otpGeneration(store) + 1
  otpGenerations.set(store, generation)
  return generation
}

function startSubmitting(store: { submitting: boolean }): void {
  const count = (submittingCounts.get(store) ?? 0) + 1
  submittingCounts.set(store, count)
  store.submitting = true
}

function finishSubmitting(store: { submitting: boolean }): void {
  const count = Math.max((submittingCounts.get(store) ?? 1) - 1, 0)
  submittingCounts.set(store, count)
  store.submitting = count > 0
}

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
      if (this.sendingOtp || this.submitting) return undefined

      const generation = nextOtpGeneration(this)
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
        if (generation !== otpGeneration(this)) {
          try {
            await getDesktopApi().auth.cancelOtp(challenge.challengeId)
          } catch {
            // A stale challenge cannot be made current again by a failed cleanup.
          }
          return undefined
        }
        this.challenge = challenge
        return challenge
      } catch (error) {
        if (generation === otpGeneration(this)) {
          this.error = displayError(error, '验证码发送失败')
        }
        return undefined
      } finally {
        this.sendingOtp = false
      }
    },
    async verifyOtp(code: string): Promise<AuthSession | undefined> {
      if (this.submitting) return undefined

      const challenge = this.challenge
      if (!challenge) {
        this.error = '请先发送验证码'
        return undefined
      }

      const generation = otpGeneration(this)
      startSubmitting(this)
      this.error = ''
      try {
        const session = await getDesktopApi().auth.verifyOtp({ challengeId: challenge.challengeId, code })
        if (generation !== otpGeneration(this)) {
          try {
            await getDesktopApi().auth.logout()
          } catch {
            // A stale verification must not update Renderer state with cleanup errors.
          }
          return undefined
        }
        this.session = session
        this.initialized = true
        return session
      } catch (error) {
        if (generation === otpGeneration(this)) {
          this.error = displayError(error, '验证码验证失败')
        }
        return undefined
      } finally {
        if (generation === otpGeneration(this) && this.challenge?.challengeId === challenge.challengeId) {
          this.challenge = null
        }
        finishSubmitting(this)
      }
    },
    async cancelOtp(): Promise<void> {
      const challenge = this.challenge
      const generation = nextOtpGeneration(this)
      this.challenge = null
      if (!challenge) return

      try {
        await getDesktopApi().auth.cancelOtp(challenge.challengeId)
      } catch (error) {
        if (generation === otpGeneration(this)) {
          this.error = displayError(error, '取消验证码失败')
        }
      }
    },
    async loginWithPassword(credentials: AuthCredentials): Promise<AuthSession | undefined> {
      if (this.sendingOtp || this.submitting) return undefined

      startSubmitting(this)
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
        finishSubmitting(this)
      }
    },
    async logout(): Promise<boolean> {
      startSubmitting(this)
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
        finishSubmitting(this)
      }
    },
  },
})
