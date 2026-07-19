<template>
  <div class="developer-files">
    <div class="project-actions">
      <el-input v-model="projectName" size="small" placeholder="新项目名称" aria-label="新项目名称" @keyup.enter="create" />
      <el-button size="small" type="primary" :disabled="!projectName.trim()" @click="create">创建</el-button>
      <el-button size="small" @click="developer.registerProject">导入</el-button>
    </div>
    <p v-if="developer.error" class="sidebar-error" role="alert">{{ developer.error }}</p>
    <p v-else-if="developer.loading" class="sidebar-state">正在加载项目…</p>
    <p v-else-if="!developer.projects.length" class="sidebar-state">尚无本地项目<br><small>创建或导入一个工作流项目</small></p>
    <div v-for="project in developer.projects" v-else :key="project.id" class="project-group">
      <button :class="['project-row', { active: project.id === developer.selectedProjectId }]" @click="developer.selectProject(project.id)">
        <span class="af-truncate">{{ project.name }}</span><small>{{ project.status }}</small>
      </button>
      <ul v-if="project.id === developer.selectedProjectId" class="file-list">
        <li v-for="file in project.files" :key="file">
          <button :class="{ active: file === developer.selectedPath }" :title="file" @click="developer.selectFile(file)">
            <span>{{ file === 'workflow.json' ? '{}' : '·' }}</span><span class="af-truncate">{{ file }}</span>
          </button>
        </li>
      </ul>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useDeveloperStore } from '../../stores/developer'

const developer = useDeveloperStore()
const projectName = ref('')
async function create() {
  const name = projectName.value.trim()
  if (!name) return
  await developer.createProject(name)
  projectName.value = ''
}
</script>

<style scoped>
.developer-files { display: grid; gap: 8px; min-height: 0; }
.project-actions { display: grid; grid-template-columns: 1fr auto; gap: 6px; }.project-actions .el-button:last-child { grid-column: 1 / -1; margin: 0; }
.project-group { border-top: 1px solid var(--af-border); padding-top: 7px; }
.project-row, .file-list button { display: flex; width: 100%; align-items: center; border: 0; border-radius: 5px; color: var(--af-text); background: transparent; cursor: pointer; text-align: left; }
.project-row { justify-content: space-between; gap: 8px; padding: 7px; font-weight: 650; }.project-row small { color: var(--af-text-muted); font-size: 9px; text-transform: uppercase; }
.project-row.active, .file-list button.active { color: var(--af-primary); background: var(--af-primary-soft); }
.file-list { display: grid; gap: 2px; margin: 4px 0 0; padding: 0; list-style: none; }.file-list button { gap: 6px; padding: 6px 8px 6px 14px; font-family: ui-monospace, monospace; font-size: 11px; }
.sidebar-error { margin: 0; color: var(--af-danger); font-size: 12px; }.sidebar-state { margin: 12px 0; color: var(--af-text-muted); font-size: 12px; line-height: 1.6; text-align: center; }
</style>
