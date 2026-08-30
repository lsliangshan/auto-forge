<template>
  <form
    class="composer"
    data-testid="chat-composer"
    @dragover.prevent
    @drop.prevent="onDrop"
    @submit.prevent="submit"
  >
    <div class="composer-frame">
      <div class="composer-tools">
        <div class="composer-actions">
          <KnowledgeSelector :disabled="disabled || running" />
          <button
            type="button"
            class="tool-button"
            data-testid="attach-media"
            :disabled="disabled || running || chat.drafts.length >= 5"
            @click="pickMedia"
          >
            添加附件
          </button>
        </div>
        <div class="composer-routing">
          <label class="output-control">
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
          <label class="model-control">
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
                :disabled="!modelOptionSupportsRequest(model)"
              >
                {{ modelOptionLabel(model) }}
              </option>
            </select>
          </label>
        </div>
      </div>

      <div
        v-if="autoChoiceRequired"
        class="choice-required"
        data-testid="output-choice-required"
        role="alert"
      >
        <span
          class="choice-icon"
          aria-hidden="true"
        >!</span>
        <span>该模型支持多种输出，请选择输出类型后发送。</span>
      </div>
      <div
        v-else-if="!selectedModel"
        class="choice-required"
        data-testid="no-compatible-model"
        role="alert"
      >
        <span
          class="choice-icon"
          aria-hidden="true"
        >!</span>
        <span>当前供应商没有兼容此输出类型的模型。</span>
      </div>
      <div
        v-else-if="!selectedModelSupportsRequest"
        class="choice-required"
        data-testid="model-attachment-incompatible"
        role="alert"
      >
        <span
          class="choice-icon"
          aria-hidden="true"
        >!</span>
        <span>{{ attachmentCompatibilityMessage }}</span>
      </div>

      <div
        v-if="chat.preferences.outputType === 'image'"
        class="generation-options"
        data-testid="image-options"
      >
        <span class="generation-heading">图片设置</span>
        <span class="generation-value">
          <span>数量</span>
          <strong>1 张</strong>
        </span>
        <label
          v-if="selectedModel?.generation.image?.resolutions.length"
          class="generation-control"
        >
          <span>分辨率</span>
          <select
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
        </label>
        <label
          v-if="selectedModel?.generation.image?.aspectRatios.length"
          class="generation-control"
        >
          <span>画幅</span>
          <select
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
              {{ value === 'auto' ? '自动' : value }}
            </option>
          </select>
        </label>
        <label
          v-if="selectedModel?.generation.image?.formats.length"
          class="generation-control"
        >
          <span>格式</span>
          <select
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
        </label>
      </div>

      <div
        v-else-if="chat.preferences.outputType === 'audio'"
        class="generation-options"
        data-testid="audio-options"
      >
        <span class="generation-heading">音频设置</span>
        <label
          v-if="selectedModel?.generation.audio?.voices.length"
          class="generation-control"
        >
          <span>音色</span>
          <select
            data-testid="audio-voice"
            :value="chat.preferences.generation.audio.voice ?? ''"
            :disabled="disabled || running || modelsLoading"
            aria-label="音色"
            @change="changeAudioOption('voice', $event)"
          >
            <option value="">
              模型默认
            </option>
            <option
              v-for="value in selectedModel.generation.audio.voices"
              :key="value"
              :value="value"
            >
              {{ value }}
            </option>
          </select>
        </label>
        <label
          v-if="selectedModel?.generation.audio?.formats.length"
          class="generation-control"
        >
          <span>格式</span>
          <select
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
        </label>
      </div>

      <div
        v-else-if="chat.preferences.outputType === 'video'"
        class="generation-options"
        data-testid="video-options"
      >
        <span class="generation-heading">视频设置</span>
        <label
          v-if="selectedModel?.generation.video?.durations.length"
          class="generation-control"
        >
          <span>时长</span>
          <select
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
        </label>
        <label
          v-if="selectedModel?.generation.video?.resolutions.length"
          class="generation-control"
        >
          <span>分辨率</span>
          <select
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
        </label>
        <label
          v-if="selectedModel?.generation.video?.aspectRatios.length"
          class="generation-control"
        >
          <span>画幅</span>
          <select
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
              {{ value === 'auto' ? '自动' : value }}
            </option>
          </select>
        </label>
        <label
          v-if="selectedModel?.generation.video?.supportsAudio"
          class="generation-toggle"
        >
          <input
            type="checkbox"
            data-testid="video-generate-audio"
            :checked="chat.preferences.generation.video.generateAudio"
            :disabled="disabled || running || modelsLoading"
            @change="changeVideoAudio"
          >
          <span>生成音频</span>
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

      <div class="composer-input">
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
      </div>
    </div>
  </form>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import {
  chatFileSupport,
  type AttachmentKind,
  type ChatSendInput,
  type ConversationGenerationPreferences,
  type GenerationOptions,
  type ModelInfo,
  type ModelProviderId,
  type OutputType,
} from '@autoforge/shared'
import { useChatStore, type ChatSendAcknowledgement } from '../../stores/chat'
import KnowledgeSelector from '../knowledge/KnowledgeSelector.vue'

