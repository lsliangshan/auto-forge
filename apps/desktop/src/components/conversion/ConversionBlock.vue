<template>
  <section
    class="conversion-block af-operation-card"
    aria-label="文件转换结果"
  >
    <header class="af-operation-card-header conversion-header">
      <span
        class="conversion-header-icon"
        aria-hidden="true"
      >
        <el-icon><DocumentCopy /></el-icon>
      </span>
      <div class="conversion-header-copy">
        <span>本地文件处理</span>
        <strong>文件转换</strong>
        <p>{{ summary }}</p>
      </div>
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
          <span class="conversion-status-copy">
            <i
              :class="{ complete: job.status === 'completed' }"
              aria-hidden="true"
            />
            <strong>{{ statusLabel(job.status) }}</strong>
          </span>
          <span class="conversion-format-pill">{{ job.targetFormat.toUpperCase() }}</span>
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
            <div class="conversion-artifact-identity">
              <span
                class="conversion-file-kind"
                aria-hidden="true"
              >
                <el-icon><Document /></el-icon>
                <small>{{ artifact.detectedFormat.toUpperCase() }}</small>
              </span>
              <div class="conversion-artifact-copy">
                <strong>{{ artifact.displayName }}</strong>
                <p>{{ artifactMetadata(artifact) }}</p>
                <p
                  v-if="artifact.status === 'deleted'"
                  class="conversion-deleted"
                >
                  已删除
                </p>
              </div>
            </div>
            <div class="conversion-actions">
              <button
                type="button"
                class="conversion-action conversion-action-primary"
                data-testid="conversion-save-copy"
                :aria-label="`下载 ${artifact.displayName}`"
                :disabled="artifact.status !== 'ready' || pending(artifact.artifactId)"
                @click="act('saveCopy', artifact)"
              >
                <el-icon aria-hidden="true">
                  <Download />
                </el-icon>
                下载
              </button>
              <button
                type="button"
                class="conversion-action"
                data-testid="conversion-preview"
                :aria-label="`预览 ${artifact.displayName}`"
                :disabled="artifact.status !== 'ready' || pending(artifact.artifactId)"
                @click="act('preview', artifact)"
              >
                <el-icon aria-hidden="true">
                  <View />
                </el-icon>
                预览
              </button>
              <button
                type="button"
                class="conversion-action conversion-action-danger"
                data-testid="conversion-delete"
                :aria-label="`删除 ${artifact.displayName}`"
                :disabled="artifact.status !== 'ready' || pending(artifact.artifactId)"
                @click="act('deleteArtifact', artifact)"
              >
                <el-icon aria-hidden="true">
                  <Delete />
                </el-icon>
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
import { Delete, Document, DocumentCopy, Download, View } from '@element-plus/icons-vue'
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
function act(action: 'saveCopy' | 'preview' | 'deleteArtifact', artifact: ConversionArtifactView): void {
  void conversion.actOnArtifact(action, artifact)
}
</script>

