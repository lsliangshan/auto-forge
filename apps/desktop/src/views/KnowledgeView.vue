<template>
  <div class="knowledge-view">
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
import { onMounted, watch } from 'vue'
import KnowledgeBaseList from '../components/knowledge/KnowledgeBaseList.vue'
import KnowledgeDocumentList from '../components/knowledge/KnowledgeDocumentList.vue'
import KnowledgeInspector from '../components/knowledge/KnowledgeInspector.vue'
import { useAuthStore } from '../stores/auth'
import { useKnowledgeStore } from '../stores/knowledge'

const auth = useAuthStore()
const store = useKnowledgeStore()
onMounted(() => store.bindOwner(auth.session?.user.id))
watch(() => auth.session?.user.id, ownerId => store.bindOwner(ownerId))
</script>

<style scoped>
.knowledge-view { display: flex; height: 100%; min-height: 0; flex-direction: column; }
.knowledge-workspace { display: grid; min-height: 0; flex: 1; grid-template-columns: minmax(190px, .75fr) minmax(260px, 1fr) minmax(280px, 1.15fr); }
@media (max-width: 1050px) { .knowledge-workspace { grid-template-columns: 190px minmax(240px, 1fr) minmax(250px, 1fr); } }
</style>
