import ElementPlus from 'element-plus'
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AutoForgeApi, SessionUser } from '../../../shared/contracts'
import DiscoverView from '../views/DiscoverView.vue'

const workflow = { id: 'wf-1', slug: 'web-collector', name: '网页数据采集器', description: '从网页中采集结构化数据', authorName: 'AutoForge 团队', version: '2.3.1', category: { id: 'cat-1', slug: 'data-collection', name: '数据采集', sortOrder: 0, active: true }, permissions: ['browser.read'] as const, targetHosts: ['example.com'], codeSha256: 'a'.repeat(64), packageSha256: 'b'.repeat(64), downloads: 100, publishedAt: '2026-07-19T00:00:00.000Z' }

function mockApi(user: SessionUser | null): AutoForgeApi {
  return {
    getSettings: vi.fn(), updateSettings: vi.fn(), getSession: vi.fn().mockResolvedValue({ user }), login: vi.fn(), register: vi.fn(), logout: vi.fn(),
    listCategories: vi.fn().mockResolvedValue([workflow.category]), listWorkflows: vi.fn().mockResolvedValue({ items: [workflow], page: 1, pageSize: 20, total: 1 }),
    listInstalledWorkflows: vi.fn().mockResolvedValue([]), installWorkflow: vi.fn(), runWorkflow: vi.fn(), listWorkflowProjects: vi.fn().mockResolvedValue([]),
    createWorkflowProject: vi.fn(), openWorkflowProject: vi.fn(), buildWorkflowProject: vi.fn(), watchWorkflowProject: vi.fn(), stopWatchingWorkflowProject: vi.fn(),
    openProjectEditor: vi.fn(), debugWorkflow: vi.fn(), stopExecution: vi.fn(), submitWorkflow: vi.fn(), listMySubmissions: vi.fn().mockResolvedValue([]),
    listPendingSubmissions: vi.fn().mockResolvedValue([]), getSubmissionDetail: vi.fn(), trialSubmission: vi.fn(), approveSubmission: vi.fn(), rejectSubmission: vi.fn(),
    listAdminCategories: vi.fn().mockResolvedValue([]), createCategory: vi.fn(), updateCategory: vi.fn(), deleteCategory: vi.fn()
  }
}

beforeEach(() => Object.defineProperty(window, 'autoForge', { configurable: true, value: mockApi(null) }))

describe('DiscoverView', () => {
  it('shows the server workflow hall and hides protected tabs for anonymous users', async () => {
    const wrapper = mount(DiscoverView, { global: { plugins: [ElementPlus] } }); await flushPromises()
    expect(wrapper.findAll('[data-testid="workflow-card"]')).toHaveLength(1)
    expect(wrapper.text()).toContain('网页数据采集器'); expect(wrapper.text()).toContain('工作流大厅')
    expect(wrapper.text()).not.toContain('审核管理'); expect(wrapper.text()).not.toContain('本地项目')
  })

  it('shows developer and review tabs only to administrators', async () => {
    Object.defineProperty(window, 'autoForge', { configurable: true, value: mockApi({ id: 'admin', email: 'admin@example.com', displayName: '管理员', role: 'ADMIN' }) })
    const wrapper = mount(DiscoverView, { global: { plugins: [ElementPlus] } }); await flushPromises()
    expect(wrapper.text()).toContain('我的工作流'); expect(wrapper.text()).toContain('审核管理')
  })
})
