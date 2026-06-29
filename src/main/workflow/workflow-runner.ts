import { EventEmitter } from 'node:events'
import type { WorkflowLog, WorkflowSnapshot, WorkflowStatus, WorkflowStep } from '@shared/workflow'

type WorkflowEvents = {
  changed: [WorkflowSnapshot]
}

const workflowSteps: WorkflowStep[] = [
  { id: 'manifest', label: '校验插件 Manifest', capability: 'plugin:validate', durationMs: 500 },
  { id: 'permission', label: '检查权限声明', capability: 'permission:check', durationMs: 650 },
  { id: 'page', label: '准备受控页面会话', capability: 'page:navigate', durationMs: 800 },
  { id: 'dom', label: '执行 DOM 自动化步骤', capability: 'dom:write', durationMs: 1000 },
  { id: 'extract', label: '提取页面结果', capability: 'dom:read', durationMs: 650 }
]

export declare interface WorkflowRunner {
  on<T extends keyof WorkflowEvents>(eventName: T, listener: (...args: WorkflowEvents[T]) => void): this
  emit<T extends keyof WorkflowEvents>(eventName: T, ...args: WorkflowEvents[T]): boolean
}

export class WorkflowRunner extends EventEmitter {
  private status: WorkflowStatus = 'idle'
  private progress = 0
  private message = '等待运行自动化工具'
  private activeStepId: string | null = null
  private logs: WorkflowLog[] = []
  private runToken = 0

  getSnapshot(): WorkflowSnapshot {
    return {
      status: this.status,
      progress: this.progress,
      message: this.message,
      activeStepId: this.activeStepId,
      steps: workflowSteps,
      logs: this.logs
    }
  }

  start(): WorkflowSnapshot {
    if (this.status === 'running' || this.status === 'paused') {
      return this.getSnapshot()
    }

    this.runToken += 1
    const token = this.runToken
    void this.run(token)
    return this.getSnapshot()
  }

  pause(): WorkflowSnapshot {
    if (this.status === 'running') {
      this.status = 'paused'
      this.message = '工作流已暂停'
      this.addLog('warn', '用户暂停了当前工作流')
      this.publish()
    }
    return this.getSnapshot()
  }

  resume(): WorkflowSnapshot {
    if (this.status === 'paused') {
      this.status = 'running'
      this.message = '继续运行工作流'
      this.addLog('info', '用户恢复了当前工作流')
      this.publish()
    }
    return this.getSnapshot()
  }

  reset(): WorkflowSnapshot {
    this.runToken += 1
    this.status = 'idle'
    this.progress = 0
    this.message = '等待运行自动化工具'
    this.activeStepId = null
    this.logs = []
    this.publish()
    return this.getSnapshot()
  }

  private async run(token: number): Promise<void> {
    this.status = 'running'
    this.progress = 0
    this.activeStepId = null
    this.logs = []
    this.addLog('info', '工作流启动，进入受控执行链路')
    this.publish()

    try {
      for (const [index, step] of workflowSteps.entries()) {
        if (token !== this.runToken) {
          return
        }

        await this.waitIfPaused(token)
        this.activeStepId = step.id
        this.message = step.label
        this.progress = Math.round((index / workflowSteps.length) * 100)
        this.addLog('info', `${step.label}：${step.capability}`)
        this.publish()

        await this.sleep(step.durationMs)
      }

      if (token !== this.runToken) {
        return
      }

      this.status = 'completed'
      this.progress = 100
      this.activeStepId = null
      this.message = '自动化工作流完成'
      this.addLog('info', '工作流完成，所有能力调用均经过平台网关')
      this.publish()
    } catch (error) {
      this.status = 'error'
      this.activeStepId = null
      this.message = '工作流运行失败'
      this.addLog('error', error instanceof Error ? error.message : '未知错误')
      this.publish()
    }
  }

  private async waitIfPaused(token: number): Promise<void> {
    while (this.status === 'paused' && token === this.runToken) {
      await this.sleep(200)
    }
  }

  private addLog(level: WorkflowLog['level'], message: string): void {
    this.logs = [
      {
        id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        level,
        message,
        time: new Date().toLocaleTimeString('zh-CN', { hour12: false })
      },
      ...this.logs
    ].slice(0, 80)
  }

  private publish(): void {
    this.emit('changed', this.getSnapshot())
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, ms)
    })
  }
}
