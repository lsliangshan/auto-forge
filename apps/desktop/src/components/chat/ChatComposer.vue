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
        :disabled="disabled || running || chat.drafts.length >= 5"
        @click="pickMedia"
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
          <option
            value="auto"
            :disabled="!outputSupported('auto')"
          >
            自动
          </option>
          <option
            value="text"
            :disabled="!outputSupported('text')"
          >
            文本
          </option>
          <option
            value="image"
            :disabled="!outputSupported('image')"
          >
            图片
          </option>
          <option
            value="audio"
            :disabled="!outputSupported('audio')"
          >
            音频
          </option>
          <option
            value="video"
            :disabled="!outputSupported('video')"
          >
            视频
          </option>
        </select>
      </label>
      <label>
        <span>模型</span>
        <select
          data-testid="model-select"
          :disabled="disabled || running || modelsLoading || chat.preferences.outputType === 'auto' || compatibleModels.length === 0"
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
      v-else-if="!selectedModel"
      class="choice-required"
      data-testid="no-compatible-model"
      role="alert"
    >
      当前供应商没有兼容此输出类型的模型。
    </div>
    <div
      v-else-if="!selectedModelSupportsRequest"
      class="choice-required"
      data-testid="model-attachment-incompatible"
      role="alert"
    >
      当前模型不支持已添加的附件。
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
        :disabled="disabled || running || modelsLoading"
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
        :disabled="disabled || running || modelsLoading"
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
        :disabled="disabled || running || modelsLoading"
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
        :disabled="disabled || running || modelsLoading"
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
        :disabled="disabled || running || modelsLoading"
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
        :disabled="disabled || running || modelsLoading"
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
        :disabled="disabled || running || modelsLoading"
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
        :disabled="disabled || running || modelsLoading"
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
          :disabled="disabled || running || modelsLoading"
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
          :disabled="disabled || running"
          @click="removeDraft(asset.id)"
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
        data-testid="cancel-send"
        :disabled="disabled"
        @click="$emit('cancel')"
      >
        取消发送
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
  GenerationOptions,
  ModelInfo,
  OutputType,
} from '@autoforge/shared'
import { useChatStore, type ChatSendAcknowledgement } from '../../stores/chat'

type ConcreteOutput = Exclude<OutputType, 'auto'>

const props = withDefaults(defineProps<{
  disabled: boolean
  running: boolean
  models?: ModelInfo[]
  defaultModel?: string
  defaultModels?: Partial<Record<ConcreteOutput, string>>
  modelsLoading?: boolean
  refreshModels?: () => Promise<ModelInfo[] | undefined>
}>(), {
  models: () => [],
  defaultModel: '',
  defaultModels: () => ({}),
  modelsLoading: false,
  refreshModels: undefined,
})
const emit = defineEmits<{
  submit: [
    input: Omit<ChatSendInput, 'conversationId'>,
    acknowledge: ChatSendAcknowledgement,
  ]
  cancel: []
}>()
const chat = useChatStore()
const composing = ref(false)
const contentsByConversation = ref<Record<string, string>>({})
const pendingByConversation = ref<Record<string, number>>({})
let pendingSequence = 0

const content = computed({
  get: () => contentsByConversation.value[chat.selectedConversationId] ?? '',
  set: (value: string) => {
    const conversationId = chat.selectedConversationId
    if (conversationId) contentsByConversation.value[conversationId] = value
  },
})

const awaitingAcceptance = computed(() =>
  pendingByConversation.value[chat.selectedConversationId] !== undefined)

function modelSupportsOutput(model: ModelInfo, output: ConcreteOutput): boolean {
  return model.outputModalities.includes(output)
    && model.inputModalities.includes('text')
    && (output === 'text' || Boolean(model.generation[output]))
}

function modelSupportsRequest(model: ModelInfo, output: ConcreteOutput): boolean {
  if (!modelSupportsOutput(model, output)) return false
  if ((output === 'image' || output === 'video')
    && chat.drafts.some(({ kind }) => kind !== 'image')) return false
  return chat.drafts.every(({ kind }) => model.inputModalities.includes(kind))
}

