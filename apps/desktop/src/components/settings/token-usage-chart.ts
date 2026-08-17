import { init, use, type EChartsCoreOption, type EChartsType } from 'echarts/core'
import { BarChart, LineChart } from 'echarts/charts'
import {
  DataZoomComponent,
  GridComponent,
  LegendComponent,
  TooltipComponent,
} from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import { onBeforeUnmount, onMounted, ref, watch, type ComputedRef } from 'vue'

use([
  LineChart,
  BarChart,
  GridComponent,
  LegendComponent,
  TooltipComponent,
  DataZoomComponent,
  CanvasRenderer,
])

export function useTokenUsageChart(option: ComputedRef<EChartsCoreOption>) {
  const element = ref<HTMLDivElement>()
  let chart: EChartsType | undefined
  let observer: ResizeObserver | undefined

  onMounted(() => {
    if (!element.value) return
    chart = init(element.value)
    chart.setOption(option.value, { notMerge: true })
    observer = new ResizeObserver(() => chart?.resize())
    observer.observe(element.value)
  })

  watch(option, (value) => chart?.setOption(value, { notMerge: true }))

  onBeforeUnmount(() => {
    observer?.disconnect()
    chart?.dispose()
    observer = undefined
    chart = undefined
  })

  return { element }
}
