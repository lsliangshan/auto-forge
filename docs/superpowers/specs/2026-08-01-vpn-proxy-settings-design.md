# AutoForge VPN 代理设置设计

## 背景

AutoForge 当前的网络请求分布在多个运行边界：Electron 默认会话负责 Renderer，模型供应商使用 Main 进程 `fetch`，媒体下载使用 Node HTTPS，请求型工作流使用独立 Playwright Chromium。仅修改环境变量或单个客户端无法满足“启用后 APP 内所有网络请求走代理、关闭后直连、设置实时生效”的要求。

本设计在 Electron Main 中建立单一代理配置源，并让每条现有网络路径显式接入该配置。

## 目标

- 在“设置”页面新增“VPN 代理”区域。
- 用户可以启用或关闭代理，填写 `http_proxy`、`https_proxy`、`socket_proxy` 和代理忽略域名。
- 启用后，除固定本机地址和用户明确忽略的目标外，AutoForge 当前所有外部 HTTP/HTTPS 请求不得静默直连。
- 关闭后，APP 内后续网络请求使用 `direct` 模式。
- 普通在途请求不被切换中断；新请求在切换完成后使用新配置。
- 已运行的自动化浏览器工作流保留其代理快照，工作流结束后新建的浏览器上下文使用最新配置。
- 配置保存在本机，重启后在创建窗口和发送任何外部请求前恢复。

## 非目标

- 不支持代理用户名或密码认证。
- 不支持 PAC、WPAD 或跟随系统代理模式。
- 不增加代理连通性测试按钮。
- 不控制 `shell.openExternal()` 打开的系统浏览器或其他外部应用。
- 不绕过 TLS 证书校验。

## 设置模型

在共享 `AppSettings` 中新增严格字段：

```ts
interface ProxySettings {
  enabled: boolean
  httpProxy?: string
  httpsProxy?: string
  socketProxy?: string
  bypassDomains: string[]
}

interface AppSettings {
  // 现有字段保持不变
  proxy: ProxySettings
}
```

默认值为：

```ts
{
  enabled: false,
  bypassDomains: [],
}
```

代理地址不是凭证，直接随其他本地设置存入 `app_settings`。关闭代理不会清空地址和忽略域名。

## 设置页面

在“默认模型”和“外观与行为”之间增加“VPN 代理”区域：

- `启用 VPN 代理` 开关。
- 标签与输入名称严格显示为 `http_proxy`、`https_proxy`、`socket_proxy`。
- “代理忽略的域名”使用多行输入框，接受逗号或换行分隔。
- 代理关闭时输入仍可编辑和保存，但状态文案明确为“已关闭，网络请求直连”。
- 保存期间使用现有 `settings.saving` 状态禁用重复提交。
- Renderer 先做即时字段提示，Main 仍执行权威校验。

不新增独立保存按钮。输入使用本地草稿，失焦或开关变化时通过现有设置更新队列提交完整 `proxy` 对象，避免每个字符触发代理切换。

## 输入校验与规范化

### 代理地址

- `httpProxy` 和 `httpsProxy` 仅接受 `http://host:port` 或 `https://host:port`。
- `socketProxy` 仅接受 `socks4://host:port` 或 `socks5://host:port`。
- 所有代理地址必须包含显式端口。
- 禁止用户名、密码、路径、查询参数和 URL 片段。
- 去除输入首尾空白后保存规范 URL；不在日志、错误或诊断中输出完整原始输入。

启用代理时至少填写一个代理地址。为满足“启用后所有外部 HTTP/HTTPS 请求不得静默直连”，缺失的协议按以下顺序补足：

1. HTTP URL 优先使用 `httpProxy`。
2. HTTPS URL 优先使用 `httpsProxy`。
3. 对应字段缺失时使用 `socketProxy`。
4. 仍缺失时使用另一个已配置的 HTTP 系代理地址作为共享代理。

因此，只配置任意一个代理地址也能覆盖 APP 当前的 HTTP/HTTPS 外部请求。已分配代理不可用时请求失败，不追加 `direct://` 故障回退，避免用户以为流量经过代理但实际发生直连。

### 忽略域名

- 接受精确域名 `example.com`、通配域名 `*.example.com`、IP 字面量和 CIDR。
- 拒绝协议、端口、路径、空规则和无法解析的模式。
- 按首次出现顺序去重。
- `<local>` 由 Main 固定追加，不由用户删除；它覆盖 `localhost`、`127.0.0.1` 和 `::1`。

