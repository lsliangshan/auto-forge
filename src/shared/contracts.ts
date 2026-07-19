import type { CategorySummary, Page, WorkflowManifest, WorkflowSummary } from '@autoforge/workflow-contracts'

export type ThemePreference = 'light' | 'dark' | 'system'

export interface AppSettings {
  theme: ThemePreference
  downloadDirectory: string
  apiBaseUrl: string
}

export interface UpdateSettingsRequest {
  theme?: ThemePreference
  downloadDirectory?: string
  apiBaseUrl?: string
}

export interface SafeError {
  code: string
  message: string
}

export interface SessionUser { id: string; email: string; displayName: string; role: 'USER' | 'ADMIN' }
export interface SessionState { user: SessionUser | null }
export interface AuthRequest { email: string; password: string; displayName?: string }
export interface WorkflowQuery { page?: number; pageSize?: number; search?: string; category?: string }
export interface WorkflowProject {
  id: string; path: string; slug: string; name: string; version: string
  status: 'READY' | 'BUILDING' | 'ERROR' | 'WATCHING'; codeSha256?: string; buildError?: string; updatedAt: string
}
export interface CreateWorkflowProjectRequest { parentDirectory?: string; manifest: WorkflowManifest }
export interface BuildWorkflowProjectRequest { projectId: string }
export interface DebugWorkflowRequest { projectId: string; targetUrl: string }
export interface InstallWorkflowRequest { workflowId: string; version: string }
export interface RunWorkflowRequest { workflowId: string; targetUrl: string }
export interface ExecutionResult { executionId: string; status: 'RUNNING' | 'COMPLETED' | 'FAILED' | 'ABORTED'; result?: unknown; error?: string }
export interface InstalledWorkflow { workflowId: string; slug: string; version: string; installedAt: string }
export interface SubmissionSummary { id: string; workflowId: string; version: string; revision: number; status: string; serverCodeSha256: string; reviewComment?: string; createdAt: string; workflow?: { name: string } }
export interface SubmissionDetail extends SubmissionSummary { source: string; manifest: WorkflowManifest; clientCodeSha256?: string; history: Array<{ id: string; revision: number; status: string; reviewComment?: string; createdAt: string }> }
export interface CategoryMutation { slug?: string; name?: string; sortOrder?: number; active?: boolean }

export interface AutoForgeApi {
  getSettings(): Promise<AppSettings>
  updateSettings(request: UpdateSettingsRequest): Promise<AppSettings>
  getSession(): Promise<SessionState>
  login(request: AuthRequest): Promise<SessionState>
  register(request: AuthRequest): Promise<SessionState>
  logout(): Promise<void>
  listCategories(): Promise<CategorySummary[]>
  listWorkflows(query?: WorkflowQuery): Promise<Page<WorkflowSummary>>
  listInstalledWorkflows(): Promise<InstalledWorkflow[]>
  installWorkflow(request: InstallWorkflowRequest): Promise<InstalledWorkflow>
  runWorkflow(request: RunWorkflowRequest): Promise<ExecutionResult>
  listWorkflowProjects(): Promise<WorkflowProject[]>
  createWorkflowProject(request: CreateWorkflowProjectRequest): Promise<WorkflowProject | null>
  openWorkflowProject(): Promise<WorkflowProject | null>
  buildWorkflowProject(request: BuildWorkflowProjectRequest): Promise<WorkflowProject>
  watchWorkflowProject(request: BuildWorkflowProjectRequest): Promise<WorkflowProject>
  stopWatchingWorkflowProject(request: BuildWorkflowProjectRequest): Promise<void>
  openProjectEditor(request: BuildWorkflowProjectRequest): Promise<void>
  debugWorkflow(request: DebugWorkflowRequest): Promise<ExecutionResult>
  stopExecution(executionId: string): Promise<void>
  submitWorkflow(projectId: string): Promise<SubmissionSummary>
  listMySubmissions(): Promise<SubmissionSummary[]>
  listPendingSubmissions(): Promise<SubmissionSummary[]>
  getSubmissionDetail(id: string): Promise<SubmissionDetail>
  trialSubmission(id: string, targetUrl: string): Promise<ExecutionResult>
  approveSubmission(id: string): Promise<void>
  rejectSubmission(id: string, comment: string): Promise<void>
  listAdminCategories(): Promise<CategorySummary[]>
  createCategory(input: CategoryMutation): Promise<CategorySummary>
  updateCategory(id: string, input: CategoryMutation): Promise<CategorySummary>
  deleteCategory(id: string): Promise<void>
}
