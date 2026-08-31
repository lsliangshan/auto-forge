import { defineWorkflow, type WorkflowDefinition } from '../src/index.js'

const config = {
  'government-service': {
    description: '政务服务',
    cities: ['北京'],
    url: 'https://service.example.gov.cn',
  },
} as const

const workflow: WorkflowDefinition<unknown, { opened: true }, typeof config> = defineWorkflow({
  async run() {
    return { opened: true as const }
  },
  getConfig() {
    return config
  },
})

const returnedConfig = workflow.getConfig?.()
if (returnedConfig) {
  const description: '政务服务' = returnedConfig['government-service'].description
  void description
}

const invalidConfig = {
  invalid: { cities: [] },
}

// @ts-expect-error Config items must declare both description and cities.
defineWorkflow<unknown, null, typeof invalidConfig>({
  async run() { return null },
  getConfig() { return invalidConfig },
})
