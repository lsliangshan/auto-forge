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
])

export type AppErrorCode = z.infer<typeof appErrorCodeSchema>

export const appErrorSchema = z.object({
  code: appErrorCodeSchema,
  message: z.string().trim().min(1),
  details: z.unknown().optional(),
}).strict()

export type AppError = z.infer<typeof appErrorSchema>

export function toSafeAppError(error: unknown): AppError {
  const parsed = appErrorSchema.safeParse(error)
  if (parsed.success) {
    return parsed.data
  }

  return {
    code: 'INTERNAL_ERROR',
    message: error instanceof Error ? error.message : 'Unexpected application error',
  }
}
