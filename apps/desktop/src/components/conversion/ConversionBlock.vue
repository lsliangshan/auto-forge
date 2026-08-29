<template>
  <section
    class="conversion-block af-operation-card"
    aria-label="文件转换结果"
  >
    <header class="af-operation-card-header">
      <span
        class="af-operation-marker tone-active"
        aria-hidden="true"
      >转换</span>
      <div><strong>文件转换</strong><p>{{ summary }}</p></div>
    </header>
    <p
      v-if="loading"
      class="conversion-note"
      role="status"
    >
      正在读取本地转换状态
    </p>
    <p
      v-else-if="loadError"
      class="conversion-failure"
      role="alert"
    >
      {{ loadError }}
    </p>
    <p
      v-else-if="unavailable"
      class="conversion-note"
      role="status"
    >
      转换结果仅在发起转换的设备上可用
    </p>
    <template v-else>
      <article
        v-for="job in jobs"
        :key="job.jobId"
        class="conversion-job"
        :aria-busy="isActive(job.status)"
      >
        <div
          class="conversion-job-status"
          role="status"
          aria-live="polite"
        >
          <strong>{{ statusLabel(job.status) }}</strong><span>{{ job.targetFormat.toUpperCase() }}</span>
        </div>
        <div
          v-if="isActive(job.status)"
          class="conversion-progress"
          role="progressbar"
          :aria-label="statusLabel(job.status)"
          :aria-valuemin="0"
          :aria-valuemax="100"
          :aria-valuenow="job.progress"
          :aria-valuetext="`${statusLabel(job.status)} ${job.progress}%`"
          :style="{ '--conversion-progress': `${job.progress}%` }"
        >
          <span /><em>{{ job.progress }}%</em>
        </div>
        <p
          v-else-if="job.status === 'failed'"
          class="conversion-failure"
          role="alert"
        >
          转换失败，请稍后重试
        </p>
        <p
          v-else-if="job.status === 'cancelled'"
          class="conversion-note"
          role="status"
        >
          转换已取消
        </p>
        <p
          v-else-if="job.status === 'interrupted'"
          class="conversion-note"
          role="status"
        >
          转换已中断，请重新发起转换
        </p>
        <div
          v-if="isActive(job.status) || isRetryable(job.status)"
          class="conversion-job-actions"
        >
          <button
            v-if="isActive(job.status)"
            type="button"
            class="af-secondary-button"
            data-testid="conversion-cancel"
            :aria-label="`取消 ${job.targetFormat.toUpperCase()} 转换`"
            :disabled="jobPending(job.jobId)"
            @click="actOnJob('cancel', job)"
          >
            取消转换
          </button>
          <button
            v-else
            type="button"
            class="af-secondary-button"
            data-testid="conversion-retry"
            :aria-label="`重试 ${job.targetFormat.toUpperCase()} 转换`"
            :disabled="jobPending(job.jobId)"
            @click="actOnJob('retry', job)"
          >
            重试转换
          </button>
        </div>
        <p
          v-if="jobActionError(job.jobId)"
          class="conversion-failure conversion-job-action-error"
          role="alert"
          aria-live="assertive"
        >
          {{ jobActionError(job.jobId) }}
        </p>
        <div
          v-if="job.status === 'completed'"
          class="conversion-results"
        >
          <article
            v-for="artifact in job.artifacts"
            :key="artifact.artifactId"
            class="conversion-artifact"
          >
            <div>
              <strong>{{ artifact.displayName }}</strong><p>{{ artifactMetadata(artifact) }}</p><p
                v-if="artifact.status === 'deleted'"
                class="conversion-deleted"
              >
                已删除
              </p>
            </div>
            <div class="conversion-actions">
              <button
                type="button"
                class="af-secondary-button"
                data-testid="conversion-save-copy"
                :disabled="artifact.status !== 'ready' || pending(artifact.artifactId)"
                @click="act('saveCopy', artifact)"
              >
                保存副本
              </button>
              <button
                type="button"
                class="af-secondary-button"
                data-testid="conversion-reveal"
                :disabled="artifact.status !== 'ready' || pending(artifact.artifactId)"
                @click="act('reveal', artifact)"
              >
                显示位置
              </button>
              <button
                type="button"
                class="af-secondary-button"
                data-testid="conversion-delete"
                :disabled="artifact.status !== 'ready' || pending(artifact.artifactId)"
                @click="act('deleteArtifact', artifact)"
              >
                删除
              </button>
            </div>
            <p
              v-if="actionError(artifact.artifactId)"
              class="conversion-failure"
              role="alert"
            >
              {{ actionError(artifact.artifactId) }}
            </p>
          </article>
        </div>
      </article>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted } from 'vue'
import type { ConversionArtifactView, ConversionJobStatus, ConversionJobView } from '@autoforge/shared'
import type { UiChatBlock } from '../../stores/chat'
import { useConversionStore } from '../../stores/conversion'

