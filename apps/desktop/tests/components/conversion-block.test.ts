import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { ConversionJobEvent, ConversionJobView, DesktopAPI } from '@autoforge/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ConversionBlock from '../../src/components/conversion/ConversionBlock.vue'
import MessageBlock from '../../src/components/chat/MessageBlock.vue'
import { useConversionStore } from '../../src/stores/conversion'

function job(status: ConversionJobView['status'], overrides: Partial<ConversionJobView> = {}): ConversionJobView {
  return {
    jobId: 'job_1', executionId: 'execution_1', targetFormat: 'png', status, epoch: 1, progress: 48,
    errorCode: status === 'failed' ? 'CONVERSION_TIMEOUT' : undefined,
    artifacts: status === 'completed' ? [{
      artifactId: 'artifact_1', status: 'ready', displayName: 'result.png', detectedFormat: 'png',
      mimeType: 'image/png', byteSize: 1234, metadata: { pdfPage: 2 },
    }] : [],
    ...overrides,
  }
}

function apiFor(jobs: ConversionJobView[] = []) {
  let listener: ((event: ConversionJobEvent) => void) | undefined
  const unsubscribe = vi.fn()
  const api = {
    auth: { getSession: vi.fn(), sendOtp: vi.fn(), verifyOtp: vi.fn(), cancelOtp: vi.fn(), loginWithPassword: vi.fn(), logout: vi.fn() },
    profile: { get: vi.fn(), update: vi.fn(), pickAndUploadAvatar: vi.fn() },
    chat: { listConversations: vi.fn(), createConversation: vi.fn(), listMessages: vi.fn(), renameConversation: vi.fn(), deleteConversation: vi.fn(), retrySync: vi.fn(), send: vi.fn(), cancel: vi.fn(), takeOverBrowser: vi.fn(), listBrowserAudit: vi.fn(), getGenerationPreferences: vi.fn(), updateGenerationPreferences: vi.fn(), onEvent: vi.fn() },
    workflows: { list: vi.fn(), get: vi.fn(), setEnabled: vi.fn(), remove: vi.fn(), installProject: vi.fn() },
    executions: { list: vi.fn(), get: vi.fn(), decide: vi.fn(), cancel: vi.fn(), onEvent: vi.fn() },
    settings: { get: vi.fn(), update: vi.fn(), saveProviderApiKey: vi.fn(), clearProviderApiKey: vi.fn(), validateProviderCredential: vi.fn(), listProviderModels: vi.fn(), clearLocalData: vi.fn() },
    conversion: {
      listForExecution: vi.fn().mockResolvedValue({ availability: 'local', jobs }),
      cancel: vi.fn().mockResolvedValue(undefined), retry: vi.fn().mockResolvedValue(undefined),
      saveCopy: vi.fn().mockResolvedValue({ saved: true }), preview: vi.fn().mockResolvedValue(undefined),
      reveal: vi.fn().mockResolvedValue(undefined),
      deleteArtifact: vi.fn().mockResolvedValue(undefined),
      onEvent: vi.fn((next) => { listener = next; return unsubscribe }),
    },
  } as unknown as DesktopAPI
  return { api, unsubscribe, emit: (event: ConversionJobEvent) => listener?.(event) }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function mountBlock(api: DesktopAPI, state: 'active' | 'terminal' = 'active') {
  Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
  return mount(ConversionBlock, {
    props: { block: { type: 'conversion', blockId: 'conversion_1', executionId: 'execution_1', state } },
    global: { plugins: [createPinia()] },
  })
}

describe('conversion chat block', () => {
  beforeEach(() => setActivePinia(createPinia()))
  afterEach(() => Reflect.deleteProperty(window, 'autoForge'))

  it.each([
    ['queued', '等待转换队列'], ['downloading_component', '正在下载转换组件'],
    ['converting', '正在转换'], ['verifying', '正在验证结果'],
    ['completed', '转换完成'], ['failed', '转换失败'], ['cancelled', '转换已取消'], ['interrupted', '转换已中断'],
  ] as const)('renders %s with localized progress or terminal status', async (status, label) => {
    const { api } = apiFor([job(status)])
    const wrapper = mountBlock(api)
    await flushPromises()
    expect(wrapper.text()).toContain(label)
    if (['queued', 'downloading_component', 'converting', 'verifying'].includes(status)) {
      expect(wrapper.get('[role="progressbar"]').attributes('aria-valuetext')).toContain(label)
      expect(wrapper.text()).toContain('48%')
    }
    if (status === 'failed') expect(wrapper.text()).toContain('请稍后重试')
  })

  it('offers download and system preview without exposing a reveal action or local path', async () => {
    const { api } = apiFor([job('completed')])
    const wrapper = mountBlock(api)
    await flushPromises()

    expect(wrapper.text()).toContain('result.png')
    expect(wrapper.text()).toContain('第 2 页')
    expect(wrapper.text()).not.toMatch(/\/Users\/|sha256|bytes|managedPath/i)
    expect(wrapper.get('[data-testid="conversion-save-copy"]').text()).toBe('下载')
    expect(wrapper.get('[data-testid="conversion-preview"]').text()).toBe('预览')
    expect(wrapper.find('[data-testid="conversion-reveal"]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('显示位置')
    await wrapper.get('[data-testid="conversion-save-copy"]').trigger('click')
    await wrapper.get('[data-testid="conversion-preview"]').trigger('click')
    await wrapper.get('[data-testid="conversion-delete"]').trigger('click')
    expect(api.conversion.saveCopy).toHaveBeenCalledWith({ artifactId: 'artifact_1' })
    expect(api.conversion.preview).toHaveBeenCalledWith({ artifactId: 'artifact_1' })
    expect(api.conversion.deleteArtifact).toHaveBeenCalledWith({ artifactId: 'artifact_1' })
  })

  it('keeps deleted outputs as an audit state and disables their actions', async () => {
    const { api } = apiFor([job('completed', {
      artifacts: [{ artifactId: 'artifact_1', status: 'deleted', displayName: 'result.png', detectedFormat: 'png', mimeType: 'image/png', byteSize: 1234 }],
    })])
    const wrapper = mountBlock(api, 'terminal')
    await flushPromises()
    expect(wrapper.text()).toContain('已删除')
    expect(wrapper.get('[data-testid="conversion-save-copy"]').attributes('disabled')).toBeDefined()
    expect(wrapper.get('[data-testid="conversion-preview"]').attributes('disabled')).toBeDefined()
    expect(wrapper.get('[data-testid="conversion-delete"]').attributes('disabled')).toBeDefined()
  })

  it('disables artifact actions while an opaque operation is pending', async () => {
    const { api } = apiFor([job('completed')])
    const save = deferred<{ saved: boolean }>()
    vi.mocked(api.conversion.saveCopy).mockReturnValue(save.promise)
    const wrapper = mountBlock(api)
    await flushPromises()
    await wrapper.get('[data-testid="conversion-save-copy"]').trigger('click')
    expect(wrapper.get('[data-testid="conversion-save-copy"]').attributes('disabled')).toBeDefined()
    save.resolve({ saved: true })
    await flushPromises()
    expect(wrapper.get('[data-testid="conversion-save-copy"]').attributes('disabled')).toBeUndefined()
  })

  it('offers an accessible cancel action for an active job and prevents duplicate cancellation while pending', async () => {
    const { api } = apiFor([job('converting')])
    const cancel = deferred<void>()
    vi.mocked(api.conversion.cancel).mockReturnValue(cancel.promise)
    const wrapper = mountBlock(api)
    await flushPromises()

    const button = wrapper.get('[data-testid="conversion-cancel"]')
    expect(button.attributes('aria-label')).toBe('取消 PNG 转换')
    await button.trigger('click')
    await button.trigger('click')

    expect(api.conversion.cancel).toHaveBeenCalledOnce()
    expect(api.conversion.cancel).toHaveBeenCalledWith({ jobId: 'job_1' })
    expect(button.attributes('disabled')).toBeDefined()
    cancel.resolve(undefined)
    await flushPromises()
    expect(button.attributes('disabled')).toBeUndefined()
  })

  it.each(['failed', 'cancelled', 'interrupted'] as const)(
    'offers an accessible retry action for a %s job and prevents duplicate retries while pending',
    async (status) => {
      const { api } = apiFor([job(status)])
      const retry = deferred<void>()
      vi.mocked(api.conversion.retry).mockReturnValue(retry.promise)
      const wrapper = mountBlock(api, 'terminal')
      await flushPromises()

      const button = wrapper.get('[data-testid="conversion-retry"]')
      expect(button.attributes('aria-label')).toBe('重试 PNG 转换')
      await button.trigger('click')
      await button.trigger('click')

      expect(api.conversion.retry).toHaveBeenCalledOnce()
      expect(api.conversion.retry).toHaveBeenCalledWith({ jobId: 'job_1' })
      expect(button.attributes('disabled')).toBeDefined()
      retry.resolve(undefined)
      await flushPromises()
      expect(button.attributes('disabled')).toBeUndefined()
    },
  )

  it('keeps a failed retry visible without exposing the underlying error', async () => {
    const { api } = apiFor([job('interrupted')])
    vi.mocked(api.conversion.retry).mockRejectedValue(new Error('/private/converter failed'))
    const wrapper = mountBlock(api, 'terminal')
    await flushPromises()

    await wrapper.get('[data-testid="conversion-retry"]').trigger('click')
    await flushPromises()

    expect(wrapper.get('[role="alert"]').text()).toContain('转换任务操作失败，请稍后重试')
    expect(wrapper.text()).not.toContain('/private/converter failed')
  })

  it('shows the cross-device local-only result notice without a local job', async () => {
    const { api } = apiFor([])
    vi.mocked(api.conversion.listForExecution).mockResolvedValue({ availability: 'unavailable', jobs: [] })
    const wrapper = mountBlock(api, 'terminal')
    await flushPromises()
    expect(wrapper.text()).toContain('转换结果仅在发起转换的设备上可用')
  })

  it('keeps local load failures distinct and clears them when a valid event arrives', async () => {
    const { api, emit } = apiFor([])
    vi.mocked(api.conversion.listForExecution).mockRejectedValue(new Error('offline'))
    const wrapper = mountBlock(api)
    await flushPromises()
    expect(wrapper.text()).toContain('本地转换结果加载失败')
    emit({ type: 'job_updated', job: job('completed') })
    await flushPromises()
    expect(wrapper.text()).toContain('转换完成')
    expect(wrapper.text()).not.toContain('本地转换结果加载失败')
  })

  it('releases the local conversion event subscription when its card unmounts', async () => {
    const { api, unsubscribe } = apiFor([job('queued')])
    const wrapper = mountBlock(api)
    await flushPromises()
    wrapper.unmount()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('does not let an older snapshot overwrite a newer event epoch and releases on reset', async () => {
    const pending = new Promise<{ availability: 'local'; jobs: ConversionJobView[] }>((resolve) => { setTimeout(() => resolve({ availability: 'local', jobs: [job('queued', { epoch: 1, progress: 0 })] }), 0) })
    const { api, unsubscribe, emit } = apiFor()
    vi.mocked(api.conversion.listForExecution).mockReturnValue(pending)
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const store = useConversionStore()
    const load = store.loadForExecution('execution_1')
    emit({ type: 'job_updated', job: job('completed', { epoch: 2, progress: 100 }) })
    await load

    expect(store.jobsForExecution('execution_1')[0]).toMatchObject({ status: 'completed', epoch: 2 })
    store.resetLocalData()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })

  it.each(['unavailable', 'reject'] as const)('ignores a late %s list result after a valid event', async (outcome) => {
    const response = deferred<{ availability: 'unavailable'; jobs: [] }>()
    const { api, emit } = apiFor()
    vi.mocked(api.conversion.listForExecution).mockReturnValue(
      outcome === 'unavailable' ? response.promise : new Promise((_, reject) => { response.promise.then(() => reject(new Error('late'))) }),
    )
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const store = useConversionStore()
    const load = store.loadForExecution('execution_1')
    emit({ type: 'job_updated', job: job('completed', { progress: 100 }) })
    response.resolve({ availability: 'unavailable', jobs: [] })
    await load

    expect(store.jobsForExecution('execution_1')).toEqual([expect.objectContaining({ status: 'completed' })])
    expect(store.unavailableByExecution.execution_1).toBeUndefined()
    expect(store.errorsByExecution.execution_1).toBeUndefined()
  })

  it('keeps same-epoch deleted outputs and unions fuller concurrent snapshots', async () => {
    const { api, emit } = apiFor([])
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const store = useConversionStore()
    store.applyEvent({ type: 'job_updated', job: job('completed', { artifacts: [{ artifactId: 'artifact_1', status: 'deleted', displayName: 'first.png', detectedFormat: 'png', mimeType: 'image/png', byteSize: 1 }] }) })
    vi.mocked(api.conversion.listForExecution).mockResolvedValue({ availability: 'local', jobs: [job('completed', { artifacts: [{ artifactId: 'artifact_1', status: 'ready', displayName: 'first.png', detectedFormat: 'png', mimeType: 'image/png', byteSize: 1 }, { artifactId: 'artifact_2', status: 'ready', displayName: 'second.png', detectedFormat: 'png', mimeType: 'image/png', byteSize: 1 }] })] })
    await store.loadForExecution('execution_1')
    expect(store.jobsForExecution('execution_1')[0]?.artifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({ artifactId: 'artifact_1', status: 'deleted' }),
      expect.objectContaining({ artifactId: 'artifact_2', status: 'ready' }),
    ]))
    emit({ type: 'job_updated', job: job('completed', { artifacts: [{ artifactId: 'artifact_2', status: 'ready', displayName: 'second.png', detectedFormat: 'png', mimeType: 'image/png', byteSize: 1 }] }) })
    expect(store.jobsForExecution('execution_1')[0]).toMatchObject({ status: 'completed' })
  })

  it('unions same-epoch representations and retains richer metadata from lower-rank observations', () => {
    const { api } = apiFor([])
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const store = useConversionStore()
    store.applyEvent({ type: 'job_updated', job: job('completed', { progress: 100, artifacts: [{
      artifactId: 'artifact_1', status: 'deleted', displayName: 'first.png', detectedFormat: 'png', mimeType: 'image/png', byteSize: 1,
      metadata: { iconRepresentations: [16], pdfPage: 2 },
    }] }) })
    store.applyEvent({ type: 'job_updated', job: job('converting', { progress: 30, artifacts: [{
      artifactId: 'artifact_1', status: 'ready', displayName: 'changed.png', detectedFormat: 'png', mimeType: 'image/png', byteSize: 99,
      metadata: { iconRepresentations: [32], frameSelection: 'first' },
    }] }) })
    expect(store.jobsForExecution('execution_1')[0]).toMatchObject({ status: 'completed', progress: 100, artifacts: [{
      artifactId: 'artifact_1', status: 'deleted', displayName: 'first.png', byteSize: 1,
      metadata: { iconRepresentations: [16, 32], pdfPage: 2, frameSelection: 'first' },
    }] })
  })

  it('releases the old module feed before a reloaded store creates one replacement feed', async () => {
    const { api, unsubscribe, emit } = apiFor([])
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const first = useConversionStore()
    first.ensureSubscription()
    expect(api.conversion.onEvent).toHaveBeenCalledTimes(1)

    first.resetLocalData()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
    vi.resetModules()
    const reloaded = await import('../../src/stores/conversion')
    const second = reloaded.useConversionStore()
    second.ensureSubscription()
    emit({ type: 'job_updated', job: job('completed') })

    expect(api.conversion.onEvent).toHaveBeenCalledTimes(2)
    expect(second.jobsForExecution('execution_1')).toHaveLength(1)
  })

  it('is rendered by MessageBlock without exposing conversion payload fields', async () => {
    const { api } = apiFor([job('completed')])
    Object.defineProperty(window, 'autoForge', { configurable: true, value: api })
    const wrapper = mount(MessageBlock, {
      props: { block: { id: 'message_1:conversion_1', type: 'conversion', blockId: 'conversion_1', executionId: 'execution_1', state: 'terminal' } },
      global: { plugins: [createPinia()] },
    })
    await flushPromises()
    expect(wrapper.text()).toContain('转换完成')
  })
})
