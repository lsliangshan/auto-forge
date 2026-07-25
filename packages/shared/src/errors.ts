import { z } from 'zod'

export const appErrorCodeSchema = z.enum([
  'INVALID_INPUT',
  'UNTRUSTED_SENDER',
  'INTERNAL_ERROR',
  'NOT_FOUND',
  'CONFLICT',
  'CANCELLED',
  'PATH_OUTSIDE_PROJECT',
  'CAPABILITY_SCOPE_DENIED',
  'PERMISSION_DENIED',
  'WORKFLOW_INTEGRITY_FAILED',
  'WORKER_PROTOCOL_INVALID',
  'WORKER_TIMEOUT',
  'CREDENTIAL_UNAVAILABLE',
  'CREDENTIAL_INVALID',
  'OPENROUTER_REQUEST_FAILED',
  'MODEL_PROVIDER_REQUEST_FAILED',
])

export type AppErrorCode = z.infer<typeof appErrorCodeSchema>

export const appErrorSchema = z.object({
  code: appErrorCodeSchema,
  message: z.string().trim().min(1),
}).strict()

export type AppError = z.infer<typeof appErrorSchema>

const safeErrorMessages: Record<AppErrorCode, string> = {
  INVALID_INPUT: 'The request is invalid.',
  UNTRUSTED_SENDER: 'The request sender is not trusted.',
  INTERNAL_ERROR: 'Unexpected application error',
  NOT_FOUND: 'The requested resource was not found.',
  CONFLICT: 'The requested operation conflicts with existing state.',
  CANCELLED: 'The operation was cancelled.',
  PATH_OUTSIDE_PROJECT: 'The requested path is outside the project.',
  CAPABILITY_SCOPE_DENIED: 'The requested capability scope is not allowed.',
  PERMISSION_DENIED: 'The requested permission was denied.',
  WORKFLOW_INTEGRITY_FAILED: 'The workflow integrity check failed.',
  WORKER_PROTOCOL_INVALID: 'The worker protocol message is invalid.',
  WORKER_TIMEOUT: 'The worker timed out.',
  CREDENTIAL_UNAVAILABLE: 'The credential is unavailable.',
  CREDENTIAL_INVALID: 'The credential is invalid.',
  OPENROUTER_REQUEST_FAILED: 'The OpenRouter request failed.',
  MODEL_PROVIDER_REQUEST_FAILED: 'The model provider request failed.',
}

export function toSafeAppError(error: unknown): AppError {
  if (typeof error === 'object' && error !== null) {
    const parsedCode = appErrorCodeSchema.safeParse((error as { code?: unknown }).code)
    if (parsedCode.success) {
      return { code: parsedCode.data, message: safeErrorMessages[parsedCode.data] }
    }
  }

  return {
    code: 'INTERNAL_ERROR',
    message: safeErrorMessages.INTERNAL_ERROR,
  }
}
