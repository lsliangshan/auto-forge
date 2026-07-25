<template>
  <form
    class="composer"
    data-testid="chat-composer"
    @dragover.prevent
    @drop.prevent="onDrop"
    @submit.prevent="submit"
  >
    <div class="composer-tools">
      <button
        type="button"
        class="tool-button"
        data-testid="attach-media"
        :disabled="disabled || chat.drafts.length >= 5"
        @click="chat.pickDraftFiles"
      >
        添加附件
      </button>
      <label>
        <span>输出</span>
        <select
          data-testid="output-type"
          :disabled="disabled || running"
          :value="chat.preferences.outputType"
          @change="changeOutputType"
        >
          <option value="auto">自动</option>
          <option value="text">文本</option>
          <option value="image">图片</option>
          <option value="audio">音频</option>
          <option value="video">视频</option>
        </select>
      </label>
      <label>
        <span>模型</span>
        <select
          data-testid="model-select"
          :disabled="disabled || running || chat.preferences.outputType === 'auto' || compatibleModels.length === 0"
          :title="chat.preferences.outputType === 'auto' ? '自动模式使用供应商默认模型' : undefined"
          :value="selectedModelId"
          @change="changeModel"
        >
          <option
            v-for="model in compatibleModels"
            :key="model.id"
            :value="model.id"
          >
            {{ model.name }}
          </option>
        </select>
      </label>
    </div>

    <div
      v-if="autoChoiceRequired"
      class="choice-required"
      data-testid="output-choice-required"
      role="alert"
    >
      该模型支持多种输出，请选择输出类型后发送。
    </div>

    <div
      v-if="chat.preferences.outputType === 'image'"
      class="generation-options"
      data-testid="image-options"
    >
      <span>图片 1 张</span>
      <select
        v-if="selectedModel?.generation.image?.resolutions.length"
        data-testid="image-resolution"
        :value="chat.preferences.generation.image.resolution"
        aria-label="图片分辨率"
        @change="changeImageOption('resolution', $event)"
      >
        <option
          v-for="value in selectedModel.generation.image.resolutions"
          :key="value"
          :value="value"
        >
          {{ value }}
        </option>
      </select>
      <select
        v-if="selectedModel?.generation.image?.aspectRatios.length"
        data-testid="image-aspect-ratio"
        :value="chat.preferences.generation.image.aspectRatio"
        aria-label="图片画幅"
        @change="changeImageOption('aspectRatio', $event)"
      >
        <option
          v-for="value in selectedModel.generation.image.aspectRatios"
          :key="value"
          :value="value"
        >
          {{ value }}
        </option>
      </select>
      <select
        v-if="selectedModel?.generation.image?.formats.length"
        data-testid="image-format"
        :value="chat.preferences.generation.image.format"
        aria-label="图片格式"
        @change="changeImageOption('format', $event)"
      >
        <option
          v-for="value in selectedModel.generation.image.formats"
          :key="value"
          :value="value"
        >
          {{ value.toUpperCase() }}
        </option>
      </select>
    </div>

    <div
      v-else-if="chat.preferences.outputType === 'audio'"
      class="generation-options"
      data-testid="audio-options"
    >
      <select
        v-if="selectedModel?.generation.audio?.voices.length"
        data-testid="audio-voice"
        :value="chat.preferences.generation.audio.voice ?? ''"
        aria-label="音色"
        @change="changeAudioOption('voice', $event)"
      >
        <option value="">
          模型默认音色
        </option>
        <option
          v-for="value in selectedModel.generation.audio.voices"
          :key="value"
          :value="value"
        >
          {{ value }}
        </option>
      </select>
      <select
        v-if="selectedModel?.generation.audio?.formats.length"
        data-testid="audio-format"
        :value="chat.preferences.generation.audio.format"
        aria-label="音频格式"
        @change="changeAudioOption('format', $event)"
      >
        <option
          v-for="value in selectedModel.generation.audio.formats"
          :key="value"
          :value="value"
        >
          {{ value.toUpperCase() }}
        </option>
      </select>
    </div>

    <div
      v-else-if="chat.preferences.outputType === 'video'"
      class="generation-options"
      data-testid="video-options"
    >
      <select
        v-if="selectedModel?.generation.video?.durations.length"
        data-testid="video-duration"
        :value="chat.preferences.generation.video.durationSeconds"
        aria-label="视频时长"
        @change="changeVideoNumberOption('durationSeconds', $event)"
      >
        <option
          v-for="value in selectedModel.generation.video.durations"
          :key="value"
          :value="value"
        >
          {{ value }} 秒
        </option>
      </select>
      <select
        v-if="selectedModel?.generation.video?.resolutions.length"
        data-testid="video-resolution"
        :value="chat.preferences.generation.video.resolution"
        aria-label="视频分辨率"
        @change="changeVideoOption('resolution', $event)"
      >
        <option
          v-for="value in selectedModel.generation.video.resolutions"
          :key="value"
          :value="value"
        >
          {{ value }}
        </option>
      </select>
      <select
        v-if="selectedModel?.generation.video?.aspectRatios.length"
        data-testid="video-aspect-ratio"
        :value="chat.preferences.generation.video.aspectRatio"
        aria-label="视频画幅"
        @change="changeVideoOption('aspectRatio', $event)"
      >
        <option
          v-for="value in selectedModel.generation.video.aspectRatios"
          :key="value"
          :value="value"
        >
          {{ value }}
        </option>
      </select>
      <label v-if="selectedModel?.generation.video?.supportsAudio">
        <input
          type="checkbox"
          data-testid="video-generate-audio"
          :checked="chat.preferences.generation.video.generateAudio"
          @change="changeVideoAudio"
        >
        生成伴随音频
      </label>
    </div>

    <div
      v-if="chat.drafts.length"
      class="draft-list"
    >
      <article
        v-for="asset in chat.drafts"
        :key="asset.id"
        class="draft-card"
        data-testid="attachment-card"
      >
        <span class="draft-kind">{{ kindLabel(asset.kind) }}</span>
        <span class="draft-name">{{ asset.name }}</span>
        <span class="draft-size">{{ formatBytes(asset.byteSize) }}</span>
        <button
          type="button"
          class="remove-draft"
          :data-testid="`remove-draft-${asset.id}`"
          :aria-label="`移除 ${asset.name}`"
          @click="chat.removeDraft(asset.id)"
        >
          移除
        </button>
      </article>
    </div>

    <textarea
      v-model="content"
      rows="2"
      :disabled="disabled"
      aria-label="消息内容"
      placeholder="描述你想完成的任务…"
      @paste="onPaste"
      @compositionstart="composing = true"
      @compositionend="composing = false"
      @keydown="onKeydown"
    />
    <div class="composer-footer">
      <span>Enter 发送 · Shift+Enter 换行</span>
      <el-button
        v-if="running"
        type="danger"
        plain
        :disabled="disabled"
        @click="$emit('cancel')"
      >
        取消生成
      </el-button>
      <el-button
        v-else
        native-type="submit"
        type="primary"
        data-testid="send-message"
        :disabled="!canSubmit"
      >
        发送
      </el-button>
    </div>
  </form>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import type {
  ChatSendInput,
  ConversationGenerationPreferences,
  ModelInfo,
  OutputType,
} from '@autoforge/shared'
import { useChatStore } from '../../stores/chat'

