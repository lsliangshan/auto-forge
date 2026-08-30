import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ElementPlus from 'element-plus'
import type { AuthSession, DesktopAPI } from '@autoforge/shared'
import UserManagementView from '../../src/views/UserManagementView.vue'
import { useAuthStore } from '../../src/stores/auth'

const adminSession: AuthSession = {
  user: { id: 'admin_1', account: 'Admin' },
  authenticatedAt: '2026-08-21T00:00:00.000Z',
  authorization: {
    role: 'super_admin', capabilities: ['manage_users'], version: 1,
    updatedAt: '2026-08-21T00:00:00.000Z', confirmed: true,
  },
}

const membershipSummary = {
  userId: 'admin_1', planId: 'free', planVersion: 1, state: 'active',
  effectiveStatus: 'active', grantKind: null, version: 0, termEndsAt: null,
  limits: { knowledgeBases: 1, knowledgeDocuments: 1, knowledgeFileBytes: 67_108_864 },
  cloudEligible: false, updatedAt: '2026-08-30T00:00:00.000Z',
} as const

function api() {
  return {
    auth: {},
    profile: {},
    chat: {},
    workflows: {},
    executions: {},
    settings: {},
    userAdmin: {
      list: vi.fn().mockResolvedValue({
        items: [
          {
            userId: 'admin_1', username: 'Admin', displayName: 'Administrator',
            maskedEmail: 'a***@example.com', maskedPhone: null, status: 'active',
            role: 'super_admin', roleVersion: 1, createdAt: '2026-08-20T00:00:00.000Z',
          },
          {
            userId: 'user_1', username: 'Alice', displayName: 'Alice',
            maskedEmail: 'a***@mail.example', maskedPhone: '138****8000', status: 'active',
            role: 'support_operator', roleVersion: 3, createdAt: '2026-08-21T00:00:00.000Z',
          },
        ],
        page: 1, pageSize: 20, total: 2,
      }),
      updateRole: vi.fn().mockResolvedValue({
        userId: 'user_1', role: 'user', version: 4, updatedAt: '2026-08-21T01:00:00.000Z',
      }),
    },
    membership: {
      getTarget: vi.fn().mockResolvedValue(membershipSummary),
      listAudit: vi.fn().mockResolvedValue({
        items: [{
          id: 'audit_1', targetUserId: 'admin_1', actorUserId: 'operator_1',
          action: 'grant', reasonCode: 'manual_payment_confirmed',
          previousVersion: 0, resultingVersion: 1, createdAt: '2026-08-30T01:00:00.000Z',
        }],
        page: 1, pageSize: 20, total: 1,
      }),
      mutate: vi.fn(),
    },
  } as unknown as DesktopAPI
}

beforeEach(() => setActivePinia(createPinia()))
afterEach(() => Reflect.deleteProperty(window, 'autoForge'))

describe('user management view', () => {
  it('lists masked users, keeps self membership editable, disables self/unknown-role role edits and never exposes usage or cost', async () => {
    const desktopApi = api()
    Object.defineProperty(window, 'autoForge', { configurable: true, value: desktopApi })
    const pinia = createPinia()
    setActivePinia(pinia)
    useAuthStore(pinia).session = adminSession
    const wrapper = mount(UserManagementView, { global: { plugins: [pinia, ElementPlus] } })
    await flushPromises()

    expect(desktopApi.userAdmin.list).toHaveBeenCalledWith({ page: 1, pageSize: 20 })
    expect(wrapper.text()).toContain('a***@example.com')
    expect(wrapper.text()).toContain('138****8000')
    expect(wrapper.text()).toContain('support_operator')
    expect(wrapper.text()).not.toContain('用量')
    expect(wrapper.text()).not.toContain('消费')
    expect(wrapper.find('[data-testid="edit-role-admin_1"]').attributes('disabled')).toBeDefined()
    expect(wrapper.find('[data-testid="edit-membership-admin_1"]').attributes('disabled')).toBeUndefined()
    expect(wrapper.find('[data-testid="edit-role-user_1"]').attributes('disabled')).toBeDefined()

    await wrapper.get('[data-testid="edit-membership-admin_1"]').trigger('click')
    await flushPromises()
    expect(desktopApi.membership.getTarget).toHaveBeenCalledWith('admin_1')
    expect(desktopApi.membership.listAudit).toHaveBeenCalledWith({
      targetUserId: 'admin_1', page: 1, pageSize: 20,
    })
    expect(document.body.querySelector('[data-testid="membership-dialog"]')).not.toBeNull()
    expect(document.body.textContent).toContain('Administrator · @Admin')
    expect(document.body.textContent).toContain('已确认线下付款')
    expect(document.body.textContent).toContain('开通')
    wrapper.unmount()
  })

  it('searches across user fields by keyword and sends role updates with optimistic version', async () => {
    const desktopApi = api()
    vi.mocked(desktopApi.userAdmin.list).mockResolvedValue({
      items: [{
        userId: 'user_1', username: 'Alice', displayName: 'Alice', maskedEmail: null,
        maskedPhone: null, status: 'active', role: 'user', roleVersion: 1,
        createdAt: '2026-08-21T00:00:00.000Z',
      }],
      page: 1, pageSize: 20, total: 1,
    })
    Object.defineProperty(window, 'autoForge', { configurable: true, value: desktopApi })
    const pinia = createPinia()
    setActivePinia(pinia)
    useAuthStore(pinia).session = adminSession
    const wrapper = mount(UserManagementView, { global: { plugins: [pinia, ElementPlus] } })
    await flushPromises()

    await wrapper.get('[data-testid="user-search-value"]').setValue('Alice')
    await wrapper.get('[data-testid="user-search-submit"]').trigger('click')
    await flushPromises()
    expect(desktopApi.userAdmin.list).toHaveBeenLastCalledWith({
      page: 1, pageSize: 20, filter: { field: 'keyword', value: 'Alice' },
    })
    const searchRequest = vi.mocked(desktopApi.userAdmin.list).mock.lastCall?.[0]
    expect(() => structuredClone(searchRequest)).not.toThrow()

    await wrapper.get('[data-testid="user-search-reset"]').trigger('click')
    await flushPromises()
    expect(desktopApi.userAdmin.list).toHaveBeenLastCalledWith({ page: 1, pageSize: 20 })

    await wrapper.get('[data-testid="edit-role-user_1"]').trigger('click')
    await flushPromises()
    const dialog = document.body.querySelector('[data-testid="role-confirm-dialog"]')
    expect(dialog).not.toBeNull()
    expect(dialog?.textContent).toContain('修改用户角色')
    expect(dialog?.textContent).toContain('Alice')
    expect(dialog?.textContent).not.toContain('user_1')
    const confirm = document.body.querySelector('[data-testid="confirm-role-update"]') as HTMLButtonElement
    expect(confirm.disabled).toBe(true)
    const adminOption = document.body.querySelector(
      '[data-testid="role-option-super-admin"] input',
    ) as HTMLInputElement
    adminOption.click()
    await flushPromises()
    expect(adminOption.checked).toBe(true)
    expect(dialog?.textContent).toContain('超级管理员拥有高权限')
    expect(confirm.disabled).toBe(false)
    confirm.click()
    await flushPromises()

    expect(desktopApi.userAdmin.updateRole).toHaveBeenCalledWith(expect.objectContaining({
      targetUserId: 'user_1', newRole: 'super_admin', expectedVersion: 1,
    }))
    wrapper.unmount()
  })
})
