import Ajv from 'ajv'
import addFormats from 'ajv-formats'
import type { ValidationResult } from '@autoforge/shared'
import manifestSchema from '../manifest.schema.json' with { type: 'json' }
import type { WorkflowManifest } from './manifest.js'

const ajv = new Ajv({ allErrors: true, strict: true })
addFormats(ajv)
ajv.addFormat('https-origin', {
  type: 'string',
  validate(value: string): boolean {
    try {
      const url = new URL(value)
      return url.protocol === 'https:'
        && url.username === ''
        && url.password === ''
        && url.pathname === '/'
        && url.search === ''
        && url.hash === ''
        && url.origin === value
    } catch {
      return false
    }
  },
})
const validate = ajv.compile<WorkflowManifest>(manifestSchema)

export function validateManifest(value: unknown): ValidationResult {
  if (validate(value)) return { valid: true, diagnostics: [] }

  return {
    valid: false,
    diagnostics: validate.errors?.map((error) => ({
      path: error.instancePath || '/',
      message: error.message ?? 'Invalid workflow manifest',
      severity: 'error' as const,
    })) ?? [],
  }
}
