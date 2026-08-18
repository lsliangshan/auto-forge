import type { TokenUsagePeriod, TokenUsageSnapshot, TokenUsageTrendPoint } from '@autoforge/shared'
import { addUsd } from './billing/decimal-usd.js'
import type {
  ProviderCostPeriodRecord,
  ProviderCostSnapshotRecord,
  ProviderUsageQueryRecord,
  TokenUsageGranularityRecord,
  TokenUsagePeriodRecord,
  TokenUsageQueryRecord,
  TokenUsageSnapshotRecord,
} from './database/repositories.js'

type SummarizeTokens = (input: TokenUsageQueryRecord) => TokenUsageSnapshotRecord
type SummarizeCosts = (input: ProviderUsageQueryRecord) => ProviderCostSnapshotRecord

const hourMs = 3_600_000
const pad = (value: number) => String(value).padStart(2, '0')

function dayStart(value: Date): Date {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate())
}

function localKey(value: Date, granularity: Exclude<TokenUsageGranularityRecord, 'hour'>): string {
  const year = value.getFullYear()
  const month = pad(value.getMonth() + 1)
  return granularity === 'month' ? `${year}-${month}` : `${year}-${month}-${pad(value.getDate())}`
}

function denseTrend(
  record: TokenUsagePeriodRecord,
  startedAt: number,
  endedAt: number,
  granularity: TokenUsageGranularityRecord,
): TokenUsageTrendPoint[] {
  const sparse = new Map<string, TokenUsagePeriodRecord['trend'][number]>()
  for (const point of record.trend) {
    if (sparse.has(point.bucket)) {
      throw new Error(`Duplicate token usage trend bucket: ${point.bucket}`)
    }
    sparse.set(point.bucket, point)
  }

  const output: TokenUsageTrendPoint[] = []
  if (granularity === 'hour') {
    for (let index = 0, cursor = startedAt; cursor < endedAt; index += 1, cursor += hourMs) {
      const bucket = String(index)
      const point = sparse.get(bucket)
      sparse.delete(bucket)
      output.push({
        startedAt: new Date(cursor).toISOString(),
        inputTokens: point?.inputTokens ?? 0,
        outputTokens: point?.outputTokens ?? 0,
        totalTokens: point?.totalTokens ?? 0,
      })
    }
  } else if (startedAt < endedAt) {
    let cursor = granularity === 'month'
      ? new Date(new Date(startedAt).getFullYear(), new Date(startedAt).getMonth(), 1)
      : dayStart(new Date(startedAt))
    while (cursor.getTime() < endedAt) {
      const bucket = localKey(cursor, granularity)
      const point = sparse.get(bucket)
      sparse.delete(bucket)
      output.push({
        startedAt: new Date(Math.max(cursor.getTime(), startedAt)).toISOString(),
        inputTokens: point?.inputTokens ?? 0,
        outputTokens: point?.outputTokens ?? 0,
        totalTokens: point?.totalTokens ?? 0,
      })
      cursor = granularity === 'month'
        ? new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1)
        : new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + 1)
    }
  }

  const unconsumed = sparse.keys().next().value
  if (unconsumed !== undefined) {
    throw new Error(`Token usage trend bucket is outside the period: ${unconsumed}`)
  }

  let inputTokens = 0
  let outputTokens = 0
  let totalTokens = 0
  for (const point of output) {
    inputTokens += point.inputTokens
    outputTokens += point.outputTokens
    totalTokens += point.totalTokens
  }
  if (inputTokens !== record.inputTokens
    || outputTokens !== record.outputTokens
    || totalTokens !== record.totalTokens) {
    throw new Error('Token usage trend totals do not match the period')
  }
  return output
}

