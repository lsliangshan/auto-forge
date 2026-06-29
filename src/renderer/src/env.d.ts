/// <reference types="vite/client" />

import type { AutoForgeBridge } from '@shared/contracts'

declare global {
  interface Window {
    autoForge: AutoForgeBridge
  }
}

export {}
