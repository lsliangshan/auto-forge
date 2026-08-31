// src/index.ts
import { defineWorkflow } from "@autoforge/workflow-sdk";
var BUSINESS_URLS = {
  "beijing-work-residence-permit": {
    description: "\u67E5\u8BE2\u3001\u529E\u7406\u3001\u7EED\u7B7E\u3001\u7533\u8BF7\u3001\u53D8\u66F4\u5317\u4EAC\u5DE5\u4F5C\u5C45\u4F4F\u8BC1",
    cities: ["\u5317\u4EAC"],
    url: "https://fw.bjrcgz.gov.cn/person-platform/"
  },
  "retirement-age-calculator": {
    description: "\u6839\u636E\u51FA\u751F\u65E5\u671F\u8BA1\u7B97\u9000\u4F11\u5E74\u9F84",
    cities: [],
    url: "https://fuwu.rsj.beijing.gov.cn/zhrs/zgtx/retire-calculator"
  }
};
function isBusiness(value) {
  return typeof value === "string" && Object.hasOwn(BUSINESS_URLS, value);
}
var index_default = defineWorkflow({
  async run(ctx, input) {
    if (!input || !isBusiness(input.key) || !input.input || typeof input.input !== "object" || Object.keys(input.input).length > 0) {
      throw new Error("business is not supported");
    }
    const url = BUSINESS_URLS[input.key].url;
    ctx.logger.info(`\u6B63\u5728\u6253\u5F00\u653F\u52A1\u4E1A\u52A1\u9875\u9762\uFF1A${input.key}`);
    await ctx.browser.open(url);
    return { success: true, business: input.key, url };
  },
  getConfig() {
    return BUSINESS_URLS;
  }
});
export {
  BUSINESS_URLS,
  index_default as default
};
