import { describe, expect, it } from 'vitest'
import type { ConverterPackLease } from '../converter-pack-types.js'
import type { ProbedConversionInput } from '../conversion-catalog.js'
import type { ConversionRequest } from '../conversion-process-runner.js'
import { imageIconAdapter } from './image-icon.js'

const root = '/packs/image-icon'
const executable = `${root}/bin/autoforge-image-converter`
const lease: ConverterPackLease = Object.freeze({
  name: 'image-icon', version: '1.0.0', platform: 'darwin', arch: 'arm64', root,
  executables: Object.freeze({ 'bin/autoforge-image-converter': executable }), release() {},
})
const specialInput = '/input/- cover "quoted"\nline.png'

function image(overrides: Partial<ProbedConversionInput> = {}): ProbedConversionInput {
  return { format: 'png', mimeType: 'image/png', kind: 'image', byteSize: 100, width: 120, height: 80, frameCount: 1, ...overrides }
}

function request(targetFormat: ConversionRequest['targetFormat'], preset?: ConversionRequest['preset']): ConversionRequest {
  return { inputPath: specialInput, targetFormat, ...(preset === undefined ? {} : { preset }) }
}

describe('image/icon conversion adapter', () => {
  it('plans transparent contain-pad ICO output with the approved default representations', () => {
    expect(imageIconAdapter.plan(image(), request('ico'), lease, '/work')).toMatchInlineSnapshot(`
      {
        "args": [
          "create-icon",
          "--format",
          "ico",
          "--sizes",
          "16,24,32,48,64,128,256",
          "--fit",
          "contain",
          "--canvas",
          "square",
          "--background",
          "transparent",
          "--crop",
          "never",
          "--output",
          "/work/output.ico",
          "--",
          "/input/- cover "quoted"
      line.png",
        ],
        "cwd": "/work",
        "env": {
          "LANG": "C.UTF-8",
          "LC_ALL": "C.UTF-8",
          "PATH": "/packs/image-icon/bin",
          "TEMP": "/work",
          "TMP": "/work",
          "TMPDIR": "/work",
        },
        "executable": "/packs/image-icon/bin/autoforge-image-converter",
        "outputContract": {
          "kind": "single",
        },
        "outputPaths": [
          "/work/output.ico",
        ],
        "outputs": [
          {
            "format": "ico",
            "metadata": {
              "iconRepresentations": [
                16,
                24,
                32,
                48,
                64,
                128,
                256,
              ],
              "transparentPadding": true,
            },
            "path": "/work/output.ico",
          },
        ],
        "timeoutMs": 120000,
      }
    `)
  })

  it('uses only 16/32/48 for favicon and scale-specific 1x/2x slots for ICNS', () => {
    const favicon = imageIconAdapter.plan(image(), request('ico', 'favicon'), lease, '/work')
    const icns = imageIconAdapter.plan(image(), request('icns', 'app-icon'), lease, '/work')
    expect(favicon.args).toContain('16,32,48')
    expect(favicon.outputs[0]?.metadata).toEqual({ iconRepresentations: [16, 32, 48], transparentPadding: true })
    expect(icns.args).toEqual([
      'create-icon', '--format', 'icns', '--representations',
      'icp4=16@1x,ic11=16@2x,icp5=32@1x,ic12=32@2x,ic07=128@1x,ic13=128@2x,ic08=256@1x,ic14=256@2x,ic09=512@1x,ic10=512@2x',
      '--fit', 'contain', '--canvas', 'square', '--background', 'transparent', '--crop', 'never',
      '--output', '/work/output.icns', '--', specialInput,
    ])
    expect(icns.outputs[0]).toEqual({
      path: '/work/output.icns',
      format: 'icns',
      metadata: { iconRepresentations: [16, 32, 64, 128, 256, 512, 1024], transparentPadding: true },
      iconSlots: [
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
      ],
    })
  })

  it('exports every structurally probed ICO/ICNS representation', () => {
    const plan = imageIconAdapter.plan(image({ format: 'ico', mimeType: 'image/vnd.microsoft.icon', frameCount: 3 }), {
      inputPath: '/input/icon.ico', targetFormat: 'png',
    }, lease, '/work')
    expect(plan.args).toEqual([
      'extract-icon', '--input-format', 'ico', '--output-format', 'png', '--all-representations',
      '--output-pattern', '/work/representation-%03d.png', '--', '/input/icon.ico',
    ])
    expect(plan.outputs).toEqual([
      { path: '/work/representation-001.png', format: 'png' },
      { path: '/work/representation-002.png', format: 'png' },
      { path: '/work/representation-003.png', format: 'png' },
    ])
  })

  it.each([101, 256])('exports all %i trusted ICO representations without the PDF page cap', (frameCount) => {
    const plan = imageIconAdapter.plan(image({
      format: 'ico', mimeType: 'image/vnd.microsoft.icon', frameCount,
    }), { inputPath: '/input/icon.ico', targetFormat: 'png' }, lease, '/work')

    expect(plan.outputContract).toEqual({ kind: 'icon-representations', count: frameCount })
    expect(plan.outputs).toHaveLength(frameCount)
    expect(plan.outputs.at(-1)?.path).toBe(`/work/representation-${String(frameCount).padStart(3, '0')}.png`)
  })

  it('rejects 257 forged ICO representations at the adapter boundary', () => {
    expect(() => imageIconAdapter.plan(image({
      format: 'ico', mimeType: 'image/vnd.microsoft.icon', frameCount: 257,
    }), { inputPath: '/input/icon.ico', targetFormat: 'png' }, lease, '/work')).toThrowError(
      expect.objectContaining({ code: 'CONVERSION_INPUT_INVALID' }),
    )
  })

  it('selects only the first frame and records metadata for animated-to-static output', () => {
    const plan = imageIconAdapter.plan(image({ format: 'webp', mimeType: 'image/webp', frameCount: 4 }), request('png'), lease, '/work')
    expect(plan.args).toEqual([
      'convert', '--input-format', 'webp', '--output-format', 'png', '--frame', 'first',
      '--output', '/work/output.png', '--', specialInput,
    ])
    expect(plan.outputs).toEqual([{ path: '/work/output.png', format: 'png', metadata: { frameSelection: 'first' } }])
  })

  it('selects and records the first frame when an animated WebP becomes a static icon', () => {
    const plan = imageIconAdapter.plan(image({ format: 'webp', mimeType: 'image/webp', frameCount: 4 }), request('ico'), lease, '/work')
    expect(plan.args).toContain('first')
    expect(plan.args.slice(-2)).toEqual(['--', specialInput])
    expect(plan.outputs[0]?.metadata).toEqual({
      iconRepresentations: [16, 24, 32, 48, 64, 128, 256],
      frameSelection: 'first',
      transparentPadding: true,
    })
  })

  it('fails closed when the trusted catalog route does not belong to this adapter', () => {
    expect(imageIconAdapter.supports(image(), 'mp4')).toBe(false)
    expect(() => imageIconAdapter.plan(image(), request('mp4'), lease, '/work')).toThrowError(
      expect.objectContaining({ code: 'CONVERSION_FORMAT_UNSUPPORTED' }),
    )
  })
})
