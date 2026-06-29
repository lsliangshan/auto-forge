# AutoForge Automation SDK 接入指南

本文档面向第三方自动化工具开发者。目标是让工具作者用受限的
Playwright-like API 编写自动化脚本，并通过 Manifest 声明权限，再交给
AutoForge 桌面端运行。

## 设计边界

第三方开发者写的是“自动化工具”，不是 Electron 插件。

工具代码不能直接访问：

- `require('fs')`
- `require('electron')`
- `ipcRenderer`
- `BrowserWindow`
- `webContents`
- 完整 CDP session
- 用户本地文件系统
- 未声明的网络、页面、密钥能力

工具只能使用 `@auto-forge/automation-sdk` 暴露的类型与函数。真正的页面控制、
权限校验、日志、暂停、取消、沙箱隔离由 AutoForge 平台运行时负责。

## 安装 SDK

在第三方工具项目中安装 SDK：

```bash
npm install @auto-forge/automation-sdk
```

当前仓库内的本地示例使用 file 依赖：

```json
{
  "dependencies": {
    "@auto-forge/automation-sdk": "file:../../../packages/automation-sdk"
  }
}
```

## 推荐目录结构

```txt
my-auto-forge-tool/
  manifest.json
  package.json
  tsconfig.json
  src/
    index.ts
  dist/
    index.js
```

`manifest.json` 是工具元数据和权限声明。`dist/index.js` 是编译后的工具入口，
路径必须与 Manifest 的 `entry` 保持一致。

## Manifest

```json
{
  "name": "example-login-tool",
  "displayName": "示例登录工具",
  "version": "1.0.0",
  "description": "登录示例站点并等待进入后台",
  "entry": "dist/index.js",
  "matches": ["https://example.com/*"],
  "permissions": ["page:navigate", "dom:read", "dom:write", "secrets:read"],
  "inputs": {
    "username": {
      "type": "string",
      "required": true,
      "label": "账号"
    },
    "password": {
      "type": "secret",
      "required": true,
      "label": "密码"
    }
  }
}
```

字段说明：

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `name` | 是 | 工具唯一名称，建议使用小写字母、数字和连字符 |
| `displayName` | 否 | 展示给用户的名称 |
| `version` | 是 | 语义化版本号 |
| `description` | 否 | 工具用途说明 |
| `entry` | 是 | 编译后的 JS 入口文件 |
| `matches` | 是 | 允许运行的 URL 范围 |
| `permissions` | 是 | 工具申请的平台能力 |
| `inputs` | 否 | 用户输入表单定义 |

## 权限

| 权限 | 允许能力 |
| --- | --- |
| `page:navigate` | 页面跳转、刷新、前进、后退 |
| `dom:read` | 读取文本、HTML、属性、元素数量和存在性 |
| `dom:write` | 点击、输入、选择、勾选、聚焦、滚动 |
| `network:read` | 等待和读取受控响应信息 |
| `network:request` | 通过平台网关发起受控请求 |
| `storage:tool` | 使用工具自己的隔离存储 |
| `files:download` | 接收平台批准的下载文件 |
| `files:upload` | 上传用户选择或平台批准的文件 |
| `secrets:read` | 读取用户授权的密钥字段 |

第一版工具应尽量申请最小权限和明确域名，不建议使用 `<all_urls>`。

## 编写工具入口

```ts
import { defineTool } from '@auto-forge/automation-sdk'

type LoginInput = {
  username: string
}

export default defineTool<LoginInput, 'password'>({
  name: 'example-login-tool',
  version: '1.0.0',
  async run(ctx) {
    const { page, input, secrets, progress, log, signal } = ctx

    progress.message('打开登录页')
    progress.set(10)
    await page.goto('https://example.com/login')

    if (signal.aborted) {
      return
    }

    progress.message('填写表单')
    await page.fill('#username', input.username)
    await page.fill('#password', await secrets.get('password'))

    progress.message('提交登录')
    await page.click('button[type="submit"]')
    await page.waitForSelector('.dashboard', { state: 'visible', timeout: 15000 })

    const title = await page.textContent('.dashboard-title')
    log.info('登录完成', { title })
    progress.set(100)
  }
})
```

`defineTool<TInput, TSecretName>()` 的两个泛型用于提升类型提示：

- `TInput`：普通输入字段，例如用户名、查询关键词、目标 URL。
- `TSecretName`：密钥名称联合类型，例如 `'password' | 'apiKey'`。

## 页面 API

### 页面控制

```ts
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 10000 })
await page.reload()
await page.back()
await page.forward()
const url = await page.url()
const title = await page.title()
await page.waitForLoadState('networkidle')
await page.waitForTimeout(500)
```

### 元素操作

```ts
await page.click('#submit')
await page.dblclick('.row')
await page.hover('.menu')
await page.fill('#username', 'alice')
await page.type('#search', 'keyword', { delay: 30 })
await page.press('#search', 'Enter')
await page.select('select[name=role]', 'admin')
await page.check('#agree')
await page.uncheck('#subscribe')
await page.focus('#comment')
await page.scrollIntoView('.footer')
```

