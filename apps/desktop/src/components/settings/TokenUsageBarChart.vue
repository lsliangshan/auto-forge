<template>
  <div
    ref="element"
    class="token-chart"
    data-testid="token-usage-bar-chart"
  />
</template>

<script setup lang="ts">
import type { ModelTokenUsage } from '@autoforge/shared'
import { computed } from 'vue'
import { useTokenUsageChart } from './token-usage-chart'
import { barChartOption } from './token-usage-chart-options'

const props = defineProps<{ models: ModelTokenUsage[] }>()
const option = computed(() => barChartOption(props.models))
const { element } = useTokenUsageChart(option)
</script>

<style scoped>
.token-chart {
  width: 100%;
  height: 300px;
}
</style>
