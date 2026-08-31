import Ajv from 'ajv'
import { describe, expect, it, vi } from 'vitest'
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
  it('filters ineligible workflows before assigning opaque names or selectors', async () => {
    const eligibleSecond: WorkflowDetail = {
      ...allCitiesWorkflow,
      id: 'weather.second',
      runtimeIdentity: { id: 'weather.second', version: allCitiesWorkflow.version, source: 'installed' },
    }
    const workflows = {
      list: async () => [
        beijingWorkflow,
        { ...allCitiesWorkflow, id: 'weather.disabled', enabled: false,
          runtimeIdentity: { id: 'weather.disabled', version: allCitiesWorkflow.version, source: 'installed' as const } },
        { ...allCitiesWorkflow, id: 'weather.failed', integrity: 'failed' as const,
          runtimeIdentity: { id: 'weather.failed', version: allCitiesWorkflow.version, source: 'installed' as const } },
        { ...allCitiesWorkflow, id: 'weather.unchecked', integrity: 'unchecked' as const,
          runtimeIdentity: { id: 'weather.unchecked', version: allCitiesWorkflow.version, source: 'installed' as const } },
        eligibleSecond,
      ],
    }
    const vault = createWorkflowSourceSelectorVault()
    const selectorFor = vi.fn(vault.create)

    const catalog = await createWorkflowCatalog({ workflows, selectorFor }).create({ developerMode: false })

    expect(catalog.map(({ toolName, workflow }) => [toolName, workflow.id])).toEqual([
      ['workflow_1', beijingWorkflow.id],
      ['workflow_2', eligibleSecond.id],
    ])
    expect(selectorFor).toHaveBeenCalledTimes(2)
    expect(selectorFor.mock.calls.map(([candidate]) => candidate.id)).toEqual([
      beijingWorkflow.id,
      eligibleSecond.id,
    ])
  })

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

  it('does not treat a literal $ref under const as a schema reference', async () => {
    const literal = { $ref: '#/literal' }
    const inputSchema = {
      type: 'object', additionalProperties: false, required: ['marker'],
      properties: { marker: { const: literal } },
    }
    const workflow: WorkflowDetail = { ...beijingWorkflow, cities: [], inputSchema }
    const [candidate] = await createWorkflowCatalog({
      workflows: { list: async () => [workflow] },
      selectorFor: createWorkflowSourceSelectorVault().create,
    }).create({ developerMode: false })
    const validate = new Ajv({ strict: false }).compile(candidate!.tool.function.parameters as object)

    expect(candidate!.tool.function.parameters).toEqual({
      type: 'object', additionalProperties: false, required: ['input'], properties: { input: inputSchema },
    })
    expect(validate({ input: { marker: literal } })).toBe(true)
    expect(validate({ input: { marker: { $ref: '#/other' } } })).toBe(false)
  })

  it.each([
    ['nested properties', {
      type: 'object', $defs: { amount: { type: 'number' } },
      properties: { payload: { type: 'object', properties: { amount: { $ref: '#/$defs/amount' } } } },
    }, { payload: { amount: 1 } }, true],
    ['allOf', {
      type: 'object', definitions: { amount: { type: 'number' } },
      allOf: [{ required: ['amount'], properties: { amount: { $ref: '#/definitions/amount' } } }],
    }, { amount: 1 }, true],
    ['items', {
      type: 'array', $defs: { amount: { type: 'number' } }, items: { $ref: '#/$defs/amount' },
    }, [1], true],
    ['an existing $id', {
      $id: 'urn:autoforge:workflow:existing', type: 'object',
      definitions: { amount: { type: 'number' } },
      properties: { amount: { $ref: '#/definitions/amount' } },
    }, { amount: 1 }, false],
  ] as const)('finds real local references through %s schema positions', async (_kind, inputSchema, validInput, injectsId) => {
    const workflow: WorkflowDetail = { ...beijingWorkflow, cities: [], inputSchema }
    const [candidate] = await createWorkflowCatalog({
      workflows: { list: async () => [workflow] },
      selectorFor: createWorkflowSourceSelectorVault().create,
    }).create({ developerMode: false })
    const schema = (candidate!.tool.function.parameters as { properties: { input: Record<string, unknown> } }).properties.input
    const validate = new Ajv({ strict: false }).compile(candidate!.tool.function.parameters as object)

    expect(schema.$id).toBe(injectsId ? 'urn:autoforge:workflow-tool:workflow_1:input' : 'urn:autoforge:workflow:existing')
    expect(validate({ input: validInput })).toBe(true)
  })

  it('recursively strips AutoForge UI annotations only from the model-visible schema', async () => {
    const inputSchema = {
      type: 'object', additionalProperties: false, required: ['files'],
      'x-autoforge-form': { density: 'compact' },
      properties: {
        files: {
          type: 'array', items: {
            type: 'integer', minimum: 0,
            'x-autoforge-item': { private: true },
          },
          'x-autoforge-control': 'file-picker',
        },
        nested: {
          oneOf: [{
            type: 'object', properties: {
              value: { type: 'string', 'x-autoforge-widget': 'secret' },
            },
          }],
        },
      },
    }
    const workflow: WorkflowDetail = { ...beijingWorkflow, cities: [], inputSchema }
    const [candidate] = await createWorkflowCatalog({
      workflows: { list: async () => [workflow] },
      selectorFor: createWorkflowSourceSelectorVault().create,
    }).create({ developerMode: false })
    const projected = (candidate!.tool.function.parameters as {
      properties: { input: Record<string, unknown> }
    }).properties.input

    expect(JSON.stringify(projected)).not.toContain('x-autoforge-')
    expect(projected).toEqual({
      type: 'object', additionalProperties: false, required: ['files'],
      properties: {
        files: { type: 'array', items: { type: 'integer', minimum: 0 } },
        nested: {
          oneOf: [{
            type: 'object', properties: { value: { type: 'string' } },
          }],
        },
      },
    })
    expect(workflow.inputSchema).toEqual(inputSchema)
    expect(JSON.stringify(workflow.inputSchema)).toContain('x-autoforge-control')
  })
})
