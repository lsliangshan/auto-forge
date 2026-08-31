import { defineWorkflow, type ConfiguredWorkflowInput } from '@autoforge/workflow-sdk'

export const BUSINESS_URLS = {
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

type Business = keyof typeof BUSINESS_URLS

type Input = ConfiguredWorkflowInput<Business, Record<string, never>>

interface Output {
  success: true
  business: Business
  url: string
}

function isBusiness(value: unknown): value is Business {
  return typeof value === 'string' && Object.hasOwn(BUSINESS_URLS, value)
}

export default defineWorkflow<Input, Output, typeof BUSINESS_URLS>({
  async run(ctx, input) {
    if (!input || !isBusiness(input.key) || !input.input
      || typeof input.input !== 'object' || Object.keys(input.input).length > 0) {
      throw new Error('business is not supported')
    }

    const url = BUSINESS_URLS[input.key].url
    ctx.logger.info(`正在打开政务业务页面：${input.key}`)
    await ctx.browser.open(url)
    return { success: true, business: input.key, url }
  },
  getConfig() {
    return BUSINESS_URLS
  },
})
