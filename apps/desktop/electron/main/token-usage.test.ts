import { describe, expect, it, vi } from 'vitest'
import { createTokenUsageSnapshot } from './token-usage.js'

const zeroRecord = () => ({
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  models: [],
  trend: [],
})

describe('createTokenUsageSnapshot', () => {
  it('uses one local time snapshot for today, yesterday, Monday week and month', () => {
    const now = new Date(2026, 7, 19, 12, 30)
    const summarize = vi.fn(() => ({
      today: zeroRecord(),
      yesterday: zeroRecord(),
      week: zeroRecord(),
      month: zeroRecord(),
      allTime: zeroRecord(),
    }))

    const snapshot = createTokenUsageSnapshot(now, summarize)

    expect(summarize).toHaveBeenCalledWith({
      yesterdayStartedAt: new Date(2026, 7, 18).getTime(),
      todayStartedAt: new Date(2026, 7, 19).getTime(),
      weekStartedAt: new Date(2026, 7, 17).getTime(),
      monthStartedAt: new Date(2026, 7, 1).getTime(),
      endedAt: now.getTime(),
    })
    expect(snapshot.generatedAt).toBe(now.toISOString())
    expect(snapshot.yesterday.endedAt).toBe(new Date(2026, 7, 19).toISOString())
    expect(snapshot.today.endedAt).toBe(snapshot.generatedAt)
    expect(snapshot.week.endedAt).toBe(snapshot.generatedAt)
    expect(snapshot.month.endedAt).toBe(snapshot.generatedAt)
    expect(snapshot.allTime.endedAt).toBe(snapshot.generatedAt)
    expect(snapshot.allTime.startedAt).toBe(now.toISOString())
    expect(snapshot.today.trend.length).toBeGreaterThan(0)
    expect(snapshot.today.trend.every(({ totalTokens }) => totalTokens === 0)).toBe(true)
    expect(snapshot.allTime.trend).toEqual([])
  })

  it('fills missing hour buckets and keeps the all-time first point inside its range', () => {
    const now = new Date(2026, 7, 17, 2, 30)
    const todayStartedAt = new Date(2026, 7, 17).getTime()
    const allTimeStartedAt = new Date(2026, 6, 15, 8).getTime()
    const snapshot = createTokenUsageSnapshot(now, () => ({
      allTimeStartedAt,
      today: {
        inputTokens: 2,
        outputTokens: 3,
        totalTokens: 5,
        models: [
          { model: 'alpha/model', inputTokens: 2, outputTokens: 3, totalTokens: 5 },
        ],
        trend: [{ bucket: '1', inputTokens: 2, outputTokens: 3, totalTokens: 5 }],
      },
      yesterday: zeroRecord(),
      week: zeroRecord(),
      month: zeroRecord(),
      allTime: {
        inputTokens: 2,
        outputTokens: 3,
        totalTokens: 5,
        models: [
          { model: 'alpha/model', inputTokens: 2, outputTokens: 3, totalTokens: 5 },
        ],
        trend: [{ bucket: '2026-07', inputTokens: 2, outputTokens: 3, totalTokens: 5 }],
      },
    }))

    expect(snapshot.today.trend).toEqual([
      {
        startedAt: new Date(todayStartedAt).toISOString(),
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
      },
      {
        startedAt: new Date(todayStartedAt + 3_600_000).toISOString(),
        inputTokens: 2,
        outputTokens: 3,
        totalTokens: 5,
      },
      {
        startedAt: new Date(todayStartedAt + 7_200_000).toISOString(),
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
      },
    ])
    expect(snapshot.today.trend.reduce((sum, point) => sum + point.inputTokens, 0))
      .toBe(snapshot.today.inputTokens)
    expect(snapshot.today.trend.reduce((sum, point) => sum + point.outputTokens, 0))
      .toBe(snapshot.today.outputTokens)
    expect(snapshot.today.trend.reduce((sum, point) => sum + point.totalTokens, 0))
      .toBe(snapshot.today.totalTokens)
    expect(snapshot.allTime.trend[0]?.startedAt).toBe(new Date(allTimeStartedAt).toISOString())
    expect(Date.parse(snapshot.allTime.trend[0]!.startedAt))
      .toBeGreaterThanOrEqual(Date.parse(snapshot.allTime.startedAt))
    expect(snapshot.allTime.trend.reduce((sum, point) => sum + point.totalTokens, 0))
      .toBe(snapshot.allTime.totalTokens)
  })

  it('uses elapsed hourly buckets across a daylight-saving transition', () => {
    const previous = process.env.TZ
    process.env.TZ = 'America/New_York'
    try {
      const endedAt = new Date(2026, 2, 9).getTime()
      const snapshot = createTokenUsageSnapshot(new Date(endedAt), () => ({
        today: zeroRecord(),
        yesterday: zeroRecord(),
        week: zeroRecord(),
        month: zeroRecord(),
        allTime: zeroRecord(),
      }))

      expect(snapshot.yesterday.trend).toHaveLength(23)
    } finally {
      if (previous === undefined) delete process.env.TZ
      else process.env.TZ = previous
    }
  })
})
