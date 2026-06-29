export type WorkflowStatus = 'idle' | 'running' | 'paused' | 'error' | 'completed'

export type WorkflowStep = {
  id: string
  label: string
  capability: string
  durationMs: number
}

export type WorkflowLogLevel = 'info' | 'warn' | 'error'

export type WorkflowLog = {
  id: string
  level: WorkflowLogLevel
  message: string
  time: string
}

export type WorkflowSnapshot = {
  status: WorkflowStatus
  progress: number
  message: string
  activeStepId: string | null
  steps: WorkflowStep[]
  logs: WorkflowLog[]
}

export type WorkflowCommand = 'start' | 'pause' | 'resume' | 'reset' | 'retry'
