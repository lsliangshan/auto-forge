import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import ElementPlus, { ElMessageBox } from 'element-plus'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DesktopAPI } from '@autoforge/shared'
import { useSettingsStore } from '../../src/stores/settings'
import SettingsView from '../../src/views/SettingsView.vue'

function createApi(): DesktopAPI {
  return {
    auth: {},
    profile: {},
    chat: {},
    workflows: {},
    executions: {},
    permissions: { listGrants: vi.fn().mockResolvedValue([]), revoke: vi.fn() },
    settings: {
      getTokenUsage: vi.fn().mockResolvedValue(undefined),
      clearLocalData: vi.fn().mockResolvedValue(undefined),
      clearBrowserData: vi.fn().mockResolvedValue(undefined),
    },
  } as unknown as DesktopAPI
}

function mountSettings(api: DesktopAPI) {
  Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
  const settings = useSettingsStore()
  settings.settings = {
    theme: 'system', language: 'zh-CN', dataDirectory: '/data', logDirectory: '/logs',
    activeProvider: 'deepseek',
    defaultModels: { deepseek: { text: 'deepseek-chat' }, openrouter: {} },
    showCosts: false, developerMode: false, permissionDefault: 'ask',
    proxy: { enabled: false, bypassDomains: [] },
  }
  return mount(SettingsView, { global: { plugins: [ElementPlus] } })
}

describe('browser data settings', () => {
  beforeEach(() => setActivePinia(createPinia()))
  afterEach(() => {
    vi.restoreAllMocks()
    Reflect.deleteProperty(window, 'autoForge')
  })

  it('clears browser site data only after explicit login-removal confirmation', async () => {
    const api = createApi()
    const confirm = vi.spyOn(ElMessageBox, 'confirm').mockResolvedValue('confirm')
    const wrapper = mountSettings(api)

    await wrapper.get('[data-testid="clear-browser-data"]').trigger('click')
    await flushPromises()

    expect(confirm).toHaveBeenCalledWith(
      expect.stringContaining('站点登录状态将被移除'),
      '清除浏览器数据',
      expect.objectContaining({ confirmButtonText: '确认清除', cancelButtonText: '取消' }),
    )
    expect(api.settings.clearBrowserData).toHaveBeenCalledOnce()
    expect(api.settings.clearLocalData).not.toHaveBeenCalled()
  })

  it('does not call the clear-browser-data API when confirmation is cancelled', async () => {
    const api = createApi()
    vi.spyOn(ElMessageBox, 'confirm').mockRejectedValue('cancel')
    const wrapper = mountSettings(api)

    await wrapper.get('[data-testid="clear-browser-data"]').trigger('click')
    await flushPromises()

    expect(api.settings.clearBrowserData).not.toHaveBeenCalled()
  })
})