固定本机绕过用于保护开发 Renderer `localhost:5173` 和应用内部本地服务，不视为外部网络直连。

## Main 进程架构

新增聚焦的 `NetworkProxyService`。它只负责代理状态，不读取 UI，也不持久化数据库。

```ts
interface ElectronProxySessionPort {
  setProxy(config: Electron.ProxyConfig): Promise<void>
  closeAllConnections(): Promise<void>
  fetch(input: string | Request, init?: RequestInit): Promise<Response>
}

interface NetworkProxySnapshot {
  enabled: boolean
  proxyRules?: string
  bypassRules: string
  playwrightArgs: string[]
}

interface NetworkProxyService {
  initialize(settings: ProxySettings): Promise<void>
  transition(settings: ProxySettings): Promise<void>
  fetch(input: string | Request, init?: RequestInit): Promise<Response>
  snapshot(): NetworkProxySnapshot
}
```

职责：

- 将共享设置转换为 Electron `fixed_servers` / `direct` 配置。
- 生成 Electron `proxyRules`、`proxyBypassRules` 和等价的 Playwright Chromium 启动参数。
- 串行化多个设置更新，最后一次排队更新不能与前一次交叉应用。
- 在代理切换期间阻止新的托管请求开始。
- 等普通在途托管请求结束后调用 `setProxy`，再调用 `closeAllConnections` 清理旧连接池。
- 切换成功后放行排队请求；失败则恢复并继续暴露旧快照。

服务不主动关闭 Playwright 上下文。浏览器上下文创建时取得不可变快照。

## 持久化与切换顺序

应用启动：

1. `app.whenReady()` 完成。
2. 创建应用运行时并读取规范化后的设置。
3. 使用保存的 `proxy` 调用 `NetworkProxyService.initialize()`。
4. 代理初始化成功后才注册窗口、IPC 和触发凭证验证/模型加载。
5. 保存配置无法应用时，以安全错误终止启动；不静默退回直连。

用户更新：

1. IPC 解析严格的 `AppSettingsPatch`。
2. `SettingsService` 生成但暂不持久化候选设置。
3. 若 `proxy` 未变化，沿用现有同步持久化路径。
4. 若 `proxy` 变化，调用 `NetworkProxyService.transition()`。
5. transition 等待普通在途请求结束，并让新托管请求排队。
6. Electron 应用新配置并清理旧连接池。
7. 成功后持久化候选设置并返回 Renderer。
8. 失败时保留旧设置和旧代理，返回固定安全错误。

若数据库提交在代理应用成功后失败，Main 重新应用旧代理，再把数据库错误作为安全错误返回，保证运行状态与持久化状态一致。

关闭代理走完全相同的顺序，目标 Electron 配置为 `{ mode: 'direct' }`。

## 网络路径接入

### Renderer 与 Electron 默认会话

主窗口继续使用 `session.defaultSession`。该会话由 `NetworkProxyService` 配置。严格 CSP 和导航保护保持不变。

### OpenRouter 与 DeepSeek

模型供应商不再默认使用 Node `globalThis.fetch`。应用组装时向两个供应商注入 `NetworkProxyService.fetch`，使聊天流、凭证验证、模型列表、图片和视频生成统一使用 Electron Chromium 网络栈。

流式响应的请求租约持续到响应体完成、取消或报错，不能在只收到响应头时提前释放。

### 媒体下载

`SafeMediaDownloader` 的传输适配器改为 Electron 会话网络栈，但保留现有安全边界：

- 只允许规范 HTTPS URL。
- 每个初始 URL和重定向目标都重新执行公有地址校验。
- 保留重定向次数、连接/首字节/总超时、最大字节数、内容长度和 MIME 校验。
- 不因代理开启而允许私网、环回、链路本地或其他受限目标。
- 用户配置的代理属于显式信任的传输端点，但不能改变目标 URL 校验结果。

### 自动化浏览器

`BrowserCapabilityService` 接收只读代理快照提供器。创建 `launchPersistentContext` 时把当时的代理规则转换为 Chromium `--proxy-server` 和 `--proxy-bypass-list` 参数。

- 已创建上下文不变，不关闭、不重载页面。
- 同一工作流后续 `fill/click/url` 保持当前上下文和旧代理。
- 当前工作流关闭后销毁上下文；以后新建上下文读取新快照。
- 新旧工作流可以在代理切换后短时间并存，各自使用创建时快照。

### 系统外部链接

