import { defineWorkflow } from '@autoforge/workflow-sdk'

interface Input {
  keyword: string
}

interface Output {
  success: true
  keyword: string
  url: string
}

export default defineWorkflow<Input, Output>({
  async run(ctx, input) {
    if (!input || typeof input.keyword !== 'string' || input.keyword.trim().length === 0) {
      throw new Error('keyword must be a non-empty string')
    }
    const keyword = input.keyword.trim()
    ctx.logger.info(`正在使用百度搜索：${keyword}`)
    await ctx.browser.open('https://www.baidu.com')
    await ctx.browser.fill('role=textbox', keyword)
    await ctx.browser.click('role=button[name="百度一下"]')
    const url = await ctx.browser.url()
    return { success: true, keyword, url }
  },
})
