import type { WorkflowDetail } from '@autoforge/shared'

function normalizeTokens(value: string): Set<string> {
  return new Set(value.toLocaleLowerCase().match(/[\p{Script=Han}]+|[\p{Letter}\p{Number}]+/gu) ?? [])
}

function hasMatchingTokens(queryTokens: Set<string>, value: string): boolean {
  return [...normalizeTokens(value)].some((token) => queryTokens.has(token))
}

function hasMatchingPhrase(query: string, phrase: string): boolean {
  return query === phrase.toLocaleLowerCase().trim()
}

function scoreWorkflow(query: string, queryTokens: Set<string>, workflow: WorkflowDetail): number {
  let score = workflow.name.toLocaleLowerCase().trim() === query ? 100 : 0

  if (workflow.activationExamples.some((example) => hasMatchingPhrase(query, example))) score += 60
  if (hasMatchingTokens(queryTokens, workflow.description)) score += 20
  if (hasMatchingTokens(queryTokens, workflow.category)) score += 10

  for (const example of workflow.activationNegativeExamples) {
    if (hasMatchingPhrase(query, example)) score -= 120
  }

  return score
}

export function retrieveWorkflows(
  query: string,
  candidates: readonly WorkflowDetail[],
  limit: number,
): WorkflowDetail[] {
  const normalizedQuery = query.toLocaleLowerCase().trim()
  const queryTokens = normalizeTokens(normalizedQuery)

  return candidates
    .filter((workflow) => workflow.enabled && workflow.integrity === 'valid')
    .map((workflow) => ({ workflow, score: scoreWorkflow(normalizedQuery, queryTokens, workflow) }))
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score || left.workflow.id.localeCompare(right.workflow.id))
    .slice(0, limit)
    .map(({ workflow }) => workflow)
}
