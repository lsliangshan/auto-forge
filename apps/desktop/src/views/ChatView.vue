<template>
  <section class="chat-view">
    <div v-if="chat.loading" class="af-empty">
      <el-icon class="is-loading">
        <Loading />
      </el-icon>
      <p>正在加载会话…</p>
    </div>
    <div v-else-if="!chat.selectedConversationId" class="af-empty">
      <div>
        <el-icon :size="34">
          <ChatDotRound />
        </el-icon>
        <h2>从一个真实任务开始</h2>
        <p>新建会话后，AutoForge 会使用你配置的模型和本地工作流。</p>
        <el-button type="primary" @click="chat.createConversation">
          新建会话
        </el-button>
      </div>
    </div>
    <template v-else>
      <div
        ref="messagesRef"
        class="messages af-scrollbar"
        aria-live="polite"
        @scroll="updateScrollFollowing"
      >
        <div v-if="chat.error" class="af-error" role="alert">
          {{ chat.error }}
        </div>
        <div v-if="settings.error" class="af-error" role="alert">
          {{ settings.error }}
        </div>
        <button
          v-if="
            chat.previousMessageCursorByConversation[
              chat.selectedConversationId
            ]
          "
          class="older-messages"
          type="button"
          @click="loadOlderMessages"
        >
          加载更早消息
        </button>
        <div
          v-if="!chat.messages.length && !chat.isAwaitingResponse"
          class="chat-empty"
        >
          <h2>准备开始</h2>
          <p>描述目标，模型会在需要时提出工作流和权限请求。</p>
        </div>
        <article
          v-for="message in chat.messages"
          :key="message.id"
          :class="['message', message.role]"
        >
          <header class="message-meta">
            <span class="message-role">
              <img
                v-if="message.role === 'assistant'"
                :src="logoUrl"
                alt=""
                class="assistant-avatar"
                data-testid="assistant-avatar"
              />
              {{ message.role === "user" ? "你" : "AutoForge" }}
            </span>
            <time
              class="message-time"
              :datetime="message.createdAt"
              :title="messageTimeTitle(message.createdAt)"
              >{{ messageTimeLabel(message.createdAt) }}</time
            >
          </header>
          <div
            :class="[
              'message-surface',
              message.role === 'user' ? 'message-bubble' : 'message-response',
            ]"
          >
            <div class="message-body">
              <MessageBlock
                v-for="block in message.blocks"
                :key="block.id"
                :block="block"
              />
            </div>
          </div>
        </article>
        <article
          v-if="chat.isAwaitingResponse"
          class="message assistant"
          data-testid="response-loader"
        >
          <header class="message-meta">
            <span class="message-role">
              <img
                :src="logoUrl"
                alt=""
                class="assistant-avatar"
                data-testid="assistant-avatar"
              />
              AutoForge
            </span>
          </header>
          <div class="message-surface message-response">
            <div class="message-body">
              <div class="response-loader" role="status">
                <el-icon class="is-loading">
                  <Loading />
                </el-icon>
                <span>正在生成回复…</span>
              </div>
            </div>
          </div>
        </article>
      </div>
      <ChatComposer
        :disabled="false"
        :running="chat.isRunning"
        :provider="settings.activeProvider"
        :models="settings.models"
        :models-loading="settings.modelsLoading"
        :refresh-models="refreshModels"
        :default-model="defaultModel"
        :default-models="defaultModels"
        @submit="submit"
        @cancel="chat.cancelCurrent"
      />
    </template>
  </section>
</template>

<script setup lang="ts">
import { ChatDotRound, Loading } from "@element-plus/icons-vue";
import type { ChatSendInput, OutputType } from "@autoforge/shared";
import { computed, nextTick, onMounted, ref, watch } from "vue";
import ChatComposer from "../components/chat/ChatComposer.vue";
import MessageBlock from "../components/chat/MessageBlock.vue";
import { useChatStore, type ChatSendAcknowledgement } from "../stores/chat";
import { useSettingsStore } from "../stores/settings";
import logoUrl from "../../resources/branding/autoforge-logo.png";

const chat = useChatStore();
const settings = useSettingsStore();
const messagesRef = ref<globalThis.HTMLElement>();
const BOTTOM_FOLLOW_THRESHOLD_PX = 20;
const shouldFollowLatest = ref(true);

function padTimePart(value: number): string {
  return String(value).padStart(2, "0");
}

function messageTimeParts(createdAt: string) {
  const created = new Date(createdAt);
  const time = `${padTimePart(created.getHours())}:${padTimePart(
    created.getMinutes()
  )}`;
  return { created, time };
}

function messageTimeTitle(createdAt: string): string {
  const { created, time } = messageTimeParts(createdAt);
  return `${created.getFullYear()}年${
    created.getMonth() + 1
  }月${created.getDate()}日 ${time}`;
}

function messageTimeLabel(createdAt: string): string {
  const now = new Date();
  const { created, time } = messageTimeParts(createdAt);
  if (created.getFullYear() !== now.getFullYear())
    return messageTimeTitle(createdAt);
  if (
    created.getMonth() === now.getMonth() &&
    created.getDate() === now.getDate()
  )
    return time;
  return `${created.getMonth() + 1}月${created.getDate()}日 ${time}`;
}

function updateScrollFollowing() {
  const messages = messagesRef.value;
  if (!messages) return;
  const distanceFromBottom =
    messages.scrollHeight - messages.scrollTop - messages.clientHeight;
  shouldFollowLatest.value = distanceFromBottom <= BOTTOM_FOLLOW_THRESHOLD_PX;
}

