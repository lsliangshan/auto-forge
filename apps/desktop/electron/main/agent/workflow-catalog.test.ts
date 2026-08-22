import Ajv from 'ajv'
import { describe, expect, it } from 'vitest'
import type { WorkflowDetail } from '@autoforge/shared'
import { createWorkflowCatalog } from './workflow-catalog.js'
import { createWorkflowSourceSelectorVault } from '../workflows/workflow-source-selector.js'

const beijingWorkflow: WorkflowDetail = {
  id: 'weather.beijing', version: '1.0.0', name: '北京天气', description: '查询北京天气',
  author: 'AutoForge', category: 'weather', enabled: true, source: 'installed', integrity: 'valid',
  updatedAt: '2026-08-22T00:00:00.000Z', codeSha256: 'a'.repeat(64), cities: ['北京'],
  runtimeIdentity: { id: 'weather.beijing', version: '1.0.0', source: 'installed' },
  permissions: [{ capability: 'browser.open', scope: { origins: ['https://weather.example.com'] } }],
  activationExamples: ['北京今天天气'], activationNegativeExamples: ['上海今天天气'], timeoutMs: 30_000,
  inputSchema: { type: 'object', additionalProperties: false, required: ['date'], properties: { date: { type: 'string' } } },
  outputSchema: { type: 'object' },
}

const allCitiesWorkflow: WorkflowDetail = {
  ...beijingWorkflow,
  id: 'weather.current', version: '2.0.0', name: '天气查询', description: '查询任意城市天气', cities: [],
  runtimeIdentity: { id: 'weather.current', version: '2.0.0', source: 'installed' },
  activationExamples: ['查询今天天气'], activationNegativeExamples: ['订机票'],
}

describe('WorkflowCatalog', () => {
  it('creates unique tools with city routing outside workflow input', async () => {
    const workflows = { list: async () => [beijingWorkflow, allCitiesWorkflow] }
    const selectorFor = createWorkflowSourceSelectorVault().create

    const catalog = await createWorkflowCatalog({ workflows, selectorFor }).create({ developerMode: true })

    expect(catalog.map(({ toolName }) => toolName)).toEqual(['workflow_1', 'workflow_2'])
    expect(catalog[0]!.tool.function.parameters).toEqual({
      type: 'object', additionalProperties: false,
      required: ['resolvedCity', 'input'],
      properties: {
        resolvedCity: { type: 'string', enum: ['北京'] },
        input: beijingWorkflow.inputSchema,
      },
    })
    expect(catalog[1]!.tool.function.parameters).toEqual({
      type: 'object', additionalProperties: false,
      required: ['input'],
      properties: { input: allCitiesWorkflow.inputSchema },
    })
  })

  it('captures immutable workflow and selector snapshots for the run', async () => {
    const mutableWorkflow = structuredClone(beijingWorkflow)
    const workflows = { list: async () => [mutableWorkflow] }
    const vault = createWorkflowSourceSelectorVault()
    const catalog = await createWorkflowCatalog({ workflows, selectorFor: vault.create }).create({ developerMode: false })

    mutableWorkflow.name = '已变更'
    ;(mutableWorkflow.inputSchema as { properties: { date: { type: string } } }).properties.date.type = 'number'

    expect(catalog[0]!.workflow.name).toBe('北京天气')
    expect(catalog[0]!.tool.function.parameters).toMatchObject({
      properties: { input: { properties: { date: { type: 'string' } } } },
    })
    expect(vault.inspect(catalog[0]!.selector)).toEqual({
      id: 'weather.beijing', version: '1.0.0', source: 'installed', codeSha256: 'a'.repeat(64),
    })
  })

  it('describes identity, routing, category, and semantic activation boundaries', async () => {
    const catalog = await createWorkflowCatalog({
      workflows: { list: async () => [beijingWorkflow, allCitiesWorkflow] },
      selectorFor: createWorkflowSourceSelectorVault().create,
    }).create({ developerMode: false })

    expect(catalog[0]!.tool.function.description).toContain('北京天气')
    expect(catalog[0]!.tool.function.description).toContain('weather.beijing@1.0.0')
    expect(catalog[0]!.tool.function.description).toContain('北京')
    expect(catalog[0]!.tool.function.description).toContain('weather')
    expect(catalog[0]!.tool.function.description).toContain('北京今天天气')
    expect(catalog[0]!.tool.function.description).toContain('上海今天天气')
    expect(catalog[1]!.tool.function.description).toContain('不限城市')
  })

  it.each([
    ['$defs', {
      type: 'object', additionalProperties: false, required: ['amount'],
      $defs: { amount: { type: 'number' } },
      properties: { amount: { $ref: '#/$defs/amount' } },
    }],
    ['definitions', {
      type: 'object', additionalProperties: false, required: ['amount'],
      definitions: { amount: { type: 'number' } },
      properties: { amount: { $ref: '#/definitions/amount' } },
    }],
  ] as const)('keeps %s references within the workflow input schema', async (_kind, inputSchema) => {
    const workflow: WorkflowDetail = { ...beijingWorkflow, cities: [], inputSchema }
    const [candidate] = await createWorkflowCatalog({
      workflows: { list: async () => [workflow] },
      selectorFor: createWorkflowSourceSelectorVault().create,
    }).create({ developerMode: false })
    const validate = new Ajv({ strict: false }).compile(candidate!.tool.function.parameters as object)

    expect(validate({ input: { amount: 1 } })).toBe(true)
    expect(validate({ input: { amount: '1' } })).toBe(false)
  })
})
