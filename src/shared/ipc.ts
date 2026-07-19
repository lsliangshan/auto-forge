import type { SafeError } from './contracts'

export const ipcChannels = {
  getSettings: 'settings:get',
  updateSettings: 'settings:update',
  getSession: 'auth:session', login: 'auth:login', register: 'auth:register', logout: 'auth:logout',
  listCategories: 'registry:categories', listWorkflows: 'registry:workflows',
  listInstalledWorkflows: 'workflows:installed', installWorkflow: 'workflows:install', runWorkflow: 'workflows:run',
  listWorkflowProjects: 'projects:list', createWorkflowProject: 'projects:create', openWorkflowProject: 'projects:open',
  buildWorkflowProject: 'projects:build', watchWorkflowProject: 'projects:watch', stopWatchingWorkflowProject: 'projects:stop-watch',
  openProjectEditor: 'projects:open-editor', debugWorkflow: 'projects:debug', stopExecution: 'execution:stop', submitWorkflow: 'projects:submit',
  listMySubmissions: 'submissions:mine', listPendingSubmissions: 'submissions:pending', getSubmissionDetail: 'submissions:detail', trialSubmission: 'submissions:trial', approveSubmission: 'submissions:approve', rejectSubmission: 'submissions:reject',
  listAdminCategories: 'categories:admin-list', createCategory: 'categories:create', updateCategory: 'categories:update', deleteCategory: 'categories:delete'
} as const

export function toSafeError(error: unknown): SafeError {
  return {
    code: 'INTERNAL_ERROR',
    message: error instanceof Error ? error.message : 'Unexpected application error'
  }
}
