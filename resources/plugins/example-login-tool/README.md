# Example Login Tool

这是一个第三方自动化工具的最小示例。

```bash
cd ../../../
npm run build:sdk
cd resources/plugins/example-login-tool
npm install
npm run build
```

交付给 AutoForge 的文件：

```txt
manifest.json
dist/index.js
```

工具代码只依赖 `@auto-forge/automation-sdk` 的类型和 `defineTool`，不会直接访问
Electron、Node.js、文件系统或 CDP。
