import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
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
    const formatter = (option.tooltip as { formatter: (value: unknown) => string }).formatter
    expect(formatter([{ dataIndex: 0, seriesName: '输入 Token', value: 2 }]))
      .toContain('输入 Token: 2')

    const longTrend = Array.from({ length: 13 }, (_, index) => ({
      startedAt: new Date(2025, index, 1).toISOString(),
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    }))
    expect(lineChartOption({ ...period, trend: longTrend }, 'allTime').dataZoom).toHaveLength(2)
  })

  it('builds stacked model bars and enables zoom after eight models', () => {
    const models = Array.from({ length: 9 }, (_, index) => ({
      model: `model/${index}`,
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
    const formatter = (option.tooltip as { formatter: (value: unknown) => string }).formatter
    expect(formatter([{ dataIndex: 0 }])).toContain('model/0')
  })
})

describe('token usage chart lifecycle', () => {
  it('updates, resizes and disposes a line chart instance', async () => {
    let resizeCallback!: () => void
    const disconnect = vi.fn()
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: () => void) {
        resizeCallback = callback
      }

      observe() {}
      disconnect() {
        disconnect()
      }
    })

    const wrapper = mount(TokenUsageLineChart, { props: { period, periodKey: 'today' } })
    expect(init).toHaveBeenCalledTimes(1)
    expect(chart.setOption).toHaveBeenCalledTimes(1)
    resizeCallback()
    expect(chart.resize).toHaveBeenCalledTimes(1)
    await wrapper.setProps({ periodKey: 'month' })
    expect(chart.setOption).toHaveBeenCalledTimes(2)
    wrapper.unmount()
    expect(disconnect).toHaveBeenCalledTimes(1)
    expect(chart.dispose).toHaveBeenCalledTimes(1)
    vi.unstubAllGlobals()
  })
})