async function loadOlderMessages() {
  const messages = messagesRef.value;
  const previousHeight = messages?.scrollHeight ?? 0;
  const previousTop = messages?.scrollTop ?? 0;
  await chat.loadOlderMessages(chat.selectedConversationId);
  await nextTick();
  if (messages)
    messages.scrollTop = previousTop + messages.scrollHeight - previousHeight;
}

async function scrollToLatest(force = false) {
  if (force) shouldFollowLatest.value = true;
  await nextTick();
  if (!force && !shouldFollowLatest.value) return;
  const messages = messagesRef.value;
  if (messages) messages.scrollTop = messages.scrollHeight;
}

watch(
  () => chat.selectedConversationId,
  () => {
    void scrollToLatest(true);
  },
  { flush: "post" }
);

watch(
  () => chat.messageVersion,
  () => {
    void scrollToLatest();
  },
  { flush: "post" }
);

type ConcreteOutput = Exclude<OutputType, "auto">;
function providerDefaultFor(output: ConcreteOutput): string {
  const defaults = settings.settings?.defaultModels;
  if (!defaults) return "";
  if (settings.activeProvider === "deepseek") {
    return output === "text" ? defaults.deepseek.text : "";
  }
  return defaults.openrouter[output] ?? "";
}
const defaultModels = computed<Partial<Record<ConcreteOutput, string>>>(() => {
  if (settings.activeProvider === "deepseek")
    return { text: providerDefaultFor("text") };
  return Object.fromEntries(
    (["text", "image", "audio", "video"] as const)
      .map((output) => [output, providerDefaultFor(output)])
      .filter(([, model]) => model)
  );
});
const defaultModel = computed(() => {
  const output = chat.preferences.outputType;
  if (output !== "auto") return providerDefaultFor(output);
  return (
    providerDefaultFor("text") ||
    providerDefaultFor("image") ||
    providerDefaultFor("audio") ||
    providerDefaultFor("video")
  );
});
async function refreshModels() {
  if (settings.activeProvider !== "openrouter") return settings.models;
  return settings.loadModels("openrouter", true);
}
async function submit(
  input: Omit<ChatSendInput, "conversationId">,
  acknowledge: ChatSendAcknowledgement
) {
  const sending = chat.send(input);
  void scrollToLatest(true);
  acknowledge(await sending);
}
onMounted(async () => {
  chat.ensureSubscriptions();
  if (!chat.conversations.length && !chat.loading)
    void chat.loadConversations();
  if (!settings.settings && !settings.loading) await settings.load();
});
</script>

<style scoped>
.chat-view {
  display: flex;
  height: 100%;
  min-height: 0;
  flex-direction: column;
  background: var(--af-surface);
}
.messages {
  flex: 1;
  overflow: auto;
  padding: 22px clamp(20px, 5vw, 72px) 30px;
}
.message {
  width: min(100%, 840px);
  margin: 0 auto;
}
.message + .message {
  margin-top: 20px;
}
.message.user {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
}
.message-surface {
  min-width: 0;
}
.message-bubble {
  width: fit-content;
  /* min-width: min(180px, 100%); */
  max-width: min(68%, 580px);
  border: 1px solid color-mix(in srgb, var(--af-cobalt) 15%, var(--af-border));
  border-radius: 17px 17px 5px;
  padding: 11px 14px 12px;
  background: linear-gradient(
    145deg,
    var(--af-surface) 0%,
    var(--af-cobalt-soft) 100%
  );
  box-shadow: 0 5px 16px rgb(37 99 235 / 7%);
}
.message-response {
  width: 100%;
  padding: 0;
}
.message-meta {
  display: flex;
  min-height: 22px;
  align-items: center;
  gap: 8px;
  margin-bottom: 7px;
}
.message.user .message-meta {
  justify-content: flex-end;
  padding-right: 3px;
}
.message-role {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  color: var(--af-text-muted);
  font-size: 0.625rem;
  font-weight: 750;
  letter-spacing: 0.045em;
  text-transform: uppercase;
}
.assistant-avatar {
  width: 24px;
  height: 24px;
  box-sizing: border-box;
  flex: none;
  border: 1px solid color-mix(in srgb, var(--af-cobalt) 18%, transparent);
  border-radius: 9px;
  padding: 3px;
  background: var(--af-cobalt-soft);
  object-fit: contain;
}
.message.user .message-role {
  color: var(--af-cobalt);
}
.message-time {
  flex: none;
  color: var(--af-text-muted);
  font-size: 0.6875rem;
  font-variant-numeric: tabular-nums;
}
.message-body {
  min-width: 0;
  font-size: 0.875rem;
}
.message.assistant .message-body {
  margin-left: 32px;
}
.response-loader {
  display: flex;
  align-items: center;
  gap: 7px;
  color: var(--af-text-muted);
  font-size: 0.75rem;
}
.chat-empty {
  padding: 56px 20px;
  color: var(--af-text-muted);
  text-align: center;
}
.chat-empty h2 {
  color: var(--af-text);
  font-size: 1.125rem;
}
.chat-empty p {
  font-size: 0.8125rem;
}
.af-empty > div {
  max-width: 420px;
}
.af-empty h2 {
  color: var(--af-graphite);
  font-size: 1.1875rem;
}
.af-empty p {
  line-height: 1.6;
}
</style>
