import { toSafeAppError } from '@autoforge/shared'
import {
  estimateRequestTokens,
  resolveChatInputBudget,
} from '../chat/conversation-context.js'
import type { ModelMessage } from '../chat/model-provider.js'
import { validateWorkflowInput } from '../workflows/input-validation.js'

const MAX_CONFIG_ITEMS = 100
const MAX_KEY_LENGTH = 128
const MAX_DESCRIPTION_LENGTH = 1_000
const MAX_CITIES_PER_ITEM = 100

const SELECTION_SYSTEM_PROMPT = [
  'Match the current user request to exactly one workflow configuration item.',
  'Use each item description as the intent definition.',
  'When an item lists cities, it matches only when the request city is one of them.',
  'Return only JSON. For a match return {"decision":"match","key":"...","resolvedCity":"...","input":{...}}.',
  'Omit resolvedCity for items with no city restriction.',
  'Build input according to the selected item inputSchema.',
  'When no item matches or required input is missing, return {"decision":"no_match"}.',
].join('\n')

interface ConfigItem {
  description: string
  cities: string[]
  inputSchema: unknown
}

export interface WorkflowConfigSelectionRequest {
  messages: ModelMessage[]
  signal: AbortSignal
}

export type WorkflowConfigSelection =
  | { kind: 'no_match' }
  | {
      kind: 'match'
      key: string
      input: unknown
      inputSchema: unknown
      resolvedCity?: string
    }

export interface SelectWorkflowConfigInput {
  query: string
  config: unknown
  contextLength?: number
  select(request: WorkflowConfigSelectionRequest): Promise<string>
  signal: AbortSignal
}

function failure(code: 'CANCELLED' | 'INVALID_INPUT' | 'MODEL_PROVIDER_REQUEST_FAILED' | 'CONTEXT_LIMIT_EXCEEDED'): never {
  throw toSafeAppError({ code })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function containsAsyncSchema(value: unknown, seen = new Set<object>()): boolean {
  if (!value || typeof value !== 'object' || seen.has(value)) return false
  seen.add(value)
  if (isRecord(value) && value.$async === true) return true
  return Object.values(value).some((child) => containsAsyncSchema(child, seen))
}

function parseConfig(value: unknown): Map<string, ConfigItem> {
  if (!isRecord(value)) return failure('INVALID_INPUT')
  const entries = Object.entries(value)
  if (entries.length === 0 || entries.length > MAX_CONFIG_ITEMS) return failure('INVALID_INPUT')

  const parsed = new Map<string, ConfigItem>()
  for (const [key, item] of entries) {
    if (!key || key.length > MAX_KEY_LENGTH || key.trim() !== key || !isRecord(item)) {
      return failure('INVALID_INPUT')
    }
    const description = item.description
    const cities = item.cities
    if (typeof description !== 'string'
      || !description.trim()
      || description.length > MAX_DESCRIPTION_LENGTH
      || !Array.isArray(cities)
      || cities.length > MAX_CITIES_PER_ITEM
      || !cities.every((city) => typeof city === 'string' && city.trim() === city && city.length > 0)
      || new Set(cities).size !== cities.length
      || (item.inputSchema !== undefined && !isRecord(item.inputSchema))) {
      return failure('INVALID_INPUT')
    }
    const inputSchema = item.inputSchema ?? {
      type: 'object', additionalProperties: false, properties: {},
    }
    if (containsAsyncSchema(inputSchema)) return failure('INVALID_INPUT')
    try {
      validateWorkflowInput(inputSchema, undefined)
    } catch {
      return failure('INVALID_INPUT')
    }
    parsed.set(key, {
      description,
      cities: [...cities] as string[],
      inputSchema,
    })
  }
  return parsed
}

function selectionMessages(query: string, items: ReadonlyMap<string, ConfigItem>): ModelMessage[] {
  return [
    { role: 'system', content: SELECTION_SYSTEM_PROMPT },
    {
      role: 'user',
      content: JSON.stringify({
        request: query,
        items: [...items].map(([key, item]) => ({
          key,
          description: item.description,
          cities: item.cities,
          inputSchema: item.inputSchema,
        })),
      }),
    },
  ]
}

function parseSelection(
  output: string,
  items: ReadonlyMap<string, ConfigItem>,
  query: string,
): WorkflowConfigSelection {
  let value: unknown
  try { value = JSON.parse(output) } catch { return failure('MODEL_PROVIDER_REQUEST_FAILED') }
  if (!isRecord(value)) return failure('MODEL_PROVIDER_REQUEST_FAILED')
  if (value.decision === 'no_match' && Object.keys(value).length === 1) return { kind: 'no_match' }
  if (value.decision !== 'match'
    || typeof value.key !== 'string'
    || !Object.prototype.hasOwnProperty.call(value, 'input')) {
    return failure('MODEL_PROVIDER_REQUEST_FAILED')
  }
  const item = items.get(value.key)
  if (!item) return failure('MODEL_PROVIDER_REQUEST_FAILED')
  const allowed = new Set(item.cities.length ? ['decision', 'key', 'resolvedCity', 'input'] : ['decision', 'key', 'input'])
  if (!Object.keys(value).every((key) => allowed.has(key))) return failure('MODEL_PROVIDER_REQUEST_FAILED')
  if (item.cities.length > 0
    && (typeof value.resolvedCity !== 'string' || !item.cities.includes(value.resolvedCity))) {
    return failure('MODEL_PROVIDER_REQUEST_FAILED')
  }
  if (item.cities.length > 0
    && !query.normalize('NFKC').includes((value.resolvedCity as string).normalize('NFKC'))) {
    return failure('MODEL_PROVIDER_REQUEST_FAILED')
  }
  const validation = validateWorkflowInput(item.inputSchema, value.input)
  if (!validation.valid) return failure('MODEL_PROVIDER_REQUEST_FAILED')
  return {
    kind: 'match',
    key: value.key,
    input: structuredClone(value.input),
    inputSchema: structuredClone(item.inputSchema),
    ...(item.cities.length > 0 ? { resolvedCity: value.resolvedCity as string } : {}),
  }
}

export async function selectWorkflowConfig(input: SelectWorkflowConfigInput): Promise<WorkflowConfigSelection> {
  if (input.signal.aborted) return failure('CANCELLED')
  const items = parseConfig(input.config)
  const messages = selectionMessages(input.query, items)
  if (estimateRequestTokens({ messages, tools: [], currentMedia: [] }) > resolveChatInputBudget(input.contextLength)) {
    return failure('CONTEXT_LIMIT_EXCEEDED')
  }
  let output: string
  try { output = await input.select({ messages, signal: input.signal }) } catch (error) {
    if (input.signal.aborted) return failure('CANCELLED')
    throw error
  }
  if (input.signal.aborted) return failure('CANCELLED')
  return parseSelection(output, items, input.query)
}
