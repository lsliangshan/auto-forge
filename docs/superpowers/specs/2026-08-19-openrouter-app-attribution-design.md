# OpenRouter App 归因请求头设计

## 目标

让 AutoForge 发出的所有 OpenRouter 请求都能在 OpenRouter Activity 中归因到 `AutoForge`，不再显示为 `Unknown`。

## 成功标准

- 所有由 `OpenRouterProvider` 发出的请求都携带以下请求头：

  ```http
  HTTP-Referer: https://autoforge.bjqisi.cn
  X-OpenRouter-Title: AutoForge
  ```

- 覆盖模型目录、凭证验证、文本聊天、图片生成、视频提交/轮询/下载以及 generation 用量查询。
- DeepSeek 和其他非 OpenRouter 请求不受影响。
- 现有 OpenRouter Provider 测试和类型检查通过。

## 最小改动范围

- `apps/desktop/electron/main/chat/openrouter-provider.ts`
- `apps/desktop/electron/main/chat/openrouter-provider.test.ts`

不修改业务层、Renderer、数据库、网络代理或通用 OpenAI-compatible Provider 契约。

## 方案

在 `OpenRouterProvider` 构造函数创建的 Fetch 边界统一注入 App 归因请求头。该包装器在保留调用方已有请求头的基础上设置固定的 `HTTP-Referer` 与 `X-OpenRouter-Title`，然后继续使用现有未授权响应释放逻辑。

这一边界覆盖 `OpenRouterProvider` 的全部网络操作，也会自然覆盖重试和凭证快照产生的新 Provider 实例。相比逐个请求添加 Header，它不存在漏掉媒体或用量接口的风险；相比扩展通用 Provider，它不会扩大与当前需求无关的公共接口。

## 数据流

1. OpenRouter Provider 方法构造原始请求。
2. 统一 Fetch 包装器合并已有 Header，并写入固定 App 归因 Header。
3. 请求继续经过现有网络代理 Fetch 发往 OpenRouter。
4. 现有响应、错误映射和重试行为保持不变。

## 错误处理与安全

- Header 是编译期固定的公开产品信息，不读取用户输入或密钥。
- 现有 `Authorization` 和 `Content-Type` Header 必须保留。
- 不改变响应处理、重试次数、超时或错误码映射。

## 验证

先新增一个 Provider 级测试，执行模型、聊天、图片、视频和用量相关操作，并断言捕获到的每个 OpenRouter 请求都含有两个准确的归因 Header。确认测试因当前缺少 Header 而失败后，再加入统一包装器并重新运行测试。

最后运行 OpenRouter Provider 测试和项目类型检查，确认没有影响既有行为。
