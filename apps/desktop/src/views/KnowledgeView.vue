<template>
  <div class="knowledge-view">
    <div
      v-if="availabilityLabel"
      class="knowledge-availability"
      :class="availabilityTone"
      data-testid="knowledge-local-availability"
      role="status"
    >
      <span class="availability-copy">
        <el-icon><CircleCheckFilled v-if="availabilityTone === 'success'" /><WarningFilled v-else /></el-icon>
        {{ availabilityLabel }}
      </span>
      <button
        v-if="canRetainSelection"
        type="button"
        data-testid="knowledge-retain-free-selection"
        :disabled="store.busy"
        @click="store.retainSelectedForFreeTier"
      >
        保留当前知识库和文件
      </button>
    </div>
    <div
      v-if="store.error"
      class="knowledge-error"
      role="alert"
    >
      <el-icon><WarningFilled /></el-icon>
      <span>{{ store.error }}</span>
    </div>
    <div
      class="knowledge-workspace"
      data-testid="knowledge-workspace"
    >
      <KnowledgeBaseList />
      <KnowledgeInspector />
    </div>
  </div>
</template>

<script setup lang="ts">
import { CircleCheckFilled, WarningFilled } from '@element-plus/icons-vue'
import { computed, onMounted, watch } from 'vue'
import KnowledgeBaseList from '../components/knowledge/KnowledgeBaseList.vue'
import KnowledgeInspector from '../components/knowledge/KnowledgeInspector.vue'
import { useAuthStore } from '../stores/auth'
import { useKnowledgeStore } from '../stores/knowledge'

const auth = useAuthStore()
const store = useKnowledgeStore()
const availabilityLabel = computed(() => {
  if (!store.availability || !store.entitlement) return ''
  if (!store.entitlement.localEnabled) return '本地知识库不可用 · 当前账户权益未启用'
  if (!store.availability.encryption.available) return '本地知识库不可用 · 本地加密不可用'
  if (!store.availability.parser.available) return '本地知识库不可用 · 文档解析器不可用'
  const cloudReady = store.entitlement.cloudEnabled
    && store.availability.cloudbase.available
    && store.availability.entitlement.available
    && store.availability.beta.available
    && store.availability.cloud.available
  const membership = store.entitlement.status === 'offline_grace'
    ? ' · 离线权益宽限期'
    : store.entitlement.status === 'expired' ? ' · 会员已到期，额外内容只读' : ''
  return `本地知识库可用 · ${cloudReady ? '云同步可用' : '云同步不可用'}${membership}`
})
const canRetainSelection = computed(() => store.entitlement?.tier === 'free'
  && !!store.selectedBaseId && !!store.selectedDocumentId
  && (store.entitlement.retentionConfirmed === false
    || store.entitlement.retainedBaseId !== store.selectedBaseId
    || store.entitlement.retainedDocumentId !== store.selectedDocumentId))
const availabilityTone = computed(() => store.localAvailable ? 'success' : 'warning')
onMounted(() => store.bindOwner(auth.session?.user.id))
watch(() => auth.session?.user.id, ownerId => store.bindOwner(ownerId))
</script>

<style scoped>
.knowledge-view { display: flex; height: 100%; min-height: 0; flex-direction: column; background: var(--af-canvas); }
.knowledge-availability { display: flex; min-height: 39px; flex: none; align-items: center; justify-content: space-between; gap: 12px; border-bottom: 1px solid var(--af-border); padding: 7px 14px; color: var(--af-text-muted); background: var(--af-surface-muted); font-size: 10px; }
.availability-copy { display: inline-flex; align-items: center; gap: 7px; font-weight: 600; }
.knowledge-availability.success .availability-copy .el-icon { color: var(--af-success); }
.knowledge-availability.warning { background: var(--af-warning-soft); }
.knowledge-availability.warning .availability-copy .el-icon { color: var(--af-warning); }
.knowledge-availability button { border: 1px solid color-mix(in srgb, var(--af-cobalt) 30%, var(--af-border)); border-radius: 7px; padding: 5px 9px; color: var(--af-cobalt); background: var(--af-surface); cursor: pointer; font-size: 10px; font-weight: 700; }
.knowledge-availability button:hover:not(:disabled) { border-color: var(--af-cobalt); background: var(--af-cobalt-soft); }
.knowledge-availability button:disabled { cursor: not-allowed; opacity: .5; }
.knowledge-error { display: flex; align-items: center; gap: 8px; border-bottom: 1px solid var(--af-danger-border); padding: 9px 14px; color: var(--af-danger); background: var(--af-danger-soft); font-size: 11px; }
.knowledge-error .el-icon { flex: none; }
.knowledge-workspace { display: grid; min-height: 0; flex: 1; overflow: hidden; grid-template-columns: minmax(250px, 285px) minmax(0, 1fr); }
@media (max-width: 950px) { .knowledge-workspace { grid-template-columns: 235px minmax(0, 1fr); } }
</style>
