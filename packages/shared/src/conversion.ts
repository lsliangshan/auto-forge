import { z } from 'zod'

export const CONVERSION_TARGET_FORMATS = [
  'png', 'jpeg', 'webp', 'avif', 'tiff', 'bmp', 'gif', 'ico', 'icns',
  'pdf', 'docx', 'xlsx', 'mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus',
  'mp4', 'webm', 'mov',
] as const

export const conversionTargetFormatSchema = z.enum(CONVERSION_TARGET_FORMATS)
export type ConversionTargetFormat = z.infer<typeof conversionTargetFormatSchema>

export const conversionPresetSchema = z.enum(['default', 'favicon', 'app-icon'])
export type ConversionPreset = z.infer<typeof conversionPresetSchema>

export const conversionJobStatusSchema = z.enum([
  'queued', 'downloading_component', 'converting', 'verifying',
  'completed', 'failed', 'cancelled', 'interrupted',
])
export type ConversionJobStatus = z.infer<typeof conversionJobStatusSchema>

export const conversionFormatScopeSchema = z.object({
  formats: z.array(conversionTargetFormatSchema).min(1).refine((formats) => new Set(formats).size === formats.length, {
    message: 'Conversion formats must be unique',
  }),
}).strict()

export const fileConvertRequestSchema = z.object({
  capability: z.literal('file.convert'),
  scope: conversionFormatScopeSchema,
  arguments: z.object({
    attachmentIndex: z.number().int().nonnegative(),
    targetFormat: conversionTargetFormatSchema,
    preset: conversionPresetSchema.optional(),
    background: z.boolean().optional(),
  }).strict(),
}).strict().superRefine(({ scope, arguments: args }, context) => {
  if (!scope.formats.includes(args.targetFormat)) {
    context.addIssue({
      code: 'custom',
      path: ['arguments', 'targetFormat'],
      message: 'Target format must be included in the declared conversion scope',
    })
  }
})

export type FileConvertRequest = z.infer<typeof fileConvertRequestSchema>
