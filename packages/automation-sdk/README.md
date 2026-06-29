# AutoForge Automation SDK

This package contains the public TypeScript contract for AutoForge automation
tools.

```ts
import { defineTool } from '@auto-forge/automation-sdk'

export default defineTool({
  async run(ctx) {
    await ctx.page.goto('https://example.com')
    await ctx.page.click('#login')
  }
})
```

The SDK is intentionally small and does not expose Electron, Node.js,
Playwright, Puppeteer, or raw CDP APIs. AutoForge provides the runtime context
inside the desktop app and enforces manifest permissions before tool execution.
