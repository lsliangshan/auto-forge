import { defineStore } from 'pinia'
import type {
  AssignableRole,
  UserAdminFilter,
  UserAdminListItem,
  UserAdminListRequest,
} from '@autoforge/shared'
import { displayError, getDesktopApi } from '../services/desktop-api'

export const useUserAdminStore = defineStore('user-admin', {
  state: () => ({
    items: [] as UserAdminListItem[],
    page: 1,
    pageSize: 20 as 20 | 50 | 100,
    total: 0,
    filter: undefined as UserAdminFilter | undefined,
    loading: false,
    updating: false,
    error: '',
  }),
  actions: {
    async load(): Promise<void> {
      this.loading = true
      this.error = ''
      const input: UserAdminListRequest = {
        page: this.page,
        pageSize: this.pageSize,
        ...(this.filter ? {
          filter: { field: this.filter.field, value: this.filter.value },
        } : {}),
      }
      try {
        const result = await getDesktopApi().userAdmin.list(input)
        this.items = result.items
        this.page = result.page
        this.pageSize = result.pageSize
        this.total = result.total
      } catch (error) {
        this.error = displayError(error, '用户列表加载失败')
      } finally {
        this.loading = false
      }
    },
    async search(filter: UserAdminFilter | undefined): Promise<void> {
      this.filter = filter
      this.page = 1
      await this.load()
    },
    async updateRole(user: UserAdminListItem, role: AssignableRole): Promise<boolean> {
      this.updating = true
      this.error = ''
      try {
        await getDesktopApi().userAdmin.updateRole({
          requestId: globalThis.crypto.randomUUID(),
          targetUserId: user.userId,
          newRole: role,
          expectedVersion: user.roleVersion,
        })
        await this.load()
        return true
      } catch (error) {
        this.error = displayError(error, '用户角色修改失败')
        await this.load()
        return false
      } finally {
        this.updating = false
      }
    },
  },
})
