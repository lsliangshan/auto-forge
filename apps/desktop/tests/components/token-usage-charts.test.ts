import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import TokenUsageBarChart from '../../src/components/settings/TokenUsageBarChart.vue'
import TokenUsageLineChart from '../../src/components/settings/TokenUsageLineChart.vue'
import { barChartOption, lineChartOption } from '../../src/components/settings/token-usage-chart-options'

const chart = vi.hoisted(() => ({
  setOption: vi.fn(),
  resize: vi.fn(),
  dispose: vi.fn(),
}))
const init = vi.hoisted(() => vi.fn(() => chart))

vi.mock('echarts/core', () => ({ use: vi.fn(), init }))
vi.mock('echarts/charts', () => ({ LineChart: {}, BarChart: {} }))
vi.mock('echarts/components', () => ({
  GridComponent: {},
  LegendComponent: {},
  TooltipComponent: {},
  DataZoomComponent: {},
}))
vi.mock('echarts/renderers', () => ({ CanvasRenderer: {} }))

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

function rangeLabel(startedAt: string, endedAt: string) {
  return `${dateTimeFormatter.format(new Date(startedAt))} — ${dateTimeFormatter.format(new Date(endedAt))}`
}

function stubResizeObserver() {
  let resizeCallback!: () => void
  const observe = vi.fn()
  const disconnect = vi.fn()
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) {
      resizeCallback = callback
    }

    observe(element: Element) {
      observe(element)
    }

    disconnect() {
      disconnect()
    }
  })
  return { observe, disconnect, resize: () => resizeCallback() }
}

const period = {
  startedAt: '2026-08-16T16:00:00.000Z',
  endedAt: '2026-08-17T04:00:00.000Z',
  inputTokens: 7,
  outputTokens: 3,
  totalTokens: 10,
  openRouterCostUsd: '0.0000001',
  openRouterKnownCostCount: 1,
  openRouterUnknownCostCount: 0,
  models: [{
    provider: 'openrouter' as const,
    model: 'alpha/model',
    inputTokens: 7,
    outputTokens: 3,
    totalTokens: 10,
    openRouterCostUsd: '0.0000001',
    openRouterKnownCostCount: 1,
    openRouterUnknownCostCount: 0,
  }],
  trend: [
    { startedAt: '2026-08-16T16:00:00.000Z', inputTokens: 2, outputTokens: 1, totalTokens: 3 },
    { startedAt: '2026-08-16T17:00:00.000Z', inputTokens: 5, outputTokens: 2, totalTokens: 7 },
  ],
}

