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
const dateTimeWithSecondsFormatter = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
})

interface TooltipItem {
  dataIndex: number
  seriesName: string
  value: unknown
  marker?: string
}

function utcOffsetLabel(value: Date) {
  const offsetMinutes = -value.getTimezoneOffset()
  const sign = offsetMinutes >= 0 ? '+' : '-'
  const absoluteMinutes = Math.abs(offsetMinutes)
  const hours = String(Math.floor(absoluteMinutes / 60)).padStart(2, '0')
  const minutes = String(absoluteMinutes % 60).padStart(2, '0')
  return `UTC${sign}${hours}:${minutes}`
}

function rangeLabel(startedAt: string, endedAt: string, repeatedHour = false) {
  const start = new Date(startedAt)
  const end = new Date(endedAt)
  let startLabel = dateTimeFormatter.format(start)
  let endLabel = dateTimeFormatter.format(end)
  if (repeatedHour) {
    startLabel = `${startLabel} ${utcOffsetLabel(start)}`
    endLabel = `${endLabel} ${utcOffsetLabel(end)}`
  } else if (startLabel === endLabel) {
    if (start.getTimezoneOffset() !== end.getTimezoneOffset()) {
      startLabel = `${startLabel} ${utcOffsetLabel(start)}`
      endLabel = `${endLabel} ${utcOffsetLabel(end)}`
    } else {
      startLabel = dateTimeWithSecondsFormatter.format(start)
      endLabel = dateTimeWithSecondsFormatter.format(end)
    }
  }
  return `${startLabel} — ${endLabel}`
}

function richTextLiteral(value: string) {
  return value
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\{/g, '{\u2060')
}

export function lineChartOption(
  period: TokenUsagePeriod,
  periodKey: TokenUsagePeriodKey,
): EChartsCoreOption {
  const zoom = period.trend.length > 12
  const values = period.trend.map(({ startedAt }) => new Date(startedAt))
  const baseLabels = values.map((value) => {
    if (periodKey === 'today' || periodKey === 'yesterday') return hourFormatter.format(value)
    if (periodKey === 'allTime') return monthFormatter.format(value)
    return dayFormatter.format(value)
  })
  const duplicateLabels = new Set(
    baseLabels.filter((label, index) => baseLabels.indexOf(label) !== index),
  )
  const labels = baseLabels.map((label, index) =>
    (periodKey === 'today' || periodKey === 'yesterday') && duplicateLabels.has(label)
      ? `${label} ${utcOffsetLabel(values[index])}`
      : label,
  )
  const rangeLabels = period.trend.map((point, index) => {
    const next = period.trend[index + 1]?.startedAt ?? period.endedAt
    const repeatedHour = (periodKey === 'today' || periodKey === 'yesterday')
      && duplicateLabels.has(baseLabels[index])
    return rangeLabel(point.startedAt, next, repeatedHour)
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
          ...items.map((item) =>
            `${item.marker ?? ''}${item.seriesName}: ${tokenFormatter.format(Number(item.value))}`,
          ),
        ].join('\n')
      },
    },
    legend: { data: ['输入 Token', '输出 Token', '总 Token'], top: 8 },
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
        const inputMarker = items.find((item) => item.seriesName === '输入 Token')?.marker ?? ''
        const outputMarker = items.find((item) => item.seriesName === '输出 Token')?.marker ?? ''
        return [
          richTextLiteral(model.model),
          `${inputMarker}输入 Token: ${tokenFormatter.format(model.inputTokens)}`,
          `${outputMarker}输出 Token: ${tokenFormatter.format(model.outputTokens)}`,
          `总 Token: ${tokenFormatter.format(model.totalTokens)}`,
        ].join('\n')
      },
    },
    legend: { data: ['输入 Token', '输出 Token'], top: 8 },
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
