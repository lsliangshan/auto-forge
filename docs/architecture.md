# AutoForge 架构

## 进程边界

```text
Vue Renderer
  -> window.autoForge typed API
  -> sandboxed preload allowlist
  -> validated ipcMain handlers
  -> catalog / installations / settings / templates services
  -> SQLite and filesystem
```

Renderer 不导入 Electron、Node.js 或文件系统模块。主窗口启用 `contextIsolation`、`sandbox` 和 `webSecurity`，关闭 `nodeIntegration`。Preload 只暴露具名方法，不暴露原始 `ipcRenderer`。

## 模块职责

- `catalog` 读取只读本地工具目录，并提供工具查找。
- `installations` 校验工具 ID，将模拟安装状态写入 SQLite。
- `settings` 管理主题与最近下载目录。
- `templates` 将随应用发布的完整模板复制到用户选择的目录，拒绝覆盖同名目录。
- `database` 执行顺序迁移并提供小型仓储接口。
- `ipc` 校验跨进程输入，并将未知异常转换为安全错误。

## 数据模型

SQLite 包含 `schema_migrations`、`app_settings` 与 `installed_tools`。工具目录位于 `resources/catalog/tools.json`，不写入数据库；后续接远程目录时可替换 `CatalogService` 而不改页面。
