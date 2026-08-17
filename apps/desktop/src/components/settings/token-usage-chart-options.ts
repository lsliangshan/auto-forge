import type { ModelTokenUsage, TokenUsagePeriod, TokenUsagePeriodKey } from '@autoforge/shared'
import type { EChartsCoreOption } from 'echarts/core'

export const tokenColors = {
  input: '#3478f6',
  output: '#f79045',
  total: '#344054',
} as const

const tokenFormatter = new Intl.NumberFormat('zh-CN')
const hourFormatter = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' })
const dayFormatter = new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric' })
const monthFormatter = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'short' })
const dateTimeFormatter = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
})

interface TooltipItem {
  dataIndex: number
  seriesName: string
  value: unknown
}

export function lineChartOption(
  period: TokenUsagePeriod,
  periodKey: TokenUsagePeriodKey,
): EChartsCoreOption {
  const zoom = period.trend.length > 12
  const labels = period.trend.map(({ startedAt }) => {
    const value = new Date(startedAt)
    if (periodKey === 'today' || periodKey === 'yesterday') return hourFormatter.format(value)
    if (periodKey === 'allTime') return monthFormatter.format(value)
    return dayFormatter.format(value)
  })
  const rangeLabels = period.trend.map((point, index) => {
    const next = period.trend[index + 1]?.startedAt ?? period.endedAt
    return `${dateTimeFormatter.format(new Date(point.startedAt))} — ${dateTimeFormatter.format(new Date(next))}`
  })

  return {
    color: [tokenColors.input, tokenColors.output, tokenColors.total],
    animationDuration: 220,
    tooltip: {
      trigger: 'axis',
      renderMode: 'richText',
      formatter: (parameters: unknown) => {
        const items = (Array.isArray(parameters) ? parameters : [parameters]) as TooltipItem[]
        const index = items[0]?.dataIndex ?? 0
        return [
          rangeLabels[index] ?? '',
          ...items.map((item) => `${item.seriesName}: ${tokenFormatter.format(Number(item.value))}`),
        ].join('\n')
      },
    },
    legend: { data: ['输入 Token', '输出 Token', '总 Token'] },
    grid: { left: 16, right: 18, top: 48, bottom: zoom ? 76 : 32, containLabel: true },
    xAxis: { type: 'category', boundaryGap: false, data: labels },
    yAxis: { type: 'value', minInterval: 1 },
    dataZoom: zoom
      ? [
          { type: 'slider', startValue: 0, endValue: 11 },
          { type: 'inside', startValue: 0, endValue: 11 },
        ]
      : [],
    series: [
      {
        name: '输入 Token',
        type: 'line',
        showSymbol: false,
        data: period.trend.map((point) => point.inputTokens),
      },
      {
        name: '输出 Token',
        type: 'line',
        showSymbol: false,
        data: period.trend.map((point) => point.outputTokens),
      },
      {
        name: '总 Token',
        type: 'line',
        showSymbol: false,
        data: period.trend.map((point) => point.totalTokens),
      },
    ],
  }
}

export function barChartOption(models: ModelTokenUsage[]): EChartsCoreOption {
  const zoom = models.length > 8

  return {
    color: [tokenColors.input, tokenColors.output],
    animationDuration: 220,
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      renderMode: 'richText',
      formatter: (parameters: unknown) => {
        const items = (Array.isArray(parameters) ? parameters : [parameters]) as TooltipItem[]
        const model = models[items[0]?.dataIndex ?? 0]
        if (!model) return ''
        return [
          model.model,
          `输入 Token: ${tokenFormatter.format(model.inputTokens)}`,
          `输出 Token: ${tokenFormatter.format(model.outputTokens)}`,
          `总 Token: ${tokenFormatter.format(model.totalTokens)}`,
        ].join('\n')
      },
    },
    legend: { data: ['输入 Token', '输出 Token'] },
    grid: { left: 16, right: 18, top: 48, bottom: zoom ? 76 : 48, containLabel: true },
    xAxis: {
      type: 'category',
      data: models.map(({ model }) => model),
      axisLabel: {
        interval: 0,
        formatter: (value: string) => value.length > 18 ? `${value.slice(0, 17)}…` : value,
      },
    },
    yAxis: { type: 'value', minInterval: 1 },
    dataZoom: zoom
      ? [
          { type: 'slider', startValue: 0, endValue: 7 },
          { type: 'inside', startValue: 0, endValue: 7 },
        ]
      : [],
    series: [
      {
        name: '输入 Token',
        type: 'bar',
        stack: 'tokens',
        data: models.map((model) => model.inputTokens),
      },
      {
        name: '输出 Token',
        type: 'bar',
        stack: 'tokens',
        data: models.map((model) => model.outputTokens),
      },
    ],
  }
}