const props = withDefaults(defineProps<{
  disabled: boolean
  running: boolean
  models?: ModelInfo[]
  defaultModel?: string
}>(), {
  models: () => [],
  defaultModel: '',
})
const emit = defineEmits<{
  submit: [input: Omit<ChatSendInput, 'conversationId'>]
  cancel: []
}>()
const chat = useChatStore()
const content = ref('')
const composing = ref(false)

const compatibleModels = computed(() => {
  const output = chat.preferences.outputType
  if (output === 'auto') return props.models
  return props.models.filter((model) => model.outputModalities.includes(output))
})

const selectedModelId = computed(() => {
  const output = chat.preferences.outputType
  const remembered = output === 'auto' ? undefined : chat.preferences.models[output]
  const preferred = remembered || props.defaultModel
  if (preferred && compatibleModels.value.some(({ id }) => id === preferred)) return preferred
  return compatibleModels.value[0]?.id ?? ''
})

const selectedModel = computed(() =>
  props.models.find(({ id }) => id === selectedModelId.value))

const autoChoiceRequired = computed(() => {
  if (chat.preferences.outputType !== 'auto' || !selectedModel.value) return false
  return new Set(selectedModel.value.outputModalities).size > 1
})

const canSubmit = computed(() => {
  if (props.disabled || props.running || autoChoiceRequired.value) return false
  if (content.value.trim()) return true
  return chat.drafts.length > 0 && chat.preferences.outputType === 'text'
})

function savePreferences(preferences: ConversationGenerationPreferences) {
  const conversationId = chat.selectedConversationId
  if (conversationId) void chat.updateGenerationPreferences(conversationId, preferences)
}

function eventValue(event: unknown): string {
  return String((event as { target?: { value?: unknown } }).target?.value ?? '')
}

function changeOutputType(event: unknown) {
  const outputType = eventValue(event) as OutputType
  savePreferences({ ...chat.preferences, outputType })
}

function changeModel(event: unknown) {
  const model = eventValue(event)
  const output = chat.preferences.outputType
  if (!model || output === 'auto') return
  savePreferences({
    ...chat.preferences,
    models: { ...chat.preferences.models, [output]: model },
  })
}

function changeImageOption(
  key: 'resolution' | 'aspectRatio' | 'format',
  event: unknown,
) {
  savePreferences({
    ...chat.preferences,
    generation: {
      ...chat.preferences.generation,
      image: {
        ...chat.preferences.generation.image,
        [key]: eventValue(event),
      },
    },
  })
}

