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
  'MODEL_PROVIDER_ACCESS_DENIED',
  'OPENROUTER_REQUEST_FAILED',
  'MODEL_PROVIDER_REQUEST_FAILED',
  'MEDIA_TYPE_UNSUPPORTED',
  'MEDIA_ATTACHMENT_LIMIT_EXCEEDED',
  'MEDIA_SIZE_LIMIT_EXCEEDED',
  'MEDIA_MIME_MISMATCH',
  'MEDIA_IMPORT_FAILED',
  'MEDIA_ASSET_UNAVAILABLE',
  'MEDIA_STORAGE_FULL',
  'MODEL_MODALITY_UNSUPPORTED',
  'MEDIA_GENERATION_FAILED',
  'MEDIA_DOWNLOAD_FAILED',
  'MEDIA_GENERATION_TIMEOUT',
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
  MODEL_PROVIDER_ACCESS_DENIED: 'The model provider denied access.',
  OPENROUTER_REQUEST_FAILED: 'The OpenRouter request failed.',
  MODEL_PROVIDER_REQUEST_FAILED: 'The model provider request failed.',
  MEDIA_TYPE_UNSUPPORTED: 'This media type is not supported.',
  MEDIA_ATTACHMENT_LIMIT_EXCEEDED: 'The attachment limit was exceeded.',
  MEDIA_SIZE_LIMIT_EXCEEDED: 'The media size limit was exceeded.',
  MEDIA_MIME_MISMATCH: 'The media type does not match its contents.',
  MEDIA_IMPORT_FAILED: 'The media import failed.',
  MEDIA_ASSET_UNAVAILABLE: 'The media asset is unavailable.',
  MEDIA_STORAGE_FULL: 'There is not enough local storage for this media.',
  MODEL_MODALITY_UNSUPPORTED: 'The selected model does not support this media request.',
  MEDIA_GENERATION_FAILED: 'The media generation failed.',
  MEDIA_DOWNLOAD_FAILED: 'The media download failed.',
  MEDIA_GENERATION_TIMEOUT: 'The media generation timed out.',
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
