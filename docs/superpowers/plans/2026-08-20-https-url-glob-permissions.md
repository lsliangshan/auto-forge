# HTTPS URL Glob Permissions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让工作流权限支持已确认的任意 HTTPS 主机/路径 glob，同时保持 Worker 与授权记录为精确 origin。

**Architecture:** 在 `@autoforge/shared` 建立唯一纯计算匹配模块。Manifest 使用模式校验，Worker 使用精确 scope 校验，执行服务在工作流声明与 Worker 请求之间执行覆盖判断。

**Tech Stack:** TypeScript、Zod、AJV、Vitest

**Spec:** `docs/superpowers/specs/2026-08-20-https-url-glob-permissions-design.md`

## Global Constraints

- 只支持 HTTPS。
- 禁止全局主机通配和端口通配。
- query/hash 不参与目标匹配。
- 不提交当前共享脏工作区中的任何文件。

---

### Task 1: HTTPS URL 模式模块

**Files:**
- Create: `packages/shared/src/https-url-pattern.ts`
- Create: `packages/shared/src/https-url-pattern.test.ts`
- Modify: `packages/shared/src/index.ts`

**Interfaces:**
- Produces: `isHttpsUrlPattern(value: string): boolean`
- Produces: `matchesHttpsUrlPattern(pattern: string, targetUrl: string): boolean`
- Produces: `matchesHttpsUrlPatternOrigin(pattern: string, targetOrigin: string): boolean`

- [ ] 写表驱动失败测试，覆盖跨标签主机、任意主机位置、路径、端口、根域和危险输入。
- [ ] 运行共享测试并确认因接口不存在而失败。
- [ ] 实现解析、正则转义、主机/路径匹配和精确端口比较。
- [ ] 运行共享测试并确认通过。

### Task 2: Manifest 与 Worker 契约分离

**Files:**
- Modify: `packages/shared/src/worker-protocol.ts`
- Modify: `packages/shared/src/contracts.test.ts`
- Modify: `packages/workflow-schema/manifest.schema.json`
- Modify: `packages/workflow-schema/src/validator.ts`
- Modify: `packages/workflow-schema/src/validator.test.ts`

**Interfaces:**
- Consumes: `isHttpsUrlPattern`
- Produces: Manifest/IPC 可接受模式的 `capabilityScopeSchema`
- Produces: 只接受精确 HTTPS origin 的 Worker browser scope

- [ ] 写失败测试，证明 Manifest/工作流权限应接受 glob，而 Worker 请求应拒绝 glob。
- [ ] 运行 schema 与 shared 测试并确认预期失败。
- [ ] 将 AJV format 改为共享 URL 模式校验，并拆分声明 scope 与 Worker 精确 scope。
- [ ] 运行 schema 与 shared 测试并确认通过。

### Task 3: 执行权限覆盖判断

**Files:**
- Modify: `apps/desktop/electron/main/workflows/execution-service.ts`
- Modify: `apps/desktop/electron/main/workflows/execution-service.test.ts`

**Interfaces:**
- Consumes: `matchesHttpsUrlPattern` 与 `matchesHttpsUrlPatternOrigin`
- Produces: Manifest permission 覆盖 Worker request 的内部判断

- [ ] 写失败集成测试，覆盖匹配的 `browser.open`、错误路径/主机拒绝和后续同 origin 操作允许。
- [ ] 运行 execution-service 测试并确认预期失败。
- [ ] 仅替换声明权限查找；审批决定与保存授权继续使用精确 scope 哈希相等。
- [ ] 运行 execution-service 测试并确认通过。

### Task 4: 回归验证

**Files:**
- Verify only: all files above

- [ ] 运行相关 Vitest 套件。
- [ ] 运行改动文件 ESLint、workspace typecheck 与完整 build。
- [ ] 用真实 `apply-test` Manifest 的内存副本验证 glob 配置通过，不修改本机项目数据。
- [ ] 检查最终 diff，确认无无关修改和调试代码。

