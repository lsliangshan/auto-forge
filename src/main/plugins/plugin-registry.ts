import { validateManifest, type PluginValidationResult, type ToolManifest } from '@shared/plugin'

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
    const result = validateManifest(value)
    return {
      ok: result.ok,
      errors: result.errors.map(localizeValidationMessage),
      warnings: result.warnings.map(localizeValidationMessage)
    }
  }
}

function localizeValidationMessage(message: string): string {
  return message
    .replace('Manifest must be an object.', 'Manifest 必须是对象')
    .replace('permissions must be a non-empty string array.', 'permissions 必须是非空字符串数组')
    .replace('matches must be a non-empty string array.', 'matches 必须是非空字符串数组')
    .replace('matches can only contain non-empty strings.', 'matches 只能包含非空字符串')
    .replace('name must be a non-empty string.', 'name 必须是非空字符串')
    .replace('version must be a non-empty string.', 'version 必须是非空字符串')
    .replace('entry must be a non-empty string.', 'entry 必须是非空字符串')
    .replace('inputs must be an object when provided.', 'inputs 必须是对象')
    .replace('input name must be a non-empty string.', '输入项名称必须是非空字符串')
    .replace('must be an object.', '必须是对象')
    .replace('has unsupported type:', '包含不支持的类型：')
    .replace('.required must be a boolean when provided.', '.required 必须是布尔值')
    .replace('with type "select" must provide non-empty options.', '类型为 select 时必须提供非空 options')
    .replace('Avoid <all_urls> in the first plugin version. Prefer explicit host matches.', '不建议第一版插件申请 <all_urls>，请尽量限制到明确域名')
    .replace('Unsupported permission:', '不支持的权限：')
}
