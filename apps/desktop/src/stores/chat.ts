import { defineStore } from 'pinia'
import type { ChatBlock, ChatEvent, ChatMessage, ConversationSummary, DesktopAPI } from '@autoforge/shared'
import { displayError, getDesktopApi } from '../services/desktop-api'

export type UiChatBlock = ChatBlock & { id: string }
export interface UiChatMessage { id: string; role: 'user' | 'assistant'; blocks: UiChatBlock[] }

interface ChatHub { listeners: Set<(event: ChatEvent) => void> }
const hubs = new WeakMap<DesktopAPI, ChatHub>()

function chatHub(api: DesktopAPI): ChatHub {
  const existing = hubs.get(api)
  if (existing) return existing
  const hub: ChatHub = { listeners: new Set() }
  api.chat.onEvent((event) => {
    for (const listener of hub.listeners) listener(event)
  })
  hubs.set(api, hub)
  return hub
}

function blockIdentity(messageId: string, block: ChatBlock, index: number): string {
  if (block.type === 'approval') return `${messageId}:approval:${block.executionId}:${block.permissionIndex}:${block.scopeHash}`
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

export const useChatStore = defineStore('chat', {
  state: () => ({
    conversations: [] as ConversationSummary[],
    selectedConversationId: '' as string,
    messagesByConversation: {} as Record<string, UiChatMessage[]>,
    activeRequestByConversation: {} as Record<string, string>,
    _terminalRequests: {} as Record<string, true>,
    loading: false,
    error: '' as string,
    _loadVersion: 0,
    _selectionVersion: 0,
    _messageVersions: {} as Record<string, number>,
    _subscribed: false,
  }),
  getters: {
    messages(state): UiChatMessage[] { return state.messagesByConversation[state.selectedConversationId] ?? [] },
    isRunning(state): boolean { return Boolean(state.activeRequestByConversation[state.selectedConversationId]) },
  },
  actions: {
    ensureSubscriptions() {
      if (this._subscribed) return
      this._subscribed = true
      chatHub(getDesktopApi()).listeners.add((event) => this.applyChatEvent(event))
    },
    async loadConversations() {
      this.ensureSubscriptions()
      const version = ++this._loadVersion
      this.loading = true
      this.error = ''
      try {
        const conversations = await getDesktopApi().chat.listConversations()
        if (version !== this._loadVersion) return
        this.conversations = conversations
        if (!conversations.some(({ id }) => id === this.selectedConversationId)) {
          this.selectedConversationId = conversations[0]?.id ?? ''
          this._selectionVersion += 1
        }
        if (this.selectedConversationId && this.messagesByConversation[this.selectedConversationId] === undefined) {
          await this.loadMessages(this.selectedConversationId)
        }
      } catch (error) {
        if (version === this._loadVersion) this.error = displayError(error, '会话加载失败')
      } finally {
        if (version === this._loadVersion) this.loading = false
      }
    },
    async createConversation() {
      this.error = ''
      try {
        const conversation = await getDesktopApi().chat.createConversation()
        this.conversations.unshift(conversation)
        this.selectedConversationId = conversation.id
      } catch (error) { this.error = displayError(error, '创建会话失败') }
    },
    async renameConversation(id: string, title: string) {
      const clean = title.trim()
      if (!clean) return
      try {
        const updated = await getDesktopApi().chat.renameConversation(id, clean)
        const index = this.conversations.findIndex((item) => item.id === id)
        if (index >= 0) this.conversations[index] = updated
      } catch (error) { this.error = displayError(error, '重命名失败') }
    },
    async deleteConversation(id: string) {
      try {
        await getDesktopApi().chat.deleteConversation(id)
        this.conversations = this.conversations.filter((item) => item.id !== id)
        delete this.messagesByConversation[id]
        if (this.selectedConversationId === id) {
          this.selectedConversationId = this.conversations[0]?.id ?? ''
          this._selectionVersion += 1
          if (this.selectedConversationId && this.messagesByConversation[this.selectedConversationId] === undefined) {
            await this.loadMessages(this.selectedConversationId)
          }
        }
      } catch (error) { this.error = displayError(error, '删除会话失败') }
    },
    async selectConversation(id: string) {
      if (this.selectedConversationId !== id) {
        this.selectedConversationId = id
        this._selectionVersion += 1
      }
      if (this.messagesByConversation[id] === undefined) await this.loadMessages(id)
    },
    async loadMessages(conversationId: string) {
      const selectionVersion = this._selectionVersion
      const messageVersion = (this._messageVersions[conversationId] ?? 0) + 1
      this._messageVersions[conversationId] = messageVersion
      try {
        const messages = await getDesktopApi().chat.listMessages(conversationId)
        if (this.selectedConversationId !== conversationId
          || selectionVersion !== this._selectionVersion
          || messageVersion !== this._messageVersions[conversationId]) return
        this.messagesByConversation[conversationId] = messages.map(persistedMessage)
      } catch (error) {
        if (this.selectedConversationId === conversationId && selectionVersion === this._selectionVersion) {
          this.error = displayError(error, '消息记录加载失败')
        }
      }
    },
    async send(content: string, model?: string) {
      const clean = content.trim()
      if (!clean || !this.selectedConversationId || this.isRunning) return
      const conversationId = this.selectedConversationId
      const message: UiChatMessage = {
        id: `local-${Date.now()}`,
        role: 'user',
        blocks: [{ id: `local-${Date.now()}:text:0`, type: 'text', text: clean }],
      }
      const messages = this.messagesByConversation[conversationId] ?? []
      this.messagesByConversation[conversationId] = [...messages, message]
      this._messageVersions[conversationId] = (this._messageVersions[conversationId] ?? 0) + 1
      this.error = ''
      try {
        const result = await getDesktopApi().chat.send({ conversationId, content: clean, ...(model ? { model } : {}) })
        if (this._terminalRequests[result.requestId]) delete this._terminalRequests[result.requestId]
        else this.activeRequestByConversation[conversationId] = result.requestId
      } catch (error) { this.error = displayError(error, '消息发送失败') }
    },
    async cancelCurrent() {
      const conversationId = this.selectedConversationId
      const requestId = this.activeRequestByConversation[conversationId]
      if (!requestId) return
      try { await getDesktopApi().chat.cancel(requestId) }
      catch (error) { this.error = displayError(error, '取消生成失败') }
    },
    applyChatEvent(event: ChatEvent) {
      if (event.type === 'status') {
        if (event.status === 'running') {
          if (!this._terminalRequests[event.requestId]) this.activeRequestByConversation[event.conversationId] = event.requestId
        } else if (this.activeRequestByConversation[event.conversationId] === event.requestId) {
          delete this.activeRequestByConversation[event.conversationId]
        } else {
          this._terminalRequests[event.requestId] = true
          const terminalRequestIds = Object.keys(this._terminalRequests)
          if (terminalRequestIds.length > 100) delete this._terminalRequests[terminalRequestIds[0]!]
        }
        if (event.status === 'failed' && event.error) this.error = event.error.message
        return
      }
      this._messageVersions[event.conversationId] = (this._messageVersions[event.conversationId] ?? 0) + 1
      const messages = this.messagesByConversation[event.conversationId] ?? []
      let message = messages.find(({ id }) => id === event.messageId)
      if (!message) {
        message = { id: event.messageId, role: 'assistant', blocks: [] }
        this.messagesByConversation[event.conversationId] = [...messages, message]
      }
      if (event.block.type === 'text') {
        const previous = message.blocks.at(-1)
        if (previous?.type === 'text') previous.text += event.block.text
        else message.blocks.push({ ...event.block, id: blockIdentity(event.messageId, event.block, message.blocks.length) })
        return
      }
      const id = blockIdentity(event.messageId, event.block, message.blocks.length)
      if (!message.blocks.some((block) => block.id === id)) message.blocks.push({ ...event.block, id })
    },
  },
})
