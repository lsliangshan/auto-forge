<template>
  <img
    v-if="visible"
    class="workflow-logo-image"
    :src="logo"
    alt=""
    aria-hidden="true"
    :data-testid="testId"
    @error="failedLogo = logo"
  >
  <slot v-else />
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'

const props = defineProps<{ logo?: string; testId?: string }>()
const failedLogo = ref<string>()
const visible = computed(() => Boolean(props.logo) && failedLogo.value !== props.logo)
</script>

<style scoped>
.workflow-logo-image { display: block; width: 100%; height: 100%; border-radius: inherit; object-fit: cover; }
</style>
