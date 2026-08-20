import type {
  AuthCredentials,
  AuthOtpChallenge,
  AuthOtpRequest,
  AuthOtpVerification,
  AuthSession,
} from '@autoforge/shared'

export interface AuthService {
  getSession(): Promise<AuthSession | null>
  sendOtp(input: AuthOtpRequest): Promise<AuthOtpChallenge>
  verifyOtp(input: AuthOtpVerification): Promise<AuthSession>
  cancelOtp(challengeId: string): Promise<void>
  loginWithPassword(input: AuthCredentials): Promise<AuthSession>
  logout(): Promise<void>
  requireSession(): Promise<AuthSession>
}

export interface AuthSecretStore {
  set(key: string, value: string): Promise<void>
  get(key: string): Promise<string | undefined>
  delete(key: string): void
}
