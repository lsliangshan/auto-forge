# AutoForge Desktop

AutoForge 是一个基于 Electron 的桌面自动化工具发现应用。首版严格提供“发现”和“设置”两个菜单：用户可以搜索、筛选、查看和模拟安装工具，并将完整的第三方工具开发模板下载到本地。

## 技术栈

- Electron + electron-vite
- Vue 3 + TypeScript + Vue Router + Pinia
- Tailwind CSS + Element Plus
- better-sqlite3
- Vitest + Vue Test Utils + Playwright Electron
- electron-builder

## 本地开发

```bash
npm install
npm run dev
```

仅调试渲染端界面：

```bash
npm run dev:renderer
```

## 验证

```bash
npm run test:unit
npm run typecheck
npm run build
npm run verify:template
npm run test:e2e
npm run dist:dir
```

`better-sqlite3` 同时服务于 Node 单元测试和 Electron 运行时。`test:unit` 会重建 Node ABI；`dev`、`test:e2e` 与打包流程会重建 Electron ABI。

## 目录

```text
src/main/       Electron 主进程、SQLite 和文件操作
src/preload/    类型化 IPC 白名单
src/renderer/   Vue 3 界面
src/shared/     跨进程共享契约
resources/      本地工具目录与完整工具模板
tests/e2e/      Electron 关键路径测试
docs/           设计、架构和开发文档
```

详细说明见 [架构](docs/architecture.md)、[开发指南](docs/development.md) 和 [工具模板](docs/tool-template.md)。
