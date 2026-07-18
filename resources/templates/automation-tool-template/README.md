# AutoForge 自动化工具模板

1. 修改 `manifest.json` 中的工具信息与权限。
2. 在 `src/index.ts` 实现工具入口。
3. 运行 `npm install && npm run build`。
4. 发布前确认 `dist/index.js` 与 `dist/index.d.ts` 已生成。

模板不直接访问 Electron、Node.js、文件系统或原始浏览器调试协议。
