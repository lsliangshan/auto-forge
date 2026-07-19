// src/index.ts
import { defineWorkflow } from "@autoforge/workflow-sdk";
var index_default = defineWorkflow({
  async run(ctx, input) {
    if (!input || typeof input.keyword !== "string" || input.keyword.trim().length === 0) {
      throw new Error("keyword must be a non-empty string");
    }
    const keyword = input.keyword.trim();
    ctx.logger.info(`\u6B63\u5728\u4F7F\u7528\u767E\u5EA6\u641C\u7D22\uFF1A${keyword}`);
    await ctx.browser.open("https://www.baidu.com");
    await ctx.browser.fill("role=textbox", keyword);
    await ctx.browser.click('role=button[name="\u767E\u5EA6\u4E00\u4E0B"]');
    const url = await ctx.browser.url();
    return { success: true, keyword, url };
  }
});
export {
  index_default as default
};
