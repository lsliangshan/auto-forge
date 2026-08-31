import type { WorkflowContext } from './context.js'

export interface ConfiguredWorkflowInput<TKey extends string = string, TInput = unknown> {
  key: TKey
  input: TInput
}

export interface WorkflowConfigItem {
  description: string
  cities: readonly string[]
  inputSchema?: Readonly<Record<string, unknown>>
  readonly [key: string]: unknown
}

export type WorkflowConfig = Readonly<Record<string, WorkflowConfigItem>>

export interface WorkflowDefinition<TInput, TOutput, TConfig extends WorkflowConfig = never> {
  run(context: WorkflowContext, input: TInput): Promise<TOutput>
  getConfig?(): TConfig
}

export function defineWorkflow<TInput, TOutput, TConfig extends WorkflowConfig = never>(
  definition: WorkflowDefinition<TInput, TOutput, TConfig>,
): WorkflowDefinition<TInput, TOutput, TConfig> {
  return Object.freeze(definition)
}
