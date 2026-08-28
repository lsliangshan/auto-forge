import { join } from 'node:path'
import type { ConversionTargetFormat } from '@autoforge/shared'
import { resolveConversionRoute, type ProbedConversionInput } from '../conversion-catalog.js'
import type { ConverterPackLease } from '../converter-pack-types.js'
import {
  CONVERSION_TIMEOUTS,
  ConversionProcessError,
  createConversionEnvironment,
  requireLeaseExecutable,
  type ConversionExpectedOutput,
  type ConverterAdapter,
} from '../conversion-process-runner.js'

const executableEntry = { darwin: 'bin/autoforge-pdf-raster', win32: 'bin/autoforge-pdf-raster.exe' } as const

function executable(lease: ConverterPackLease): string {
  if (lease.name !== 'pdf') throw new ConversionProcessError('CONVERSION_COMPONENT_UNAVAILABLE')
  return requireLeaseExecutable(lease, executableEntry[lease.platform])
}

function ownedRoute(input: ProbedConversionInput, target: ConversionTargetFormat): boolean {
  return input.format === 'pdf' && (target === 'png' || target === 'jpeg')
}

export const pdfAdapter: ConverterAdapter = {
  supports(input, target) {
    try {
      resolveConversionRoute(input, target)
      return ownedRoute(input, target)
    } catch {
      return false
    }
  },

  plan(input, request, lease, outputRoot) {
    resolveConversionRoute(input, request.targetFormat)
    if (!this.supports(input, request.targetFormat)) throw new ConversionProcessError('CONVERSION_FORMAT_UNSUPPORTED')
    if (request.preset !== undefined && request.preset !== 'default') throw new ConversionProcessError('CONVERSION_INPUT_INVALID')
    if (!Number.isSafeInteger(input.pageCount) || input.pageCount === undefined || input.pageCount < 1 || input.pageCount > 100) {
      throw new ConversionProcessError('CONVERSION_INPUT_INVALID')
    }
    const selected = executable(lease)
    const pattern = join(outputRoot, `page-%03d.${request.targetFormat}`)
    const outputs: ConversionExpectedOutput[] = Array.from({ length: input.pageCount }, (_, index) => ({
      path: join(outputRoot, `page-${String(index + 1).padStart(3, '0')}.${request.targetFormat}`),
      format: request.targetFormat,
      metadata: { pdfPage: index + 1 },
    }))
    return {
      executable: selected,
      args: [
        'raster', '--format', request.targetFormat, '--pages', 'all', '--page-number-width', '3',
        '--output-pattern', pattern, '--', request.inputPath,
      ],
      cwd: outputRoot,
      env: createConversionEnvironment(selected, outputRoot),
      timeoutMs: CONVERSION_TIMEOUTS.pdf,
      outputPaths: outputs.map((output) => output.path),
      outputs,
    }
  },
}
