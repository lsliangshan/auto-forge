import type { ConversionPreset, ConversionTargetFormat } from '@autoforge/shared'

export interface BrowserCapability {
  open(url: string): Promise<void>
  fill(locator: string, value: string): Promise<void>
  click(locator: string): Promise<void>
  url(): Promise<string>
  close(): Promise<void>
}

export type ConversionErrorCode =
  | 'CONVERSION_FORMAT_UNSUPPORTED'
  | 'CONVERSION_COMPONENT_UNAVAILABLE'
  | 'CONVERSION_INPUT_INVALID'
  | 'CONVERSION_OUTPUT_TOO_LARGE'
  | 'CONVERSION_TIMEOUT'
  | 'CONVERSION_CANCELLED'
  | 'CONVERSION_INTERRUPTED'

export interface ConverterSubmitInput {
  attachmentIndex: number
  targetFormat: ConversionTargetFormat
  preset?: ConversionPreset
  background?: boolean
}

export type ConverterSubmitResult =
  | {
      accepted: true
      status: 'queued' | 'completed'
      outputs: Array<{ name: string; format: ConversionTargetFormat; byteSize: number }>
    }
  | {
      accepted: false
      status: 'failed'
      error: { code: ConversionErrorCode; message: string }
    }

export interface ConverterCapability {
  submit(input: ConverterSubmitInput): Promise<ConverterSubmitResult>
}

export interface LoggerCapability {
  debug(message: string): void
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}

export interface WorkflowContext {
  browser: BrowserCapability
  converter: ConverterCapability
  logger: LoggerCapability
}
