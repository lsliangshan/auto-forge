# AutoForge

自动工坊：Build Once, Automate Everywhere.

AutoForge 是一个桌面端网页自动化工具平台。当前版本使用 Electron +
Vite + Vue 3 + TypeScript + Tailwind CSS 搭建，重点先落地安全边界、
插件 Manifest、受控 SDK 契约和工作流状态机。

## 架构

```txt
第三方自动化工具
  -> 受限 Playwright-like SDK
  -> 权限校验 / 状态机 / 日志
  -> Electron main process
  -> CDP / DOM 注入 / webContents
  -> 目标网页
```

第三方开发者写的是自动化脚本，不是 Electron 插件。插件不能直接访问
Node.js、Electron、文件系统、任意 IPC 或完整 CDP session。

## 目录

```txt
src/main              Electron 主进程、IPC、插件注册、工作流运行器
src/preload           受控 preload bridge
src/renderer/src      Vue 3 工作台界面
src/shared            Renderer / preload / main 共享类型与 SDK 契约
packages/automation-sdk 对外 Automation SDK 包
resources/plugins     示例插件 Manifest 与工具代码
docs                  架构说明
```

第三方工具接入文档见 [docs/automation-sdk.md](docs/automation-sdk.md)。

## 开发

```bash
npm install
npm run dev
```

## 验证

```bash
npm run typecheck
npm run build:sdk
npm run build
```

## 打包

```bash
npm run dist
```
