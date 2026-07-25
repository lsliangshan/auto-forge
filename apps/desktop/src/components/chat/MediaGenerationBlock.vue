<template>
  <section
    class="af-media-generation"
    :class="{ 'is-failed': block.status === 'failed' }"
  >
    <div
      v-if="active"
      class="af-media-generation-status"
      data-testid="generation-progress"
      role="status"
      aria-live="polite"
    >
      <el-icon class="is-loading">
        <Loading />
      </el-icon>
      <strong>{{ statusLabel }}</strong>
    </div>
    <div
      v-else-if="block.status === 'paused'"
      class="af-media-generation-status"
      role="status"
    >
      <strong>{{ statusLabel }}</strong>
    </div>
    <div
      v-else
      class="af-media-generation-failure"
      role="alert"
    >
      <strong>生成失败</strong>
      <span>{{ failureMessage }}</span>
    </div>

    <template v-if="block.kind === 'video'">
      <p
        v-if="active"
        class="af-media-generation-warning"
      >
        暂停只会停止本地跟踪，上游任务可能继续执行并产生费用。
      </p>
      <button
        v-if="active"
        type="button"
        class="af-secondary-button"
        data-testid="pause-video-job"
        :disabled="actionPending"
        @click="pause"
      >
        暂停跟踪
      </button>
      <button
        v-else-if="block.status === 'paused'"
        type="button"
        class="af-secondary-button"
        data-testid="resume-video-job"
        :disabled="actionPending"
        @click="resume"
      >
        继续跟踪
      </button>
    </template>

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
import { Loading } from '@element-plus/icons-vue'
import { computed, ref } from 'vue'
import type { UiChatBlock } from '../../stores/chat'
import { displayError, getDesktopApi } from '../../services/desktop-api'

type GenerationBlockData = Extract<UiChatBlock, { type: 'media_generation' }>

const props = defineProps<{ block: GenerationBlockData }>()
const actionPending = ref(false)
const actionError = ref('')
const active = computed(() => (
  props.block.status === 'pending'
  || props.block.status === 'in_progress'
  || props.block.status === 'downloading'
))
const kindLabel = computed(() => ({
  image: '图片',
  audio: '音频',
  video: '视频',
})[props.block.kind])
const statusLabel = computed(() => ({
  pending: `正在准备${kindLabel.value}生成`,
  in_progress: `正在生成${kindLabel.value}`,
  downloading: `正在下载${kindLabel.value}`,
  paused: '已暂停跟踪',
  failed: '生成失败',
})[props.block.status])
const failureMessage = computed(() => displayError(
  props.block.errorCode ? { code: props.block.errorCode } : undefined,
  '媒体生成失败',
))

async function runAction(action: 'pause' | 'resume'): Promise<void> {
  if (actionPending.value) return
  actionPending.value = true
  actionError.value = ''
  try {
    if (action === 'pause') await getDesktopApi().media.pauseVideoJob(props.block.jobId)
    else await getDesktopApi().media.resumeVideoJob(props.block.jobId)
  } catch (error) {
    actionError.value = displayError(
      error,
      action === 'pause' ? '暂停跟踪失败' : '继续跟踪失败',
    )
  } finally {
    actionPending.value = false
  }
}

function pause(): void {
  void runAction('pause')
}

function resume(): void {
  void runAction('resume')
}
</script>
