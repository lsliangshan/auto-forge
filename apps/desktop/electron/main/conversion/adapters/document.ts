import { basename, extname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ConversionTargetFormat } from '@autoforge/shared'
import { resolveConversionRoute, type ProbedConversionInput } from '../conversion-catalog.js'
import type { ConverterPackLease } from '../converter-pack-types.js'
import {
  CONVERSION_TIMEOUTS,
  ConversionProcessError,
  createConversionEnvironment,
  requireLeaseExecutable,
  type ConversionProcessPlan,
  type ConverterAdapter,
} from '../conversion-process-runner.js'

const executableEntry = { darwin: 'program/soffice', win32: 'program/soffice.exe' } as const
const documentFormats = new Set<ProbedConversionInput['format']>([
  'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp', 'rtf', 'csv', 'html', 'markdown', 'txt',
])

function ownedRoute(input: ProbedConversionInput, target: ConversionTargetFormat): boolean {
  return documentFormats.has(input.format) && (target === 'pdf' || (input.format === 'csv' && target === 'xlsx'))
}

function executable(lease: ConverterPackLease): string {
  if (lease.name !== 'document') throw new ConversionProcessError('CONVERSION_COMPONENT_UNAVAILABLE')
  return requireLeaseExecutable(lease, executableEntry[lease.platform])
}

export const documentAdapter: ConverterAdapter = {
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
    const selected = executable(lease)
    const profile = join(outputRoot, 'libreoffice-profile')
    const sourceBase = basename(request.inputPath, extname(request.inputPath))
    if (sourceBase.length === 0 || sourceBase === '.' || sourceBase === '..') {
      throw new ConversionProcessError('CONVERSION_INPUT_INVALID')
    }
    const outputPath = join(outputRoot, `${sourceBase}.${request.targetFormat}`)
    const plan: ConversionProcessPlan = {
      executable: selected,
      args: [
        `-env:UserInstallation=${pathToFileURL(profile).href}`,
        '--headless', '--invisible', '--nologo', '--nodefault', '--nolockcheck', '--norestore',
        '--convert-to', request.targetFormat, '--outdir', outputRoot, '--', request.inputPath,
      ],
      cwd: outputRoot,
      env: createConversionEnvironment(selected, outputRoot),
      timeoutMs: CONVERSION_TIMEOUTS.document,
      outputContract: { kind: 'single' },
      outputPaths: [outputPath],
      outputs: [{ path: outputPath, format: request.targetFormat }],
    }
    return plan
  },
}
