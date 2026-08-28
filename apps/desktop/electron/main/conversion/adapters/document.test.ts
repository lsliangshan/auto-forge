import { describe, expect, it } from 'vitest'
import type { ConverterPackLease } from '../converter-pack-types.js'
import type { ProbedConversionInput } from '../conversion-catalog.js'
import { documentAdapter } from './document.js'

const root = '/packs/document'
const executable = `${root}/program/soffice`
const lease: ConverterPackLease = Object.freeze({
  name: 'document', version: '1.0.0', platform: 'darwin', arch: 'arm64', root,
  executables: Object.freeze({ 'program/soffice': executable }), release() {},
})

function input(format: ProbedConversionInput['format']): ProbedConversionInput {
  return { format, mimeType: 'application/octet-stream', kind: 'file', byteSize: 100, frameCount: 1 }
}

describe('document conversion adapter', () => {
  it('uses an isolated LibreOffice profile and keeps the hostile-looking input positional', () => {
    const plan = documentAdapter.plan(input('docx'), {
      inputPath: '/input/- report "quoted"\nline.docx', targetFormat: 'pdf',
    }, lease, '/work')
    expect(plan).toMatchInlineSnapshot(`
      {
        "args": [
          "-env:UserInstallation=file:///work/libreoffice-profile",
          "--headless",
          "--invisible",
          "--nologo",
          "--nodefault",
          "--nolockcheck",
          "--norestore",
          "--convert-to",
          "pdf",
          "--outdir",
          "/work",
          "--",
          "/input/- report "quoted"
      line.docx",
        ],
        "cwd": "/work",
        "env": {
          "LANG": "C.UTF-8",
          "LC_ALL": "C.UTF-8",
          "PATH": "/packs/document/program",
          "TEMP": "/work",
          "TMP": "/work",
          "TMPDIR": "/work",
        },
        "executable": "/packs/document/program/soffice",
        "outputPaths": [
          "/work/- report "quoted"
      line.pdf",
        ],
        "outputs": [
          {
            "format": "pdf",
            "path": "/work/- report "quoted"
      line.pdf",
          },
        ],
        "timeoutMs": 300000,
      }
    `)
    expect(plan.env).not.toHaveProperty('HOME')
  })

  it('plans the only approved non-PDF document route from CSV to XLSX', () => {
    const plan = documentAdapter.plan(input('csv'), { inputPath: '/input/data.csv', targetFormat: 'xlsx' }, lease, '/work')
    expect(plan.args).toContain('xlsx')
    expect(plan.outputs).toEqual([{ path: '/work/data.xlsx', format: 'xlsx' }])
  })

  it('fails closed for routes outside the trusted catalog document matrix', () => {
    expect(documentAdapter.supports(input('docx'), 'xlsx')).toBe(false)
    expect(() => documentAdapter.plan(input('docx'), {
      inputPath: '/input/report.docx', targetFormat: 'xlsx',
    }, lease, '/work')).toThrowError(expect.objectContaining({ code: 'CONVERSION_FORMAT_UNSUPPORTED' }))
  })
})