### 等待

```ts
await page.waitForSelector('.result', { state: 'visible', timeout: 10000 })
await page.waitForText('保存成功')
await page.waitForUrl('/dashboard')
await page.waitForFunction('() => window.__READY__ === true')
```

### 数据提取

```ts
const name = await page.textContent('.name')
const html = await page.innerHTML('.content')
const href = await page.getAttribute('a.detail', 'href')
const exists = await page.exists('.empty')
const count = await page.count('.list-item')
```

结构化提取：

```ts
const data = await page.extract<{
  title: string
  items: Array<{ name: string; url: string }>
}>({
  title: '.product-title',
  items: {
    selector: '.list-item',
    many: true,
    fields: {
      name: '.name',
      url: { selector: 'a', attr: 'href' }
    }
  }
})
```

### evaluate

`evaluate` 是高风险能力。只应在受控、必要、可审计的场景使用：

```ts
const title = await page.evaluate<string>('() => document.title')
```

不要尝试读取 cookie、localStorage、token 或把页面数据发送到未授权域名。平台运行时会根据权限和安全策略拒绝高风险脚本。

## 网络 API

```ts
const response = await ctx.network.waitForResponse('/api/orders')

const result = await ctx.network.request({
  url: 'https://api.example.com/orders',
  method: 'POST',
  headers: {
    'content-type': 'application/json'
  },
  body: {
    keyword: 'demo'
  }
})
```

网络 API 需要 `network:read` 或 `network:request` 权限。平台可能会限制目标域名、
请求头、响应体大小和敏感字段。

## 文件 API

```ts
const file = await ctx.files.download({ filename: 'report.csv' })
await ctx.files.upload('#file', {
  name: 'payload.json',
  mimeType: 'application/json',
  content: JSON.stringify({ ok: true })
})
await ctx.files.saveJson('result.json', { status: 'ok' })
```

文件 API 由平台授权，不等同于本地文件系统权限。

## 日志、进度、取消

```ts
ctx.progress.message('正在抓取列表')
ctx.progress.set(40)

ctx.log.info('读取到订单', { count: 12 })
ctx.log.warn('页面响应较慢')
ctx.log.error('提交失败', { reason: 'timeout' })

if (ctx.signal.aborted) {
  return
}
```

长流程工具应在关键步骤之间检查 `ctx.signal.aborted`，这样用户点击停止或平台取消任务时可以及时退出。

## 编译配置

`package.json`：

```json
{
  "name": "my-auto-forge-tool",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "build": "tsc -p tsconfig.json"
  },
  "dependencies": {
    "@auto-forge/automation-sdk": "^0.1.0"
  },
  "devDependencies": {
    "typescript": "^5.7.2"
  }
}
```

`tsconfig.json`：

```json
{
  "compilerOptions": {
    "declaration": true,
    "lib": ["ES2022", "DOM"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "target": "ES2022",
    "skipLibCheck": true
  },
  "include": ["src/**/*.ts"]
}
```

## 本地校验 Manifest

SDK 提供轻量校验函数，适合在工具项目构建脚本或单元测试中使用：

```js
import { readFile } from 'node:fs/promises'
import { assertManifest, validateManifest } from '@auto-forge/automation-sdk'

const manifest = JSON.parse(await readFile(new URL('./manifest.json', import.meta.url), 'utf8'))

const result = validateManifest(manifest)
if (!result.ok) {
  console.error(result.errors)
  process.exit(1)
}

assertManifest(manifest)
```

AutoForge 桌面端仍会在安装和运行前再次校验 Manifest。工具侧校验只用于提前发现错误。

## 打包交付

构建后至少包含：

```txt
manifest.json
dist/index.js
```

推荐 zip 结构：

```txt
example-login-tool-1.0.0.zip
  manifest.json
  dist/
    index.js
    index.d.ts
  README.md
```

平台后续接入插件市场、签名和审核时，会基于 Manifest、入口文件和包内容做完整校验。

## 常见问题

### 可以直接用 Playwright 或 Puppeteer 吗？

不建议。AutoForge 的设计是平台内部使用 CDP、DOM 注入或 webContents 能力，对外只提供受限 SDK。第三方工具拿到完整 Playwright/Puppeteer 能力后很难做权限治理。

### 可以访问页面 cookie 吗？

默认不可以。cookie、token、localStorage 属于敏感数据。未来如开放，也必须通过明确权限、用户授权和审计日志。

### 工具里可以请求任意接口吗？

不可以。网络请求必须经过 `ctx.network`，并受 Manifest 权限、域名、请求头和平台策略限制。

### 密码应该放在哪里？

不要放在 Manifest 或源码里。使用 `inputs` 的 `secret` 类型声明密钥字段，并在运行时通过 `ctx.secrets.get(name)` 获取用户授权后的值。
