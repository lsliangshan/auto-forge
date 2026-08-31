import { describe, expect, expectTypeOf, it } from 'vitest'
import type {
  ConfiguredWorkflowInput,
  ConversionErrorCode,
  ConverterCapability,
  ConverterSubmitInput,
  WorkflowContext,
} from './index.js'
import { defineWorkflow } from './define-workflow.js'

describe('defineWorkflow', () => {
  it('exposes a generic configured workflow input envelope', () => {
    expectTypeOf<ConfiguredWorkflowInput<'permit', { applicant: string }>>().toEqualTypeOf<{
      key: 'permit'
      input: { applicant: string }
    }>()
  })

  it('returns a frozen workflow definition', () => {
    const definition = defineWorkflow({
      async run(_context, input: { value: string }) {
        return { value: input.value }
      },
    })

    expect(Object.isFrozen(definition)).toBe(true)
  })

  it('exposes an exact metadata-only converter submit contract', () => {
    expectTypeOf<ConverterSubmitInput>().toEqualTypeOf<{
      attachmentIndex: number
      targetFormat: 'png' | 'jpeg' | 'webp' | 'avif' | 'tiff' | 'bmp' | 'gif' | 'ico' | 'icns'
        | 'pdf' | 'xlsx' | 'mp3' | 'wav' | 'm4a' | 'aac' | 'flac' | 'ogg' | 'opus'
        | 'mp4' | 'webm' | 'mov'
      preset?: 'default' | 'favicon' | 'app-icon'
      background?: boolean
    }>()
    expectTypeOf<Awaited<ReturnType<ConverterCapability['submit']>>>().toEqualTypeOf<
      | {
          accepted: true
          status: 'queued' | 'completed'
          outputs: Array<{
            name: string
            format: ConverterSubmitInput['targetFormat']
            byteSize: number
          }>
        }
      | {
          accepted: false
          status: 'failed'
          error: { code: ConversionErrorCode; message: string }
        }
    >()

    defineWorkflow({
      async run(context: WorkflowContext) {
        await context.converter.submit({ attachmentIndex: 0, targetFormat: 'png' })
        await context.converter.submit({
          attachmentIndex: 1,
          targetFormat: 'ico',
          preset: 'favicon',
          background: true,
        })
        // @ts-expect-error Paths and source identifiers never enter the public SDK request.
        await context.converter.submit({ attachmentIndex: 0, targetFormat: 'png', sourceId: 'asset_1' })
        return null
      },
    })
  })

  it('preserves an optional typed workflow config reader', () => {
    const definition = defineWorkflow({
      async run() {
        return { opened: true }
      },
      getConfig() {
        return {
          'government-service': {
            description: '政务服务',
            cities: ['北京'] as const,
            url: 'https://service.example.gov.cn',
          },
        } as const
      },
    })

    expect(definition.getConfig?.()).toEqual({
      'government-service': {
        description: '政务服务',
        cities: ['北京'],
        url: 'https://service.example.gov.cn',
      },
    })
    expectTypeOf(definition.getConfig).toEqualTypeOf<
      | (() => {
        readonly 'government-service': {
          readonly description: '政务服务'
          readonly cities: readonly ['北京']
          readonly url: 'https://service.example.gov.cn'
        }
      })
      | undefined
    >()
  })
})
