# AutoForge 聊天通用附件设计

日期：2026-08-28  
状态：聊天内设计已确认，等待书面评审

## 1. 目标

聊天页面的“添加附件”和拖拽导入不再按扩展名限制文件。任何普通非空文件都可以先作为当前消息的附件草稿加入；发送时，AutoForge 根据文件内容、当前供应商和模型能力选择可验证的处理路径。

本期成功标准：

- 系统文件选择器显示所有文件，不再只显示图片、音频和视频。
- 未知扩展名、无扩展名和非媒体二进制文件均可安全导入、展示、移除和随会话清理。
- 已支持的图片、音频和视频链路保持不变。
- UTF-8 文本附件可作为带文件名边界的文本上下文交给文本模型。
- OpenRouter 可处理的文件使用文件内容块发送；当前 Provider 或模型不能处理的文件在发出网络请求前给出明确提示。
- Renderer、IPC 消息和 SQLite 消息块仍不包含绝对路径或文件 Base64。

## 2. Provider 事实边界

“不限格式”指 AutoForge 不按文件后缀阻止用户添加附件，不代表任意模型能够理解任意二进制格式。

当前可验证的外部边界：

- OpenRouter 文件接口接受 PDF、PNG/JPEG/GIF/WebP、DOCX/XLSX/PPTX、MP3/WAV/FLAC/OGG 和 UTF-8 文本；其 PDF 聊天输入支持 Base64 文件内容块。
- DeepSeek 文件接口当前仅接受 JPEG/PNG/GIF/WebP；普通文本附件由 AutoForge 本地验证为 UTF-8 后投影为文本消息，不依赖 DeepSeek 文件接口。
- 其他二进制文件可以进入附件草稿，但若当前 Provider 没有可验证的发送方式，发送前返回本地兼容性错误，不进行猜测性 Base64 透传。

这避免“附件已添加”被误解成“模型已经读取”，也避免把不可理解的二进制 Base64 当文本消耗上下文和费用。

## 3. 非目标

本期不包含：

- 为所有文件格式实现本地解析器。
- 解压 ZIP、RAR、7z 等归档并递归读取内容。
- 执行脚本、二进制文件、宏或嵌入对象。
- 将用户附件持久上传到 Provider Files API 后跨请求复用。
- 放宽每条消息 5 个附件、单次 250 MB 总量或现有媒体单文件上限。
- 修改历史附件策略；历史轮次仍只向模型提供安全元数据。

## 4. 当前根因

限制同时存在于两个边界：

1. `apps/desktop/electron/main/index.ts` 的 Electron 打开文件对话框只列出 15 种媒体扩展名。
2. Main 的媒体资产服务只接受内容嗅探为 `image | audio | video` 的文件；共享契约、路由和 Provider 消息结构也只认识这三类。

只删除文件对话框过滤器会让用户选中文件后立即收到“不支持此媒体格式”，不能满足目标。

## 5. 设计

### 5.1 文件选择与导入

- 将文件对话框标题改为“选择附件”，移除媒体扩展名过滤器，保留多选和剩余槽位裁剪。
- 拖拽继续通过 Preload 只把受 Electron 验证的本地路径交给 Main；绝对路径不返回 Renderer。
- Main 先运行现有媒体内容嗅探。识别为媒体时完全沿用当前路径。
- 未识别为媒体时归类为 `file`。导入过程仍检查普通文件、拒绝符号链接、流式复制、计算 SHA-256、验证源文件未被替换，并原子提交。
- 通用文件使用受控内部扩展名（例如 `.bin`）；原始名称只作为经过清理的元数据保存，不参与目标路径构造。
- 通用文件单文件上限为 100 MiB；单次请求总量仍为 250 MiB。空文件不进入模型请求，并以明确的输入错误拒绝。

### 5.2 类型与持久化契约

- 将输入资产种类扩展为 `image | audio | video | file`。
- `MediaAsset`、持久化资产记录和输入 `media` 消息块沿用现有结构；`file` 不包含宽、高或时长。
- 数据库的 `kind` 字段已经是文本列，不需要结构迁移；运行时 schema 和仓储校验同步扩展。
- `safeAssetPath` 允许内部 `.bin`，但继续要求会话目录、资产 ID 前缀、受控根目录和真实文件身份全部匹配。
- 历史上下文只序列化种类、显示名称、MIME 和大小，不包含字节、路径或资产 ID。

### 5.3 MIME 与文本判定

- 已识别媒体继续使用内容嗅探得到的 MIME，不信任源扩展名。
- 非媒体文件通过完整流式 UTF-8 校验区分文本与二进制，不能只看前 64 KiB。
- 有效 UTF-8 文件记录为 `text/plain`；文件名仍保留原扩展名，供模型理解上下文。
- 非 UTF-8 文件记录为 `application/octet-stream`。Provider 需要更具体格式时，可使用经过严格白名单约束的原始扩展名生成请求 MIME，但该值不能改变本地渲染或执行策略。