function period(
  record: TokenUsagePeriodRecord,
  costs: ProviderCostPeriodRecord,
  startedAt: number,
  endedAt: number,
  granularity: TokenUsageGranularityRecord,
): TokenUsagePeriod {
  const models = new Map<string, TokenUsagePeriod['models'][number]>()
  let modelInputTokens = 0
  let modelOutputTokens = 0
  let modelTotalTokens = 0
  for (const model of record.models) {
    const key = `${model.provider}\u0000${model.model}`
    if (models.has(key)) throw new Error(`Duplicate token usage model: ${key}`)
    models.set(key, {
      ...model,
      openRouterCostUsd: '0',
      openRouterKnownCostCount: 0,
      openRouterUnknownCostCount: 0,
    })
    modelInputTokens += model.inputTokens
    modelOutputTokens += model.outputTokens
    modelTotalTokens += model.totalTokens
  }
  if (!Number.isSafeInteger(modelInputTokens)
    || !Number.isSafeInteger(modelOutputTokens)
    || !Number.isSafeInteger(modelTotalTokens)
    || modelInputTokens !== record.inputTokens
    || modelOutputTokens !== record.outputTokens
    || modelTotalTokens !== record.totalTokens) {
    throw new Error('Token usage model totals do not match the period')
  }

  const costKeys = new Set<string>()
  for (const model of costs.models) {
    const key = `${model.provider}\u0000${model.model}`
    if (costKeys.has(key)) throw new Error(`Duplicate provider cost model: ${key}`)
    costKeys.add(key)
    const tokens = models.get(key)
    models.set(key, {
      provider: model.provider,
      model: model.model,
      inputTokens: tokens?.inputTokens ?? 0,
      outputTokens: tokens?.outputTokens ?? 0,
      totalTokens: tokens?.totalTokens ?? 0,
      openRouterCostUsd: model.openRouterCostUsd,
      openRouterKnownCostCount: model.openRouterKnownCostCount,
      openRouterUnknownCostCount: model.openRouterUnknownCostCount,
    })
  }

  const knownCostCount = costs.models.reduce(
    (total, model) => total + model.openRouterKnownCostCount,
    0,
  )
  const unknownCostCount = costs.models.reduce(
    (total, model) => total + model.openRouterUnknownCostCount,
    0,
  )
  if (!Number.isSafeInteger(knownCostCount)
    || !Number.isSafeInteger(unknownCostCount)
    || addUsd(costs.models.map((model) => model.openRouterCostUsd)) !== costs.openRouterCostUsd
    || knownCostCount !== costs.openRouterKnownCostCount
    || unknownCostCount !== costs.openRouterUnknownCostCount) {
    throw new Error('Provider cost model totals do not match the period')
  }

  return {
    startedAt: new Date(startedAt).toISOString(),
    endedAt: new Date(endedAt).toISOString(),
    inputTokens: record.inputTokens,
    outputTokens: record.outputTokens,
    totalTokens: record.totalTokens,
    openRouterCostUsd: costs.openRouterCostUsd,
    openRouterKnownCostCount: costs.openRouterKnownCostCount,
    openRouterUnknownCostCount: costs.openRouterUnknownCostCount,
    models: [...models.values()],
    trend: denseTrend(record, startedAt, endedAt, granularity),
  }
}

export function createTokenUsageSnapshot(
  now: Date,
  userId: string,
  summarizeTokens: SummarizeTokens,
  summarizeCosts: SummarizeCosts,
): TokenUsageSnapshot {
  const endedAt = now.getTime()
  const today = dayStart(now)
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1)
  const mondayOffset = (today.getDay() + 6) % 7
  const week = new Date(today.getFullYear(), today.getMonth(), today.getDate() - mondayOffset)
  const month = new Date(today.getFullYear(), today.getMonth(), 1)
  const query: TokenUsageQueryRecord & ProviderUsageQueryRecord = {
    userId,
    yesterdayStartedAt: yesterday.getTime(),
    todayStartedAt: today.getTime(),
    weekStartedAt: week.getTime(),
    monthStartedAt: month.getTime(),
    endedAt,
  }
  const usage = summarizeTokens(query)
  const costs = summarizeCosts(query)
  const allTimeStartedAt = Math.min(
    usage.allTimeStartedAt ?? endedAt,
    costs.allTimeStartedAt ?? endedAt,
  )
  return {
    generatedAt: now.toISOString(),
    today: period(usage.today, costs.today, query.todayStartedAt, endedAt, 'hour'),
    yesterday: period(usage.yesterday, costs.yesterday, query.yesterdayStartedAt, query.todayStartedAt, 'hour'),
    week: period(usage.week, costs.week, query.weekStartedAt, endedAt, 'day'),
    month: period(usage.month, costs.month, query.monthStartedAt, endedAt, 'day'),
    allTime: period(usage.allTime, costs.allTime, allTimeStartedAt, endedAt, 'month'),
  }
}
