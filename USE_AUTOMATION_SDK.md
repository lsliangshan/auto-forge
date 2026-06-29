第三方用户从零开发 AutoForge 自动化工具，推荐按这个流程走。

**1. 创建工具项目**

```bash
mkdir my-auto-forge-tool
cd my-auto-forge-tool
npm init -y
npm install @auto-forge/automation-sdk
npm install -D typescript
```

如果是在当前仓库内调试本地 SDK，可以先用：

```json
{
  "dependencies": {
    "@auto-forge/automation-sdk": "file:/Users/liangshan/Downloads/workspace/workspace_qisi/auto-forge/packages/automation-sdk"
  }
}
```

**2. 建议目录结构**

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

**3. 配置 TypeScript**

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

**4. 写 Manifest**

`manifest.json`：

```json
{
  "name": "example-login-tool",
  "displayName": "示例登录工具",
  "version": "1.0.0",
  "description": "打开登录页，填写账号密码并等待进入后台",
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

原则：权限要最小化，`matches` 要限制到明确域名，不要一上来申请 `<all_urls>`。

**5. 写工具入口**

`src/index.ts`：

```ts
import { defineTool } from "@auto-forge/automation-sdk";

type LoginInput = {
  username: string;
};

export default defineTool<LoginInput, "password">({
  name: "example-login-tool",
  version: "1.0.0",

  async run(ctx) {
    const { page, input, secrets, progress, log, signal } = ctx;

    progress.message("打开登录页");
    progress.set(10);
    await page.goto("https://example.com/login");

    if (signal.aborted) return;

    progress.message("填写表单");
    progress.set(40);
    await page.fill("#username", input.username);
    await page.fill("#password", await secrets.get("password"));

    progress.message("提交登录");
    progress.set(70);
    await page.click('button[type="submit"]');
    await page.waitForSelector(".dashboard", {
      state: "visible",
      timeout: 15000,
    });

    const title = await page.textContent(".dashboard-title");
    log.info("登录完成", { title });

    progress.set(100);
  },
});
```

**6. 本地校验 Manifest**

可以加一个 `scripts/validate-manifest.mjs`：

```js
import { readFile } from "node:fs/promises";
import { validateManifest } from "@auto-forge/automation-sdk";

const manifest = JSON.parse(await readFile("./manifest.json", "utf8"));
const result = validateManifest(manifest);

if (!result.ok) {
  console.error(result.errors);
  process.exit(1);
}

console.log("Manifest ok");
```

然后运行：

```bash
node scripts/validate-manifest.mjs
npm run build
```

**7. 打包交付**

最终交付给 AutoForge 的最小内容：

```txt
manifest.json
dist/index.js
```

推荐 zip：

```txt
example-login-tool-1.0.0.zip
  manifest.json
  dist/
    index.js
    index.d.ts
  README.md
```

**8. 开发注意事项**

不要在工具里直接访问 `fs`、`electron`、`ipcRenderer`、`BrowserWindow`、`webContents`、cookie、localStorage 或完整 CDP。所有能力都应该通过 `ctx.page`、`ctx.network`、`ctx.files`、`ctx.secrets` 走平台网关。

长流程工具要经常检查：

```ts
if (ctx.signal.aborted) return;
```

日志和进度要写清楚，方便用户知道工具卡在哪一步：

```ts
ctx.progress.message("正在读取订单列表");
ctx.progress.set(50);
ctx.log.info("读取完成", { count: 20 });
```

当前仓库里的完整文档在：[docs/automation-sdk.md](/Users/liangshan/Downloads/workspace/workspace_qisi/auto-forge/docs/automation-sdk.md)。
