# HTTPS URL 通配权限设计

## 目标

保持 `scope.origins` 字段兼容，同时允许工作流用受控 HTTPS URL glob 声明 `browser.open` 范围。Worker 请求、用户审批和持久化授权继续使用精确 HTTPS origin。

## 模式语义

- 支持带 `https://` 或省略协议的写法；省略时隐含 HTTPS。
- `*` 在主机中可跨越多个 DNS 标签，在路径中可跨越多个路径段。
- 主机模式必须至少包含一个字母或数字，禁止 `*`、`*/*` 等全局模式。
- 含通配符的主机只匹配 DNS 主机，不匹配 IP；精确 IP origin 保持现有兼容行为。
- 裸主机模式匹配该主机下所有路径，`*.baidu.com` 与 `*.baidu.com/*` 等价。
- 显式路径在首次 `browser.open` 时参与匹配；query 和 hash 不参与匹配。
- 未声明端口时只匹配 HTTPS 默认端口 443；显式端口必须精确匹配，端口不支持通配符。
- 主机匹配不区分大小写，路径匹配区分大小写；模式按完整主机和完整路径锚定。
- `*.baidu.com` 不包含根域 `baidu.com`，根域必须单独声明。

## 模块与数据流

`@autoforge/shared` 提供唯一的纯计算模式模块，负责校验和匹配。Workflow Manifest 校验复用该模块；共享 Zod 契约区分声明范围与 Worker 精确范围。

执行服务以“声明覆盖请求”替代 Manifest 权限与 Worker 请求的 scope 哈希相等判断。`browser.open` 使用请求中的完整 URL；后续 `fill/click/url/close` 只比较主机与端口并继续沿用现有精确 origin 会话约束。同一 origin 内的路径导航不因初始路径模式而拒绝，跨 origin 导航仍拒绝。

审批事件、一次性授权和持久化授权保存 Worker 提交的精确 origin。通配符只存在于工作流声明，不进入运行时授权记录。

## 兼容性与错误处理

- 现有 `https://www.baidu.com` 继续表示该精确 origin 下的所有路径。
- HTTP、凭证、query/hash 模式、全局通配、通配端口、畸形主机和通配 IP 模式继续在 Manifest 校验阶段拒绝。
- 非浏览器权限继续使用原有精确 scope 哈希比较。

## 验证

- 共享模式模块使用表驱动测试覆盖合法性、跨标签、路径、端口、根域、恶意后缀和 query/hash。
- Manifest 测试覆盖通配模式接受与危险模式拒绝。
- Worker 协议测试证明 Worker 仍不能提交通配符 scope。
- 执行服务测试覆盖首次 URL 匹配、错误路径/主机拒绝、后续同 origin 操作允许及审批 scope 保持精确。

