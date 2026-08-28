import { describe, expect, it } from 'vitest'
import type { ConversionTargetFormat } from '@autoforge/shared'
import type { ConverterPackLease } from '../converter-pack-types.js'
import type { ProbedConversionInput } from '../conversion-catalog.js'
import { mediaAdapter } from './media.js'

const root = '/packs/media'
const executable = `${root}/bin/ffmpeg`
const lease: ConverterPackLease = Object.freeze({
  name: 'media', version: '1.0.0', platform: 'darwin', arch: 'arm64', root,
  executables: Object.freeze({ 'bin/ffmpeg': executable }), release() {},
})
const video: ProbedConversionInput = {
  format: 'mp4', mimeType: 'video/mp4', kind: 'video', byteSize: 100, frameCount: 1,
}
const audio: ProbedConversionInput = {
  format: 'wav', mimeType: 'audio/wav', kind: 'audio', byteSize: 100, frameCount: 1,
}

describe('media conversion adapter', () => {
  it('snapshots the exact fixed MP4 H.264/AAC argv with local-file protocols only', () => {
    expect(mediaAdapter.plan(video, {
      inputPath: '/input/- movie "quoted"\nline.mp4', targetFormat: 'mp4',
    }, lease, '/work')).toMatchInlineSnapshot(`
      {
        "args": [
          "-nostdin",
          "-hide_banner",
          "-loglevel",
          "error",
          "-nostats",
          "-protocol_whitelist",
          "file",
          "-i",
          "/input/- movie "quoted"
      line.mp4",
          "-map_metadata",
          "-1",
          "-map_chapters",
          "-1",
          "-map",
          "0:v:0?",
          "-map",
          "0:a:0?",
          "-c:v",
          "libx264",
          "-pix_fmt",
          "yuv420p",
          "-c:a",
          "aac",
          "-movflags",
          "+faststart",
          "-f",
          "mp4",
          "-y",
          "/work/output.mp4",
        ],
        "cwd": "/work",
        "env": {
          "LANG": "C.UTF-8",
          "LC_ALL": "C.UTF-8",
          "PATH": "/packs/media/bin",
          "TEMP": "/work",
          "TMP": "/work",
          "TMPDIR": "/work",
        },
        "executable": "/packs/media/bin/ffmpeg",
        "outputPaths": [
          "/work/output.mp4",
        ],
        "outputs": [
          {
            "format": "mp4",
            "path": "/work/output.mp4",
          },
        ],
        "timeoutMs": 1800000,
      }
    `)
  })

  it('fixes WebM to VP9/Opus, MOV to H.264/AAC, and GIF to video-only output', () => {
    const plans = (['webm', 'mov', 'gif'] as const).map((targetFormat) => mediaAdapter.plan(video, {
      inputPath: '/input/movie.mp4', targetFormat,
    }, lease, '/work').args)
    expect(plans).toMatchInlineSnapshot(`
      [
        [
          "-nostdin",
          "-hide_banner",
          "-loglevel",
          "error",
          "-nostats",
          "-protocol_whitelist",
          "file",
          "-i",
          "/input/movie.mp4",
          "-map_metadata",
          "-1",
          "-map_chapters",
          "-1",
          "-map",
          "0:v:0?",
          "-map",
          "0:a:0?",
          "-c:v",
          "libvpx-vp9",
          "-c:a",
          "libopus",
          "-f",
          "webm",
          "-y",
          "/work/output.webm",
        ],
        [
          "-nostdin",
          "-hide_banner",
          "-loglevel",
          "error",
          "-nostats",
          "-protocol_whitelist",
          "file",
          "-i",
          "/input/movie.mp4",
          "-map_metadata",
          "-1",
          "-map_chapters",
          "-1",
          "-map",
          "0:v:0?",
          "-map",
          "0:a:0?",
          "-c:v",
          "libx264",
          "-pix_fmt",
          "yuv420p",
          "-c:a",
          "aac",
          "-f",
          "mov",
          "-y",
          "/work/output.mov",
        ],
        [
          "-nostdin",
          "-hide_banner",
          "-loglevel",
          "error",
          "-nostats",
          "-protocol_whitelist",
          "file",
          "-i",
          "/input/movie.mp4",
          "-map_metadata",
          "-1",
          "-map_chapters",
          "-1",
          "-map",
          "0:v:0",
          "-an",
          "-c:v",
          "gif",
          "-f",
          "gif",
          "-y",
          "/work/output.gif",
        ],
      ]
    `)
  })

  it('uses fixed codecs and muxers for every approved audio target', () => {
    const targets: ConversionTargetFormat[] = ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus']
    const codecAndFormat = targets.map((targetFormat) => {
      const args = mediaAdapter.plan(audio, { inputPath: '/input/audio.wav', targetFormat }, lease, '/work').args
      return [targetFormat, args.slice(args.indexOf('-c:a'), -2)]
    })
    expect(codecAndFormat).toEqual([
      ['mp3', ['-c:a', 'libmp3lame', '-f', 'mp3']],
      ['wav', ['-c:a', 'pcm_s16le', '-f', 'wav']],
      ['m4a', ['-c:a', 'aac', '-f', 'ipod']],
      ['aac', ['-c:a', 'aac', '-f', 'adts']],
      ['flac', ['-c:a', 'flac', '-f', 'flac']],
      ['ogg', ['-c:a', 'libvorbis', '-f', 'ogg']],
      ['opus', ['-c:a', 'libopus', '-f', 'opus']],
    ])
    for (const targetFormat of targets) {
      expect(mediaAdapter.plan(audio, { inputPath: '/input/audio.wav', targetFormat }, lease, '/work').timeoutMs).toBe(600_000)
    }
  })

  it('allows approved video-to-audio and animated-image-to-video routes only', () => {
    const extracted = mediaAdapter.plan(video, { inputPath: '/input/movie.mp4', targetFormat: 'mp3' }, lease, '/work')
    expect(extracted.args).toContain('-vn')
    expect(extracted.timeoutMs).toBe(1_800_000)
    const animated: ProbedConversionInput = {
      format: 'webp', mimeType: 'image/webp', kind: 'image', byteSize: 100, width: 10, height: 10, frameCount: 2,
    }
    expect(mediaAdapter.supports(animated, 'mp4')).toBe(true)
    expect(mediaAdapter.supports({ ...animated, frameCount: 1 }, 'mp4')).toBe(false)
  })
})
