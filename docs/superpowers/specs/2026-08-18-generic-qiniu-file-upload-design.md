# 通用七牛文件上传设计

## 目标

将桌面端现有的七牛上传能力从头像业务中提取为公共的主进程文件上传模块，并新增以下本机配置：

```dotenv
QINIU_DEFAULT_PATH=autoforge/
QINIU_UPLOAD_URL=https://up-z2.qiniup.com
```

`QINIU_DEFAULT_PATH` 是所有远程对象 key 的统一前缀。头像上传传入相对 key `profiles/<userId>/<uuid>.<ext>`，最终上传到 `autoforge/profiles/<userId>/<uuid>.<ext>`。`QINIU_UPLOAD_URL` 是实际上传请求使用的七牛上传入口。

## 范围与边界

- 只修改 `auto-forge` 桌面端主进程、七牛配置文件和相关测试。
- `/Users/liangshan/workspace/workspace_qisi/smlrtapi/src/modules/upload/upload.service.ts` 只作为配置、路径规范化和上传数据流的参考，不做修改。
- 公共上传模块负责七牛配置解析、对象 key 规范化、上传执行和公共返回结果。
- 头像模块继续负责文件选择、5 MiB 限制、JPEG/PNG/WebP 嗅探、扩展名匹配、用户目录和头像专用错误映射。
- 不新增渲染进程可直接调用的任意文件上传 IPC；当前唯一调用方仍是头像上传。公共方法位于主进程，供后续真实调用方复用。

## 方案比较

### 方案一：独立公共上传模块，复用七牛 SDK（采用）

新增 `apps/desktop/electron/main/upload/qiniu-file-uploader.ts`。公共上传器继续使用七牛 SDK 的流式本地文件上传，通过基于 `QINIU_UPLOAD_URL` 创建的自定义上传区域固定请求入口。

优点是不会为通用文件增加整文件内存占用，上传 token 和 multipart 细节继续由已安装的 SDK 处理，同时模块不依赖头像规则。代价是需要把 URL 转为 SDK 使用的上传主机，并为其做严格校验。

### 方案二：使用 `fetch`、`FormData` 和手工 token

直接复刻参考服务的上传方式。行为容易对照，但 Node 原生 `FormData` 对本地文件的流式处理更复杂；简单实现需要把整个文件读入内存，不适合作为通用上传基础能力。

### 方案三：在头像上传文件内导出公共函数

改动最少，但公共能力仍和头像的限制、错误码及目录结构耦合，不满足“不要局限于上传头像”的模块边界。

## 公共接口

公共模块提供以下语义：

```ts
interface QiniuFileUploadInput {
  localPath: string
  key: string
  mimeType?: string
}

interface QiniuFileUploadResult {
  url: string
  key: string
  hash?: string
  bucket: string
}

interface FileUploader {
  uploadFile(input: QiniuFileUploadInput): Promise<QiniuFileUploadResult>
}
```

`key` 必须是相对于默认目录的对象 key。公共上传器规范化反斜杠、重复分隔符、`.` 和 `..` 段，然后在前面添加规范化后的 `QINIU_DEFAULT_PATH`。返回的 `key` 是七牛确认的完整远程 key，`url` 使用 `QINIU_DOMAIN` 和逐段编码后的 key 构造。

公共上传器不施加文件类型和大小限制。调用方若有业务限制，应在调用 `uploadFile` 前完成检查。

## 配置契约

通用配置包含：

- `QINIU_ACCESS_KEY`：必填。
- `QINIU_SECRET_KEY`：必填。
- `QINIU_BUCKET`：必填。
- `QINIU_DOMAIN`：必填，必须是无凭据、端口、查询、片段和子路径的 HTTPS 源。
- `QINIU_DEFAULT_PATH`：必填，规范化为零个或多个安全目录段并以 `/` 结尾；本次本机值为 `autoforge/`。
- `QINIU_UPLOAD_URL`：必填，必须是无凭据、端口、查询、片段和子路径的 HTTPS 源；本次本机值为 `https://up-z2.qiniup.com`。

现有 `QINIU_REGION` 不再决定上传请求地址；为避免无关配置清理，本次不从现有本机文件中主动删除它。上传行为以 `QINIU_UPLOAD_URL` 为准。

## 数据流

1. Electron 主进程初始化时读取根目录 `.env`，与当前行为一致。
2. 应用组合层创建一个 `QiniuFileUploader`，其配置在实际上传时延迟读取。
3. 用户选择头像后，头像上传器先完成文件安全检查。
4. 头像上传器生成相对 key `profiles/<userId>/<uuid>.<ext>`，调用公共 `uploadFile`。
5. 公共上传器生成完整 key `autoforge/profiles/<userId>/<uuid>.<ext>`，创建仅允许该 key 的上传凭证，并通过 `QINIU_UPLOAD_URL` 上传本地文件。
6. 公共上传器校验七牛返回 key 与请求 key 一致，然后返回 URL 等公共元数据。
7. 头像上传器只返回 URL；现有资料服务将 URL 保存到当前用户的本机 SQLite 资料记录。

## 错误处理

- 缺失配置继续使用 `CREDENTIAL_UNAVAILABLE`。
- URL 或路径配置不合法继续使用 `CREDENTIAL_INVALID`。
- 七牛上传异常、响应缺少 key 或返回不同 key，由公共上传器抛出内部错误。
- 头像调用方捕获公共上传异常并映射为 `PROFILE_AVATAR_UPLOAD_FAILED`，不向渲染进程暴露密钥、token、远程响应或本地路径。
- 用户取消文件选择仍返回 `null`，不读取配置、不发起上传。

## 测试与成功标准

- 配置测试证明两个新配置被读取和规范化，无效上传 URL 被拒绝。
- 公共上传测试证明默认目录统一添加、危险路径段被消除、上传 URL 确实传入 SDK 适配层、返回 URL 正确编码，并拒绝不一致的响应 key。
- 头像测试证明最终 key 为 `autoforge/profiles/<userId>/<uuid>.<ext>`，且图片限制和安全错误映射保持不变。
- `.env` 与 `.env.example` 均包含两个新配置，其中 `.env` 继续被 Git 忽略。
- 相关测试、完整测试、类型检查和生产构建通过；功能文件 ESLint 无新增问题。
