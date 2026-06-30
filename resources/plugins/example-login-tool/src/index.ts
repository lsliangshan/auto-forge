import { defineTool } from "@auto-forge/automation-sdk";

export default defineTool({
  name: "example-login-tool",
  version: "1.0.0",
  async run(ctx) {
    ctx.log.info(">>>>> ctx.input: ", ctx.input);
    console.log(">>>>> ctx.input: ", ctx.input);
    ctx.progress.message("打开目标网页");
    await ctx.page.goto(String(ctx.input.url ?? "https://example.com"));

    ctx.progress.message("填写登录表单");
    await ctx.page.fill("#username", String(ctx.input.username ?? ""));
    await ctx.page.fill("#password", await ctx.secrets.get("password"));

    ctx.progress.message("提交表单");
    await ctx.page.click('button[type="submit"]');
    await ctx.page.waitForSelector(".dashboard");

    ctx.log.info("示例工具运行完成");
  },
});
