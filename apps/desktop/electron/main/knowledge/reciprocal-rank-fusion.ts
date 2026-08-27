export interface RankedIdentifier {
  id: string
}

export interface FusedRank extends RankedIdentifier {
  score: number
  bestRank: number
}

function compareIdentifier(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

export function reciprocalRankFusion(
  rankings: readonly (readonly RankedIdentifier[])[],
  options: { rankConstant?: number; limit: number },
): FusedRank[] {
  const rankConstant = options.rankConstant ?? 60
  const scores = new Map<string, FusedRank>()
  for (const ranking of rankings) {
    const seen = new Set<string>()
    let rank = 0
    for (const candidate of ranking) {
      if (!candidate.id || seen.has(candidate.id)) continue
      seen.add(candidate.id)
      rank += 1
      const existing = scores.get(candidate.id)
      if (existing) {
        existing.score += 1 / (rankConstant + rank)
        existing.bestRank = Math.min(existing.bestRank, rank)
      } else {
        scores.set(candidate.id, {
          id: candidate.id,
          score: 1 / (rankConstant + rank),
          bestRank: rank,
        })
      }
    }
  }
  return [...scores.values()]
    .sort((left, right) => right.score - left.score
      || left.bestRank - right.bestRank
      || compareIdentifier(left.id, right.id))
    .slice(0, Math.max(0, options.limit))
}

export function cosineSimilarity(
  left: readonly number[],
  right: readonly number[],
  dimensions: number,
): number | undefined {
  if (left.length !== dimensions || right.length !== dimensions) return undefined
  let dot = 0
  let leftMagnitude = 0
  let rightMagnitude = 0
  for (let index = 0; index < dimensions; index += 1) {
    const leftValue = left[index]
    const rightValue = right[index]
    if (!Number.isFinite(leftValue) || !Number.isFinite(rightValue)) return undefined
    dot += leftValue * rightValue
    leftMagnitude += leftValue * leftValue
    rightMagnitude += rightValue * rightValue
  }
  if (leftMagnitude === 0 || rightMagnitude === 0) return undefined
  return dot / (Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude))
}

export function rankByCosine<T extends { id: string; vector: readonly number[] }>(
  query: readonly number[],
  candidates: readonly T[],
  dimensions: number,
): Array<T & { score: number }> {
  if (query.length !== dimensions || query.some(value => !Number.isFinite(value))) return []
  return candidates.flatMap(candidate => {
    const score = cosineSimilarity(query, candidate.vector, dimensions)
    return score === undefined ? [] : [{ ...candidate, score }]
  }).sort((left, right) => right.score - left.score || compareIdentifier(left.id, right.id))
}
