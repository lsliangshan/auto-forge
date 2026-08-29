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
  type ConversionIcnsSlot,
  type ConversionOutputContract,
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
const icnsSlots = [
  { type: 'icp4', logicalSize: 16, scale: 1, pixelSize: 16 },
  { type: 'ic11', logicalSize: 16, scale: 2, pixelSize: 32 },
  { type: 'icp5', logicalSize: 32, scale: 1, pixelSize: 32 },
  { type: 'ic12', logicalSize: 32, scale: 2, pixelSize: 64 },
  { type: 'ic07', logicalSize: 128, scale: 1, pixelSize: 128 },
  { type: 'ic13', logicalSize: 128, scale: 2, pixelSize: 256 },
  { type: 'ic08', logicalSize: 256, scale: 1, pixelSize: 256 },
  { type: 'ic14', logicalSize: 256, scale: 2, pixelSize: 512 },
  { type: 'ic09', logicalSize: 512, scale: 1, pixelSize: 512 },
  { type: 'ic10', logicalSize: 512, scale: 2, pixelSize: 1024 },
] as const satisfies readonly ConversionIcnsSlot[]
const probedIcnsSlots = new Map<string, { readonly type: string; readonly logicalSize: number; readonly scale: number; readonly pixelSize: number }>([
  ...icnsSlots.map((slot) => [slot.type, slot] as const),
  ['icp6', { type: 'icp6', logicalSize: 64, scale: 1, pixelSize: 64 }] as const,
])

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
  outputContract: ConversionOutputContract = { kind: 'single' },
): ConversionProcessPlan {
  const selected = executable(lease)
  return {
    executable: selected,
    args,
    cwd: outputRoot,
    env: createConversionEnvironment(selected, outputRoot),
    timeoutMs: CONVERSION_TIMEOUTS.image,
    outputContract,
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
        'create-icon', '--format', request.targetFormat,
        ...(request.targetFormat === 'icns'
          ? ['--representations', icnsSlots.map((slot) => `${slot.type}=${slot.logicalSize}@${slot.scale}x`).join(',')]
          : ['--sizes', sizes.join(',')]),
        '--fit', 'contain', '--canvas', 'square', '--background', 'transparent', '--crop', 'never',
        ...(frameSelection === undefined ? [] : ['--frame', frameSelection]),
        '--output', outputPath, '--', request.inputPath,
      ], [{
        path: outputPath,
        format: request.targetFormat,
        ...(request.targetFormat === 'icns' ? { iconSlots: icnsSlots } : {}),
        metadata: {
          iconRepresentations: [...sizes],
          ...(frameSelection === undefined ? {} : { frameSelection }),
          ...(route.iconGeometry === undefined ? {} : { transparentPadding: true as const }),
        },
      }])
    }

    if (input.format === 'ico' || input.format === 'icns') {
      if (!Number.isSafeInteger(input.frameCount) || input.frameCount < 1 || input.frameCount > 256) {
        throw new ConversionProcessError('CONVERSION_INPUT_INVALID')
      }
      const extractionSlots = input.format === 'icns' ? input.iconSlots : undefined
      const extractionRepresentations = input.format === 'ico' ? input.icoRepresentations : undefined
      if (input.format === 'icns' && (
        extractionSlots?.length !== input.frameCount
        || new Set(extractionSlots.map((slot) => slot.type)).size !== extractionSlots.length
        || extractionSlots.some((slot) => {
          const expected = probedIcnsSlots.get(slot.type)
          return expected === undefined
            || expected.logicalSize !== slot.logicalSize
            || expected.pixelSize !== slot.pixelSize
            || expected.scale !== slot.scale
        })
      )) throw new ConversionProcessError('CONVERSION_INPUT_INVALID')
      if (input.format === 'ico' && (
        extractionRepresentations?.length !== input.frameCount
        || extractionRepresentations.some((representation, index) => (
          !Number.isSafeInteger(representation.sourceIndex)
          || representation.sourceIndex < 1
          || representation.sourceIndex > 256
          || (index > 0 && representation.sourceIndex <= extractionRepresentations[index - 1]!.sourceIndex)
          || !Number.isSafeInteger(representation.width)
          || representation.width < 1
          || representation.width > 256
          || !Number.isSafeInteger(representation.height)
          || representation.height < 1
          || representation.height > 256
          || !/^[a-f0-9]{64}$/u.test(representation.payloadSha256)
        ))
        || new Set(extractionRepresentations.map((representation) => (
          `${representation.width}x${representation.height}:${representation.payloadSha256}`
        ))).size !== extractionRepresentations.length
      )) throw new ConversionProcessError('CONVERSION_INPUT_INVALID')
      const pattern = join(outputRoot, `representation-%03d.${request.targetFormat}`)
      const outputs = Array.from({ length: input.frameCount }, (_, index) => {
        const slot = extractionSlots?.[index]
        const representation = extractionRepresentations?.[index]
        const sourceIndex = representation?.sourceIndex ?? index + 1
        const iconRepresentation = representation === undefined
          ? (slot === undefined ? undefined : {
              sourceType: slot.type,
              logicalWidth: slot.logicalSize,
              logicalHeight: slot.logicalSize,
              pixelWidth: slot.pixelSize,
              pixelHeight: slot.pixelSize,
              scale: slot.scale,
            })
          : {
              sourceType: 'ico' as const,
              sourceIndex: representation.sourceIndex,
              logicalWidth: representation.width,
              logicalHeight: representation.height,
              pixelWidth: representation.width,
              pixelHeight: representation.height,
              scale: 1 as const,
            }
        return {
          path: join(outputRoot, `representation-${String(sourceIndex).padStart(3, '0')}.${request.targetFormat}`),
          format: request.targetFormat,
          ...(iconRepresentation === undefined ? {} : { metadata: { iconRepresentation } }),
        }
      })
      return planResult(lease, outputRoot, [
        'extract-icon', '--input-format', input.format, '--output-format', request.targetFormat,
        '--all-representations',
        ...(extractionRepresentations === undefined ? [] : [
          '--representation-indexes', extractionRepresentations.map(({ sourceIndex }) => sourceIndex).join(','),
        ]),
        '--output-pattern', pattern, '--', request.inputPath,
      ], outputs, { kind: 'icon-representations', count: outputs.length })
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
