import { isToolPermission, type PluginValidationResult, type ToolManifest } from '@shared/plugin'

const builtInTools: ToolManifest[] = [
  {
    name: 'example-login-tool',
    displayName: '示例登录工具',
    version: '1.0.0',
    description: '演示受限 Playwright-like SDK 的最小工具 Manifest。',
    entry: 'dist/index.js',
    matches: ['https://example.com/*'],
    permissions: ['page:navigate', 'dom:read', 'dom:write', 'secrets:read'],
    inputs: {
      username: {
        type: 'string',
        required: true,
        label: '账号'
      },
      password: {
        type: 'secret',
        required: true,
        label: '密码'
      }
    }
  }
]

export class PluginRegistry {
  list(): ToolManifest[] {
    return builtInTools
  }

  validateManifest(value: unknown): PluginValidationResult {
    const errors: string[] = []
    const warnings: string[] = []

    if (!this.isRecord(value)) {
      return { ok: false, errors: ['Manifest 必须是对象'], warnings }
    }

    this.requireString(value, 'name', errors)
    this.requireString(value, 'version', errors)
    this.requireString(value, 'entry', errors)
    this.requireStringArray(value, 'matches', errors)

    const permissions = value.permissions
    if (!Array.isArray(permissions) || permissions.length === 0) {
      errors.push('permissions 必须是非空数组')
    } else {
      for (const permission of permissions) {
        if (typeof permission !== 'string' || !isToolPermission(permission)) {
          errors.push(`不支持的权限：${String(permission)}`)
        }
      }
    }

    if (Array.isArray(value.matches) && value.matches.some((match) => match === '<all_urls>')) {
      warnings.push('不建议第一版插件申请 <all_urls>，请尽量限制到明确域名')
    }

    return { ok: errors.length === 0, errors, warnings }
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
  }

  private requireString(value: Record<string, unknown>, key: string, errors: string[]): void {
    if (typeof value[key] !== 'string' || value[key].trim() === '') {
      errors.push(`${key} 必须是非空字符串`)
    }
  }

  private requireStringArray(value: Record<string, unknown>, key: string, errors: string[]): void {
    if (!Array.isArray(value[key]) || value[key].length === 0) {
      errors.push(`${key} 必须是非空字符串数组`)
      return
    }

    for (const item of value[key]) {
      if (typeof item !== 'string' || item.trim() === '') {
        errors.push(`${key} 只能包含非空字符串`)
      }
    }
  }
}
