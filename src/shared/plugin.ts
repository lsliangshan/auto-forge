export const toolPermissions = [
  'page:navigate',
  'dom:read',
  'dom:write',
  'network:read',
  'network:request',
  'storage:tool',
  'files:download',
  'files:upload',
  'secrets:read'
] as const

export type ToolPermission = (typeof toolPermissions)[number]

export type InputDefinition = {
  type: 'string' | 'number' | 'boolean' | 'secret' | 'select'
  required?: boolean
  label?: string
  description?: string
  options?: string[]
}

export type ToolManifest = {
  name: string
  displayName?: string
  version: string
  description?: string
  entry: string
  matches: string[]
  permissions: ToolPermission[]
  inputs?: Record<string, InputDefinition>
}

export type PluginValidationResult = {
  ok: boolean
  errors: string[]
  warnings: string[]
}

export function isToolPermission(value: string): value is ToolPermission {
  return toolPermissions.includes(value as ToolPermission)
}
