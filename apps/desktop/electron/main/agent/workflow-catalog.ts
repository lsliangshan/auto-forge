import type { WorkflowDetail } from '@autoforge/shared'
import type { ModelTool } from '../chat/model-provider.js'
import type { WorkflowExecutionSourceSelector } from '../workflows/workflow-source-selector.js'

export interface WorkflowCandidate {
  key: string
  toolName: string
  workflow: WorkflowDetail
  selector: WorkflowExecutionSourceSelector
  tool: ModelTool
}

export interface WorkflowCatalogDependencies {
  workflows: {
    list(options?: { developerMode?: boolean }): Promise<WorkflowDetail[]>
  }
  selectorFor(workflow: WorkflowDetail): WorkflowExecutionSourceSelector
}

export interface WorkflowCatalog {
  create(options: { developerMode: boolean }): Promise<WorkflowCandidate[]>
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

function snapshot(workflow: WorkflowDetail): WorkflowDetail {
  return deepFreeze(structuredClone(workflow))
}

function toolParameters(workflow: WorkflowDetail): Record<string, unknown> {
  const restricted = workflow.cities.length > 0
  return {
    type: 'object', additionalProperties: false,
    required: restricted ? ['resolvedCity', 'input'] : ['input'],
    properties: {
      ...(restricted ? { resolvedCity: { type: 'string', enum: workflow.cities } } : {}),
      input: workflow.inputSchema,
    },
  }
}

function toolDescription(workflow: WorkflowDetail): string {
  const cities = workflow.cities.length ? workflow.cities.join('、') : '不限城市'
  const positive = workflow.activationExamples.join('；') || '无'
  const negative = workflow.activationNegativeExamples.join('；') || '无'
  return `${workflow.name}（${workflow.id}@${workflow.version}）：${workflow.description}。城市：${cities}。分类：${workflow.category}。适用：${positive}。不适用：${negative}。`
}

export function createWorkflowCatalog(dependencies: WorkflowCatalogDependencies): WorkflowCatalog {
  return {
    async create(options) {
      const workflows = await dependencies.workflows.list({ developerMode: options.developerMode })
      return workflows.map((detail, index) => {
        const workflow = snapshot(detail)
        const toolName = `workflow_${index + 1}`
        const candidate: WorkflowCandidate = {
          key: `${workflow.id}\u0000${workflow.version}\u0000${index + 1}`,
          toolName,
          workflow,
          selector: dependencies.selectorFor(workflow),
          tool: {
            type: 'function',
            function: {
              name: toolName,
              description: toolDescription(workflow),
              parameters: toolParameters(workflow),
            },
          },
        }
        return deepFreeze(candidate)
      })
    },
  }
}