function changeAudioOption(key: 'voice' | 'format', event: unknown) {
  const value = eventValue(event)
  const audio = { ...chat.preferences.generation.audio }
  if (key === 'voice') {
    if (value) audio.voice = value
    else delete audio.voice
  } else {
    audio.format = value
  }
  savePreferences({
    ...chat.preferences,
    generation: { ...chat.preferences.generation, audio },
  })
}

function changeVideoOption(
  key: 'resolution' | 'aspectRatio',
  event: unknown,
) {
  savePreferences({
    ...chat.preferences,
    generation: {
      ...chat.preferences.generation,
      video: {
        ...chat.preferences.generation.video,
        [key]: eventValue(event),
      },
    },
  })
}

function changeVideoNumberOption(key: 'durationSeconds', event: unknown) {
  savePreferences({
    ...chat.preferences,
    generation: {
      ...chat.preferences.generation,
      video: {
        ...chat.preferences.generation.video,
        [key]: Number(eventValue(event)),
      },
    },
  })
}

function changeVideoAudio(event: unknown) {
  savePreferences({
    ...chat.preferences,
    generation: {
      ...chat.preferences.generation,
      video: {
        ...chat.preferences.generation.video,
        generateAudio: Boolean((event as { target?: { checked?: unknown } }).target?.checked),
      },
    },
  })
}

function onDrop(event: unknown) {
  const dataTransfer = (event as { dataTransfer?: { files?: ArrayLike<unknown> } }).dataTransfer
  const files = Array.from(dataTransfer?.files ?? []) as Parameters<typeof chat.importDroppedDrafts>[0]
  if (files.length) void chat.importDroppedDrafts(files)
}

function onPaste(event: unknown) {
  const clipboard = (event as {
    clipboardData?: { items?: ArrayLike<{ type: string }> }
    preventDefault?: () => void
  })
  const hasImage = Array.from(clipboard.clipboardData?.items ?? [])
    .some((item) => item.type.startsWith('image/'))
  if (!hasImage) return
  clipboard.preventDefault?.()
  void chat.importClipboardDraft()
}

function submit() {
  if (!canSubmit.value) return
  const clean = content.value.trim()
  const payload: Omit<ChatSendInput, 'conversationId'> = {
    content: clean,
    assetIds: chat.drafts.map(({ id }) => id),
    outputType: chat.preferences.outputType,
    generation: chat.preferences.generation,
    ...(selectedModelId.value ? { model: selectedModelId.value } : {}),
  }
  emit('submit', payload)
  content.value = ''
}

function onKeydown(event: KeyboardEvent) {
  if (event.key !== 'Enter' || event.shiftKey || composing.value || event.isComposing) return
  event.preventDefault()
  submit()
}

function kindLabel(kind: 'image' | 'audio' | 'video') {
  return kind === 'image' ? '图片' : kind === 'audio' ? '音频' : '视频'
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
</script>

<style scoped>
.composer { border-top: 1px solid var(--af-border); padding: 12px 16px 14px; background: var(--af-surface); }
.composer-tools, .generation-options { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-bottom: 9px; }
.composer-tools label, .generation-options label { display: inline-flex; align-items: center; gap: 5px; color: var(--af-text-muted); font-size: 11px; }
.tool-button, select, .remove-draft { border: 1px solid var(--af-border-strong); border-radius: 6px; padding: 6px 9px; color: var(--af-text); background: white; font: inherit; }
.tool-button, .remove-draft { cursor: pointer; }
.tool-button:disabled, select:disabled { cursor: not-allowed; opacity: 0.55; }
.choice-required { margin-bottom: 9px; border-left: 3px solid var(--af-warning, #d89018); padding: 7px 9px; color: var(--af-text); background: var(--af-surface-muted); font-size: 12px; }
.draft-list { display: grid; gap: 6px; margin-bottom: 9px; }
.draft-card { display: grid; grid-template-columns: auto minmax(0, 1fr) auto auto; align-items: center; gap: 8px; border: 1px solid var(--af-border); border-radius: 7px; padding: 7px 9px; background: var(--af-surface-muted); font-size: 12px; }
.draft-kind, .draft-size { color: var(--af-text-muted); }
.draft-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.remove-draft { padding: 3px 7px; color: var(--af-danger, #b42318); }
textarea { display: block; width: 100%; min-height: 66px; max-height: 180px; resize: vertical; border: 1px solid var(--af-border-strong); border-radius: 7px; padding: 10px 12px; color: var(--af-text); background: white; line-height: 1.5; }
textarea:hover:not(:disabled) { border-color: #9aa6b5; }
textarea:disabled { cursor: not-allowed; background: var(--af-surface-muted); }
.composer-footer { display: flex; align-items: center; justify-content: space-between; margin-top: 8px; }
.composer-footer span { color: var(--af-text-muted); font-size: 11px; }
</style>