<style scoped>
.conversion-block { width: min(100%, 680px); overflow: hidden; box-shadow: 0 10px 30px rgb(32 36 43 / 7%), 0 2px 8px rgb(32 36 43 / 4%); }
.conversion-header { grid-template-columns: auto minmax(0, 1fr); min-height: 76px; border-bottom: 1px solid color-mix(in srgb, var(--af-border) 76%, transparent); padding: 14px 16px; background: color-mix(in srgb, var(--af-surface-muted) 56%, var(--af-surface)); }
.conversion-header-icon { display: grid; width: 40px; height: 40px; place-items: center; border: 1px solid color-mix(in srgb, var(--af-cobalt) 18%, var(--af-border)); border-radius: 12px; color: var(--af-cobalt); background: var(--af-cobalt-soft); box-shadow: 0 5px 14px color-mix(in srgb, var(--af-cobalt) 10%, transparent); font-size: 18px; }
.conversion-header-copy { display: grid; min-width: 0; grid-template-columns: minmax(0, 1fr) auto; align-items: baseline; gap: 2px 12px; }
.conversion-header-copy > span { grid-column: 1 / -1; color: var(--af-text-muted); font-size: 9px; font-weight: 750; letter-spacing: .1em; }
.conversion-header-copy strong { color: var(--af-graphite); font-size: 14px; font-weight: 720; }
.conversion-header-copy p, .conversion-artifact p { margin: 0; color: var(--af-text-muted); font-size: 11px; }
.conversion-note, .conversion-failure { margin: 0; padding: 10px 16px; font-size: 12px; }
.conversion-failure { color: var(--af-danger); background: var(--af-danger-soft); }
.conversion-job { padding: 14px 16px 16px; }.conversion-job + .conversion-job { border-top: 1px solid var(--af-border); }
.conversion-job-status { display: flex; align-items: center; justify-content: space-between; gap: 10px; font-size: 12px; }
.conversion-status-copy { display: inline-flex; align-items: center; gap: 7px; }.conversion-status-copy i { width: 7px; height: 7px; border-radius: 50%; background: var(--af-cobalt); box-shadow: 0 0 0 3px color-mix(in srgb, var(--af-cobalt) 11%, transparent); }.conversion-status-copy i.complete { background: var(--af-success); box-shadow: 0 0 0 3px color-mix(in srgb, var(--af-success) 12%, transparent); }
.conversion-format-pill { border: 1px solid color-mix(in srgb, var(--af-success) 18%, var(--af-border)); border-radius: 999px; padding: 3px 8px; color: var(--af-success); background: var(--af-success-soft); font-size: 9px; font-weight: 750; letter-spacing: .04em; }
.conversion-progress { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; align-items: center; margin-top: 9px; color: var(--af-text-muted); font-size: 11px; }.conversion-progress > span { height: 5px; border-radius: 99px; background: linear-gradient(to right, var(--af-cobalt) var(--conversion-progress), var(--af-border) var(--conversion-progress)); }
.conversion-job-actions { display: flex; justify-content: flex-end; margin-top: 9px; }.conversion-job-actions button { font-size: 11px; }.conversion-job-action-error { margin-top: 8px; padding: 7px 8px; }
.conversion-results { display: grid; gap: 9px; margin-top: 12px; }.conversion-artifact { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 14px; align-items: center; border: 1px solid color-mix(in srgb, var(--af-border-strong) 72%, var(--af-border)); border-radius: 11px; padding: 11px 12px; background: var(--af-surface); box-shadow: 0 3px 12px rgb(32 36 43 / 4%); transition: border-color .15s ease, box-shadow .15s ease; }.conversion-artifact:hover { border-color: color-mix(in srgb, var(--af-cobalt) 26%, var(--af-border)); box-shadow: 0 5px 16px rgb(32 36 43 / 7%); }
.conversion-artifact-identity { display: flex; min-width: 0; align-items: center; gap: 10px; }.conversion-file-kind { display: grid; width: 38px; height: 42px; flex: 0 0 38px; grid-template-rows: 26px 14px; place-items: center; overflow: hidden; border: 1px solid color-mix(in srgb, var(--af-cobalt) 18%, var(--af-border)); border-radius: 8px; color: var(--af-cobalt); background: color-mix(in srgb, var(--af-cobalt-soft) 58%, var(--af-surface)); font-size: 15px; }.conversion-file-kind small { align-self: stretch; width: 100%; color: var(--af-surface); background: var(--af-cobalt); font-size: 7px; font-weight: 800; line-height: 14px; letter-spacing: .03em; text-align: center; }
.conversion-artifact-copy { min-width: 0; }.conversion-artifact strong { display: block; overflow: hidden; color: var(--af-graphite); font-size: 12px; font-weight: 680; text-overflow: ellipsis; white-space: nowrap; }.conversion-artifact-copy p { margin-top: 4px; }.conversion-deleted { color: var(--af-text-muted); }
.conversion-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 6px; }.conversion-action { display: inline-flex; min-height: 30px; align-items: center; justify-content: center; gap: 4px; border: 1px solid var(--af-border-strong); border-radius: 7px; padding: 5px 9px; color: var(--af-text); background: var(--af-surface); cursor: pointer; font-size: 10px; transition: border-color .15s ease, color .15s ease, background .15s ease, box-shadow .15s ease; }.conversion-action:hover:not(:disabled) { border-color: var(--af-cobalt); color: var(--af-cobalt); background: var(--af-cobalt-soft); }.conversion-action:disabled { cursor: not-allowed; opacity: .5; }.conversion-action-primary { border-color: color-mix(in srgb, var(--af-cobalt) 28%, var(--af-border)); color: var(--af-cobalt); background: var(--af-cobalt-soft); font-weight: 680; }.conversion-action-primary:hover:not(:disabled) { border-color: var(--af-cobalt); box-shadow: 0 3px 9px color-mix(in srgb, var(--af-cobalt) 14%, transparent); }.conversion-action-danger { color: var(--af-text-muted); }.conversion-action-danger:hover:not(:disabled) { border-color: color-mix(in srgb, var(--af-danger) 36%, var(--af-border)); color: var(--af-danger); background: var(--af-danger-soft); }.conversion-artifact > .conversion-failure { grid-column: 1 / -1; padding: 0; background: transparent; }
@media (max-width: 720px) { .conversion-artifact { grid-template-columns: 1fr; }.conversion-actions { justify-content: flex-start; padding-left: 48px; } }
</style>
