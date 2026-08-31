import { describe, expect, it, vi } from 'vitest'
import {
  selectWorkflowConfig,
  type WorkflowConfigSelectionRequest,
} from './workflow-config-selector.js'

describe('selectWorkflowConfig', () => {
  it('selects a dynamic key and validates its workflow-specific input', async () => {
    const select = vi.fn(async (request: WorkflowConfigSelectionRequest) => {
      expect(request.signal.aborted).toBe(false)
      return JSON.stringify({
        decision: 'match',
        key: 'retirement-age-calculator',
        input: { birthDate: '1990-01-02' },
      })
    })

    await expect(selectWorkflowConfig({
      query: '帮我算一下 1990 年 1 月 2 日出生的退休年龄',
      config: {
        'beijing-work-residence-permit': {
          description: '查询、办理北京工作居住证',
          cities: ['北京'],
          url: 'https://private.example.test/permit',
        },
        'retirement-age-calculator': {
          description: '根据出生日期计算退休年龄',
          cities: [],
          inputSchema: {
            type: 'object',
            additionalProperties: false,
            required: ['birthDate'],
            properties: { birthDate: { type: 'string', format: 'date' } },
          },
        },
      },
      select,
      signal: new AbortController().signal,
    })).resolves.toEqual({
      kind: 'match',
      key: 'retirement-age-calculator',
      input: { birthDate: '1990-01-02' },
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['birthDate'],
        properties: { birthDate: { type: 'string', format: 'date' } },
      },
    })

    const request = select.mock.calls[0]![0]
    expect(JSON.stringify(request.messages)).toContain('根据出生日期计算退休年龄')
    expect(JSON.stringify(request.messages)).not.toContain('private.example.test')
  })

  it('requires a configured city match and accepts an explicit no-match decision', async () => {
    const controller = new AbortController()
    const config = {
      permit: {
        description: '办理工作居住证',
        cities: ['北京'],
      },
    }

    await expect(selectWorkflowConfig({
      query: '办理上海工作居住证',
      config,
      select: async () => JSON.stringify({ decision: 'no_match' }),
      signal: controller.signal,
    })).resolves.toEqual({ kind: 'no_match' })

    await expect(selectWorkflowConfig({
      query: '办理上海工作居住证',
      config,
      select: async () => JSON.stringify({
        decision: 'match', key: 'permit', resolvedCity: '上海', input: {},
      }),
      signal: controller.signal,
    })).rejects.toMatchObject({ code: 'MODEL_PROVIDER_REQUEST_FAILED' })

    await expect(selectWorkflowConfig({
      query: '办理上海工作居住证',
      config,
      select: async () => JSON.stringify({
        decision: 'match', key: 'permit', resolvedCity: '北京', input: {},
      }),
      signal: controller.signal,
    })).rejects.toMatchObject({ code: 'MODEL_PROVIDER_REQUEST_FAILED' })
  })

  it('rejects model input that does not satisfy the selected config schema', async () => {
    await expect(selectWorkflowConfig({
      query: '计算退休年龄',
      config: {
        retirement: {
          description: '计算退休年龄',
          cities: [],
          inputSchema: {
            type: 'object', additionalProperties: false, required: ['birthDate'],
            properties: { birthDate: { type: 'string' } },
          },
        },
      },
      select: async () => JSON.stringify({ decision: 'match', key: 'retirement', input: {} }),
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'MODEL_PROVIDER_REQUEST_FAILED' })
  })

  it('rejects the whole config before model selection when any input schema is invalid', async () => {
    const select = vi.fn(async () => JSON.stringify({
      decision: 'match', key: 'valid', input: {},
    }))

    await expect(selectWorkflowConfig({
      query: '执行有效业务',
      config: {
        valid: { description: '有效业务', cities: [] },
        invalid: {
          description: '无效业务', cities: [], inputSchema: { type: 'not-a-json-schema-type' },
        },
      },
      select,
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(select).not.toHaveBeenCalled()
  })

  it('rejects async input schemas before they can create an unhandled validation rejection', async () => {
    const select = vi.fn(async () => JSON.stringify({
      decision: 'match', key: 'async', input: {},
    }))

    await expect(selectWorkflowConfig({
      query: '执行异步业务',
      config: {
        async: {
          description: '异步业务', cities: [],
          inputSchema: { $async: true, type: 'object' },
        },
      },
      select,
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(select).not.toHaveBeenCalled()
  })
})
