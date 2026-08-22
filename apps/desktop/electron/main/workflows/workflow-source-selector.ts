import type { WorkflowDetail } from '@autoforge/shared'

export type ExactWorkflowSource =
  | { id: string; version: string; source: 'installed'; codeSha256: string }
  | { id: string; version: string; source: 'development'; buildHash: string }

export interface WorkflowExecutionSourceSelector {
  readonly kind: 'installed-build' | 'development-build'
}

export interface WorkflowSourceSelectorVault {
  create(workflow: WorkflowDetail): WorkflowExecutionSourceSelector
  inspect(selector: WorkflowExecutionSourceSelector): ExactWorkflowSource | undefined
}

export function createWorkflowSourceSelectorVault(): WorkflowSourceSelectorVault {
  const sources = new WeakMap<WorkflowExecutionSourceSelector, ExactWorkflowSource>()

  return {
    create(workflow) {
      const source = workflow.source === 'installed'
        ? workflow.codeSha256 && workflow.runtimeIdentity.source === 'installed'
          ? { id: workflow.id, version: workflow.version, source: 'installed' as const, codeSha256: workflow.codeSha256 }
          : undefined
        : workflow.runtimeIdentity.source === 'development'
          ? { id: workflow.id, version: workflow.version, source: 'development' as const, buildHash: workflow.runtimeIdentity.buildHash }
          : undefined
      if (!source) throw new TypeError('Workflow detail has no exact source identity')
      const selector = Object.freeze({
        kind: source.source === 'installed' ? 'installed-build' as const : 'development-build' as const,
      })
      sources.set(selector, Object.freeze(source))
      return selector
    },
    inspect(selector) {
      return sources.get(selector)
    },
  }
}