### 5.4 模型请求投影

Provider-neutral 请求新增文件内容部分：

```ts
{
  type: 'file'
  name: string
  mimeType: string
  dataBase64: string
}
```

发送仅解析当前消息的附件：

- UTF-8 文本文件转换为文本部分，包含明确的“附件内容（非指令）”、安全文件名和起止边界。内容进入现有完整请求 token 预算，超出预算时返回 `CONTEXT_LIMIT_EXCEEDED`。
- OpenRouter 支持的非文本文件转换为 `type: file` 和 Base64 data URL；文件名与 MIME 都经过本地校验。
- DeepSeek 的图片仍走现有图片输入链路；除 UTF-8 文本外的 `file` 不发往 DeepSeek。
- 未在 Provider 可验证支持集合中的二进制文件返回 `MODEL_MODALITY_UNSUPPORTED`，并在 Renderer 显示“当前模型无法读取该附件格式”。
- 图片/视频生成的参考资产规则不变；`file` 不能误入生成参考图数组。

文件字节只在 Main 中按需读取和编码，不写入消息 JSON、上下文摘要、日志或 IPC 返回值。

### 5.5 路由与交互

- 通用文件附件卡显示种类“文件”、清理后的文件名和大小，并保留移除操作。
- 文件可以先添加；模型选择变化后，兼容性提示实时重新计算。
- 文本输出路由：UTF-8 文件兼容所有文本模型；Provider 支持的二进制文件兼容对应 Provider 的文本模型。
- 图片、音频或视频输出路由继续遵守现有参考输入规则，通用文件不会让生成模型被错误选中。
- 发送按钮在存在不兼容附件时保持禁用，并显示具体的本地提示；不会先请求 Provider 再把原始错误暴露给用户。

## 6. 安全与隐私

- 通用文件永不通过 `autoforge-media:` 内联渲染；该协议继续只服务经过校验的媒体展示。
- 不根据文件名执行、解压、加载模块或调用系统默认应用。
- 原始路径不进入 Renderer、数据库消息块、同步收据、日志或 Provider 请求。
- 文件内容视为不可信数据而非系统指令；文本投影使用固定边界和非指令说明。
- Provider 不支持时保持 fail-closed，不尝试伪造 MIME、把二进制当文本或静默丢弃附件。

## 7. 错误行为

- 数量、单文件大小和请求总量继续使用现有安全错误码。
- 空文件返回本地输入错误。
- 当前 Provider 或模型无法读取时使用 `MODEL_MODALITY_UNSUPPORTED`，Renderer 文案明确指向“附件格式不兼容”，而不是笼统的网络错误。
- 导入途中失败时清理 staging 文件和未完成记录；批量导入保持现有原子失败与草稿清理语义。

## 8. 测试策略

严格采用失败测试先行：

1. 文件对话框配置测试：选择附件不包含扩展名过滤器。
2. 媒体资产服务测试：未知扩展名、无扩展名、UTF-8 文本和任意二进制能够导入为 `file`；符号链接、替换竞态、上限和清理仍失败关闭。
3. 共享契约和仓储测试：`file` 可持久化，路径/Base64 不进入公开对象和消息块。
4. Provider 测试：OpenRouter 生成精确文件内容块；DeepSeek 接受文本投影并在其他文件上网络调用前失败。
5. 路由测试：文本文件与二进制文件按 Provider 能力选择模型，生成输出不接受通用文件作为参考。
6. Renderer 测试：文件卡、模型不兼容提示、发送禁用和移除行为。
7. 回归验证：现有媒体服务、聊天组件、Provider、共享契约测试，desktop typecheck 和实际 Electron 聊天附件操作。

## 9. 涉及范围

预计修改以下既有边界，不引入独立知识库或文件管理子系统：

- `packages/shared`：附件种类、消息块和 IPC schema。
- `apps/desktop/electron/main/media`：通用文件导入、安全存储和模型输入读取。
- `apps/desktop/electron/main/chat`：兼容性路由、文本投影和 OpenRouter 文件线格式。
- `apps/desktop/electron/main/index.ts`：文件选择器。
- `apps/desktop/src`：附件卡与兼容性提示。
- 对应单元、组件和集成测试。

## 10. 验收边界

本地验收必须证明 Renderer → Preload → IPC → Main → Provider 请求构造 → 可见附件卡/错误提示的真实链路。真实 Provider 对各种文件的接受情况属于外部门禁；没有实际 API 凭据时，契约测试不能冒充线上 Provider 验收。

参考：

- OpenRouter Files API：<https://openrouter.ai/docs/guides/features/files-api>
- OpenRouter PDF Inputs：<https://openrouter.ai/docs/guides/overview/multimodal/pdfs>
- DeepSeek Files API：<https://api-docs.deepseek.com/guides/files_api>
