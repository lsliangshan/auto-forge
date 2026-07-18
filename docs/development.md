# 开发指南

## 环境要求

- Node.js 22.12 或更高版本
- npm 10 或更高版本
- macOS、Windows 或 Linux 桌面环境

## 常用命令

`npm run dev` 启动完整 Electron 应用；它会先将原生 SQLite 模块重建为 Electron ABI。`npm run dev:renderer` 只启动浏览器可访问的渲染端，并使用内置演示适配器。

`npm run test:unit` 会将 SQLite 模块重建为当前 Node ABI，再运行领域、数据库和 Vue 组件测试。`npm run test:e2e` 会构建应用、重建 Electron ABI，并启动真实 Electron 窗口验证主路径。

## 新增 IPC

1. 在 `src/shared/contracts.ts` 定义可序列化输入与输出。
2. 在 `src/shared/ipc.ts` 注册唯一通道名。
3. 在 `src/main/ipc/register-ipc.ts` 校验输入并调用领域服务。
4. 在 `src/preload/index.ts` 暴露具名方法。
5. 更新 `AutoForgeApi` 和相关测试。

不要向 Renderer 暴露 `ipcRenderer`、文件路径拼接、Node.js API 或任意通道调用能力。
