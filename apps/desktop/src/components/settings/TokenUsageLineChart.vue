<template>
  <div
    ref="element"
    class="token-chart"
    data-testid="token-usage-line-chart"
  />
</template>

<script setup lang="ts">
import type { TokenUsagePeriod, TokenUsagePeriodKey } from '@autoforge/shared'
import { computed } from 'vue'
import { useTokenUsageChart } from './token-usage-chart'
import { lineChartOption } from './token-usage-chart-options'

const props = defineProps<{
  period: TokenUsagePeriod
  periodKey: TokenUsagePeriodKey
}>()
const option = computed(() => lineChartOption(props.period, props.periodKey))
const { element } = useTokenUsageChart(option)
</script>

<style scoped>
.token-chart {
  width: 100%;
  height: 280px;
}
</style>
