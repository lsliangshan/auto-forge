# DeepSeek 默认供应商与 API Key 状态设计

## 目标

在现有 DeepSeek/OpenRouter 供应商管理基础上完成以下调整：

- 新安装默认选择 DeepSeek。
- 没有保存过供应商的旧配置迁移为 DeepSeek。
- 已明确保存 DeepSeek 或 OpenRouter 的配置保持原选择。
- 每个供应商的 API Key 继续独立加密写入本地 SQLite 数据库。
- API Key 保存成功后明确显示“已设置 API Key”，并单独表达在线验证结果。

## 方案选择

使用现有 `encrypted_secrets` 表中是否存在对应供应商的加密记录作为“已设置”的唯一事实来源。不要在普通设置中增加 `hasApiKey`，也不要新建重复的供应商凭据表。

这样可以避免展示状态与真实密钥记录不同步，并保持现有安全边界：密钥只在 Main 进程中通过 Electron `safeStorage` 加解密，Renderer 只能获得供应商、是否已设置和验证结果。

## 默认供应商与迁移

应用运行时默认设置改为：

```ts
activeProvider: 'deepseek'
```

设置归一化遵循以下顺序：

1. 已保存的 `activeProvider === 'deepseek'` 时保留 DeepSeek。
2. 已保存的 `activeProvider === 'openrouter'` 时保留 OpenRouter。
3. 字段缺失或值无效时使用运行时默认值 DeepSeek。

旧 `defaultModel` 仍只迁移到 `defaultModels.openrouter`，不改变已有默认模型迁移规则。

## API Key 持久化

保存流程保持不变：

1. Renderer 向受信 IPC 发送明确的供应商和新 API Key。
2. Main 根据供应商映射到 `deepseek_api_key` 或 `openrouter_api_key`。
3. `SecretStore` 使用 `safeStorage` 加密。
4. 加密结果写入 SQLite 的 `encrypted_secrets` 表。
5. Main 返回不含密钥的 `ProviderCredentialStatus`。

DeepSeek 与 OpenRouter 使用不同记录，保存、替换和清除互不影响。任何 IPC 响应、Pinia 状态、日志或错误消息都不得包含 API Key。

## 状态展示

设置页将“是否已保存”和“在线验证结果”合并成清晰文案：

- 无加密记录：`未设置 API Key`
- `configured: true, validation: valid`：`已设置 API Key · 已验证`
- `configured: true, validation: invalid`：`已设置 API Key · 验证失败`
- `configured: true, validation: unavailable`：`已设置 API Key · 暂时无法验证`
- `configured: true, validation: unchecked`：`已设置 API Key · 尚未验证`

保存到本地数据库成功后清空输入框，并显示：

```text
API Key 已保存到本地数据库
```

“已设置”只表示本地加密写入成功，不把网络故障误报为没有保存。验证失败不会自动删除已保存的密钥。

## 测试

增加或调整以下回归测试：

- 空设置仓库使用 DeepSeek 作为默认供应商。
- 缺少 `activeProvider` 的旧配置迁移为 DeepSeek。
- 已显式保存 OpenRouter 的配置继续保留 OpenRouter。
- 应用默认设置为 DeepSeek。
- DeepSeek 与 OpenRouter API Key 分别写入不同的加密数据库记录。
- 保存成功后设置页显示“已设置 API Key”状态和本地数据库成功提示。
- 不同验证结果映射到对应状态文案。

完成前运行完整测试、类型检查、Lint、生产构建和 `git diff --check`。没有用户提供的真实 API Key 时，不宣称完成真实上游联网验证。
