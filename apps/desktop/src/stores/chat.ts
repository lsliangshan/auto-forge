import { acceptHMRUpdate, defineStore } from 'pinia'
import type {
  ChatBlock,
  ChatEvent,
  ChatMessage,
  ChatSendInput,
  ConversationGenerationPreferences,
  ConversationSummary,
  DesktopAPI,
  GenerationOptions,
  MediaAsset,
} from '@autoforge/shared'
import { displayError, getDesktopApi } from '../services/desktop-api'

export type UiChatBlock = ChatBlock & { id: string }
export interface UiChatMessage { id: string; role: 'user' | 'assistant'; blocks: UiChatBlock[] }
export type ChatSendAcknowledgement = (accepted: boolean) => void

interface ChatHub { listeners: Set<(event: ChatEvent) => void>; unsubscribe: () => void }
const hubs = new WeakMap<DesktopAPI, ChatHub>()
const storeReleases = new WeakMap<object, () => void>()
const disposeWrapped = new WeakSet<object>()
const preferenceQueues = new WeakMap<object, Map<string, Promise<void>>>()
const mediaQueues = new WeakMap<object, Map<string, Promise<void>>>()
const closedMediaAdmissions = new WeakMap<object, Set<string>>()
let localMessageSequence = 0

function defaultGenerationPreferences(): ConversationGenerationPreferences {
  return {
    outputType: 'auto',
    models: {},
    generation: {
      image: { count: 1, resolution: '1K', aspectRatio: 'auto', format: 'png' },
      audio: { format: 'mp3' },
      video: { durationSeconds: 5, resolution: '720p', aspectRatio: 'auto', generateAudio: false },
    },
  }
}

function copyGenerationOptions(generation: GenerationOptions): GenerationOptions {
  return {
    image: { ...generation.image },
    audio: { ...generation.audio },
    video: { ...generation.video },
  }
}

function copyGenerationPreferences(
  preferences: ConversationGenerationPreferences,
): ConversationGenerationPreferences {
  return {
    outputType: preferences.outputType,
    models: { ...preferences.models },
    generation: copyGenerationOptions(preferences.generation),
  }
}

function acquireChatEvents(api: DesktopAPI, listener: (event: ChatEvent) => void): () => void {
  const existing = hubs.get(api)
  const hub: ChatHub = existing ?? { listeners: new Set(), unsubscribe: () => undefined }
  if (!existing) {
    hub.unsubscribe = api.chat.onEvent((event) => {
    for (const listener of hub.listeners) listener(event)
    })
    hubs.set(api, hub)
  }
  hub.listeners.add(listener)
  let active = true
  return () => {
    if (!active) return
    active = false
    hub.listeners.delete(listener)
    if (!hub.listeners.size) {
      hub.unsubscribe()
      hubs.delete(api)
    }
  }
}

function blockIdentity(messageId: string, block: ChatBlock, index: number): string {
  if ('blockId' in block) return `${messageId}:${block.blockId}`
  if ('executionId' in block) return `${messageId}:${block.type}:${block.executionId}`
  if (block.type === 'error') return `${messageId}:error:${block.code}`
  return `${messageId}:${block.type}:${index}`
}

function persistedMessage(message: ChatMessage): UiChatMessage {
  return {
    id: message.id,
    role: message.role,
    blocks: message.blocks.map((block, index) => ({ ...block, id: blockIdentity(message.id, block, index) })),
  }
}

function appendTextDelta(current: string, delta: string): string {
  let overlap = Math.min(current.length, delta.length)
  while (overlap > 0 && !current.endsWith(delta.slice(0, overlap))) overlap -= 1
  return current + delta.slice(overlap)
}

