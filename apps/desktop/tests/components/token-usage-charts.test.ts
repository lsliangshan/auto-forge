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
  models: [{ model: 'alpha/model', inputTokens: 7, outputTokens: 3, totalTokens: 10 }],
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
    const tooltip = option.tooltip as { renderMode: string; formatter: (value: unknown) => string }
    expect(tooltip.renderMode).toBe('richText')
    expect(tooltip.formatter([
      { dataIndex: 0, seriesName: '输入 Token', value: '2' },
      { dataIndex: 0, seriesName: '输出 Token', value: 1 },
      { dataIndex: 0, seriesName: '总 Token', value: 3 },
    ])).toBe([
      rangeLabel(period.trend[0].startedAt, period.trend[1].startedAt),
      '输入 Token: 2',
      '输出 Token: 1',
      '总 Token: 3',
    ].join('\n'))
    expect(tooltip.formatter([
      { dataIndex: 1, seriesName: '输入 Token', value: 5 },
      { dataIndex: 1, seriesName: '输出 Token', value: 2 },
      { dataIndex: 1, seriesName: '总 Token', value: 7 },
    ])).toBe([
      rangeLabel(period.trend[1].startedAt, period.endedAt),
      '输入 Token: 5',
      '输出 Token: 2',
      '总 Token: 7',
    ].join('\n'))

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
      model: index === 0 ? 'provider/very-long-model-identifier' : `model/${index}`,
      inputTokens: index + 1,
      outputTokens: index,
      totalTokens: index * 2 + 1,
    }))
    const option = barChartOption(models)
    expect(option.series).toMatchObject([
      { name: '输入 Token', type: 'bar', stack: 'tokens' },
      { name: '输出 Token', type: 'bar', stack: 'tokens' },
    ])
    expect(option.dataZoom).toHaveLength(2)
    expect(barChartOption(models.slice(0, 8)).dataZoom).toHaveLength(0)
    const tooltip = option.tooltip as { renderMode: string; formatter: (value: unknown) => string }
    expect(tooltip.renderMode).toBe('richText')
    expect(tooltip.formatter([{ dataIndex: 0 }])).toBe([
      'provider/very-long-model-identifier',
      '输入 Token: 1',
      '输出 Token: 0',
      '总 Token: 1',
    ].join('\n'))
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
