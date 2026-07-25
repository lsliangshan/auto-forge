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
  if (!api?.chat || !api?.workflows || !api?.executions || !api?.settings) {
    throw new DesktopBridgeUnavailableError()
  }
  return api
}

const messages: Partial<Record<AppError['code'], string>> = {
  CANCELLED: '操作已取消',
  INVALID_INPUT: '输入内容无效',
  NOT_FOUND: '请求的内容不存在',
  CONFLICT: '内容已被其他操作更新，请刷新后重试',
  PERMISSION_DENIED: '没有执行此操作的权限',
  UNTRUSTED_SENDER: '当前页面无法访问桌面服务',
  CREDENTIAL_UNAVAILABLE: '当前供应商尚未配置 API Key，或系统安全存储暂时不可用',
  CREDENTIAL_INVALID: '当前供应商的 API Key 无效',
  MODEL_PROVIDER_ACCESS_DENIED: '供应商拒绝了该模型请求，请检查模型权限、内容策略或 Guardrail 设置',
  MODEL_PROVIDER_REQUEST_FAILED: '大模型供应商请求失败，请稍后重试',
  OPENROUTER_REQUEST_FAILED: '大模型供应商请求失败，请稍后重试',
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