function mergeMessageBlocks(
  messageId: string,
  persisted: UiChatBlock[],
  live: UiChatBlock[],
): UiChatBlock[] {
  const blocks = [...persisted]
  let cursor = 0
  const nextAnchorIndex = (liveIndex: number): number => {
    for (let index = liveIndex + 1; index < live.length; index += 1) {
      const candidate = live[index]!
      if (candidate.type === 'text') continue
      const anchorIndex = blocks.findIndex((block, blockIndex) =>
        blockIndex >= cursor && block.id === candidate.id)
      if (anchorIndex >= 0) return anchorIndex
    }
    return blocks.length
  }

  for (let liveIndex = 0; liveIndex < live.length; liveIndex += 1) {
    const liveBlock = live[liveIndex]!
    if (liveBlock.type === 'text') {
      const boundary = nextAnchorIndex(liveIndex)
      const previousIndex = boundary - 1
      const previous = previousIndex >= cursor ? blocks[previousIndex] : undefined
      if (previous?.type === 'text') {
        blocks[previousIndex] = {
          ...previous,
          text: appendTextDelta(previous.text, liveBlock.text),
        }
        cursor = previousIndex + 1
      } else {
        blocks.splice(boundary, 0, {
          ...liveBlock,
          id: blockIdentity(messageId, liveBlock, boundary),
        })
        cursor = boundary + 1
      }
      continue
    }

    const existingIndex = blocks.findIndex(({ id }) => id === liveBlock.id)
    if (existingIndex >= 0) {
      blocks[existingIndex] = liveBlock
      cursor = Math.max(cursor, existingIndex + 1)
    } else {
      const boundary = nextAnchorIndex(liveIndex)
      blocks.splice(boundary, 0, liveBlock)
      cursor = boundary + 1
    }
  }
  return blocks
}

function mergeMessageSnapshots(
  persisted: UiChatMessage[],
  live: UiChatMessage[],
): UiChatMessage[] {
  const liveMessages = new Map(live.map((message) => [message.id, message]))
  const persistedIds = new Set(persisted.map(({ id }) => id))
  const merged = persisted.map((message) => {
    const liveMessage = liveMessages.get(message.id)
    if (!liveMessage) return message
    return {
      ...message,
      role: liveMessage.role,
      blocks: mergeMessageBlocks(message.id, message.blocks, liveMessage.blocks),
    }
  })
  return [
    ...merged,
    ...live.filter(({ id }) => !persistedIds.has(id)),
  ]
}

function sortConversations(conversations: ConversationSummary[]): ConversationSummary[] {
  return [...conversations].sort((left, right) => (
    right.lastActivityAt.localeCompare(left.lastActivityAt) || left.id.localeCompare(right.id)
  ))
}

function mergeConversationPages(
  existing: ConversationSummary[],
  incoming: ConversationSummary[],
): ConversationSummary[] {
  const byId = new Map(existing.map((conversation) => [conversation.id, conversation]))
  for (const conversation of incoming) byId.set(conversation.id, conversation)
  return sortConversations([...byId.values()])
}

function mergeHistoryPages(older: UiChatMessage[], current: UiChatMessage[]): UiChatMessage[] {
  const order: string[] = []
  const byId = new Map<string, UiChatMessage>()
  for (const message of [...older, ...current]) {
    const existing = byId.get(message.id)
    if (!existing) {
      order.push(message.id)
      byId.set(message.id, message)
      continue
    }
    byId.set(message.id, mergeMessageSnapshots([existing], [message])[0]!)
  }
  return order.map((id) => byId.get(id)!)
}

function closedAdmissions(store: object): Set<string> {
  let closed = closedMediaAdmissions.get(store)
  if (!closed) {
    closed = new Set()
    closedMediaAdmissions.set(store, closed)
  }
  return closed
}

