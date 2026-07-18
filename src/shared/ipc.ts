import type { SafeError } from './contracts'

export const ipcChannels = {
  listTools: 'catalog:list',
  listInstalledToolIds: 'installations:list',
  installTool: 'installations:install',
  getSettings: 'settings:get',
  updateSettings: 'settings:update',
  exportToolTemplate: 'templates:export'
} as const

export function toSafeError(error: unknown): SafeError {
  return {
    code: 'INTERNAL_ERROR',
    message: error instanceof Error ? error.message : 'Unexpected application error'
  }
}