type ConcreteOutput = Exclude<OutputType, 'auto'>

const props = withDefaults(defineProps<{
  disabled: boolean
  running: boolean
  provider: ModelProviderId
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
  if (output === 'video') {
    const video = model.generation.video
    const imageCapacity = Math.max(
      video?.frameImages.length ?? 0,
      video?.maxReferenceImages ?? 0,
    )
    if (chat.drafts.length > imageCapacity) return false
  }
  return chat.drafts.every((asset) => {
    if (asset.kind === 'file') {
      return output === 'text'
        && chatFileSupport(props.provider, asset.name, asset.mimeType).mode !== 'unsupported'
    }
    return model.inputModalities.includes(asset.kind)
  })
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

const hasFileDraft = computed(() => chat.drafts.some(({ kind }) => kind === 'file'))

function modelOptionSupportsRequest(model: ModelInfo): boolean {
  const output = chat.preferences.outputType
  if (output !== 'auto') return modelSupportsRequest(model, output)
  return model.outputModalities.some((candidate) => modelSupportsRequest(model, candidate))
}

function modelOptionLabel(model: ModelInfo): string {
  if (chat.drafts.length === 0 || modelOptionSupportsRequest(model)) return model.name
  return `${model.name}（不支持当前附件）`
}

const attachmentCompatibilityMessage = computed(() => {
  const output = chat.preferences.outputType
  const model = selectedModel.value
  if (!model) return '当前模型不支持已添加的附件。'
  if (hasFileDraft.value) {
    return '当前模型无法读取该附件格式。请更换模型、供应商或移除附件。'
  }
  if (output === 'text') {
    const unsupported = [...new Set(chat.drafts
      .filter(({ kind }) => kind !== 'file' && !model.inputModalities.includes(kind))
      .map(({ kind }) => kindLabel(kind)))]
    if (unsupported.length > 0) {
      const kinds = unsupported.join('、')
      return `文本输出仍需要模型支持${kinds}输入。当前模型无法读取已添加的${kinds}；请切换模型或移除附件。`
    }
  }
  if ((output === 'image' || output === 'video')
    && chat.drafts.some(({ kind }) => kind !== 'image')) {
    return `${kindLabel(output)}生成仅支持图片附件作为参考。请移除不兼容的附件。`
  }
  if (output === 'video') {
    const video = model.generation.video
    const imageCapacity = Math.max(
      video?.frameImages.length ?? 0,
      video?.maxReferenceImages ?? 0,
    )
    if (chat.drafts.length > imageCapacity) {
      return `当前模型最多支持 ${imageCapacity} 张参考图片。请移除多余附件。`
    }
  }
  return '当前模型不支持已添加的附件。请切换模型或移除附件。'
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

function kindLabel(kind: AttachmentKind) {
  return kind === 'image' ? '图片' : kind === 'audio' ? '音频' : kind === 'video' ? '视频' : '文件'
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
.composer {
  border-top: 1px solid var(--af-border);
  padding: 12px 16px 16px;
  background: color-mix(in srgb, var(--af-canvas) 54%, var(--af-surface));
}
.composer-frame {
  border: 1px solid var(--af-border);
  border-radius: 14px;
  padding: 10px;
  background: var(--af-surface);
  box-shadow: 0 7px 24px rgb(32 36 43 / 7%);
}
.composer-tools {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
  margin-bottom: 10px;
}
.composer-actions, .composer-routing, .generation-options {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.composer-actions { flex: none; }
.composer-routing { min-width: min(100%, 360px); flex: 1 1 420px; }
.composer-routing label {
  display: inline-flex;
  min-height: 34px;
  align-items: center;
  gap: 6px;
  border: 1px solid var(--af-border);
  border-radius: 9px;
  padding-left: 9px;
  color: var(--af-text-muted);
  background: var(--af-surface-muted);
  font-size: 0.6875rem;
  transition: border-color .15s ease, box-shadow .15s ease, background .15s ease;
}
.composer-routing label:focus-within {
  border-color: color-mix(in srgb, var(--af-cobalt) 62%, var(--af-border));
  background: var(--af-surface);
  box-shadow: var(--af-focus);
}
.composer-routing label > span { flex: none; font-weight: 650; }
.output-control { flex: 0 0 122px; }
.model-control { min-width: 220px; flex: 1 1 280px; }
.tool-button, select, .remove-draft {
  border: 1px solid var(--af-border-strong);
  border-radius: 8px;
  padding: 6px 9px;
  color: var(--af-text);
  background: var(--af-surface);
  font: inherit;
}
.tool-button {
  min-height: 34px;
  cursor: pointer;
  font-size: 0.75rem;
  font-weight: 600;
  transition: border-color .15s ease, color .15s ease, background .15s ease;
}
.tool-button:hover:not(:disabled) {
  border-color: color-mix(in srgb, var(--af-cobalt) 38%, var(--af-border));
  color: var(--af-cobalt);
  background: color-mix(in srgb, var(--af-cobalt-soft) 52%, var(--af-surface));
}
.composer-routing select {
  min-width: 0;
  height: 32px;
  flex: 1;
  border: 0;
  padding: 0 26px 0 0;
  background-color: transparent;
  outline: 0;
  box-shadow: none;
}
.generation-options {
  width: fit-content;
  max-width: 100%;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 9px;
  padding: 1px 0;
}
.generation-heading {
  display: inline-flex;
  min-height: 34px;
  align-items: center;
  padding: 0 5px 0 2px;
  color: var(--af-text-muted);
  font-size: 0.625rem;
  font-weight: 700;
  letter-spacing: .04em;
}
.generation-value, .generation-control, .generation-toggle {
  display: inline-flex;
  min-height: 34px;
  align-items: center;
  gap: 6px;
  border: 1px solid var(--af-border);
  border-radius: 9px;
  padding-left: 9px;
  color: var(--af-text);
  background: var(--af-surface-muted);
  transition: border-color .15s ease, box-shadow .15s ease, background .15s ease;
}
.generation-value > span, .generation-control > span {
  color: var(--af-text-muted);
  font-size: 0.625rem;
  font-weight: 650;
}
.generation-value strong {
  padding-right: 10px;
  font-size: 0.6875rem;
  font-weight: 650;
  line-height: 1.2;
}
.generation-control:focus-within {
  border-color: color-mix(in srgb, var(--af-cobalt) 62%, var(--af-border));
  background: var(--af-surface);
  box-shadow: var(--af-focus);
}
.generation-control select {
  min-width: 72px;
  height: 32px;
  border: 0;
  padding: 0 26px 0 0;
  background-color: transparent;
  font-size: 0.6875rem;
  line-height: 1.2;
  outline: 0;
  box-shadow: none;
}
.generation-toggle {
  gap: 7px;
  padding: 0 10px;
  color: var(--af-text-muted);
  cursor: pointer;
  font-size: 0.6875rem;
  font-weight: 600;
}
.generation-toggle input { margin: 0; accent-color: var(--af-cobalt); }
.generation-toggle:has(input:checked) {
  border-color: color-mix(in srgb, var(--af-cobalt) 32%, var(--af-border));
  color: var(--af-cobalt);
  background: color-mix(in srgb, var(--af-cobalt-soft) 58%, var(--af-surface));
}
.tool-button:disabled, .remove-draft:disabled, select:disabled { cursor: not-allowed; opacity: 0.55; }
.choice-required {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin-bottom: 9px;
  border: 1px solid color-mix(in srgb, var(--af-warning) 26%, var(--af-border));
  border-radius: 9px;
  padding: 8px 10px;
  color: var(--af-warning-text);
  background: var(--af-warning-soft);
  font-size: 0.75rem;
  line-height: 1.5;
}
.choice-icon {
  display: grid;
  width: 17px;
  height: 17px;
  flex: 0 0 17px;
  place-items: center;
  margin-top: 1px;
  border-radius: 50%;
  color: var(--af-surface);
  background: var(--af-warning);
  font-size: 0.625rem;
  font-weight: 800;
}
.draft-list { display: grid; gap: 6px; margin-bottom: 9px; }
.draft-card {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto auto;
  align-items: center;
  gap: 8px;
  border: 1px solid var(--af-border);
  border-radius: 9px;
  padding: 7px 9px;
  background: var(--af-surface-muted);
  font-size: 0.75rem;
}
.draft-kind {
  border-radius: 5px;
  padding: 2px 6px;
  color: var(--af-cobalt);
  background: var(--af-cobalt-soft);
  font-size: 0.625rem;
  font-weight: 650;
}
.draft-size { color: var(--af-text-muted); font-variant-numeric: tabular-nums; }
.draft-name { overflow: hidden; font-weight: 550; text-overflow: ellipsis; white-space: nowrap; }
.remove-draft { padding: 3px 7px; color: var(--af-danger); background: var(--af-surface); cursor: pointer; }
.remove-draft:hover:not(:disabled) { border-color: var(--af-danger-border); background: var(--af-danger-soft); }
.composer-input {
  overflow: hidden;
  border: 1px solid var(--af-border-strong);
  border-radius: 11px;
  background: var(--af-surface);
  transition: border-color .15s ease, box-shadow .15s ease;
}
.composer-input:hover { border-color: var(--af-control-hover); }
.composer-input:focus-within {
  border-color: color-mix(in srgb, var(--af-cobalt) 62%, var(--af-border));
  box-shadow: var(--af-focus);
}
textarea {
  display: block;
  width: 100%;
  min-height: 66px;
  max-height: 180px;
  resize: vertical;
  border: 0;
  padding: 10px 12px 6px;
  color: var(--af-text);
  background: transparent;
  line-height: 1.5;
  outline: 0;
  box-shadow: none;
}
textarea::placeholder { color: var(--af-text-muted); opacity: .74; }
textarea:disabled { cursor: not-allowed; background: var(--af-surface-muted); }
.composer-footer {
  display: flex;
  min-height: 40px;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 4px 8px 8px 12px;
}
.composer-footer span { color: var(--af-text-muted); font-size: 0.6875rem; }
.composer-actions :deep(.knowledge-selector > summary) {
  display: flex;
  min-height: 34px;
  align-items: center;
  border-color: var(--af-border-strong);
  border-radius: 8px;
  padding: 6px 9px;
  font-size: 0.75rem;
  font-weight: 600;
}
@media (max-width: 1100px) {
  .composer-routing { flex-basis: 100%; }
}
</style>
