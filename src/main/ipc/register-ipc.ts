import { dialog, ipcMain, shell } from 'electron'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseWorkflowManifest } from '@autoforge/workflow-contracts'
import type { AuthRequest, BuildWorkflowProjectRequest, CategoryMutation, CreateWorkflowProjectRequest, DebugWorkflowRequest, InstallWorkflowRequest, RunWorkflowRequest, UpdateSettingsRequest, WorkflowQuery } from '../../shared/contracts'
import { ipcChannels, toSafeError } from '../../shared/ipc'
import type { SettingsService } from '../settings/settings-service'
import type { RegistryClient } from '../registry/registry-client'
import type { WorkflowProjectService } from '../workflows/workflow-project-service'
import type { WorkflowInstallationService } from '../installations/workflow-installation-service'
import type { WorkflowExecutionService } from '../runtime/workflow-execution-service'

export interface IpcServices { settings: SettingsService; registry: RegistryClient; projects: WorkflowProjectService; installations: WorkflowInstallationService; executions: WorkflowExecutionService }
const safe = <T extends unknown[], R>(handler: (...args: T) => R) => async (_event: Electron.IpcMainInvokeEvent, ...args: T) => { try { return await handler(...args) } catch (error) { throw new Error(JSON.stringify(toSafeError(error))) } }
const projectId = (input: BuildWorkflowProjectRequest) => { if (!input?.projectId) throw new Error('Project id is required'); return input.projectId }

export function registerIpcHandlers(s: IpcServices): void {
  ipcMain.handle(ipcChannels.getSettings, () => s.settings.get()); ipcMain.handle(ipcChannels.updateSettings, safe((input: UpdateSettingsRequest) => s.settings.update(input)))
  ipcMain.handle(ipcChannels.getSession, () => s.registry.getSession()); ipcMain.handle(ipcChannels.login, safe((input: AuthRequest) => s.registry.login(input))); ipcMain.handle(ipcChannels.register, safe((input: AuthRequest) => s.registry.register(input))); ipcMain.handle(ipcChannels.logout, safe(() => s.registry.logout()))
  ipcMain.handle(ipcChannels.listCategories, safe(() => s.registry.listCategories())); ipcMain.handle(ipcChannels.listWorkflows, safe((query?: WorkflowQuery) => s.registry.listWorkflows(query)))
  ipcMain.handle(ipcChannels.listInstalledWorkflows, () => s.installations.list()); ipcMain.handle(ipcChannels.installWorkflow, safe((input: InstallWorkflowRequest) => s.installations.install(input.workflowId, input.version)))
  ipcMain.handle(ipcChannels.runWorkflow, safe((input: RunWorkflowRequest) => { const installed = s.installations.entry(input.workflowId); return s.executions.start(installed.path, installed.manifest, input.targetUrl) }))
  ipcMain.handle(ipcChannels.listWorkflowProjects, () => s.projects.list())
  ipcMain.handle(ipcChannels.createWorkflowProject, safe(async (input: CreateWorkflowProjectRequest) => { let parent = input.parentDirectory; if (!parent) { const result = await dialog.showOpenDialog({ title: '选择工作流项目保存目录', properties: ['openDirectory', 'createDirectory'] }); parent = result.filePaths[0] } return parent ? s.projects.create(parent, input.manifest) : null }))
  ipcMain.handle(ipcChannels.openWorkflowProject, safe(async () => { const result = await dialog.showOpenDialog({ title: '打开工作流项目', properties: ['openDirectory'] }); return result.filePaths[0] ? s.projects.register(result.filePaths[0]) : null }))
  ipcMain.handle(ipcChannels.buildWorkflowProject, safe((input: BuildWorkflowProjectRequest) => s.projects.build(projectId(input)))); ipcMain.handle(ipcChannels.watchWorkflowProject, safe((input: BuildWorkflowProjectRequest) => s.projects.watch(projectId(input)))); ipcMain.handle(ipcChannels.stopWatchingWorkflowProject, safe((input: BuildWorkflowProjectRequest) => s.projects.stopWatching(projectId(input))))
  ipcMain.handle(ipcChannels.openProjectEditor, safe(async (input: BuildWorkflowProjectRequest) => { const error = await shell.openPath(s.projects.get(projectId(input)).path); if (error) throw new Error(error) }))
  ipcMain.handle(ipcChannels.debugWorkflow, safe(async (input: DebugWorkflowRequest) => { const built = await s.projects.build(input.projectId); const manifest = parseWorkflowManifest(JSON.parse(readFileSync(join(built.path, 'workflow.json'), 'utf8'))); return s.executions.start(s.projects.entryPath(input.projectId), manifest, input.targetUrl) }))
  ipcMain.handle(ipcChannels.stopExecution, safe((id: string) => s.executions.stop(id))); ipcMain.handle(ipcChannels.submitWorkflow, safe(async (id: string) => { const built = await s.projects.build(id); const manifest = parseWorkflowManifest(JSON.parse(readFileSync(join(built.path, 'workflow.json'), 'utf8'))); const remote = await s.registry.createWorkflow(manifest); return s.registry.submit(remote.id, s.projects.sourceArchive(id), built.codeSha256) }))
  ipcMain.handle(ipcChannels.listMySubmissions, safe(() => s.registry.mySubmissions())); ipcMain.handle(ipcChannels.listPendingSubmissions, safe(() => s.registry.pendingSubmissions())); ipcMain.handle(ipcChannels.approveSubmission, safe((id: string) => s.registry.approve(id))); ipcMain.handle(ipcChannels.rejectSubmission, safe((input: { id: string; comment: string }) => s.registry.reject(input.id, input.comment)))
  ipcMain.handle(ipcChannels.getSubmissionDetail, safe((id: string) => s.registry.submission(id)))
  ipcMain.handle(ipcChannels.trialSubmission, safe(async (input: { id: string; targetUrl: string }) => { const detail = await s.registry.submission(input.id); return s.executions.startSource(detail.source, parseWorkflowManifest(detail.manifest), input.targetUrl) }))
  ipcMain.handle(ipcChannels.listAdminCategories, safe(() => s.registry.adminCategories())); ipcMain.handle(ipcChannels.createCategory, safe((input: CategoryMutation) => s.registry.createCategory(input))); ipcMain.handle(ipcChannels.updateCategory, safe((payload: { id: string; input: CategoryMutation }) => s.registry.updateCategory(payload.id, payload.input))); ipcMain.handle(ipcChannels.deleteCategory, safe((id: string) => s.registry.deleteCategory(id)))
}
