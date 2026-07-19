import type { WorkflowPermission } from '@autoforge/shared'

export interface WorkflowManifest {
  id: string
  version: string
  name: string
  description: string
  author: string
  category: string
  entryPath: string
  codeSha256: string
  permissions: WorkflowPermission[]
  activationExamples: string[]
  activationNegativeExamples: string[]
  timeoutMs: number
  inputSchema: unknown
  outputSchema: unknown
}
