import { toSafeAppError } from '@autoforge/shared'
import {
  estimateRequestTokens,
  resolveChatInputBudget,
} from '../chat/conversation-context.js'
import type { ModelMessage } from '../chat/model-provider.js'
import type { WorkflowCandidate } from './workflow-catalog.js'

const MAX_ROUTED_CANDIDATES = 20

const ROUTING_SYSTEM_PROMPT = [
  'Select the workflows relevant to the current user request.',
  'Return only a JSON array of candidate keys in preferred order.',
  'Return [] when no workflow is relevant. Do not include markdown or explanations.',
].join('\n')

interface CompactWorkflowCandidate {
  key: string
  identity: WorkflowCandidate['workflow']['runtimeIdentity']
  name: string
  description: string
  cities: string[]
  category: string
  activationExamples: string[]
  activationNegativeExamples: string[]
}

export interface WorkflowRoutingRequest {
  messages: ModelMessage[]
  signal: AbortSignal
}

export interface WorkflowRouteInput {
  query: string
  candidates: readonly WorkflowCandidate[]
  contextLength?: number
  select(request: WorkflowRoutingRequest): Promise<string>
  signal: AbortSignal
}

function cancellationFailure(): never {
  throw toSafeAppError({ code: 'CANCELLED' })
}

function routingFailure(): never {
  throw toSafeAppError({ code: 'MODEL_PROVIDER_REQUEST_FAILED' })
}

function compactCandidate(candidate: WorkflowCandidate): CompactWorkflowCandidate {
  const { workflow } = candidate
  return {
    key: candidate.key,
    identity: workflow.runtimeIdentity,
    name: workflow.name,
    description: workflow.description,
    cities: workflow.cities,
    category: workflow.category,
    activationExamples: workflow.activationExamples,
    activationNegativeExamples: workflow.activationNegativeExamples,
  }
}

function routingMessages(query: string, candidates: readonly WorkflowCandidate[]): ModelMessage[] {
  return [
    { role: 'system', content: ROUTING_SYSTEM_PROMPT },
    {
      role: 'user',
      content: JSON.stringify({
        request: query,
        candidates: candidates.map(compactCandidate),
      }),
    },
  ]
}

function parseSelection(
  output: string,
  candidatesByKey: ReadonlyMap<string, WorkflowCandidate>,
): WorkflowCandidate[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(output)
  } catch {
    return routingFailure()
  }
  if (!Array.isArray(parsed) || !parsed.every((value) => typeof value === 'string')) {
    return routingFailure()
  }

  const selected: WorkflowCandidate[] = []
  const seen = new Set<string>()
  for (const key of parsed) {
    const candidate = candidatesByKey.get(key)
    if (!candidate) return routingFailure()
    if (seen.has(key)) continue
    seen.add(key)
    if (selected.length < MAX_ROUTED_CANDIDATES) selected.push(candidate)
  }
  return selected
}

function completeToolsFit(candidates: readonly WorkflowCandidate[], budget: number): boolean {
  return estimateRequestTokens({
    messages: [],
    tools: candidates.map(({ tool }) => tool),
    currentMedia: [],
  }) <= budget
}

export class WorkflowRouter {
  async route(input: WorkflowRouteInput): Promise<WorkflowCandidate[]> {
    if (input.signal.aborted) return cancellationFailure()

    const inputBudget = resolveChatInputBudget(input.contextLength)
    const toolBudget = Math.floor(inputBudget * 0.20)
    if (completeToolsFit(input.candidates, toolBudget)) return [...input.candidates]

    const messages = routingMessages(input.query, input.candidates)
    if (estimateRequestTokens({ messages, tools: [], currentMedia: [] }) > inputBudget) {
      throw toSafeAppError({ code: 'CONTEXT_LIMIT_EXCEEDED' })
    }
    if (input.signal.aborted) return cancellationFailure()

    let output: string
    try {
      output = await input.select({ messages, signal: input.signal })
    } catch (error) {
      if (input.signal.aborted) return cancellationFailure()
      throw error
    }
    if (input.signal.aborted) return cancellationFailure()

    const candidatesByKey = new Map(input.candidates.map((candidate) => [candidate.key, candidate]))
    const selected = parseSelection(output, candidatesByKey)
    if (selected.length === 0) return []

    const prefix: WorkflowCandidate[] = []
    for (const candidate of selected) {
      const next = [...prefix, candidate]
      if (!completeToolsFit(next, toolBudget)) break
      prefix.push(candidate)
    }
    if (prefix.length === 0) throw toSafeAppError({ code: 'CONTEXT_LIMIT_EXCEEDED' })
    return prefix
  }
}
