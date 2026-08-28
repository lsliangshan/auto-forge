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
  type ConversionProcessPlan,
  type ConverterAdapter,
} from '../conversion-process-runner.js'

const executableEntry = {
  darwin: 'bin/autoforge-image-converter',
  win32: 'bin/autoforge-image-converter.exe',
} as const
const staticTargets = new Set<ConversionTargetFormat>(['png', 'jpeg', 'webp', 'avif', 'tiff', 'bmp', 'pdf'])
const iconRepresentations = {
  ico: [16, 24, 32, 48, 64, 128, 256],
  favicon: [16, 32, 48],
  icns: [16, 32, 64, 128, 256, 512, 1024],
} as const

function ownedRoute(input: ProbedConversionInput, target: ConversionTargetFormat): boolean {
  if (target === 'ico' || target === 'icns') return input.kind === 'image' && input.format !== 'ico' && input.format !== 'icns'
  if ((input.format === 'ico' || input.format === 'icns') && staticTargets.has(target)) return true
  return input.kind === 'image' && staticTargets.has(target)
}

function executable(lease: ConverterPackLease): string {
  if (lease.name !== 'image-icon') throw new ConversionProcessError('CONVERSION_COMPONENT_UNAVAILABLE')
  return requireLeaseExecutable(lease, executableEntry[lease.platform])
}

function planResult(
  lease: ConverterPackLease,
  outputRoot: string,
  args: readonly string[],
  outputs: readonly ConversionExpectedOutput[],
): ConversionProcessPlan {
  const selected = executable(lease)
  return {
    executable: selected,
    args,
    cwd: outputRoot,
    env: createConversionEnvironment(selected, outputRoot),
    timeoutMs: CONVERSION_TIMEOUTS.image,
    outputPaths: outputs.map((output) => output.path),
    outputs,
  }
}

export const imageIconAdapter: ConverterAdapter = {
  supports(input, target) {
    try {
      resolveConversionRoute(input, target)
      return ownedRoute(input, target)
        && !((input.format === 'gif' || (input.format === 'webp' && input.frameCount > 1)) && (target === 'gif' || target === 'mp4'))
    } catch {
      return false
    }
  },

  plan(input, request, lease, outputRoot) {
    const route = resolveConversionRoute(input, request.targetFormat)
    if (!this.supports(input, request.targetFormat)) {
      throw new ConversionProcessError('CONVERSION_FORMAT_UNSUPPORTED')
    }
    if (request.preset !== undefined && request.preset !== 'default'
      && !((request.targetFormat === 'ico' && request.preset === 'favicon')
        || ((request.targetFormat === 'ico' || request.targetFormat === 'icns') && request.preset === 'app-icon'))) {
      throw new ConversionProcessError('CONVERSION_INPUT_INVALID')
    }

    if (request.targetFormat === 'ico' || request.targetFormat === 'icns') {
      const sizes = request.targetFormat === 'ico'
        ? (request.preset === 'favicon' ? iconRepresentations.favicon : iconRepresentations.ico)
        : iconRepresentations.icns
      const frameSelection = input.frameCount > 1 ? 'first' as const : undefined
      const outputPath = join(outputRoot, `output.${request.targetFormat}`)
      return planResult(lease, outputRoot, [
        'create-icon', '--format', request.targetFormat, '--sizes', sizes.join(','),
        '--fit', 'contain', '--canvas', 'square', '--background', 'transparent', '--crop', 'never',
        ...(frameSelection === undefined ? [] : ['--frame', frameSelection]),
        '--output', outputPath, '--', request.inputPath,
      ], [{
        path: outputPath,
        format: request.targetFormat,
        metadata: {
          iconRepresentations: [...sizes],
          ...(frameSelection === undefined ? {} : { frameSelection }),
          ...(route.iconGeometry === undefined ? {} : { transparentPadding: true as const }),
        },
      }])
    }

    if (input.format === 'ico' || input.format === 'icns') {
      if (!Number.isSafeInteger(input.frameCount) || input.frameCount < 1 || input.frameCount > 100) {
        throw new ConversionProcessError('CONVERSION_INPUT_INVALID')
      }
      const pattern = join(outputRoot, `representation-%03d.${request.targetFormat}`)
      const outputs = Array.from({ length: input.frameCount }, (_, index) => ({
        path: join(outputRoot, `representation-${String(index + 1).padStart(3, '0')}.${request.targetFormat}`),
        format: request.targetFormat,
      }))
      return planResult(lease, outputRoot, [
        'extract-icon', '--input-format', input.format, '--output-format', request.targetFormat,
        '--all-representations', '--output-pattern', pattern, '--', request.inputPath,
      ], outputs)
    }

    const outputPath = join(outputRoot, `output.${request.targetFormat}`)
    return planResult(lease, outputRoot, [
      'convert', '--input-format', input.format, '--output-format', request.targetFormat,
      ...(route.frameSelection === undefined ? [] : ['--frame', route.frameSelection]),
      '--output', outputPath, '--', request.inputPath,
    ], [{
      path: outputPath,
      format: request.targetFormat,
      ...(route.frameSelection === undefined ? {} : { metadata: { frameSelection: route.frameSelection } }),
    }])
  },
}
