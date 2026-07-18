# 自动化工具模板

设置页中的“下载模板”会创建 `auto-forge-tool-template` 目录。模板包含：

```text
auto-forge-tool-template/
├── manifest.json
├── package.json
├── tsconfig.json
├── README.md
├── src/index.ts
└── dist/
    ├── index.js
    └── index.d.ts
```

## 从零开始

1. 修改 `manifest.json` 的 `id`、`name`、`version` 和权限。
2. 在 `src/index.ts` 中实现入口函数。
3. 运行 `npm install && npm run build`。
4. 运行 `npm run verify:template` 或人工确认源码与编译产物同时存在。
5. 发布时打包完整顶层目录，不要只打包 `dist`。

工具模板默认不具备 Electron、Node.js、任意文件系统、完整 Cookie 或原始 CDP 权限。权限应按最小能力声明，并在发布说明中解释用途。
