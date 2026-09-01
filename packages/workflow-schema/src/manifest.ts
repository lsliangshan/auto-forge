import type { WorkflowPermission } from '@autoforge/shared'

export const BROWSER_CONTINUATION_ARRAY_LIMIT = 32

export interface BrowserContinuationManifest {
  auth?: {
    loginUrls?: string[]
    loggedIn?: string[]
    loggedOut?: string[]
  }
  readableRegions?: string[]
  manualActions?: Array<{ locator: string; reason: string }>
}

export interface WorkflowManifest {
  id: string
  version: string
  name: string
  description: string
  logo?: string
  author: string
  category: string
  cities?: string[]
  entryPath: string
  codeSha256: string
  permissions: WorkflowPermission[]
  activationExamples: string[]
  activationNegativeExamples: string[]
  timeoutMs: number
  inputSchema: unknown
  outputSchema: unknown
  browserContinuation?: BrowserContinuationManifest
}
