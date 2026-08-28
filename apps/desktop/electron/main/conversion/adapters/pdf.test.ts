import { describe, expect, it } from 'vitest'
import type { ConverterPackLease } from '../converter-pack-types.js'
import type { ProbedConversionInput } from '../conversion-catalog.js'
import { pdfAdapter } from './pdf.js'

const root = '/packs/pdf'
const executable = `${root}/bin/autoforge-pdf-raster`
const lease: ConverterPackLease = Object.freeze({
  name: 'pdf', version: '1.0.0', platform: 'darwin', arch: 'arm64', root,
  executables: Object.freeze({ 'bin/autoforge-pdf-raster': executable }), release() {},
})
const input: ProbedConversionInput = {
  format: 'pdf', mimeType: 'application/pdf', kind: 'file', byteSize: 100, frameCount: 1, pageCount: 3,
}

describe('PDF conversion adapter', () => {
  it('plans all structurally probed pages with zero-padded output names and page metadata', () => {
    expect(pdfAdapter.plan(input, {
      inputPath: '/input/- pages "quoted"\nline.pdf', targetFormat: 'png',
    }, lease, '/work')).toMatchInlineSnapshot(`
      {
        "args": [
          "raster",
          "--format",
          "png",
          "--pages",
          "all",
          "--page-number-width",
          "3",
          "--output-pattern",
          "/work/page-%03d.png",
          "--",
          "/input/- pages "quoted"
      line.pdf",
        ],
        "cwd": "/work",
        "env": {
          "LANG": "C.UTF-8",
          "LC_ALL": "C.UTF-8",
          "PATH": "/packs/pdf/bin",
          "TEMP": "/work",
          "TMP": "/work",
          "TMPDIR": "/work",
        },
        "executable": "/packs/pdf/bin/autoforge-pdf-raster",
        "outputPaths": [
          "/work/page-001.png",
          "/work/page-002.png",
          "/work/page-003.png",
        ],
        "outputs": [
          {
            "format": "png",
            "metadata": {
              "pdfPage": 1,
            },
            "path": "/work/page-001.png",
          },
          {
            "format": "png",
            "metadata": {
              "pdfPage": 2,
            },
            "path": "/work/page-002.png",
          },
          {
            "format": "png",
            "metadata": {
              "pdfPage": 3,
            },
            "path": "/work/page-003.png",
          },
        ],
        "timeoutMs": 300000,
      }
    `)
  })

  it('uses the same bounded page plan for JPEG and rejects missing trusted page metadata', () => {
    const jpeg = pdfAdapter.plan(input, { inputPath: '/input/pages.pdf', targetFormat: 'jpeg' }, lease, '/work')
    expect(jpeg.outputPaths).toEqual(['/work/page-001.jpeg', '/work/page-002.jpeg', '/work/page-003.jpeg'])
    expect(() => pdfAdapter.plan({ ...input, pageCount: undefined }, {
      inputPath: '/input/pages.pdf', targetFormat: 'png',
    }, lease, '/work')).toThrowError(expect.objectContaining({ code: 'CONVERSION_INPUT_INVALID' }))
  })
})
