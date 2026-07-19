# AutoForge

AutoForge 是面向网页自动化的工作流开发、审核、发布与运行平台。桌面端侧栏始终只有“发现 / 设置”；发现页内部提供工作流大厅、我的工作流和管理员审核管理。

## 能力

- 固定项目格式、本地 esbuild 构建、150ms 监听构建、SHA-256 与外部编辑器开发。
- 邮箱账号、轮换 refresh token、开发者提交、管理员源码查看/试运行/通过/驳回。
- 服务端重建、确定性 ZIP、RFC 8785 规范化、Ed25519 签名与不可变 Release。
- 客户端签名/包 Hash/代码 Hash 验证、安全解压、SQLite 原子版本指针与离线运行。
- 目标页和隐藏 runner 双 WebContents；runner 无 Node、无原始 IPC、无网络，仅能使用声明的能力式 SDK。

## 目录结构

```text
auto-forge/
├── packages/workflow-contracts/     Manifest、分页、错误码、规范化与签名契约
├── server/
│   ├── prisma/                      PostgreSQL schema 与迁移
│   └── src/                         Fastify API、认证、S3、构建、审核与发布
├── src/
│   ├── main/
│   │   ├── database/                SQLite 项目、安装指针和加密会话
│   │   ├── installations/           签名下载和原子安装
│   │   ├── registry/                中心服务客户端与 token 轮换
│   │   ├── runtime/                 隔离执行器和能力 RPC
│   │   └── workflows/               本地项目创建、构建和监听
│   ├── preload/                     应用 IPC 与 runner SDK 两个白名单桥
│   ├── renderer/                    Vue 工作流大厅、开发台、审核台和设置
│   └── shared/                      桌面端跨进程契约
├── resources/
│   ├── keys/                        内置 keyId → Ed25519 公钥信任表
│   └── runner/                      带 CSP 的隐藏 runner 页面
├── tests/e2e/                       Electron 冒烟与生命周期 E2E
└── docker-compose.yml               PostgreSQL、MinIO、中心服务
```

## 开发

```bash
npm install
cp server/.env.example server/.env
docker compose up --build
npm run dev
```

开发 API 默认 `http://127.0.0.1:4310`。正式桌面构建必须通过 `AUTOFORGE_API_URL` 注入 HTTPS 地址。发布私钥只属于服务端；对应公钥和 `keyId` 需要编入 `resources/keys/trusted-release-keys.json`。开发时可用 `AUTOFORGE_TRUSTED_KEYS_JSON` 临时追加信任公钥。

## 验证

```bash
npm run test:unit
npm run typecheck
npm run build
npm run test:e2e
npm run dist:dir
```

协议、安全边界和 API 详见 [工作流生命周期](docs/workflow-lifecycle.md)。
