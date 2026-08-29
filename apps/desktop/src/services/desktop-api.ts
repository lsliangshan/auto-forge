import type { AppError, DesktopAPI } from '@autoforge/shared'

export class DesktopBridgeUnavailableError extends Error {
  readonly code = 'BRIDGE_UNAVAILABLE'

  constructor() {
    super('桌面服务不可用，请重新启动 AutoForge。')
    this.name = 'DesktopBridgeUnavailableError'
  }
}

export function getDesktopApi(): DesktopAPI {
  const api = window.autoForge
  if (!api?.auth || !api?.profile || !api?.chat
    || !api?.workflows || !api?.executions || !api?.settings) {
    throw new DesktopBridgeUnavailableError()
  }
  return api
}

const messages: Partial<Record<AppError['code'], string>> = {
  AUTH_REQUIRED: '请先登录',
  AUTH_INVALID_CREDENTIALS: '账号或密码错误',
  AUTH_ACCOUNT_EXISTS: '该账号已存在',
  AUTH_INVALID_OTP: '验证码错误，请重新发送后再试',
  AUTH_OTP_EXPIRED: '验证码已失效，请重新发送',
  AUTH_OTP_RATE_LIMITED: '验证码发送过于频繁，请稍后再试',
  AUTH_ACCOUNT_NOT_FOUND: '该手机号或邮箱尚未注册',
  FORBIDDEN: '没有用户管理权限',
  USER_NOT_FOUND: '用户不存在或已被删除',
  ROLE_CONFLICT: '用户角色已被其他管理员更新，请刷新后重试',
  SELF_ROLE_CHANGE_FORBIDDEN: '不能修改自己的角色',
  MEMBERSHIP_CONFLICT: '会员状态已被其他管理员更新，请刷新后重试',
  SELF_MEMBERSHIP_CHANGE_FORBIDDEN: '不能修改自己的会员状态',
  KNOWLEDGE_BASE_LIMIT_EXCEEDED: '当前会员版本的知识库数量已达上限',
  KNOWLEDGE_DOCUMENT_LIMIT_EXCEEDED: '当前会员版本的文件数量已达上限；回收站、处理失败和处理中条目也会计入，请永久删除后重试',
  LAST_SUPER_ADMIN: '不能降级最后一个可用的超级管理员',
  REQUEST_ID_CONFLICT: '本次角色修改请求与已完成请求冲突',
  SERVICE_UNAVAILABLE: '用户角色服务暂时不可用，请稍后重试',
  CANCELLED: '操作已取消',
  CAPABILITY_SCOPE_DENIED: '工作流尝试访问未授权的网站，请检查工作流权限并重新构建',
  INVALID_INPUT: '输入内容无效',
  NOT_FOUND: '请求的内容不存在',
  CONFLICT: '内容已被其他操作更新，请刷新后重试',
  PERMISSION_DENIED: '没有执行此操作的权限',
  UNTRUSTED_SENDER: '当前页面无法访问桌面服务',
  CREDENTIAL_UNAVAILABLE: '当前供应商尚未配置 API Key，或系统安全存储暂时不可用',
  CREDENTIAL_INVALID: '当前供应商的 API Key 无效',
  MODEL_PROVIDER_ACCESS_DENIED: '供应商拒绝了该模型请求，请检查模型权限、内容策略或 Guardrail 设置',
  MODEL_PROVIDER_INVALID_REQUEST: '供应商拒绝了当前请求，请调整生成设置或稍后重试',
  MODEL_PROVIDER_PAYMENT_REQUIRED: '供应商账户或 API Key 额度不足，请充值或检查限额',
  MODEL_PROVIDER_RATE_LIMITED: '供应商请求过于频繁，请稍后重试',
  MODEL_PROVIDER_TIMEOUT: '供应商响应超时，请稍后重试',
  MODEL_PROVIDER_UNAVAILABLE: '供应商或所选模型暂时不可用，请稍后重试',
  TOOL_CALL_LIMIT: '工作流工具调用次数已达上限',
  MODEL_PROVIDER_REQUEST_FAILED: '大模型供应商请求失败，请稍后重试',
  OPENROUTER_REQUEST_FAILED: '大模型供应商请求失败，请稍后重试',
  CONTEXT_LIMIT_EXCEEDED: '当前输入和会话上下文超出模型限制，请缩短输入或新建会话',
  MEDIA_TYPE_UNSUPPORTED: '不支持此媒体格式',
  MEDIA_ATTACHMENT_LIMIT_EXCEEDED: '每条消息最多添加 5 个附件',
  MEDIA_SIZE_LIMIT_EXCEEDED: '媒体文件大小超出限制',
  MEDIA_MIME_MISMATCH: '文件内容与格式不匹配',
  MEDIA_IMPORT_FAILED: '媒体文件导入失败',
  MEDIA_ASSET_UNAVAILABLE: '媒体文件不可用或已损坏',
  MEDIA_STORAGE_FULL: '本地磁盘空间不足',
  MODEL_MODALITY_UNSUPPORTED: '当前模型不支持所选输入或输出类型',
  MEDIA_GENERATION_FAILED: '媒体生成失败',
  MEDIA_DOWNLOAD_FAILED: '媒体下载失败',
  MEDIA_GENERATION_TIMEOUT: '视频生成超时',
  PROFILE_AVATAR_UPLOAD_FAILED: '头像上传失败，请稍后重试',
  NETWORK_PROXY_APPLY_FAILED: '代理应用失败，已保留原配置',
  NO_BOUND_PAGE: '当前会话没有绑定的浏览器页面',
  PAGE_CLOSED: '绑定的浏览器页面已关闭',
  PAGE_BUSY: '浏览器页面正在被其他操作使用',
  AUTH_STATE_UNKNOWN: '无法确认页面登录状态，请手动检查',
  TARGET_AMBIGUOUS: '页面中的目标不明确，请手动操作',
  DOMAIN_BLOCKED: '当前网站不允许执行此浏览器操作',
  MANUAL_ACTION_REQUIRED: '此操作需要你在页面中手动确认',
  PAGE_CHANGED: '页面已变化，请重新检查后继续',
  UNSUPPORTED_CONTROL: '当前页面控件不受支持，请手动操作',
  ACTION_LIMIT_EXCEEDED: '网页读取或单次操作超出安全处理范围',
  INTERNAL_ERROR: '操作失败，请稍后重试',
}

export function displayError(error: unknown, fallback = '操作失败，请稍后重试'): string {
  if (error instanceof DesktopBridgeUnavailableError) return error.message
  if (typeof error === 'object' && error && 'code' in error) {
    const code = String((error as { code: unknown }).code) as AppError['code']
    return messages[code] ?? fallback
  }
  if (error instanceof Error && error.message.startsWith('AUTOFORGE_APP_ERROR:')) {
    const code = error.message.slice('AUTOFORGE_APP_ERROR:'.length) as AppError['code']
    return messages[code] ?? fallback
  }
  return fallback
}
