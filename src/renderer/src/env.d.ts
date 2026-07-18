/// <reference types="vite/client" />

import type { AutoForgeApi } from '../../shared/contracts'

declare global {
  interface Window {
    autoForge?: AutoForgeApi
  }
}

export {}
