import { defineWorkflow, type ConversionErrorCode, type ConverterSubmitResult } from '@autoforge/workflow-sdk'
import type { ConversionPreset, ConversionTargetFormat } from '@autoforge/shared'

const targetFormats = new Set<ConversionTargetFormat>([
  'png', 'jpeg', 'webp', 'avif', 'tiff', 'bmp', 'gif', 'ico', 'icns',
  'pdf', 'xlsx', 'mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus',
  'mp4', 'webm', 'mov',
])
const presets = new Set<ConversionPreset>(['default', 'favicon', 'app-icon'])
const safeConversionErrors: Readonly<Record<ConversionErrorCode, string>> = Object.freeze({
  CONVERSION_FORMAT_UNSUPPORTED: 'The requested output format is not supported.',
  CONVERSION_COMPONENT_UNAVAILABLE: 'The required conversion component is unavailable.',
  CONVERSION_INPUT_INVALID: 'The input file cannot be converted.',
  CONVERSION_OUTPUT_TOO_LARGE: 'The converted output is too large.',
  CONVERSION_TIMEOUT: 'The conversion timed out.',
  CONVERSION_CANCELLED: 'The conversion was cancelled.',
  CONVERSION_INTERRUPTED: 'The conversion was interrupted.',
})

interface Input {
  files: number[]
  targetFormat: ConversionTargetFormat
  preset?: ConversionPreset
  background?: boolean
}

interface Output {
  workflow: '万象转换'
  results: ConverterSubmitResult[]
}

function validateInput(input: Input): void {
  if (!Array.isArray(input.files) || input.files.length === 0 || input.files.length > 5) {
    throw new Error('files must contain between one and five attachment indexes')
  }
  if (input.files.some((index) => !Number.isInteger(index) || index < 0) || new Set(input.files).size !== input.files.length) {
    throw new Error('files must contain unique non-negative attachment indexes')
  }
  if (!targetFormats.has(input.targetFormat)) throw new Error('targetFormat is not supported')
  if (input.preset !== undefined && !presets.has(input.preset)) throw new Error('preset is not supported')
  if (input.background !== undefined && typeof input.background !== 'boolean') throw new Error('background must be a boolean')
}

function errorResult(code: ConversionErrorCode): ConverterSubmitResult {
  return {
    accepted: false,
    status: 'failed',
    error: {
      code,
      message: safeConversionErrors[code],
    },
  }
}

function failedResult(error: unknown): ConverterSubmitResult {
  if (typeof error !== 'object' || error === null) return errorResult('CONVERSION_COMPONENT_UNAVAILABLE')

  try {
    const code = Object.getOwnPropertyDescriptor(error, 'code')?.value
    if (typeof code === 'string' && Object.hasOwn(safeConversionErrors, code)) {
      return errorResult(code as ConversionErrorCode)
    }
  } catch {
    // An untrusted rejected value must not prevent later files from submitting.
  }

  return errorResult('CONVERSION_COMPONENT_UNAVAILABLE')
}

export default defineWorkflow<Input, Output>({
  async run(ctx, input) {
    validateInput(input)

    const results: ConverterSubmitResult[] = []
    for (const attachmentIndex of input.files) {
      try {
        results.push(await ctx.converter.submit({
          attachmentIndex,
          targetFormat: input.targetFormat,
          preset: input.preset,
          background: input.background,
        }))
      } catch (error) {
        results.push(failedResult(error))
      }
    }
    return { workflow: '万象转换', results }
  },
})
