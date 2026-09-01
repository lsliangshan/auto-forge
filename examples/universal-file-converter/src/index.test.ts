import Ajv from 'ajv'
import { describe, expect, it } from 'vitest'
import { CONVERSION_TARGET_FORMATS } from '@autoforge/shared'
import type { WorkflowContext } from '@autoforge/workflow-sdk'
import manifest from '../workflow.json' with { type: 'json' }
import workflow from './index.js'

const ajv = new Ajv({ allErrors: true, strict: false })
const validateInput = ajv.compile(manifest.inputSchema)

describe('万象转换 workflow', () => {
  const safeConversionErrors = [
    ['CONVERSION_FORMAT_UNSUPPORTED', 'The requested output format is not supported.'],
    ['CONVERSION_COMPONENT_UNAVAILABLE', 'The required conversion component is unavailable.'],
    ['CONVERSION_INPUT_INVALID', 'The input file cannot be converted.'],
    ['CONVERSION_OUTPUT_TOO_LARGE', 'The converted output is too large.'],
    ['CONVERSION_TIMEOUT', 'The conversion timed out.'],
    ['CONVERSION_CANCELLED', 'The conversion was cancelled.'],
    ['CONVERSION_INTERRUPTED', 'The conversion was interrupted.'],
  ] as const

  it.each([
    { files: [], targetFormat: 'png' },
    { files: [0, 0], targetFormat: 'png' },
    { files: [0, 1, 2, 3, 4, 5], targetFormat: 'png' },
    { files: [0], targetFormat: 'docx' },
    { files: [0], targetFormat: 'png', preset: 'unsafe' },
  ])('rejects invalid workflow input %#', (input) => {
    expect(validateInput(input)).toBe(false)
  })

  it('declares every approved target format and the developer file picker annotation', () => {
    expect(manifest.permissions).toEqual([{
      capability: 'file.convert',
      scope: { formats: CONVERSION_TARGET_FORMATS },
    }])
    expect(manifest.inputSchema).toMatchObject({
      properties: {
        files: {
          type: 'array',
          minItems: 1,
          maxItems: 5,
          uniqueItems: true,
          'x-autoforge-control': 'file-picker',
        },
      },
    })
  })

  it('submits each attachment in input order and retains every result after a rejection', async () => {
    const submissions: unknown[] = []
    const context = {
      converter: {
        submit: async (input: unknown) => {
          submissions.push(input)
          if ((input as { attachmentIndex: number }).attachmentIndex === 7) {
            return {
              accepted: false as const,
              status: 'failed' as const,
              error: { code: 'CONVERSION_INPUT_INVALID' as const, message: 'Invalid conversion input.' },
            }
          }
          return {
            accepted: true as const,
            status: 'queued' as const,
            outputs: [{ name: 'result.png', format: 'png' as const, byteSize: 42 }],
          }
        },
      },
    } as WorkflowContext

    const result = await workflow.run(context, {
      files: [3, 7, 1],
      targetFormat: 'png',
      preset: 'default',
      background: true,
    })

    expect(submissions).toEqual([
      { attachmentIndex: 3, targetFormat: 'png', preset: 'default', background: true },
      { attachmentIndex: 7, targetFormat: 'png', preset: 'default', background: true },
      { attachmentIndex: 1, targetFormat: 'png', preset: 'default', background: true },
    ])
    expect(result).toEqual({
      workflow: '万象转换',
      results: [
        { accepted: true, status: 'queued', outputs: [{ name: 'result.png', format: 'png', byteSize: 42 }] },
        {
          accepted: false,
          status: 'failed',
          error: { code: 'CONVERSION_INPUT_INVALID', message: 'Invalid conversion input.' },
        },
        { accepted: true, status: 'queued', outputs: [{ name: 'result.png', format: 'png', byteSize: 42 }] },
      ],
    })
  })

  it('does not start a later converter submission until the prior submission resolves', async () => {
    let firstStarted = false
    let secondStarted = false
    let releaseFirst!: () => void
    const firstSubmission = new Promise<void>((resolve) => { releaseFirst = resolve })
    const context = {
      converter: {
        submit: async ({ attachmentIndex }: { attachmentIndex: number }) => {
          if (attachmentIndex === 0) {
            firstStarted = true
            await firstSubmission
          } else {
            secondStarted = true
          }
          return {
            accepted: true as const,
            status: 'queued' as const,
            outputs: [],
          }
        },
      },
    } as WorkflowContext

    const running = workflow.run(context, { files: [0, 1], targetFormat: 'pdf' })
    await Promise.resolve()

    expect(firstStarted).toBe(true)
    expect(secondStarted).toBe(false)
    releaseFirst()
    await expect(running).resolves.toEqual({
      workflow: '万象转换',
      results: [
        { accepted: true, status: 'queued', outputs: [] },
        { accepted: true, status: 'queued', outputs: [] },
      ],
    })
  })

  it('converts one rejected converter submission into a stable result without skipping later files', async () => {
    const submissions: number[] = []
    const context = {
      converter: {
        submit: async ({ attachmentIndex }: { attachmentIndex: number }) => {
          submissions.push(attachmentIndex)
          if (attachmentIndex === 1) throw new Error('sensitive implementation detail')
          return {
            accepted: true as const,
            status: 'queued' as const,
            outputs: [],
          }
        },
      },
    } as WorkflowContext

    const result = await workflow.run(context, { files: [0, 1, 2], targetFormat: 'pdf' })

    expect(submissions).toEqual([0, 1, 2])
    expect(result.results).toEqual([
      { accepted: true, status: 'queued', outputs: [] },
      {
        accepted: false,
        status: 'failed',
        error: {
          code: 'CONVERSION_COMPONENT_UNAVAILABLE',
          message: 'The required conversion component is unavailable.',
        },
      },
      { accepted: true, status: 'queued', outputs: [] },
    ])
  })

  it.each(safeConversionErrors)('preserves the safe %s code without copying a rejected message', async (code, message) => {
    const submissions: number[] = []
    const context = {
      converter: {
        submit: async ({ attachmentIndex }: { attachmentIndex: number }) => {
          submissions.push(attachmentIndex)
          if (attachmentIndex === 1) throw { code, message: 'sensitive implementation detail', stack: 'sensitive stack', path: '/secret/path' }
          return { accepted: true as const, status: 'queued' as const, outputs: [] }
        },
      },
    } as WorkflowContext

    const result = await workflow.run(context, { files: [0, 1, 2], targetFormat: 'pdf' })

    expect(submissions).toEqual([0, 1, 2])
    expect(result.results).toEqual([
      { accepted: true, status: 'queued', outputs: [] },
      { accepted: false, status: 'failed', error: { code, message } },
      { accepted: true, status: 'queued', outputs: [] },
    ])
  })

  it.each([
    ['an Error', new Error('sensitive implementation detail')],
    ['a string', 'sensitive implementation detail'],
    ['null', null],
    ['a spoofed code', { code: 'CONVERSION_SECRET_LEAK', message: 'sensitive implementation detail' }],
    ['an inherited code', Object.create({ code: 'CONVERSION_TIMEOUT', message: 'sensitive implementation detail' })],
  ])('converts %s rejections to component-unavailable results without skipping later files', async (_name, rejection) => {
    const submissions: number[] = []
    const context = {
      converter: {
        submit: async ({ attachmentIndex }: { attachmentIndex: number }) => {
          submissions.push(attachmentIndex)
          if (attachmentIndex === 1) throw rejection
          return { accepted: true as const, status: 'queued' as const, outputs: [] }
        },
      },
    } as WorkflowContext

    const result = await workflow.run(context, { files: [0, 1, 2], targetFormat: 'pdf' })

    expect(submissions).toEqual([0, 1, 2])
    expect(result.results).toEqual([
      { accepted: true, status: 'queued', outputs: [] },
      {
        accepted: false,
        status: 'failed',
        error: {
          code: 'CONVERSION_COMPONENT_UNAVAILABLE',
          message: 'The required conversion component is unavailable.',
        },
      },
      { accepted: true, status: 'queued', outputs: [] },
    ])
  })

  it('does not give workflow code filesystem, process, or environment access', async () => {
    const source = await import('node:fs/promises').then(({ readFile }) =>
      readFile(new URL('./index.ts', import.meta.url), 'utf8'))

    expect(source).not.toMatch(/(?:from\s+|import\s+)['"](?:node:)?(?:fs(?:\/promises)?|path|child_process)['"]/u)
    expect(source).not.toMatch(/import\(\s*['"](?:node:)?(?:fs(?:\/promises)?|path|child_process)['"]\s*\)/u)
    expect(source).not.toMatch(/require\(\s*['"](?:node:)?(?:fs(?:\/promises)?|path|child_process)['"]\s*\)/u)
    expect(source).not.toMatch(/\bprocess\b/u)
  })
})
