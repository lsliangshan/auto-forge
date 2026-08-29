import cloudbase from '@cloudbase/js-sdk'
import type { AuthCredentials, AuthOtpChannel } from '@autoforge/shared'

export interface CloudBaseAuthConfig {
  env: 'autoforge-d1gkhyfb419ba8455'
  region: 'ap-shanghai'
  accessKey: string
}

export interface CloudBaseAuthPort {
  signInWithOtp(input:
    | { phone: string; options: { shouldCreateUser: false } }
    | { email: string; options: { shouldCreateUser: false } }
  ): Promise<unknown>
  signUp(input:
    | { phone: string; username: string; password: string; nickname: string }
    | { email: string; username: string; password: string; nickname: string }
  ): Promise<unknown>
  signInWithPassword(input: { username: string; password: string }): Promise<unknown>
  getSession(): Promise<unknown>
  getUser(): Promise<unknown>
  refreshUser(): Promise<unknown>
  updateUser(input: {
    nickname?: string
    avatar_url?: string
    gender?: 'MALE' | 'FEMALE' | 'OTHER' | 'PREFER_NOT_TO_SAY'
  }): Promise<unknown>
  setSession(input: { access_token: string; refresh_token: string }): Promise<unknown>
  refreshSession(refreshToken?: string): Promise<unknown>
  signOut(): Promise<unknown>
}

export interface CloudBaseFunctionPort {
  callFunction(options: {
    name: string
    data: Record<string, unknown>
    signal?: AbortSignal
  }): Promise<unknown>
}

interface CloudBaseFactory {
  init(config: {
    env: string
    region: string
    accessKey: string
    auth: { detectSessionInUrl: false }
  }): {
    auth: CloudBaseAuthPort
  } & CloudBaseFunctionPort
}

const cloudBaseFactory: CloudBaseFactory = {
  init(config) {
    const app = cloudbase.init(config)
    return {
      auth: app.auth,
      callFunction: ({ signal, ...options }) => abortableCallFunction(
        () => app.callFunction(options), signal,
      ),
    }
  },
}

function abortableCallFunction(
  invoke: () => Promise<unknown>,
  signal?: AbortSignal,
): Promise<unknown> {
  if (!signal) return invoke()
  return new Promise((resolve, reject) => {
    const aborted = () => reject(new Error('CloudBase function call aborted'))
    if (signal.aborted) {
      aborted()
      return
    }
    const pending = invoke()
    signal.addEventListener('abort', aborted, { once: true })
    pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted))
  })
}

export function readCloudBaseAuthConfig(env: NodeJS.ProcessEnv): CloudBaseAuthConfig {
  const accessKey = env.AUTOFORGE_CLOUDBASE_PUBLISHABLE_KEY?.trim()
  if (!accessKey) throw new Error('CloudBase authentication is not configured')
  return {
    env: 'autoforge-d1gkhyfb419ba8455',
    region: 'ap-shanghai',
    accessKey,
  }
}

export function createCloudBaseAuthPort(
  config: CloudBaseAuthConfig,
  factory: CloudBaseFactory = cloudBaseFactory,
): CloudBaseAuthPort {
  return factory.init({
    ...config,
    auth: { detectSessionInUrl: false },
  }).auth
}

export function createCloudBaseClientPorts(
  config: CloudBaseAuthConfig,
  factory: CloudBaseFactory = cloudBaseFactory,
) {
  const app = factory.init({
    ...config,
    auth: { detectSessionInUrl: false },
  })
  return {
    auth: app.auth,
    functions: {
      callFunction: ({ signal, ...options }: {
        name: string
        data: Record<string, unknown>
        signal?: AbortSignal
      }) => abortableCallFunction(() => app.callFunction(options), signal),
    },
  }
}

export function cloudBaseOtpTarget(channel: AuthOtpChannel, target: string) {
  return channel === 'phone' ? { phone: `+86${target}` } : { email: target }
}

export function cloudBasePasswordCredentials(input: AuthCredentials) {
  return { username: input.account.toLowerCase(), password: input.password }
}
