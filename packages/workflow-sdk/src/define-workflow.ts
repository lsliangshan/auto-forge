import type { WorkflowContext } from './context.js'

export interface WorkflowDefinition<TInput, TOutput> {
  run(context: WorkflowContext, input: TInput): Promise<TOutput>
}

export function defineWorkflow<TInput, TOutput>(
  definition: WorkflowDefinition<TInput, TOutput>,
): WorkflowDefinition<TInput, TOutput> {
  return Object.freeze(definition)
}