`shell.openExternal()` 交给操作系统默认浏览器，不承诺使用 AutoForge 代理。设置页明确说明这一范围。

## 并发和在途请求

`NetworkProxyService` 使用代际状态和请求租约：

- 每个托管网络操作开始前取得当前代租约。
- transition 关闭新租约入口，等待旧代租约归零。
- 归零后应用代理并清理旧连接池。
- 成功时发布新代并开放入口；失败时重新开放旧代。
- 被用户取消的请求正常释放租约。
- 多个 transition 串行执行，不能出现设置返回 B 但网络仍处于 A 的状态。

Playwright 上下文不计入该等待，因为用户已选择保留活动工作流；它通过不可变快照隔离代理代际。

## 错误处理

共享错误新增一个稳定代码：

```ts
NETWORK_PROXY_APPLY_FAILED: 'The network proxy configuration could not be applied.'
```

Renderer 显示：

- 缺少地址：`启用代理时至少填写一个代理地址`
- 地址格式错误：`请输入不包含用户名、密码和路径的有效代理地址`
- 忽略规则错误：`代理忽略域名格式不正确`
- 应用失败：`代理应用失败，已保留原配置`

不把代理地址、请求 URL、供应商响应体或用户内容加入错误消息。

## 安全与隐私

- Renderer 只能提交结构化 `ProxySettings`，不能提交原始 Electron `ProxyConfig` 或 Chromium 参数。
- Main 独立验证并生成所有代理规则，防止参数注入。
- 不改变证书验证、导航限制、CSP、Preload 或 IPC 发送方校验。
- 不设置进程级 `HTTP_PROXY`、`HTTPS_PROXY` 或 `ALL_PROXY`，避免影响不在应用控制范围内的子进程和构建工具。
- 设置页提示：用户配置的代理可观察目标地址；明文 HTTP 内容也可能被代理读取。

## 测试策略

### 共享契约

- 默认关闭配置可以解析。
- 三种合法协议分别可以解析。
- 启用但无地址、缺少端口、含认证信息、含路径、协议不匹配时拒绝。
- 忽略域名规范化、去重和非法模式拒绝。
- IPC 请求和响应继续保持严格对象校验。

### Main 代理服务

- 为单一或组合代理生成覆盖 HTTP/HTTPS 且无 `direct://` 回退的规则。
- `<local>` 始终存在，用户规则正确追加。
- 关闭生成 `direct` 配置。
- 初始化先于第一个请求。
- transition 等待旧租约并阻止新请求。
- 切换成功后关闭旧连接池并发布新快照。
- `setProxy`、连接清理或持久化失败时恢复旧配置。
- 并发更新按顺序完成，最终状态与最后一次成功设置一致。

### 网络消费者

- OpenRouter 和 DeepSeek 由应用注入 Electron 会话 fetch。
- 流式、取消和失败响应都释放请求租约。
- 媒体下载继续拒绝私网和不安全重定向，并使用会话传输。
- 新 Playwright 上下文使用最新快照；已存在上下文不变。

### Renderer

- VPN 代理区域和全部精确标签可见。
- 开关、三个地址和忽略域名从设置回填。
- 失焦提交规范化配置，不逐字符切换。
- 格式错误留在本地并显示，不调用 IPC。
- Main 应用失败后草稿保留，权威设置仍为旧值。
- 关闭代理不清空输入。

### 完整验证

- 运行聚焦测试并观察每项新行为先失败后通过。
- 运行完整测试套件、类型检查和生产构建。
- 在真实 Electron 中使用本地可观测代理验证：启用后 `session.resolveProxy()` 返回配置代理；关闭后返回 `DIRECT`；忽略域名返回 `DIRECT`。
- 验证 OpenRouter/DeepSeek 请求与自动化浏览器新上下文使用相同代的代理配置。
- 不把“窗口打开”或“设置已保存”单独视为网络代理已生效的证据。

## 验收标准

- 设置页可以配置、保存、恢复和关闭代理。
- 代理启用时，当前 APP 的 Renderer、模型、媒体和新自动化浏览器外部 HTTP/HTTPS 流量都有明确代理路径，不发生静默直连。
- 用户忽略目标和固定 `<local>` 目标直连。
- 代理关闭后，新请求直连。
- 切换不会中断普通在途请求，也不会破坏正在运行的自动化浏览器状态。
- 新请求不会在代理切换窗口中使用旧配置。
- 非法配置、应用失败和持久化失败都不会造成设置与实际网络状态不一致。
- 现有安全边界、测试、类型检查和构建保持通过。
