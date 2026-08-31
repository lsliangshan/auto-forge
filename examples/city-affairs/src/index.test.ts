import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import type { WorkflowContext } from '@autoforge/workflow-sdk'
import manifest from '../manifest.json' with { type: 'json' }
import workflowManifest from '../workflow.json' with { type: 'json' }
import workflow, { BUSINESS_URLS } from './index.js'

const expectedBusinessUrls = {
  'beijing-work-residence-permit': {
    description: '查询、办理、续签、申请、变更北京工作居住证',
    cities: ['北京'],
    url: 'https://fw.bjrcgz.gov.cn/person-platform/',
  },
  'retirement-age-calculator': {
    description: '根据出生日期计算退休年龄',
    cities: [],
    url: 'https://fuwu.rsj.beijing.gov.cn/zhrs/zgtx/retire-calculator',
  },
} as const

function browserContext(openedUrls: string[]): WorkflowContext {
  return {
    browser: {
      async open(url) {
        openedUrls.push(url)
      },
      async fill() {},
      async click() {},
      async url() {
        return openedUrls.at(-1) ?? ''
      },
      async close() {},
    },
    converter: {
      async submit() {
        throw new Error('converter is not available in this workflow')
      },
    },
    logger: {
      debug() {},
      info() {},
      warn() {},
      error() {},
    },
  }
}

describe('城事通 workflow', () => {
  it('keeps manifests, business keys, browser origins, and bundle hash aligned', async () => {
    expect(manifest).toEqual(workflowManifest)
    expect(manifest.inputSchema.properties.key.enum).toEqual(Object.keys(BUSINESS_URLS))
    expect(manifest.outputSchema.properties.business.enum).toEqual(Object.keys(BUSINESS_URLS))
    expect(manifest.permissions).toEqual([{
      capability: 'browser.open',
      scope: {
        origins: [...new Set(Object.values(BUSINESS_URLS).map(({ url }) => new URL(url).origin))],
      },
    }])
    const code = await readFile(new URL('../dist/index.js', import.meta.url))
    expect(createHash('sha256').update(code).digest('hex')).toBe(manifest.codeSha256)
  })

  it('returns the maintained business URL mapping from getConfig', () => {
    expect(BUSINESS_URLS).toEqual(expectedBusinessUrls)
    expect(workflow.getConfig?.()).toEqual(expectedBusinessUrls)
  })

  it.each([
    ['beijing-work-residence-permit', 'https://fw.bjrcgz.gov.cn/person-platform/'],
    ['retirement-age-calculator', 'https://fuwu.rsj.beijing.gov.cn/zhrs/zgtx/retire-calculator'],
  ] as const)('opens the mapped URL for %s', async (business, expectedUrl) => {
    const openedUrls: string[] = []

    await expect(workflow.run(browserContext(openedUrls), { key: business, input: {} })).resolves.toEqual({
      success: true,
      business,
      url: expectedUrl,
    })
    expect(openedUrls).toEqual([expectedUrl])
  })

  it('rejects an unknown business before opening a page', async () => {
    const openedUrls: string[] = []

    await expect(workflow.run(browserContext(openedUrls), {
      key: 'unknown-business', input: {},
    } as never)).rejects.toThrow('business is not supported')
    expect(openedUrls).toEqual([])
  })
})
