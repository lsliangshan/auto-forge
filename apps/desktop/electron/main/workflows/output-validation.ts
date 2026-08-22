import Ajv, { type AnySchema } from 'ajv'
import addFormats from 'ajv-formats'

export type WorkflowOutputValidationResult = { valid: boolean }

export function validateWorkflowOutput(schema: unknown, output: unknown): WorkflowOutputValidationResult {
  try {
    const ajv = new Ajv({ strict: false })
    addFormats(ajv)
    return { valid: Boolean(ajv.compile(schema as AnySchema)(output)) }
  } catch {
    return { valid: false }
  }
}
