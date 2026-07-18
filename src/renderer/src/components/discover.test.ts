import ElementPlus from 'element-plus'
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AutoForgeApi } from '../../../shared/contracts'
import type { ToolSummary } from '../../../shared/catalog'
import DiscoverView from '../views/DiscoverView.vue'

const tools: ToolSummary[] = [
  {
    id: 'web-collector',
    name: '网页数据采集器',
    description: '从网页中采集结构化数据',
    developer: 'AutoForge 团队',
    version: '2.3.1',
    category: 'data',
    tags: ['采集'],
    platforms: ['windows', 'macos', 'linux'],
    downloads: 128600,
    featured: true,
    permissions: []
  },
  {
    id: 'content-publisher',
    name: '定时内容发布',
    description: '定时发布内容',
    developer: 'AutoForge 团队',
    version: '1.0.0',
    category: 'publishing',
    tags: ['发布'],
    platforms: ['windows'],
    downloads: 1200,
    featured: false,
    permissions: []
  }
]

beforeEach(() => {
  const api: AutoForgeApi = {
    listTools: vi.fn().mockResolvedValue(tools),
    listInstalledToolIds: vi.fn().mockResolvedValue([]),
    installTool: vi.fn(),
    getSettings: vi.fn(),
    updateSettings: vi.fn(),
    exportToolTemplate: vi.fn()
  }
  Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
})

describe('DiscoverView', () => {
  it('filters visible tool rows by search query', async () => {
    const wrapper = mount(DiscoverView, { global: { plugins: [ElementPlus] } })
    await flushPromises()
    expect(wrapper.findAll('[data-testid="tool-row"]')).toHaveLength(2)

    await wrapper.get('[data-testid="tool-search"]').setValue('网页')
    expect(wrapper.findAll('[data-testid="tool-row"]')).toHaveLength(1)
    expect(wrapper.text()).toContain('网页数据采集器')
  })
})