function modelsForOutput(output: OutputType, models = props.models): ModelInfo[] {
  if (output === 'auto') {
    return models.filter((model) =>
      model.outputModalities.some((candidate) => modelSupportsOutput(model, candidate)))
  }
  return models.filter((model) => modelSupportsOutput(model, output))
}

function outputSupported(output: OutputType): boolean {
  return modelsForOutput(output).some((model) => output === 'auto'
    ? model.outputModalities.some((candidate) => modelSupportsRequest(model, candidate))
    : modelSupportsRequest(model, output))
}

const compatibleModels = computed(() => modelsForOutput(chat.preferences.outputType))

function modelIdFor(
  output: OutputType,
  preferences: ConversationGenerationPreferences,
): string {
  const models = modelsForOutput(output)
  const remembered = output === 'auto' ? undefined : preferences.models[output]
  const outputDefault = output === 'auto' ? props.defaultModel : props.defaultModels[output]
  const preferred = remembered || outputDefault || props.defaultModel
  if (preferred && models.some(({ id }) => id === preferred)) return preferred
  return models[0]?.id ?? ''
}

const selectedModelId = computed(() => modelIdFor(chat.preferences.outputType, chat.preferences))

const selectedModel = computed(() => compatibleModels.value
  .find(({ id }) => id === selectedModelId.value))

const selectedModelSupportsRequest = computed(() => {
  if (!selectedModel.value) return false
  const output = chat.preferences.outputType
  if (output !== 'auto') return modelSupportsRequest(selectedModel.value, output)
  return selectedModel.value.outputModalities
    .some((candidate) => modelSupportsRequest(selectedModel.value!, candidate))
})

const autoChoiceRequired = computed(() => {
  if (chat.preferences.outputType !== 'auto' || !selectedModel.value) return false
  const supported = selectedModel.value.outputModalities
    .filter((output) => modelSupportsRequest(selectedModel.value!, output))
  return new Set(supported).size > 1
})

const canSubmit = computed(() => {
  if (props.disabled
    || props.running
    || props.modelsLoading
    || awaitingAcceptance.value
    || autoChoiceRequired.value
    || !selectedModel.value
    || !selectedModelSupportsRequest.value) return false
  if (content.value.trim()) return true
  return chat.drafts.length > 0 && chat.preferences.outputType === 'text'
})

function savePreferences(preferences: ConversationGenerationPreferences) {
  if (props.disabled || props.running) return
  const conversationId = chat.selectedConversationId
  if (conversationId) void chat.updateGenerationPreferences(conversationId, preferences)
}

function eventValue(event: unknown): string {
  return String((event as { target?: { value?: unknown } }).target?.value ?? '')
}

function changeOutputType(event: unknown) {
  if (props.disabled || props.running) return
  const outputType = eventValue(event) as OutputType
  if (!outputSupported(outputType)) return
  const next = { ...chat.preferences, outputType }
  const modelId = modelIdFor(outputType, next)
  const model = modelsForOutput(outputType).find(({ id }) => id === modelId)
  savePreferences({
    ...next,
    generation: normalizeGeneration(next.generation, model, outputType),
  })
}

async function changeModel(event: unknown) {
  if (props.disabled || props.running || props.modelsLoading) return
  const requested = eventValue(event)
  const output = chat.preferences.outputType
  if (!requested || output === 'auto' || requested === selectedModelId.value) return
  const refreshed = props.refreshModels ? await props.refreshModels() : undefined
  if (chat.preferences.outputType !== output) return
  const candidates = modelsForOutput(output, refreshed ?? props.models)
  const selected = candidates.find(({ id }) => id === requested) ?? candidates[0]
  if (!selected) return
  savePreferences({
    ...chat.preferences,
    models: { ...chat.preferences.models, [output]: selected.id },
    generation: normalizeGeneration(chat.preferences.generation, selected, output),
  })
}

function advertisedString(current: string, values: string[]): string {
  return values.length > 0 && !values.includes(current) ? values[0]! : current
}

function advertisedNumber(current: number, values: number[]): number {
  return values.length > 0 && !values.includes(current) ? values[0]! : current
}