type ConversionBlockData = Extract<UiChatBlock, { type: 'conversion' }>
const props = defineProps<{ block: ConversionBlockData }>()
const conversion = useConversionStore()
const jobs = computed(() => conversion.jobsForExecution(props.block.executionId))
const loading = computed(() => Boolean(conversion.loadingByExecution[props.block.executionId]))
const loadError = computed(() => conversion.errorsByExecution[props.block.executionId] ?? '')
const unavailable = computed(() => Boolean(conversion.unavailableByExecution[props.block.executionId]))
const summary = computed(() => jobs.value.length ? `${jobs.value.length} 个本地转换任务` : '本地转换结果')
let releaseSubscription: (() => void) | undefined

onMounted(() => {
  releaseSubscription = conversion.acquireSubscription()
  void conversion.loadForExecution(props.block.executionId)
})
onUnmounted(() => releaseSubscription?.())

function isActive(status: ConversionJobStatus): boolean {
  return ['queued', 'downloading_component', 'converting', 'verifying'].includes(status)
}

function isRetryable(status: ConversionJobStatus): boolean {
  return ['failed', 'cancelled', 'interrupted'].includes(status)
}

function statusLabel(status: ConversionJobStatus): string {
  return ({
    queued: '等待转换队列', downloading_component: '正在下载转换组件', converting: '正在转换', verifying: '正在验证结果',
    completed: '转换完成', failed: '转换失败', cancelled: '转换已取消', interrupted: '转换已中断',
  })[status]
}

function artifactMetadata(artifact: ConversionArtifactView): string {
  const metadata = artifact.metadata
  if (!metadata) return artifact.detectedFormat.toUpperCase()
  if (metadata.pdfPage) return `第 ${metadata.pdfPage} 页`
  if (metadata.iconRepresentation) {
    const slot = metadata.iconRepresentation
    return `${slot.sourceType}: ${slot.logicalWidth}×${slot.logicalHeight} @${slot.scale}x (${slot.pixelWidth}×${slot.pixelHeight})`
  }
  if (metadata.iconRepresentations) return `图标规格: ${metadata.iconRepresentations.map((size) => `${size}×${size}`).join('、')}`
  if (metadata.frameSelection) return '首帧'
  if (metadata.transparentPadding) return '保留透明边距'
  return artifact.detectedFormat.toUpperCase()
}

function pending(artifactId: string): boolean { return Boolean(conversion.pendingArtifactIds[artifactId]) }
function actionError(artifactId: string): string { return conversion.actionErrorsByArtifact[artifactId] ?? '' }
function jobPending(jobId: string): boolean { return Boolean(conversion.pendingJobIds[jobId]) }
function jobActionError(jobId: string): string { return conversion.actionErrorsByJob[jobId] ?? '' }
function actOnJob(action: 'cancel' | 'retry', job: ConversionJobView): void {
  void conversion.actOnJob(action, job)
}
function act(action: 'saveCopy' | 'reveal' | 'deleteArtifact', artifact: ConversionArtifactView): void {
  void conversion.actOnArtifact(action, artifact)
}
</script>

<style scoped>
.conversion-block { width: min(100%, 680px); overflow: hidden; }
.conversion-block header p, .conversion-artifact p { margin: 3px 0 0; color: var(--af-text-muted); font-size: 12px; }
.conversion-note, .conversion-failure { margin: 0; padding: 10px 16px; font-size: 12px; }
.conversion-failure { color: var(--af-danger); background: var(--af-danger-soft); }
.conversion-job { border-top: 1px solid var(--af-border); padding: 12px 16px; }
.conversion-job-status { display: flex; justify-content: space-between; gap: 10px; font-size: 13px; }.conversion-job-status span { color: var(--af-text-muted); font-size: 11px; }
.conversion-progress { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; align-items: center; margin-top: 9px; color: var(--af-text-muted); font-size: 11px; }.conversion-progress > span { height: 5px; border-radius: 99px; background: linear-gradient(to right, var(--af-cobalt) var(--conversion-progress), var(--af-border) var(--conversion-progress)); }
.conversion-job-actions { display: flex; justify-content: flex-end; margin-top: 9px; }.conversion-job-actions button { font-size: 11px; }.conversion-job-action-error { margin-top: 8px; padding: 7px 8px; }
.conversion-results { display: grid; gap: 8px; margin-top: 10px; }.conversion-artifact { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 12px; align-items: center; border: 1px solid var(--af-border); padding: 9px 10px; }.conversion-artifact > div:first-child { min-width: 0; }.conversion-artifact strong { overflow-wrap: anywhere; word-break: break-word; }.conversion-deleted { color: var(--af-text-muted); }.conversion-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 6px; }.conversion-actions button { font-size: 11px; }.conversion-artifact > .conversion-failure { grid-column: 1 / -1; padding: 0; background: transparent; }
</style>
