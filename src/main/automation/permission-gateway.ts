import type { ToolPermission } from '@shared/plugin'

export class PermissionGateway {
  constructor(private readonly grantedPermissions: ToolPermission[]) {}

  assert(permission: ToolPermission): void {
    if (!this.grantedPermissions.includes(permission)) {
      throw new Error(`插件未声明所需权限：${permission}`)
    }
  }

  can(permission: ToolPermission): boolean {
    return this.grantedPermissions.includes(permission)
  }
}