function normalizeGeneration(
  generation: GenerationOptions,
  model: ModelInfo | undefined,
  output: OutputType,
): GenerationOptions {
  const normalized: GenerationOptions = {
    image: { ...generation.image },
    audio: { ...generation.audio },
    video: { ...generation.video },
  }
  if (!model || output === 'auto' || output === 'text') return normalized
  if (output === 'image') {
    const capability = model.generation.image
    if (!capability) return normalized
    normalized.image = {
      count: 1,
      resolution: advertisedString(normalized.image.resolution, capability.resolutions),
      aspectRatio: advertisedString(normalized.image.aspectRatio, capability.aspectRatios),
      format: advertisedString(normalized.image.format, capability.formats),
    }
  } else if (output === 'audio') {
    const capability = model.generation.audio
    if (!capability) return normalized
    normalized.audio.format = advertisedString(normalized.audio.format, capability.formats)
    if (normalized.audio.voice !== undefined) {
      normalized.audio.voice = advertisedString(normalized.audio.voice, capability.voices)
    }
  } else {
    const capability = model.generation.video
    if (!capability) return normalized
    normalized.video = {
      durationSeconds: advertisedNumber(normalized.video.durationSeconds, capability.durations),
      resolution: advertisedString(normalized.video.resolution, capability.resolutions),
      aspectRatio: advertisedString(normalized.video.aspectRatio, capability.aspectRatios),
      generateAudio: capability.supportsAudio && normalized.video.generateAudio,
    }
  }
  return normalized
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
  if (props.disabled || props.running) return
  const dataTransfer = (event as { dataTransfer?: { files?: ArrayLike<unknown> } }).dataTransfer
  const files = Array.from(dataTransfer?.files ?? []) as Parameters<typeof chat.importDroppedDrafts>[0]
  if (files.length) void chat.importDroppedDrafts(files)
}

function onPaste(event: unknown) {
  if (props.disabled || props.running) return
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
  const conversationId = chat.selectedConversationId
  if (!conversationId) return
  const clean = content.value.trim()
  const submittedContent = content.value
  const payload: Omit<ChatSendInput, 'conversationId'> = {
    content: clean,
    assetIds: chat.drafts.map(({ id }) => id),
    outputType: chat.preferences.outputType,
    generation: normalizeGeneration(
      chat.preferences.generation,
      selectedModel.value,
      chat.preferences.outputType,
    ),
    ...(selectedModelId.value ? { model: selectedModelId.value } : {}),
  }
  const pendingId = ++pendingSequence
  pendingByConversation.value[conversationId] = pendingId
  if (contentsByConversation.value[conversationId] === submittedContent) {
    delete contentsByConversation.value[conversationId]
  }
  let acknowledged = false
  emit('submit', payload, (accepted) => {
    if (acknowledged) return
    acknowledged = true
    if (pendingByConversation.value[conversationId] === pendingId) {
      delete pendingByConversation.value[conversationId]
    }
    if (accepted) return
    const newerContent = contentsByConversation.value[conversationId] ?? ''
    contentsByConversation.value[conversationId] = newerContent
      ? `${submittedContent}\n\n${newerContent}`
      : submittedContent
  })
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

function pickMedia() {
  if (!props.disabled && !props.running) void chat.pickDraftFiles()
}

function removeDraft(assetId: string) {
  if (!props.disabled && !props.running) void chat.removeDraft(assetId)
}
</script>

<style scoped>
.composer { border-top: 1px solid var(--af-border); padding: 12px 16px 14px; background: var(--af-surface); }
.composer-tools, .generation-options { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-bottom: 9px; }
.composer-tools label, .generation-options label { display: inline-flex; align-items: center; gap: 5px; color: var(--af-text-muted); font-size: 11px; }
.tool-button, select, .remove-draft { border: 1px solid var(--af-border-strong); border-radius: 6px; padding: 6px 9px; color: var(--af-text); background: white; font: inherit; }
.tool-button, .remove-draft { cursor: pointer; }
.tool-button:disabled, .remove-draft:disabled, select:disabled { cursor: not-allowed; opacity: 0.55; }
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
