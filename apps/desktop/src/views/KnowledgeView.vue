<template>
  <div class="knowledge-view">
    <div
      v-if="availabilityLabel"
      class="knowledge-availability"
      data-testid="knowledge-local-availability"
      role="status"
    >
      {{ availabilityLabel }}
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
      class="af-error"
      role="alert"
    >
      {{ store.error }}
    </div>
    <div
      class="knowledge-workspace"
      data-testid="knowledge-workspace"
    >
      <KnowledgeBaseList />
      <KnowledgeDocumentList />
      <KnowledgeInspector />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, watch } from 'vue'
import KnowledgeBaseList from '../components/knowledge/KnowledgeBaseList.vue'
import KnowledgeDocumentList from '../components/knowledge/KnowledgeDocumentList.vue'
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
onMounted(() => store.bindOwner(auth.session?.user.id))
watch(() => auth.session?.user.id, ownerId => store.bindOwner(ownerId))
</script>

<style scoped>
.knowledge-view { display: flex; height: 100%; min-height: 0; flex-direction: column; }
.knowledge-availability { display: flex; align-items: center; justify-content: space-between; gap: 12px; border-bottom: 1px solid var(--af-border); padding: 7px 12px; color: var(--af-text-muted); background: var(--af-surface-muted); font-size: 11px; }
.knowledge-availability button { border: 1px solid var(--af-border-strong); border-radius: 7px; padding: 4px 8px; color: var(--af-text); background: var(--af-surface); cursor: pointer; }
.knowledge-workspace { display: grid; min-height: 0; flex: 1; grid-template-columns: minmax(190px, .75fr) minmax(260px, 1fr) minmax(280px, 1.15fr); }
@media (max-width: 1050px) { .knowledge-workspace { grid-template-columns: 190px minmax(240px, 1fr) minmax(250px, 1fr); } }
</style>
