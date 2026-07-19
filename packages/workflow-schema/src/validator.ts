import Ajv from 'ajv'
import addFormats from 'ajv-formats'
import type { ValidationResult } from '@autoforge/shared'
import manifestSchema from '../manifest.schema.json' with { type: 'json' }
import type { WorkflowManifest } from './manifest.js'

const ajv = new Ajv({ allErrors: true, strict: true })
addFormats(ajv)
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