describe('token usage chart options', () => {
  it('builds three token trend series', () => {
    const option = lineChartOption(period, 'today')
    expect(option.series).toMatchObject([
      { name: '输入 Token', type: 'line', data: [2, 5] },
      { name: '输出 Token', type: 'line', data: [1, 2] },
      { name: '总 Token', type: 'line', data: [3, 7] },
    ])
    expect((option.series as Array<{ name?: string }>).map(({ name }) => name))
      .toEqual(['输入 Token', '输出 Token', '总 Token'])
    expect(JSON.stringify(option.series)).not.toContain('0.0000001')
    expect(option.legend).toMatchObject({ top: 8 })
    expect((option.xAxis as { data: string[] }).data.every((label) => !label.includes('UTC')))
      .toBe(true)
    const tooltip = option.tooltip as {
      renderMode: string
      formatter: (value: unknown) => string
    }
    expect(tooltip.renderMode).toBe('richText')
    expect(tooltip).not.toHaveProperty('textStyle')
    const inputMarker = '{lineInputMarker|●} '
    const outputMarker = '{lineOutputMarker|●} '
    const totalMarker = '{lineTotalMarker|●} '
    expect(tooltip.formatter([
      { dataIndex: 0, seriesName: '输入 Token', value: '2', marker: inputMarker },
      { dataIndex: 0, seriesName: '输出 Token', value: 1, marker: outputMarker },
      { dataIndex: 0, seriesName: '总 Token', value: 3, marker: totalMarker },
    ])).toBe([
      rangeLabel(period.trend[0].startedAt, period.trend[1].startedAt),
      `${inputMarker}输入 Token: 2`,
      `${outputMarker}输出 Token: 1`,
      `${totalMarker}总 Token: 3`,
    ].join('\n'))
    expect(tooltip.formatter([
      { dataIndex: 1, seriesName: '输入 Token', value: 5, marker: inputMarker },
      { dataIndex: 1, seriesName: '输出 Token', value: 2, marker: outputMarker },
      { dataIndex: 1, seriesName: '总 Token', value: 7, marker: totalMarker },
    ])).toBe([
      rangeLabel(period.trend[1].startedAt, period.endedAt),
      `${inputMarker}输入 Token: 5`,
      `${outputMarker}输出 Token: 2`,
      `${totalMarker}总 Token: 7`,
    ].join('\n'))
    expect(tooltip.formatter([
      { dataIndex: 0, seriesName: '输入 Token', value: '2000', marker: inputMarker },
    ])).toContain(`${inputMarker}输入 Token: 2,000`)

    const shortStartedAt = '2026-08-17T04:00:00.000Z'
    const shortEndedAt = '2026-08-17T04:00:30.000Z'
    const shortOption = lineChartOption({
      ...period,
      startedAt: shortStartedAt,
      endedAt: shortEndedAt,
      trend: [{ startedAt: shortStartedAt, inputTokens: 7, outputTokens: 3, totalTokens: 10 }],
    }, 'today')
    const shortFormatter = (
      shortOption.tooltip as { formatter: (value: unknown) => string }
    ).formatter
    const shortRange = shortFormatter([
      { dataIndex: 0, seriesName: '输入 Token', value: 7 },
    ]).split('\n')[0]
    const [shortStartLabel, shortEndLabel] = shortRange.split(' — ')
    expect(shortRange).toBe([
      dateTimeWithSecondsFormatter.format(new Date(shortStartedAt)),
      dateTimeWithSecondsFormatter.format(new Date(shortEndedAt)),
    ].join(' — '))
    expect(shortRange).not.toContain('UTC')
    expect(shortStartLabel).not.toBe(shortEndLabel)

    const longTrend = Array.from({ length: 13 }, (_, index) => ({
      startedAt: new Date(2025, index, 1).toISOString(),
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    }))
    expect(lineChartOption({ ...period, trend: longTrend }, 'allTime').dataZoom).toHaveLength(2)
    expect(lineChartOption({ ...period, trend: longTrend.slice(0, 12) }, 'allTime').dataZoom)
      .toHaveLength(0)
  })

  it('builds stacked model bars and enables zoom after eight models', () => {
    const models = Array.from({ length: 9 }, (_, index) => ({
      provider: 'openrouter' as const,
      model: index === 0 ? 'provider/very-long-model-identifier' : `model/${index}`,
      inputTokens: index + 1,
      outputTokens: index,
      totalTokens: index * 2 + 1,
      openRouterCostUsd: '0',
      openRouterKnownCostCount: 0,
      openRouterUnknownCostCount: 0,
    }))
    const option = barChartOption(models)
    expect(option.series).toMatchObject([
      { name: '输入 Token', type: 'bar', stack: 'tokens' },
      { name: '输出 Token', type: 'bar', stack: 'tokens' },
    ])
    expect((option.series as Array<{ name?: string }>).map(({ name }) => name))
      .toEqual(['输入 Token', '输出 Token'])
    expect(option.legend).toMatchObject({ top: 8 })
    expect(option.dataZoom).toHaveLength(2)
    expect(barChartOption(models.slice(0, 8)).dataZoom).toHaveLength(0)
    const tooltip = option.tooltip as {
      renderMode: string
      formatter: (value: unknown) => string
    }
    expect(tooltip.renderMode).toBe('richText')
    expect(tooltip).not.toHaveProperty('textStyle')
    const inputMarker = '{barInputMarker|●} '
    const outputMarker = '{barOutputMarker|●} '
    expect(tooltip.formatter([
      { dataIndex: 0, seriesName: '输入 Token', value: 1, marker: inputMarker },
      { dataIndex: 0, seriesName: '输出 Token', value: 0, marker: outputMarker },
    ])).toBe([
      'provider/very-long-model-identifier',
      `${inputMarker}输入 Token: 1`,
      `${outputMarker}输出 Token: 0`,
      '总 Token: 1',
    ].join('\n'))

    const unsafeModel = '{input|literal-model}\r\nnext}'
    const unsafeOption = barChartOption([
      {
        provider: 'openrouter',
        model: unsafeModel,
        inputTokens: 1,
        outputTokens: 2,
        totalTokens: 3,
        openRouterCostUsd: '0',
        openRouterKnownCostCount: 0,
        openRouterUnknownCostCount: 0,
      },
    ])
    const unsafeFormatter = (
      unsafeOption.tooltip as { formatter: (value: unknown) => string }
    ).formatter
    const unsafeTooltip = unsafeFormatter([
      { dataIndex: 0, seriesName: '输入 Token', value: 1, marker: inputMarker },
      { dataIndex: 0, seriesName: '输出 Token', value: 2, marker: outputMarker },
    ])
    const withoutMarkers = unsafeTooltip
      .replace(inputMarker, '')
      .replace(outputMarker, '')
    expect(withoutMarkers).not.toMatch(/\{[A-Za-z0-9_]+\|/)
    expect(unsafeTooltip.split('\n')).toHaveLength(4)
    expect(unsafeTooltip.split('\n')[0].replaceAll('\u2060', ''))
      .toBe('{input|literal-model}\\r\\nnext}')
  })

  it('disambiguates repeated local hours during daylight-saving fallback', async () => {
    const previousTimezone = process.env.TZ
    try {
      process.env.TZ = 'America/New_York'
      vi.resetModules()
      const { lineChartOption: newYorkLineChartOption } = await import(
        '../../src/components/settings/token-usage-chart-options'
      )
      const fallbackPeriod = {
        startedAt: '2026-11-01T05:00:00.000Z',
        endedAt: '2026-11-01T07:00:00.000Z',
        inputTokens: 3,
        outputTokens: 3,
        totalTokens: 6,
        openRouterCostUsd: '0',
        openRouterKnownCostCount: 0,
        openRouterUnknownCostCount: 0,
        models: [{
          provider: 'openrouter' as const,
          model: 'model/dst',
          inputTokens: 3,
          outputTokens: 3,
          totalTokens: 6,
          openRouterCostUsd: '0',
          openRouterKnownCostCount: 0,
          openRouterUnknownCostCount: 0,
        }],
        trend: [
          { startedAt: '2026-11-01T05:00:00.000Z', inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          { startedAt: '2026-11-01T06:00:00.000Z', inputTokens: 2, outputTokens: 2, totalTokens: 4 },
        ],
      }

      const option = newYorkLineChartOption(fallbackPeriod, 'today')
      const labels = (option.xAxis as { data: string[] }).data
      expect(labels[0]).not.toBe(labels[1])
      expect(labels).toEqual(['01:00 UTC-04:00', '01:00 UTC-05:00'])
      const formatter = (option.tooltip as { formatter: (value: unknown) => string }).formatter
      const firstRange = formatter([{ dataIndex: 0, seriesName: '输入 Token', value: 1 }])
        .split('\n')[0]
      expect(firstRange).toContain('UTC-04:00')
      expect(firstRange).toContain('UTC-05:00')
      const secondRange = formatter([{ dataIndex: 1, seriesName: '输入 Token', value: 2 }])
        .split('\n')[0]
      expect(secondRange.match(/UTC-05:00/g)).toHaveLength(2)
    } finally {
      if (previousTimezone === undefined) delete process.env.TZ
      else process.env.TZ = previousTimezone
      vi.resetModules()
    }
  })
})

describe('token usage chart lifecycle', () => {
  beforeEach(() => vi.clearAllMocks())
  afterEach(() => vi.unstubAllGlobals())

  it('updates, resizes and disposes a line chart instance', async () => {
    const observer = stubResizeObserver()

    const wrapper = mount(TokenUsageLineChart, { props: { period, periodKey: 'today' } })
    expect(init).toHaveBeenCalledTimes(1)
    expect(observer.observe).toHaveBeenCalledWith(
      wrapper.get('[data-testid="token-usage-line-chart"]').element,
    )
    expect(chart.setOption).toHaveBeenCalledTimes(1)
    expect(chart.setOption).toHaveBeenNthCalledWith(1, expect.any(Object), { notMerge: true })
    observer.resize()
    expect(chart.resize).toHaveBeenCalledTimes(1)
    await wrapper.setProps({ periodKey: 'month' })
    expect(chart.setOption).toHaveBeenCalledTimes(2)
    expect(chart.setOption).toHaveBeenNthCalledWith(2, expect.any(Object), { notMerge: true })
    wrapper.unmount()
    expect(observer.disconnect).toHaveBeenCalledTimes(1)
    expect(chart.dispose).toHaveBeenCalledTimes(1)
  })

  it('initializes and disposes a bar chart instance', () => {
    const observer = stubResizeObserver()

    const wrapper = mount(TokenUsageBarChart, { props: { models: period.models } })
    expect(init).toHaveBeenCalledTimes(1)
    expect(observer.observe).toHaveBeenCalledWith(
      wrapper.get('[data-testid="token-usage-bar-chart"]').element,
    )
    expect(chart.setOption).toHaveBeenCalledTimes(1)
    expect(chart.setOption).toHaveBeenCalledWith(expect.any(Object), { notMerge: true })
    wrapper.unmount()
    expect(observer.disconnect).toHaveBeenCalledTimes(1)
    expect(chart.dispose).toHaveBeenCalledTimes(1)
  })
})
