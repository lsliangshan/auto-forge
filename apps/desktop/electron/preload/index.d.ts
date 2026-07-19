import type { DesktopAPI } from '@autoforge/shared'

declare global {
  interface Window {
    autoForge: DesktopAPI
  }
}

export {}
