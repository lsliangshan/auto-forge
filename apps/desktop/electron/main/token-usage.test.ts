import { describe, expect, it, vi } from 'vitest'
import { createTokenUsageSnapshot } from './token-usage.js'

const zeroRecord = () => ({
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  models: [],
  trend: [],
})

const zeroCostRecord = () => ({
  openRouterCostUsd: '0',
  openRouterKnownCostCount: 0,
  openRouterUnknownCostCount: 0,
  models: [],
})

const zeroCostSnapshot = () => ({
  today: zeroCostRecord(),
  yesterday: zeroCostRecord(),
  week: zeroCostRecord(),
  month: zeroCostRecord(),
  allTime: zeroCostRecord(),
})

const zeroTokenSnapshot = () => ({
  today: zeroRecord(),
  yesterday: zeroRecord(),
  week: zeroRecord(),
  month: zeroRecord(),
  allTime: zeroRecord(),
})

const createSnapshot = (
  now: Date,
  summarizeTokens: Parameters<typeof createTokenUsageSnapshot>[2],
  summarizeCosts: Parameters<typeof createTokenUsageSnapshot>[3] = () => zeroCostSnapshot(),
) => createTokenUsageSnapshot(now, 'user_1', summarizeTokens, summarizeCosts)

describe('createTokenUsageSnapshot', () => {
  it('uses one local time snapshot for today, yesterday, Monday week and month', () => {
    const now = new Date(2026, 7, 19, 12, 30)
    const summarize = vi.fn((query: Parameters<Parameters<typeof createTokenUsageSnapshot>[2]>[0]) => {
      void query
      return {
        today: zeroRecord(),
        yesterday: zeroRecord(),
        week: zeroRecord(),
        month: zeroRecord(),
        allTime: zeroRecord(),
      }
    })

    const summarizeCosts = vi.fn((query: Parameters<Parameters<typeof createTokenUsageSnapshot>[3]>[0]) => {
      void query
      return zeroCostSnapshot()
    })
    const snapshot = createTokenUsageSnapshot(now, 'user_1', summarize, summarizeCosts)

    expect(summarize).toHaveBeenCalledWith({
      userId: 'user_1',
      yesterdayStartedAt: new Date(2026, 7, 18).getTime(),
      todayStartedAt: new Date(2026, 7, 19).getTime(),
      weekStartedAt: new Date(2026, 7, 17).getTime(),
      monthStartedAt: new Date(2026, 7, 1).getTime(),
      endedAt: now.getTime(),
    })
    expect(summarize).toHaveBeenCalledTimes(1)
    expect(summarizeCosts).toHaveBeenCalledWith(summarize.mock.calls[0]![0])
    expect(summarizeCosts).toHaveBeenCalledTimes(1)
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
    expect(snapshot.today).toMatchObject({
      openRouterCostUsd: '0',
      openRouterKnownCostCount: 0,
      openRouterUnknownCostCount: 0,
    })
  })

  it('merges token and cost models by provider plus model and preserves sparse rows', () => {
    const now = new Date(2026, 7, 17, 2)
    const tokenPeriod = {
      inputTokens: 3,
      outputTokens: 3,
      totalTokens: 6,
      models: [
        { provider: 'openrouter' as const, model: 'shared/model', inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        { provider: 'deepseek' as const, model: 'shared/model', inputTokens: 2, outputTokens: 1, totalTokens: 3 },
        { provider: 'openrouter' as const, model: 'token-only', inputTokens: 0, outputTokens: 1, totalTokens: 1 },
      ],
      trend: [{ bucket: '0', inputTokens: 3, outputTokens: 3, totalTokens: 6 }],
    }
    const costPeriod = {
      openRouterCostUsd: '0.3',
      openRouterKnownCostCount: 2,
      openRouterUnknownCostCount: 1,
      models: [
        {
          provider: 'openrouter' as const,
          model: 'shared/model',
          openRouterCostUsd: '0.1',
          openRouterKnownCostCount: 1,
          openRouterUnknownCostCount: 0,
        },
        {
          provider: 'openrouter' as const,
          model: 'cost-only',
          openRouterCostUsd: '0.2',
          openRouterKnownCostCount: 1,
          openRouterUnknownCostCount: 1,
        },
      ],
    }

    const snapshot = createSnapshot(
      now,
      () => ({
        today: tokenPeriod,
        yesterday: zeroRecord(),
        week: zeroRecord(),
        month: zeroRecord(),
        allTime: zeroRecord(),
      }),
      () => ({
        today: costPeriod,
        yesterday: zeroCostRecord(),
        week: zeroCostRecord(),
        month: zeroCostRecord(),
        allTime: zeroCostRecord(),
      }),
    )

    expect(snapshot.today).toMatchObject({
      openRouterCostUsd: '0.3',
      openRouterKnownCostCount: 2,
      openRouterUnknownCostCount: 1,
    })
    expect(snapshot.today.models).toEqual([
      {
        provider: 'openrouter', model: 'shared/model',
        inputTokens: 1, outputTokens: 1, totalTokens: 2,
        openRouterCostUsd: '0.1', openRouterKnownCostCount: 1, openRouterUnknownCostCount: 0,
      },
      {
        provider: 'deepseek', model: 'shared/model',
        inputTokens: 2, outputTokens: 1, totalTokens: 3,
        openRouterCostUsd: '0', openRouterKnownCostCount: 0, openRouterUnknownCostCount: 0,
      },
      {
        provider: 'openrouter', model: 'token-only',
        inputTokens: 0, outputTokens: 1, totalTokens: 1,
        openRouterCostUsd: '0', openRouterKnownCostCount: 0, openRouterUnknownCostCount: 0,
      },
      {
        provider: 'openrouter', model: 'cost-only',
        inputTokens: 0, outputTokens: 0, totalTokens: 0,
        openRouterCostUsd: '0.2', openRouterKnownCostCount: 1, openRouterUnknownCostCount: 1,
      },
    ])
  })

  it('starts all-time at the earliest token or provider cost event', () => {
    const now = new Date(2026, 7, 17, 2)
    const tokenStartedAt = new Date(2026, 6, 10).getTime()
    const costStartedAt = new Date(2026, 5, 20).getTime()

    const snapshot = createSnapshot(
      now,
      () => ({ ...zeroTokenSnapshot(), allTimeStartedAt: tokenStartedAt }),
      () => ({ ...zeroCostSnapshot(), allTimeStartedAt: costStartedAt }),
    )

    expect(snapshot.allTime.startedAt).toBe(new Date(costStartedAt).toISOString())
  })

  it('rejects duplicate provider cost model keys', () => {
    const duplicate = {
      provider: 'openrouter' as const,
      model: 'alpha/model',
      openRouterCostUsd: '0.1',
      openRouterKnownCostCount: 1,
      openRouterUnknownCostCount: 0,
    }

    expect(() => createSnapshot(
      new Date(2026, 7, 17, 2),
      () => ({
        today: zeroRecord(), yesterday: zeroRecord(), week: zeroRecord(), month: zeroRecord(), allTime: zeroRecord(),
      }),
      () => ({
        today: {
          openRouterCostUsd: '0.2', openRouterKnownCostCount: 2, openRouterUnknownCostCount: 0,
          models: [duplicate, duplicate],
        },
        yesterday: zeroCostRecord(), week: zeroCostRecord(), month: zeroCostRecord(), allTime: zeroCostRecord(),
      }),
    )).toThrowError('Duplicate provider cost model: openrouter\u0000alpha/model')
  })

  it('rejects provider cost model totals that do not match the period', () => {
    expect(() => createSnapshot(
      new Date(2026, 7, 17, 2),
      () => ({
        today: zeroRecord(), yesterday: zeroRecord(), week: zeroRecord(), month: zeroRecord(), allTime: zeroRecord(),
      }),
      () => ({
        today: {
          openRouterCostUsd: '0.2', openRouterKnownCostCount: 1, openRouterUnknownCostCount: 0,
          models: [{
            provider: 'openrouter' as const, model: 'alpha/model', openRouterCostUsd: '0.1',
            openRouterKnownCostCount: 1, openRouterUnknownCostCount: 0,
          }],
        },
        yesterday: zeroCostRecord(), week: zeroCostRecord(), month: zeroCostRecord(), allTime: zeroCostRecord(),
      }),
    )).toThrowError('Provider cost model totals do not match the period')
  })

  it('rejects token model totals that do not match the period', () => {
    expect(() => createSnapshot(new Date(2026, 7, 17, 2), () => ({
      today: {
        inputTokens: 2,
        outputTokens: 0,
        totalTokens: 2,
        models: [{
          provider: 'openrouter' as const,
          model: 'alpha/model',
          inputTokens: 1,
          outputTokens: 0,
          totalTokens: 1,
        }],
        trend: [{ bucket: '0', inputTokens: 2, outputTokens: 0, totalTokens: 2 }],
      },
      yesterday: zeroRecord(), week: zeroRecord(), month: zeroRecord(), allTime: zeroRecord(),
    }))).toThrowError('Token usage model totals do not match the period')
  })

  it('fills missing hour buckets and keeps the all-time first point inside its range', () => {
    const now = new Date(2026, 7, 17, 2, 30)
    const todayStartedAt = new Date(2026, 7, 17).getTime()
    const allTimeStartedAt = new Date(2026, 6, 15, 8).getTime()
    const snapshot = createSnapshot(now, () => ({
      allTimeStartedAt,
      today: {
        inputTokens: 2,
        outputTokens: 3,
        totalTokens: 5,
        models: [
          { provider: 'openrouter' as const, model: 'alpha/model', inputTokens: 2, outputTokens: 3, totalTokens: 5 },
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
          { provider: 'openrouter' as const, model: 'alpha/model', inputTokens: 2, outputTokens: 3, totalTokens: 5 },
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
      const snapshot = createSnapshot(new Date(endedAt), () => ({
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

  it('keeps both elapsed buckets for the repeated daylight-saving hour', () => {
    const previous = process.env.TZ
    process.env.TZ = 'America/New_York'
    try {
      const yesterdayStartedAt = new Date(2026, 10, 1).getTime()
      const endedAt = new Date(2026, 10, 2).getTime()
      const snapshot = createSnapshot(new Date(endedAt), () => ({
        today: zeroRecord(),
        yesterday: {
          inputTokens: 9,
          outputTokens: 14,
          totalTokens: 23,
          models: [
            { provider: 'openrouter' as const, model: 'alpha/model', inputTokens: 9, outputTokens: 14, totalTokens: 23 },
          ],
          trend: [
            { bucket: '1', inputTokens: 2, outputTokens: 3, totalTokens: 5 },
            { bucket: '2', inputTokens: 7, outputTokens: 11, totalTokens: 18 },
          ],
        },
        week: zeroRecord(),
        month: zeroRecord(),
        allTime: zeroRecord(),
      }))

      expect(snapshot.yesterday.trend).toHaveLength(25)
      expect(snapshot.yesterday.trend.slice(1, 3)).toEqual([
        {
          startedAt: new Date(yesterdayStartedAt + 3_600_000).toISOString(),
          inputTokens: 2,
          outputTokens: 3,
          totalTokens: 5,
        },
        {
          startedAt: new Date(yesterdayStartedAt + 7_200_000).toISOString(),
          inputTokens: 7,
          outputTokens: 11,
          totalTokens: 18,
        },
      ])
      expect(Date.parse(snapshot.yesterday.trend[2]!.startedAt)
        - Date.parse(snapshot.yesterday.trend[1]!.startedAt)).toBe(3_600_000)
      expect(snapshot.yesterday.trend.reduce((sum, point) => sum + point.inputTokens, 0))
        .toBe(snapshot.yesterday.inputTokens)
      expect(snapshot.yesterday.trend.reduce((sum, point) => sum + point.outputTokens, 0))
        .toBe(snapshot.yesterday.outputTokens)
      expect(snapshot.yesterday.trend.reduce((sum, point) => sum + point.totalTokens, 0))
        .toBe(snapshot.yesterday.totalTokens)
    } finally {
      if (previous === undefined) delete process.env.TZ
      else process.env.TZ = previous
    }
  })

  it('excludes the bucket beginning exactly at the period end', () => {
    const now = new Date(2026, 7, 17, 2)
    const todayStartedAt = new Date(2026, 7, 17).getTime()
    const snapshot = createSnapshot(now, () => ({
      today: zeroRecord(),
      yesterday: zeroRecord(),
      week: zeroRecord(),
      month: zeroRecord(),
      allTime: zeroRecord(),
    }))

    expect(snapshot.today.trend.map(({ startedAt }) => startedAt)).toEqual([
      new Date(todayStartedAt).toISOString(),
      new Date(todayStartedAt + 3_600_000).toISOString(),
    ])
  })

  it('rejects a sparse bucket outside the period', () => {
    const now = new Date(2026, 7, 17, 2)

    expect(() => createSnapshot(now, () => ({
      today: {
        inputTokens: 1,
        outputTokens: 0,
        totalTokens: 1,
        models: [{ provider: 'openrouter' as const, model: 'alpha/model', inputTokens: 1, outputTokens: 0, totalTokens: 1 }],
        trend: [{ bucket: '2', inputTokens: 1, outputTokens: 0, totalTokens: 1 }],
      },
      yesterday: zeroRecord(),
      week: zeroRecord(),
      month: zeroRecord(),
      allTime: zeroRecord(),
    }))).toThrowError('Token usage trend bucket is outside the period: 2')
  })

  it('rejects duplicate sparse buckets', () => {
    const now = new Date(2026, 7, 17, 2)

    expect(() => createSnapshot(now, () => ({
      today: {
        inputTokens: 2,
        outputTokens: 0,
        totalTokens: 2,
        models: [{ provider: 'openrouter' as const, model: 'alpha/model', inputTokens: 2, outputTokens: 0, totalTokens: 2 }],
        trend: [
          { bucket: '0', inputTokens: 1, outputTokens: 0, totalTokens: 1 },
          { bucket: '0', inputTokens: 1, outputTokens: 0, totalTokens: 1 },
        ],
      },
      yesterday: zeroRecord(),
      week: zeroRecord(),
      month: zeroRecord(),
      allTime: zeroRecord(),
    }))).toThrowError('Duplicate token usage trend bucket: 0')
  })

  it('rejects dense trend totals that do not match the period', () => {
    const now = new Date(2026, 7, 17, 2)

    expect(() => createSnapshot(now, () => ({
      today: {
        inputTokens: 2,
        outputTokens: 0,
        totalTokens: 2,
        models: [{ provider: 'openrouter' as const, model: 'alpha/model', inputTokens: 2, outputTokens: 0, totalTokens: 2 }],
        trend: [{ bucket: '0', inputTokens: 1, outputTokens: 0, totalTokens: 1 }],
      },
      yesterday: zeroRecord(),
      week: zeroRecord(),
      month: zeroRecord(),
      allTime: zeroRecord(),
    }))).toThrowError('Token usage trend totals do not match the period')
  })
})
