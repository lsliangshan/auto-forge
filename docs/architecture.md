# AutoForge 架构

```text
Vue Renderer
  → 主窗口 preload 具名 API
  → ipcMain 输入校验
  → RegistryClient / WorkflowProjectService / InstallationService
  → SQLite、文件系统、HTTPS 中心服务

工作流模块
  → 隐藏 sandbox runner
  → 固定 SDK RPC + executionId/sender 绑定
  → 主进程能力检查
  → 可见 target WebContents 的窄化 DOM 操作
```

Renderer 不导入 Electron、Node.js 或文件系统模块。主窗口与 runner 都启用 `contextIsolation`、`sandbox` 和 `webSecurity`，关闭 `nodeIntegration`。两个 preload 都不暴露原始 `ipcRenderer`。

中心服务使用 Fastify、Prisma/PostgreSQL 与 S3 兼容存储。桌面端的 access token 只在主进程内存中，refresh token 经 Electron `safeStorage` 加密后写入 SQLite。

SQLite 迁移保留旧 `installed_tools`，但运行路径只使用 `workflow_projects`、`installed_workflows`、`encrypted_sessions`、`app_settings`。详细安全与状态流见 [工作流生命周期](workflow-lifecycle.md)。
