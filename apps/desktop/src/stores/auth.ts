import { defineStore } from 'pinia'
import { hasBusinessCapability, type AuthCredentials, type AuthOtpChallenge, type AuthOtpRequest, type AuthSession } from '@autoforge/shared'
import { displayError, getDesktopApi } from '../services/desktop-api'
import { useChatStore } from './chat'
import { useExecutionStore } from './execution'
import { useKnowledgeStore } from './knowledge'
import { useSettingsStore, type AccountOperationAttemptToken } from './settings'

const restorePromises = new WeakMap<object, Promise<void>>()
const otpGenerations = new WeakMap<object, number>()
const sessionGenerations = new WeakMap<object, number>()
const submittingCounts = new WeakMap<object, number>()
const restoringCounts = new WeakMap<object, number>()

function otpGeneration(store: object): number {
  return otpGenerations.get(store) ?? 0
}

function nextOtpGeneration(store: object): number {
  const generation = otpGeneration(store) + 1
  otpGenerations.set(store, generation)
  return generation
}

function sessionGeneration(store: object): number {
  return sessionGenerations.get(store) ?? 0
}

function nextSessionGeneration(store: object): number {
  const generation = sessionGeneration(store) + 1
  sessionGenerations.set(store, generation)
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

function startRestoring(store: { restoring: boolean }): void {
  const count = (restoringCounts.get(store) ?? 0) + 1
  restoringCounts.set(store, count)
  store.restoring = true
}

function finishRestoring(store: { restoring: boolean }): void {
  const count = Math.max((restoringCounts.get(store) ?? 1) - 1, 0)
  restoringCounts.set(store, count)
  store.restoring = count > 0
}

async function settleFailedAccountTransition(
  store: { session: AuthSession | null },
  attempt: AccountOperationAttemptToken,
): Promise<boolean> {
  const settings = useSettingsStore()
  let session: AuthSession | null
  try {
    session = await getDesktopApi().auth.getSession()
  } catch {
    session = null
  }
  const recovery = await settings.recoverAccountOperationAdmission(
    session?.user.id,
    attempt,
  )
  if (recovery === 'stale') return false
  return replaceSession(store, session, attempt)
}

function replaceSession(
  store: { session: AuthSession | null },
  session: AuthSession | null,
  attempt: AccountOperationAttemptToken,
  terminalClose = false,
): boolean {
  const previousUserId = store.session?.user.id
  const nextUserId = session?.user.id
  const binding = terminalClose && nextUserId === undefined
    ? useSettingsStore().closeAccountOwner()
    : useSettingsStore().bindAccountOwner(nextUserId, attempt)
  if (binding !== 'applied') return false
  if (previousUserId !== nextUserId) {
    if (previousUserId !== undefined) {
      useChatStore().resetLocalData()
      useExecutionStore().resetLocalData()
      useKnowledgeStore().resetLocalData()
    }
  }
  store.session = session
  return true
}

export const useAuthStore = defineStore('auth', {
  state: () => ({
    session: null as AuthSession | null,
    initialized: false,
    restoring: false,
    submitting: false,
    challenge: null as AuthOtpChallenge | null,
    sendingOtp: false,
    pendingLogoutCount: 0,
    error: '',
  }),
  getters: {
    canManageUsers: (state) => hasBusinessCapability(state.session?.authorization, 'manage_users'),
  },
  actions: {
    restore(): Promise<void> {
      if (this.initialized) return Promise.resolve()
      const pending = restorePromises.get(this)
      if (pending) return pending

      const generation = nextSessionGeneration(this)
      const accountAttempt = useSettingsStore().suspendAccountOperationAdmission()
      startRestoring(this)
      this.error = ''
      const operation = (async () => {
        try {
          const session = await getDesktopApi().auth.getSession()
          if (generation !== sessionGeneration(this)) return
          if (!replaceSession(this, session, accountAttempt)) return
          this.initialized = true
        } catch (error) {
          if (generation !== sessionGeneration(this)) return
          if (!replaceSession(this, null, accountAttempt)) return
          this.initialized = true
          this.error = displayError(error, '登录状态恢复失败')
        } finally {
          finishRestoring(this)
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
      const sessionOwner = nextSessionGeneration(this)
      const accountAttempt = useSettingsStore().suspendAccountOperationAdmission()
      startSubmitting(this)
      this.error = ''
      try {
        const session = await getDesktopApi().auth.verifyOtp({ challengeId: challenge.challengeId, code })
        if (generation !== otpGeneration(this) || sessionOwner !== sessionGeneration(this)) {
          const cleanupOwner = sessionGeneration(this)
          try {
            const result = await getDesktopApi().auth.logout({ preservePending: true })
            if (result.status !== 'logged_out') {
              if (cleanupOwner === sessionGeneration(this)) {
                if (!replaceSession(this, session, accountAttempt)) return undefined
                this.initialized = true
                this.error = '同步仍在进行，请稍后重试退出登录'
              }
              return undefined
            }
          } catch {
            if (cleanupOwner === sessionGeneration(this)) {
              if (!replaceSession(this, session, accountAttempt)) return undefined
              this.initialized = true
              this.error = '退出登录失败'
            }
            return undefined
          }
          nextSessionGeneration(this)
          replaceSession(this, null, accountAttempt, true)
          this.initialized = true
          this.error = ''
          return undefined
        }
        if (!replaceSession(this, session, accountAttempt)) return undefined
        this.initialized = true
        return session
      } catch (error) {
        if (generation === otpGeneration(this) && sessionOwner === sessionGeneration(this)) {
          const settled = await settleFailedAccountTransition(this, accountAttempt)
          if (settled && generation === otpGeneration(this)
            && sessionOwner === sessionGeneration(this)) {
            this.error = displayError(error, '验证码验证失败')
          }
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
      const sessionOwner = nextSessionGeneration(this)
      this.challenge = null
      if (!challenge) return

      try {
        await getDesktopApi().auth.cancelOtp(challenge.challengeId)
      } catch (error) {
        if (generation === otpGeneration(this) && sessionOwner === sessionGeneration(this)) {
          this.error = displayError(error, '取消验证码失败')
        }
      }
    },
    async loginWithPassword(credentials: AuthCredentials): Promise<AuthSession | undefined> {
      if (this.sendingOtp || this.submitting) return undefined

      const sessionOwner = nextSessionGeneration(this)
      const accountAttempt = useSettingsStore().suspendAccountOperationAdmission()
      startSubmitting(this)
      this.error = ''
      try {
        const session = await getDesktopApi().auth.loginWithPassword(credentials)
        if (sessionOwner !== sessionGeneration(this)) return undefined
        if (!replaceSession(this, session, accountAttempt)) return undefined
        this.initialized = true
        return session
      } catch (error) {
        if (sessionOwner === sessionGeneration(this)) {
          const settled = await settleFailedAccountTransition(this, accountAttempt)
          if (settled && sessionOwner === sessionGeneration(this)) {
            this.error = displayError(error, '登录失败')
          }
        }
        return undefined
      } finally {
        finishSubmitting(this)
      }
    },
    async logout(discardPending = false): Promise<boolean> {
      const accountAttempt = useSettingsStore().suspendAccountOperationAdmission()
      startSubmitting(this)
      this.error = ''
      await this.cancelOtp()
      const sessionOwner = nextSessionGeneration(this)
      try {
        const result = await getDesktopApi().auth.logout(
          discardPending ? { discardPending: true } : undefined,
        )
        if (result.status === 'pending_sync') {
          const settled = await settleFailedAccountTransition(this, accountAttempt)
          if (settled) this.pendingLogoutCount = result.pendingCount
          return false
        }
        if (result.status === 'sync_timeout') {
          const settled = await settleFailedAccountTransition(this, accountAttempt)
          if (settled) this.error = '同步仍在进行，请稍后重试退出登录'
          return false
        }
        nextSessionGeneration(this)
        replaceSession(this, null, accountAttempt, true)
        this.initialized = true
        this.pendingLogoutCount = 0
        this.error = ''
        return true
      } catch (error) {
        if (sessionOwner === sessionGeneration(this)) {
          const settled = await settleFailedAccountTransition(this, accountAttempt)
          if (settled && sessionOwner === sessionGeneration(this)) {
            this.error = displayError(error, '退出登录失败')
          }
        }
        return false
      } finally {
        finishSubmitting(this)
      }
    },
    async refreshAuthorization(): Promise<void> {
      if (!this.session) return
      const sessionOwner = sessionGeneration(this)
      try {
        const session = await getDesktopApi().auth.refreshAuthorization()
        if (sessionOwner === sessionGeneration(this)
          && session.user.id === this.session?.user.id) this.session = session
      } catch (error) {
        if (sessionOwner !== sessionGeneration(this) || !this.session) return
        this.session = {
          ...this.session,
          authorization: {
            role: this.session.authorization?.role ?? 'user',
            capabilities: [],
            version: this.session.authorization?.version ?? 0,
            updatedAt: this.session.authorization?.updatedAt ?? this.session.authenticatedAt,
            confirmed: false,
          },
        }
        this.error = displayError(error, '权限刷新失败')
      }
    },
  },
})
