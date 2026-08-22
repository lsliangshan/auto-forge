import { describe, expect, it } from 'vitest'
import { validateWorkflowOutput } from './output-validation.js'

describe('validateWorkflowOutput', () => {
  it('rejects output that violates schema formats', () => {
    const schema = {
      type: 'object',
      required: ['url'],
      additionalProperties: false,
      properties: { url: { type: 'string', format: 'uri' } },
    }

    expect(validateWorkflowOutput(schema, { url: 'https://example.com' })).toEqual({ valid: true })
    expect(validateWorkflowOutput(schema, { url: 'not a url' })).toEqual({ valid: false })
  })

  it('fails closed when the output schema is invalid', () => {
    expect(validateWorkflowOutput({ type: 'not-a-json-schema-type' }, { ok: true })).toEqual({ valid: false })
  })
})