export const useChatStore = defineStore('chat', {
  state: () => ({
    conversations: [] as ConversationSummary[],
    nextConversationCursor: undefined as string | undefined,
    selectedConversationId: '' as string,
    messagesByConversation: {} as Record<string, UiChatMessage[]>,
    previousMessageCursorByConversation: {} as Record<string, string | undefined>,
    draftsByConversation: {} as Record<string, MediaAsset[]>,
    preferencesByConversation: {} as Record<string, ConversationGenerationPreferences>,
    pendingRequestByConversation: {} as Record<string, true>,
    activeRequestByConversation: {} as Record<string, string>,
    awaitingResponseByConversation: {} as Record<string, true>,
    _cancelRequestedByConversation: {} as Record<string, true>,
    _terminalRequests: {} as Record<string, true>,
    loading: false,
    error: '' as string,
    _loadVersion: 0,
    _selectionVersion: 0,
    _messageVersions: {} as Record<string, number>,
    _messageLoadVersions: {} as Record<string, number>,
    _conversationPageRequests: {} as Record<string, true>,
    _messagePageRequests: {} as Record<string, true>,
    _preferenceVersions: {} as Record<string, number>,
    _stateEpoch: 0,
    _subscribed: false,
  }),
  getters: {
    messages(state): UiChatMessage[] { return state.messagesByConversation[state.selectedConversationId] ?? [] },
    messageVersion(state): number {
      return state._messageVersions[state.selectedConversationId] ?? 0
    },
    drafts(state): MediaAsset[] { return state.draftsByConversation[state.selectedConversationId] ?? [] },
    preferences(state): ConversationGenerationPreferences {
      return state.preferencesByConversation[state.selectedConversationId] ?? defaultGenerationPreferences()
    },
    isRunning(state): boolean {
      const conversationId = state.selectedConversationId
      return Boolean(
        state.pendingRequestByConversation[conversationId]
          || state.activeRequestByConversation[conversationId],
      )
    },
    isAwaitingResponse(state): boolean {
      return Boolean(state.awaitingResponseByConversation[state.selectedConversationId])
    },
  },
  actions: {
    resetLocalData() {
      this._loadVersion += 1
      this._selectionVersion += 1
      this._stateEpoch += 1
      storeReleases.get(this)?.()
      storeReleases.delete(this)
      this._subscribed = false
      this.conversations = []
      this.nextConversationCursor = undefined
      this.selectedConversationId = ''
      this.messagesByConversation = {}
      this.previousMessageCursorByConversation = {}
      this.draftsByConversation = {}
      this.preferencesByConversation = {}
      this.pendingRequestByConversation = {}
      this.activeRequestByConversation = {}
      this.awaitingResponseByConversation = {}
      this._cancelRequestedByConversation = {}
      this._terminalRequests = {}
      this._messageVersions = {}
      this._messageLoadVersions = {}
      this._conversationPageRequests = {}
      this._messagePageRequests = {}
      this._preferenceVersions = {}
      closedMediaAdmissions.delete(this)
      this.loading = false
      this.error = ''
    },
    ensureSubscriptions() {
      if (this._subscribed) return
      this._subscribed = true
      const release = acquireChatEvents(getDesktopApi(), (event) => this.applyChatEvent(event))
      storeReleases.set(this, release)
      if (!disposeWrapped.has(this)) {
        disposeWrapped.add(this)
        const dispose = this.$dispose.bind(this)
        this.$dispose = () => {
          storeReleases.get(this)?.()
          storeReleases.delete(this)
          this._subscribed = false
          dispose()
        }
      }
    },
    async loadConversations() {
      this.ensureSubscriptions()
      const requestKey = 'initial'
      if (this._conversationPageRequests[requestKey]) return
      const version = ++this._loadVersion
      this._conversationPageRequests[requestKey] = true
      this.loading = true
      this.error = ''
      try {
        const page = await getDesktopApi().chat.listConversations({ limit: 50 })
        if (version !== this._loadVersion) return
        const selected = this.conversations.find(({ id }) => id === this.selectedConversationId)
        this.conversations = mergeConversationPages(selected ? [selected] : [], page.items)
        this.nextConversationCursor = page.nextCursor
        if (!this.selectedConversationId) {
          this.selectedConversationId = this.conversations[0]?.id ?? ''
          this._selectionVersion += 1
        }
        if (this.selectedConversationId) {
          await Promise.all([
            this.messagesByConversation[this.selectedConversationId] === undefined
              ? this.loadMessages(this.selectedConversationId)
              : undefined,
            this.preferencesByConversation[this.selectedConversationId] === undefined
              ? this.loadGenerationPreferences(this.selectedConversationId)
              : undefined,
          ])
        }
      } catch (error) {
        if (version === this._loadVersion) this.error = displayError(error, '会话加载失败')
      } finally {
        delete this._conversationPageRequests[requestKey]
        if (version === this._loadVersion) this.loading = false
      }
    },
    async loadMoreConversations() {
      const cursor = this.nextConversationCursor
      if (!cursor || this._conversationPageRequests[cursor]) return
      this._conversationPageRequests[cursor] = true
      try {
        const page = await getDesktopApi().chat.listConversations({ limit: 50, cursor })
        if (this.nextConversationCursor !== cursor) return
        this.conversations = mergeConversationPages(this.conversations, page.items)
        this.nextConversationCursor = page.nextCursor
      } catch (error) {
        this.error = displayError(error, '会话加载失败')
      } finally {
        delete this._conversationPageRequests[cursor]
      }
    },
    async createConversation() {
      this.error = ''
      try {
        const conversation = await getDesktopApi().chat.createConversation()
        this._loadVersion += 1
        this.loading = false
        this.conversations = mergeConversationPages(this.conversations, [conversation])
        closedAdmissions(this).delete(conversation.id)
        this.selectedConversationId = conversation.id
        this._selectionVersion += 1
        await this.loadGenerationPreferences(conversation.id)
      } catch (error) { this.error = displayError(error, '创建会话失败') }
    },
    async renameConversation(id: string, title: string) {
      const clean = title.trim()
      if (!clean) return
      try {
        const updated = await getDesktopApi().chat.renameConversation(id, clean)
        this._loadVersion += 1
        this.loading = false
        const index = this.conversations.findIndex((item) => item.id === id)
        if (index >= 0) this.conversations = mergeConversationPages(
          this.conversations.filter((item) => item.id !== id),
          [updated],
        )
      } catch (error) { this.error = displayError(error, '重命名失败') }
    },
    async deleteConversation(id: string) {
      const admissions = closedAdmissions(this)
      if (admissions.has(id)) return
      admissions.add(id)
      await this.queueMediaOperation(id, async () => {
        try {
          await getDesktopApi().chat.deleteConversation(id)
          this._loadVersion += 1
          this.loading = false
          this.conversations = this.conversations.filter((item) => item.id !== id)
          delete this.messagesByConversation[id]
          delete this.previousMessageCursorByConversation[id]
          delete this.draftsByConversation[id]
          delete this.preferencesByConversation[id]
          delete this.pendingRequestByConversation[id]
          delete this.activeRequestByConversation[id]
          delete this.awaitingResponseByConversation[id]
          delete this._cancelRequestedByConversation[id]
          delete this._messageVersions[id]
          delete this._messageLoadVersions[id]
          this._preferenceVersions[id] = (this._preferenceVersions[id] ?? 0) + 1
          if (this.selectedConversationId === id) {
            this.selectedConversationId = this.conversations[0]?.id ?? ''
            this._selectionVersion += 1
            if (this.selectedConversationId) {
              await Promise.all([
                this.messagesByConversation[this.selectedConversationId] === undefined
                  ? this.loadMessages(this.selectedConversationId)
                  : undefined,
                this.preferencesByConversation[this.selectedConversationId] === undefined
                  ? this.loadGenerationPreferences(this.selectedConversationId)
                  : undefined,
              ])
            }
          }
        } catch (error) {
          admissions.delete(id)
          this.error = displayError(error, '删除会话失败')
        }
      })
    },
    async selectConversation(id: string) {
      if (this.selectedConversationId !== id) {
        this.selectedConversationId = id
        this._selectionVersion += 1
      }
      await Promise.all([
        this.messagesByConversation[id] === undefined ? this.loadMessages(id) : undefined,
        this.preferencesByConversation[id] === undefined ? this.loadGenerationPreferences(id) : undefined,
      ])
    },
    async loadMessages(conversationId: string) {
      const requestKey = `${conversationId}:latest`
      if (this._messagePageRequests[requestKey]) return
      const selectionVersion = this._selectionVersion
      const mutationVersion = this._messageVersions[conversationId] ?? 0
      const loadVersion = (this._messageLoadVersions[conversationId] ?? 0) + 1
      this._messageLoadVersions[conversationId] = loadVersion
      this._messagePageRequests[requestKey] = true
      try {
        const page = await getDesktopApi().chat.listMessages({ conversationId, limit: 100 })
        if (this.selectedConversationId !== conversationId
          || selectionVersion !== this._selectionVersion
          || loadVersion !== this._messageLoadVersions[conversationId]) return
        const snapshot = page.items.map(persistedMessage)
        this.previousMessageCursorByConversation[conversationId] = page.previousCursor
        if (mutationVersion !== (this._messageVersions[conversationId] ?? 0)) {
          this.messagesByConversation[conversationId] = mergeMessageSnapshots(
            snapshot,
            this.messagesByConversation[conversationId] ?? [],
          )
        } else {
          this.messagesByConversation[conversationId] = snapshot
        }
      } catch (error) {
        if (this.selectedConversationId === conversationId && selectionVersion === this._selectionVersion) {
          this.error = displayError(error, '消息记录加载失败')
        }
      } finally {
        delete this._messagePageRequests[requestKey]
      }
    },
    async loadOlderMessages(conversationId: string) {
      const cursor = this.previousMessageCursorByConversation[conversationId]
      const requestKey = `${conversationId}:${cursor ?? 'complete'}`
      if (!cursor || this._messagePageRequests[requestKey]) return
      this._messagePageRequests[requestKey] = true
      try {
        const page = await getDesktopApi().chat.listMessages({
          conversationId,
          limit: 100,
          cursor,
        })
        if (this.previousMessageCursorByConversation[conversationId] !== cursor) return
        this.messagesByConversation[conversationId] = mergeHistoryPages(
          page.items.map(persistedMessage),
          this.messagesByConversation[conversationId] ?? [],
        )
        this.previousMessageCursorByConversation[conversationId] = page.previousCursor
      } catch (error) {
        if (this.selectedConversationId === conversationId) {
          this.error = displayError(error, '消息记录加载失败')
        }
      } finally {
        delete this._messagePageRequests[requestKey]
      }
    },
    async retrySync(conversationId: string) {
      try {
        await getDesktopApi().chat.retrySync(conversationId)
        await this.loadConversations()
      } catch (error) {
        this.error = displayError(error, '同步重试失败')
      }
    },
    async loadGenerationPreferences(conversationId: string) {
      const epoch = this._stateEpoch
      const version = (this._preferenceVersions[conversationId] ?? 0) + 1
      this._preferenceVersions[conversationId] = version
      try {
        const preferences = await getDesktopApi().chat.getGenerationPreferences(conversationId)
        if (epoch !== this._stateEpoch || version !== this._preferenceVersions[conversationId]) return
        this.preferencesByConversation[conversationId] = preferences
      } catch (error) {
        if (epoch === this._stateEpoch
          && version === this._preferenceVersions[conversationId]
          && this.selectedConversationId === conversationId) {
          this.error = displayError(error, '生成设置加载失败')
        }
      }
    },
    async updateGenerationPreferences(
      conversationId: string,
      preferences: ConversationGenerationPreferences,
    ) {
      if (!conversationId) return
      const epoch = this._stateEpoch
      const version = (this._preferenceVersions[conversationId] ?? 0) + 1
      this._preferenceVersions[conversationId] = version
      const snapshot = copyGenerationPreferences(preferences)
      this.preferencesByConversation[conversationId] = snapshot
      let queues = preferenceQueues.get(this)
      if (!queues) {
        queues = new Map()
        preferenceQueues.set(this, queues)
      }
      const previous = queues.get(conversationId) ?? Promise.resolve()
      let saved: ConversationGenerationPreferences | undefined
      const operation = previous
        .catch(() => undefined)
        .then(async () => {
          saved = await getDesktopApi().chat.updateGenerationPreferences(conversationId, snapshot)
        })
      const settled = operation.catch(() => undefined)
      queues.set(conversationId, settled)
      try {
        await operation
        if (saved
          && epoch === this._stateEpoch
          && version === this._preferenceVersions[conversationId]) {
          this.preferencesByConversation[conversationId] = saved
        }
      } catch (error) {
        if (epoch === this._stateEpoch && this.selectedConversationId === conversationId) {
          this.error = displayError(error, '生成设置保存失败')
        }
      } finally {
        if (queues.get(conversationId) === settled) queues.delete(conversationId)
      }
    },
    async queueMediaOperation(conversationId: string, operation: () => Promise<void>) {
      let queues = mediaQueues.get(this)
      if (!queues) {
        queues = new Map()
        mediaQueues.set(this, queues)
      }
      const previous = queues.get(conversationId) ?? Promise.resolve()
      const queued = previous.catch(() => undefined).then(operation)
      const settled = queued.catch(() => undefined)
      queues.set(conversationId, settled)
      try {
        await queued
      } finally {
        if (queues.get(conversationId) === settled) queues.delete(conversationId)
      }
    },
    reportConversationError(conversationId: string, epoch: number, message: string) {
      if (epoch === this._stateEpoch && conversationId === this.selectedConversationId) {
        this.error = message
      }
    },
    async acceptImportedDrafts(
      conversationId: string,
      epoch: number,
      assets: MediaAsset[],
    ) {
      const current = this.draftsByConversation[conversationId] ?? []
      const currentIds = new Set(current.map(({ id }) => id))
      const imported = assets.filter(({ id }, index) =>
        !currentIds.has(id) && assets.findIndex((asset) => asset.id === id) === index)
      if (epoch !== this._stateEpoch) {
        await Promise.allSettled(imported.map(({ id }) =>
          getDesktopApi().media.removeDraft({ conversationId, assetId: id })))
        return
      }
      if (current.length + imported.length <= 5) {
        this.draftsByConversation[conversationId] = [...current, ...imported]
        return
      }
      const cleanup = await Promise.allSettled(imported.map(({ id }) =>
        getDesktopApi().media.removeDraft({ conversationId, assetId: id })))
      const visibleCleanupFailures = imported.filter((_, index) => cleanup[index]?.status === 'rejected')
      if (visibleCleanupFailures.length) {
        this.draftsByConversation[conversationId] = [...current, ...visibleCleanupFailures]
      }
      this.reportConversationError(conversationId, epoch, '附件导入结果超过 5 个，已拒绝本次导入')
    },
    async pickDraftFiles() {
      const conversationId = this.selectedConversationId
      const epoch = this._stateEpoch
      if (!conversationId || closedAdmissions(this).has(conversationId)) return
      await this.queueMediaOperation(conversationId, async () => {
        if (epoch !== this._stateEpoch) return
        const existing = this.draftsByConversation[conversationId] ?? []
        if (existing.length >= 5) {
          this.reportConversationError(conversationId, epoch, '每条消息最多添加 5 个附件')
          return
        }
        try {
          const assets = await getDesktopApi().media.pickFiles({
            conversationId,
            existingAssetIds: existing.map(({ id }) => id),
          })
          await this.acceptImportedDrafts(conversationId, epoch, assets)
        } catch (error) {
          this.reportConversationError(conversationId, epoch, displayError(error, '附件导入失败'))
        }
      })
    },
    async importDroppedDrafts(files: readonly File[]) {
      const conversationId = this.selectedConversationId
      const epoch = this._stateEpoch
      if (!conversationId
        || files.length === 0
        || closedAdmissions(this).has(conversationId)) return
      await this.queueMediaOperation(conversationId, async () => {
        if (epoch !== this._stateEpoch) return
        const existing = this.draftsByConversation[conversationId] ?? []
        if (existing.length + files.length > 5) {
          this.reportConversationError(conversationId, epoch, '每条消息最多添加 5 个附件')
          return
        }
        try {
          const assets = await getDesktopApi().media.importDroppedFiles({
            conversationId,
            existingAssetIds: existing.map(({ id }) => id),
          }, files)
          await this.acceptImportedDrafts(conversationId, epoch, assets)
        } catch (error) {
          this.reportConversationError(conversationId, epoch, displayError(error, '附件导入失败'))
        }
      })
    },
    async importClipboardDraft() {
      const conversationId = this.selectedConversationId
      const epoch = this._stateEpoch
      if (!conversationId || closedAdmissions(this).has(conversationId)) return
      await this.queueMediaOperation(conversationId, async () => {
        if (epoch !== this._stateEpoch) return
        const existing = this.draftsByConversation[conversationId] ?? []
        if (existing.length >= 5) {
          this.reportConversationError(conversationId, epoch, '每条消息最多添加 5 个附件')
          return
        }
        try {
          const assets = await getDesktopApi().media.importClipboardImage({
            conversationId,
            existingAssetIds: existing.map(({ id }) => id),
          })
          await this.acceptImportedDrafts(conversationId, epoch, assets)
        } catch (error) {
          this.reportConversationError(conversationId, epoch, displayError(error, '剪贴板图片导入失败'))
        }
      })
    },
    async removeDraft(assetId: string) {
      const conversationId = this.selectedConversationId
      const epoch = this._stateEpoch
      if (!conversationId || closedAdmissions(this).has(conversationId)) return
      await this.queueMediaOperation(conversationId, async () => {
        if (epoch !== this._stateEpoch) return
        try {
          await getDesktopApi().media.removeDraft({ conversationId, assetId })
          if (epoch === this._stateEpoch) {
            this.draftsByConversation[conversationId] = (this.draftsByConversation[conversationId] ?? [])
              .filter(({ id }) => id !== assetId)
          }
        } catch (error) {
          this.reportConversationError(conversationId, epoch, displayError(error, '附件移除失败'))
        }
      })
    },
    async send(input: Omit<ChatSendInput, 'conversationId'>): Promise<boolean> {
      const clean = input.content.trim()
      if ((!clean && input.assetIds.length === 0)
        || (!clean && input.outputType !== 'text')
        || !this.selectedConversationId
        || this.isRunning) return false
      const conversationId = this.selectedConversationId
      const epoch = this._stateEpoch
      this.pendingRequestByConversation[conversationId] = true
      this.awaitingResponseByConversation[conversationId] = true
      const drafts = this.draftsByConversation[conversationId] ?? []
      const draftById = new Map(drafts.map((asset) => [asset.id, asset]))
      const localId = `local-${Date.now()}-${++localMessageSequence}`
      const blocks: UiChatBlock[] = []
      if (clean) blocks.push({ id: `${localId}:text:0`, type: 'text', text: clean })
      for (const assetId of input.assetIds) {
        const asset = draftById.get(assetId)
        if (!asset) continue
        const blockId = `draft:${asset.id}`
        blocks.push({
          id: `${localId}:${blockId}`,
          type: 'media',
          blockId,
          assetId: asset.id,
          kind: asset.kind,
          purpose: 'input',
          name: asset.name,
          mimeType: asset.mimeType,
          byteSize: asset.byteSize,
          ...(asset.width === undefined ? {} : { width: asset.width }),
          ...(asset.height === undefined ? {} : { height: asset.height }),
          ...(asset.durationMs === undefined ? {} : { durationMs: asset.durationMs }),
        })
      }
      const message: UiChatMessage = {
        id: localId,
        role: 'user',
        blocks,
      }
      const messages = this.messagesByConversation[conversationId] ?? []
      this.messagesByConversation[conversationId] = [...messages, message]
      this._messageVersions[conversationId] = (this._messageVersions[conversationId] ?? 0) + 1
      this.error = ''
      try {
        const api = getDesktopApi()
        const result = await api.chat.send({
          conversationId,
          content: clean,
          assetIds: [...input.assetIds],
          outputType: input.outputType,
          generation: copyGenerationOptions(input.generation),
          ...(input.model ? { model: input.model } : {}),
        })
        delete this.pendingRequestByConversation[conversationId]
        const sentIds = new Set(input.assetIds)
        this.draftsByConversation[conversationId] = (this.draftsByConversation[conversationId] ?? [])
          .filter(({ id }) => !sentIds.has(id))
        const alreadyTerminal = Boolean(this._terminalRequests[result.requestId])
        if (alreadyTerminal) delete this._terminalRequests[result.requestId]
        else this.activeRequestByConversation[conversationId] = result.requestId
        const cancellationRequested = Boolean(this._cancelRequestedByConversation[conversationId])
        delete this._cancelRequestedByConversation[conversationId]
        if (cancellationRequested && !alreadyTerminal) {
          try {
            await api.chat.cancel(result.requestId)
          } catch (error) {
            this.reportConversationError(
              conversationId,
              epoch,
              displayError(error, '取消生成失败'),
            )
          }
        }
        return true
      } catch (error) {
        delete this.pendingRequestByConversation[conversationId]
        delete this.awaitingResponseByConversation[conversationId]
        delete this._cancelRequestedByConversation[conversationId]
        this.messagesByConversation[conversationId] = (this.messagesByConversation[conversationId] ?? [])
          .filter(({ id }) => id !== localId)
        this._messageVersions[conversationId] = (this._messageVersions[conversationId] ?? 0) + 1
        this.reportConversationError(conversationId, epoch, displayError(error, '消息发送失败'))
        return false
      }
    },
    async cancelCurrent() {
      const conversationId = this.selectedConversationId
      const requestId = this.activeRequestByConversation[conversationId]
      if (!requestId) {
        if (this.pendingRequestByConversation[conversationId]) {
          this._cancelRequestedByConversation[conversationId] = true
        }
        return
      }
      try { await getDesktopApi().chat.cancel(requestId) }
      catch (error) { this.error = displayError(error, '取消生成失败') }
    },
    applyChatEvent(event: ChatEvent) {
      if (event.type === 'conversation_title_updated') {
        const index = this.conversations.findIndex(({ id }) => id === event.conversationId)
        if (index >= 0) {
          const updated = {
            ...this.conversations[index]!,
            title: event.title,
            metadataUpdatedAt: event.updatedAt,
          }
          this.conversations = mergeConversationPages(
            this.conversations.filter(({ id }) => id !== event.conversationId),
            [updated],
          )
        }
        return
      }
      if (event.type === 'status') {
        if (event.status === 'running') {
          if (!this._terminalRequests[event.requestId]) this.activeRequestByConversation[event.conversationId] = event.requestId
        } else {
          delete this.awaitingResponseByConversation[event.conversationId]
          const matchedActive = this.activeRequestByConversation[event.conversationId] === event.requestId
          if (matchedActive) delete this.activeRequestByConversation[event.conversationId]
          if (this.pendingRequestByConversation[event.conversationId] || !matchedActive) {
            this._terminalRequests[event.requestId] = true
            const terminalRequestIds = Object.keys(this._terminalRequests)
            if (terminalRequestIds.length > 100) delete this._terminalRequests[terminalRequestIds[0]!]
          }
        }
        if (event.status === 'failed'
          && event.error
          && event.conversationId === this.selectedConversationId) {
          this.error = displayError(event.error, '消息发送失败')
        }
        return
      }
      delete this.awaitingResponseByConversation[event.conversationId]
      this._messageVersions[event.conversationId] = (this._messageVersions[event.conversationId] ?? 0) + 1
      const messages = this.messagesByConversation[event.conversationId] ?? []
      let message = messages.find(({ id }) => id === event.messageId)
      if (!message) {
        message = { id: event.messageId, role: 'assistant', blocks: [] }
        this.messagesByConversation[event.conversationId] = [...messages, message]
      }
      if (event.type === 'block_update') {
        const index = message.blocks.findIndex((block) =>
          'blockId' in block && block.blockId === event.blockId)
        if (index >= 0) {
          message.blocks[index] = {
            ...event.block,
            id: `${event.messageId}:${event.blockId}`,
          }
        } else {
          message.blocks.push({
            ...event.block,
            id: `${event.messageId}:${event.blockId}`,
          })
        }
        return
      }
      if (event.block.type === 'text') {
        const previous = message.blocks.at(-1)
        if (previous?.type === 'text') previous.text += event.block.text
        else message.blocks.push({ ...event.block, id: blockIdentity(event.messageId, event.block, message.blocks.length) })
        return
      }
      const id = blockIdentity(event.messageId, event.block, message.blocks.length)
      const existingIndex = message.blocks.findIndex((block) => block.id === id)
      if (existingIndex >= 0) {
        if (event.block.type === 'approval'
          || event.block.type === 'browser_status'
          || event.block.type === 'workflow_status'
          || event.block.type === 'workflow_provenance') {
          message.blocks[existingIndex] = { ...event.block, id }
        }
        return
      }
      message.blocks.push({ ...event.block, id })
    },
  },
})

if (import.meta.hot) import.meta.hot.accept(acceptHMRUpdate(useChatStore, import.meta.hot))
