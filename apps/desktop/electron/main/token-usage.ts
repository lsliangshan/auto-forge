import type { TokenUsagePeriod, TokenUsageSnapshot, TokenUsageTrendPoint } from '@autoforge/shared'
import type {
  TokenUsageGranularityRecord,
  TokenUsagePeriodRecord,
  TokenUsageQueryRecord,
  TokenUsageSnapshotRecord,
} from './database/repositories.js'

type Summarize = (input: TokenUsageQueryRecord) => TokenUsageSnapshotRecord

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
  if (startedAt >= endedAt) return []

  const sparse = new Map(record.trend.map((point) => [point.bucket, point]))
  const output: TokenUsageTrendPoint[] = []
  if (granularity === 'hour') {
    for (let index = 0, cursor = startedAt; cursor < endedAt; index += 1, cursor += hourMs) {
      const point = sparse.get(String(index))
      output.push({
        startedAt: new Date(cursor).toISOString(),
        inputTokens: point?.inputTokens ?? 0,
        outputTokens: point?.outputTokens ?? 0,
        totalTokens: point?.totalTokens ?? 0,
      })
    }
    return output
  }

  let cursor = granularity === 'month'
    ? new Date(new Date(startedAt).getFullYear(), new Date(startedAt).getMonth(), 1)
    : dayStart(new Date(startedAt))
  while (cursor.getTime() < endedAt) {
    const point = sparse.get(localKey(cursor, granularity))
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
  return output
}

function period(
  record: TokenUsagePeriodRecord,
  startedAt: number,
  endedAt: number,
  granularity: TokenUsageGranularityRecord,
): TokenUsagePeriod {
  return {
    startedAt: new Date(startedAt).toISOString(),
    endedAt: new Date(endedAt).toISOString(),
    inputTokens: record.inputTokens,
    outputTokens: record.outputTokens,
    totalTokens: record.totalTokens,
    models: record.models,
    trend: denseTrend(record, startedAt, endedAt, granularity),
  }
}

export function createTokenUsageSnapshot(now: Date, summarize: Summarize): TokenUsageSnapshot {
  const endedAt = now.getTime()
  const today = dayStart(now)
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1)
  const mondayOffset = (today.getDay() + 6) % 7
  const week = new Date(today.getFullYear(), today.getMonth(), today.getDate() - mondayOffset)
  const month = new Date(today.getFullYear(), today.getMonth(), 1)
  const query: TokenUsageQueryRecord = {
    yesterdayStartedAt: yesterday.getTime(),
    todayStartedAt: today.getTime(),
    weekStartedAt: week.getTime(),
    monthStartedAt: month.getTime(),
    endedAt,
  }
  const usage = summarize(query)
  const allTimeStartedAt = usage.allTimeStartedAt ?? endedAt
  return {
    generatedAt: now.toISOString(),
    today: period(usage.today, query.todayStartedAt, endedAt, 'hour'),
    yesterday: period(usage.yesterday, query.yesterdayStartedAt, query.todayStartedAt, 'hour'),
    week: period(usage.week, query.weekStartedAt, endedAt, 'day'),
    month: period(usage.month, query.monthStartedAt, endedAt, 'day'),
    allTime: period(usage.allTime, allTimeStartedAt, endedAt, 'month'),
  }
}
