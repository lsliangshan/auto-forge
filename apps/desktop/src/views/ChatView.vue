<template>
  <section class="chat-view">
    <div
      v-if="chat.loading"
      class="af-empty"
    >
      <el-icon class="is-loading">
        <Loading />
      </el-icon><p>正在加载会话…</p>
    </div>
    <div
      v-else-if="!chat.selectedConversationId"
      class="af-empty"
    >
      <div>
        <el-icon :size="34">
          <ChatDotRound />
        </el-icon><h2>从一个真实任务开始</h2><p>新建会话后，AutoForge 会使用你配置的模型和本地工作流。</p><el-button
          type="primary"
          @click="chat.createConversation"
        >
          新建会话
        </el-button>
      </div>
    </div>
    <template v-else>
      <div
        class="messages af-scrollbar"
        aria-live="polite"
      >
        <div
          v-if="chat.error"
          class="af-error"
          role="alert"
        >
          {{ chat.error }}
        </div>
        <div
          v-if="!chat.messages.length"
          class="chat-empty"
        >
          <h2>准备开始</h2><p>描述目标，模型会在需要时提出工作流和权限请求。</p>
        </div>
        <article
          v-for="message in chat.messages"
          :key="message.id"
          :class="['message', message.role]"
        >
          <span class="message-role">{{ message.role === 'user' ? '你' : 'AutoForge' }}</span>
          <div class="message-body">
            <MessageBlock
              v-for="block in message.blocks"
              :key="block.id"
              :block="block"
            />
          </div>
        </article>
      </div>
      <ChatComposer
        :disabled="false"
        :running="chat.isRunning"
        :models="settings.models"
        :default-model="defaultModel"
        @submit="chat.send($event)"
        @cancel="chat.cancelCurrent"
      />
    </template>
  </section>
</template>

<script setup lang="ts">
import { ChatDotRound, Loading } from '@element-plus/icons-vue'
import { computed, onMounted } from 'vue'
import ChatComposer from '../components/chat/ChatComposer.vue'
import MessageBlock from '../components/chat/MessageBlock.vue'
import { useChatStore } from '../stores/chat'
import { useSettingsStore } from '../stores/settings'

const chat = useChatStore()
const settings = useSettingsStore()
const defaultModel = computed(() => {
  const defaults = settings.settings?.defaultModels
  if (!defaults) return ''
  if (settings.activeProvider === 'deepseek') return defaults.deepseek.text
  const output = chat.preferences.outputType
  if (output !== 'auto') return defaults.openrouter[output] ?? ''
  return defaults.openrouter.text
    ?? defaults.openrouter.image
    ?? defaults.openrouter.audio
    ?? defaults.openrouter.video
    ?? ''
})
onMounted(async () => {
  chat.ensureSubscriptions()
  if (!chat.conversations.length && !chat.loading) void chat.loadConversations()
  if (!settings.settings && !settings.loading) await settings.load()
})
</script>

<style scoped>
.chat-view { display: flex; height: 100%; min-height: 0; flex-direction: column; background: var(--af-surface); }
.messages { flex: 1; overflow: auto; padding: 18px clamp(20px, 5vw, 72px); }
.message { display: grid; grid-template-columns: 74px minmax(0, 760px); gap: 12px; max-width: 920px; margin: 0 auto; padding: 16px 0; border-bottom: 1px solid var(--af-border); }
.message-role { padding-top: 2px; color: var(--af-text-muted); font-size: 11px; font-weight: 700; text-transform: uppercase; }.message.user .message-role { color: var(--af-cobalt); }
.message-body { min-width: 0; font-size: 14px; }
.chat-empty { padding: 56px 20px; color: var(--af-text-muted); text-align: center; }.chat-empty h2 { color: var(--af-text); font-size: 18px; }.chat-empty p { font-size: 13px; }
.af-empty > div { max-width: 420px; }.af-empty h2 { color: var(--af-graphite); font-size: 19px; }.af-empty p { line-height: 1.6; }
</style>
