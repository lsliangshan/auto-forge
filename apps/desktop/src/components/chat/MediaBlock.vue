<template>
  <section class="af-media-card">
    <img
      v-if="inlineImage && source"
      class="af-media-image"
      :src="source"
      :alt="block.name"
    >
    <audio
      v-else-if="block.kind === 'audio' && source"
      class="af-media-audio"
      :src="source"
      controls
    />
    <video
      v-else-if="block.kind === 'video' && source"
      class="af-media-video"
      :src="source"
      controls
      preload="metadata"
    />

    <div class="af-media-details">
      <strong class="af-truncate">{{ block.name }}</strong>
      <span class="af-media-metadata">{{ metadata }}</span>
    </div>
    <div class="af-media-actions">
      <button
        type="button"
        class="af-secondary-button"
        data-testid="save-media-copy"
        :disabled="busy !== null"
        aria-label="保存媒体副本"
        @click="runAction('save')"
      >
        保存副本
      </button>
      <button
        type="button"
        class="af-secondary-button"
        data-testid="reveal-media"
        :disabled="busy !== null"
        aria-label="在文件管理器中显示媒体"
        @click="runAction('reveal')"
      >
        在文件管理器中显示
      </button>
    </div>
    <p
      v-if="actionError"
      class="af-media-action-error"
      role="alert"
    >
      {{ actionError }}
    </p>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import type { UiChatBlock } from '../../stores/chat'
import { displayError, getDesktopApi } from '../../services/desktop-api'

type MediaBlockData = Extract<UiChatBlock, { type: 'media' }>

const props = defineProps<{ block: MediaBlockData }>()
const assetIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const source = computed(() => (
  assetIdPattern.test(props.block.assetId)
    ? `autoforge-media://asset/${props.block.assetId}`
    : undefined
))
const inlineImage = computed(() => (
  props.block.kind === 'image' && props.block.mimeType.toLowerCase() !== 'image/svg+xml'
))
const busy = ref<'save' | 'reveal' | null>(null)
const actionError = ref('')

const formatLabel = computed(() => {
  const extension = props.block.name.split('.').at(-1)?.trim()
  if (extension) return extension.toUpperCase()
  return props.block.mimeType.split('/').at(-1)?.toUpperCase() ?? props.block.mimeType
})

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${Number((bytes / 1024).toFixed(1))} KB`
  return `${Number((bytes / 1024 ** 2).toFixed(1))} MB`
}

function formatDuration(durationMs: number): string {
  const seconds = Math.floor(durationMs / 1000)
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const remainder = seconds % 60
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`
    : `${minutes}:${String(remainder).padStart(2, '0')}`
}

const metadata = computed(() => [
  formatLabel.value,
  props.block.durationMs === undefined ? undefined : formatDuration(props.block.durationMs),
  props.block.width && props.block.height ? `${props.block.width} × ${props.block.height}` : undefined,
  formatBytes(props.block.byteSize),
].filter(Boolean).join(' · '))

async function runAction(action: 'save' | 'reveal'): Promise<void> {
  if (busy.value) return
  busy.value = action
  actionError.value = ''
  try {
    if (action === 'save') await getDesktopApi().media.saveCopy(props.block.assetId)
    else await getDesktopApi().media.reveal(props.block.assetId)
  } catch (error) {
    actionError.value = displayError(
      error,
      action === 'save' ? '媒体副本保存失败' : '无法在文件管理器中显示媒体',
    )
  } finally {
    busy.value = null
  }
}
</script>
