import type { AutoForgeApi } from '../../../shared/contracts'
export function getDesktopApi(): AutoForgeApi {
  if (!window.autoForge) throw new Error('AutoForge desktop bridge is unavailable')
  return window.autoForge
}
