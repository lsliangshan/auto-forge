<template>
  <blockquote
    class="knowledge-source-preview"
    data-testid="knowledge-source-preview"
  >
    {{ preview }}
  </blockquote>
</template>

<script setup lang="ts">
defineProps<{ preview: string }>()
</script>

<style scoped>
.knowledge-source-preview { margin: 8px 0 0; border-left: 2px solid var(--af-cobalt); padding: 7px 10px; color: var(--af-text-muted); background: var(--af-surface-muted); white-space: pre-wrap; }
</style>
