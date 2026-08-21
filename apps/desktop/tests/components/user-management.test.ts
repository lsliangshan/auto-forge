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
  } as unknown as DesktopAPI
}

beforeEach(() => setActivePinia(createPinia()))
afterEach(() => Reflect.deleteProperty(window, 'autoForge'))

describe('user management view', () => {
  it('lists masked users, disables self/unknown-role edits and never exposes usage or cost', async () => {
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
    expect(wrapper.find('[data-testid="edit-role-user_1"]').attributes('disabled')).toBeDefined()
    wrapper.unmount()
  })

  it('sends fielded searches and approved assignable role updates with optimistic version', async () => {
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
      page: 1, pageSize: 20, filter: { field: 'username', value: 'Alice' },
    })

    await wrapper.get('[data-testid="edit-role-user_1"]').trigger('click')
    await flushPromises()
    const dialog = document.body.querySelector('[data-testid="role-confirm-dialog"]')
    expect(dialog).not.toBeNull()
    const select = document.body.querySelector('[data-testid="role-select"]') as HTMLSelectElement
    select.value = 'super_admin'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    const confirm = document.body.querySelector('[data-testid="confirm-role-update"]') as HTMLButtonElement
    confirm.click()
    await flushPromises()

    expect(desktopApi.userAdmin.updateRole).toHaveBeenCalledWith(expect.objectContaining({
      targetUserId: 'user_1', newRole: 'super_admin', expectedVersion: 1,
    }))
    wrapper.unmount()
  })
})
