import {
  toSafeAppError,
  type AuthSession,
  type UserAdminListRequest,
  type UserAdminListResponse,
  type UserAdminUpdateRoleRequest,
  type UserAdminUpdateRoleResponse,
} from '@autoforge/shared'

interface UserAdminAuthPort {
  requireSession(): Promise<AuthSession>
}

interface UserAdminRolePort {
  listUsers(input: UserAdminListRequest): Promise<UserAdminListResponse>
  updateUserRole(input: UserAdminUpdateRoleRequest): Promise<UserAdminUpdateRoleResponse>
}

export class UserAdminService {
  constructor(
    private readonly auth: UserAdminAuthPort,
    private readonly roles: UserAdminRolePort,
  ) {}

  private async requireManageUsers(): Promise<void> {
    const authorization = (await this.auth.requireSession()).authorization
    if (authorization?.confirmed !== true || !authorization.capabilities.includes('manage_users')) {
      throw toSafeAppError({ code: 'FORBIDDEN' })
    }
  }

  async list(input: UserAdminListRequest): Promise<UserAdminListResponse> {
    await this.requireManageUsers()
    return this.roles.listUsers(input)
  }

  async updateRole(input: UserAdminUpdateRoleRequest): Promise<UserAdminUpdateRoleResponse> {
    await this.requireManageUsers()
    return this.roles.updateUserRole(input)
  }
}
