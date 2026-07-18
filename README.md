# AutoForge Desktop

AutoForge 是一个基于 Electron 的桌面自动化工具发现应用。首版严格提供“发现”和“设置”两个菜单：用户可以搜索、筛选、查看和模拟安装工具，并将完整的第三方工具开发模板下载到本地。

## 技术栈

- Electron + electron-vite
- Vue 3 + TypeScript + Vue Router + Pinia
- Tailwind CSS + Element Plus
- Node.js 内置 SQLite (`node:sqlite`)
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

本地数据使用 Electron 43 / Node 24 内置的 `node:sqlite`，无需下载或重编译原生 ABI 依赖。

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
