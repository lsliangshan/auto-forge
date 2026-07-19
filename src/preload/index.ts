import { contextBridge, ipcRenderer } from 'electron'
import type { AutoForgeApi } from '../shared/contracts'
import { ipcChannels as c } from '../shared/ipc'

const api: AutoForgeApi = {
  getSettings: () => ipcRenderer.invoke(c.getSettings), updateSettings: (request) => ipcRenderer.invoke(c.updateSettings, request),
  getSession: () => ipcRenderer.invoke(c.getSession), login: (request) => ipcRenderer.invoke(c.login, request), register: (request) => ipcRenderer.invoke(c.register, request), logout: () => ipcRenderer.invoke(c.logout),
  listCategories: () => ipcRenderer.invoke(c.listCategories), listWorkflows: (query) => ipcRenderer.invoke(c.listWorkflows, query),
  listInstalledWorkflows: () => ipcRenderer.invoke(c.listInstalledWorkflows), installWorkflow: (request) => ipcRenderer.invoke(c.installWorkflow, request), runWorkflow: (request) => ipcRenderer.invoke(c.runWorkflow, request),
  listWorkflowProjects: () => ipcRenderer.invoke(c.listWorkflowProjects), createWorkflowProject: (request) => ipcRenderer.invoke(c.createWorkflowProject, request), openWorkflowProject: () => ipcRenderer.invoke(c.openWorkflowProject),
  buildWorkflowProject: (request) => ipcRenderer.invoke(c.buildWorkflowProject, request), watchWorkflowProject: (request) => ipcRenderer.invoke(c.watchWorkflowProject, request), stopWatchingWorkflowProject: (request) => ipcRenderer.invoke(c.stopWatchingWorkflowProject, request),
  openProjectEditor: (request) => ipcRenderer.invoke(c.openProjectEditor, request), debugWorkflow: (request) => ipcRenderer.invoke(c.debugWorkflow, request), stopExecution: (executionId) => ipcRenderer.invoke(c.stopExecution, executionId), submitWorkflow: (projectId) => ipcRenderer.invoke(c.submitWorkflow, projectId),
  listMySubmissions: () => ipcRenderer.invoke(c.listMySubmissions), listPendingSubmissions: () => ipcRenderer.invoke(c.listPendingSubmissions), getSubmissionDetail: (id) => ipcRenderer.invoke(c.getSubmissionDetail, id), trialSubmission: (id, targetUrl) => ipcRenderer.invoke(c.trialSubmission, { id, targetUrl }), approveSubmission: (id) => ipcRenderer.invoke(c.approveSubmission, id), rejectSubmission: (id, comment) => ipcRenderer.invoke(c.rejectSubmission, { id, comment }),
  listAdminCategories: () => ipcRenderer.invoke(c.listAdminCategories), createCategory: (input) => ipcRenderer.invoke(c.createCategory, input), updateCategory: (id, input) => ipcRenderer.invoke(c.updateCategory, { id, input }), deleteCategory: (id) => ipcRenderer.invoke(c.deleteCategory, id)
}
contextBridge.exposeInMainWorld('autoForge', api)
