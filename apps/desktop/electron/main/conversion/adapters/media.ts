import { join } from 'node:path'
import type { ConversionTargetFormat } from '@autoforge/shared'
import { resolveConversionRoute, type ProbedConversionInput } from '../conversion-catalog.js'
import type { ConverterPackLease } from '../converter-pack-types.js'
import {
  CONVERSION_TIMEOUTS,
  ConversionProcessError,
  createConversionEnvironment,
  requireLeaseExecutable,
  type ConverterAdapter,
} from '../conversion-process-runner.js'

const executableEntry = { darwin: 'bin/ffmpeg', win32: 'bin/ffmpeg.exe' } as const
const audioTargets = new Set<ConversionTargetFormat>(['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus'])
const videoTargets = new Set<ConversionTargetFormat>(['mp4', 'webm', 'mov', 'gif'])

function executable(lease: ConverterPackLease): string {
  if (lease.name !== 'media') throw new ConversionProcessError('CONVERSION_COMPONENT_UNAVAILABLE')
  return requireLeaseExecutable(lease, executableEntry[lease.platform])
}

function animatedImage(input: ProbedConversionInput): boolean {
  return input.kind === 'image' && input.frameCount > 1 && (input.format === 'gif' || input.format === 'webp')
}

function ownedRoute(input: ProbedConversionInput, target: ConversionTargetFormat): boolean {
  if (input.kind === 'audio') return audioTargets.has(target)
  if (input.kind === 'video') return audioTargets.has(target) || videoTargets.has(target)
  return animatedImage(input) && (target === 'mp4' || target === 'gif')
}

function audioCodec(target: ConversionTargetFormat): readonly string[] {
  switch (target) {
    case 'mp3': return ['-c:a', 'libmp3lame', '-f', 'mp3']
    case 'wav': return ['-c:a', 'pcm_s16le', '-f', 'wav']
    case 'm4a': return ['-c:a', 'aac', '-f', 'ipod']
    case 'aac': return ['-c:a', 'aac', '-f', 'adts']
    case 'flac': return ['-c:a', 'flac', '-f', 'flac']
    case 'ogg': return ['-c:a', 'libvorbis', '-f', 'ogg']
    case 'opus': return ['-c:a', 'libopus', '-f', 'opus']
    default: throw new ConversionProcessError('CONVERSION_FORMAT_UNSUPPORTED')
  }
}

function outputArguments(target: ConversionTargetFormat): readonly string[] {
  switch (target) {
    case 'mp4':
      return ['-map', '0:v:0?', '-map', '0:a:0?', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', '-f', 'mp4']
    case 'webm':
      return ['-map', '0:v:0?', '-map', '0:a:0?', '-c:v', 'libvpx-vp9', '-c:a', 'libopus', '-f', 'webm']
    case 'mov':
      return ['-map', '0:v:0?', '-map', '0:a:0?', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-f', 'mov']
    case 'gif':
      return ['-map', '0:v:0', '-an', '-c:v', 'gif', '-f', 'gif']
    default:
      return ['-vn', '-map', '0:a:0', ...audioCodec(target)]
  }
}

export const mediaAdapter: ConverterAdapter = {
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
    const outputPath = join(outputRoot, `output.${request.targetFormat}`)
    return {
      executable: selected,
      args: [
        '-nostdin', '-hide_banner', '-loglevel', 'error', '-nostats',
        '-protocol_whitelist', 'file', '-i', request.inputPath,
        '-map_metadata', '-1', '-map_chapters', '-1',
        ...outputArguments(request.targetFormat), '-y', outputPath,
      ],
      cwd: outputRoot,
      env: createConversionEnvironment(selected, outputRoot),
      timeoutMs: input.kind === 'audio' ? CONVERSION_TIMEOUTS.audio : CONVERSION_TIMEOUTS.video,
      outputPaths: [outputPath],
      outputs: [{ path: outputPath, format: request.targetFormat }],
    }
  },
}
