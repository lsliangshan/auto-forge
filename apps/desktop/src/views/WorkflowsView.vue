<template>
  <section class="page workflows-page">
    <div class="page-toolbar">
      <div><strong>本地工作流</strong><span>{{ workflow.items.length }} 个</span></div>
      <div>
        <el-button
          :icon="Refresh"
          :loading="workflow.loading"
          @click="workflow.load()"
        >
          刷新
        </el-button><el-button
          type="primary"
          :icon="Upload"
          :loading="workflow.importing"
          @click="workflow.importProject"
        >
          {{ importLabel }}
        </el-button>
      </div>
    </div>
    <div
      v-if="workflow.error"
      class="af-error"
      role="alert"
    >
      <strong>工作流加载失败</strong><p>{{ workflow.error }}</p><el-button
        size="small"
        @click="workflow.load()"
      >
        重试
      </el-button>
    </div>
    <div
      v-if="workflow.loading && !workflow.items.length"
      class="af-empty"
    >
      正在加载工作流…
    </div>
    <div
      v-else-if="!workflow.error && !workflow.items.length"
      class="af-empty"
    >
      <div>
        <h2>尚未安装工作流</h2><p>从本地 TypeScript 工作流项目导入；不会加载示例或远程数据。</p><el-button
          type="primary"
          @click="workflow.importProject"
        >
          选择本地项目
        </el-button>
      </div>
    </div>
    <div
      v-else
      class="workflow-list"
    >
      <article
        v-for="item in workflow.items"
        :key="`${item.id}@${item.version}`"
        class="workflow-row"
      >
        <div class="workflow-icon">
          <el-icon><Operation /></el-icon>
        </div>
        <button
          class="workflow-main"
          :aria-label="`查看${item.name}详情`"
          @click="workflow.select(item)"
        >
          <div class="workflow-title">
            <strong class="af-truncate">{{ item.name }}</strong><span>{{ item.version }}</span>
          </div>
          <p>{{ item.description }}</p>
          <div class="workflow-meta">
            <span>{{ item.source === 'installed' ? '已安装' : '开发中' }}</span>
            <span>{{ item.category }}</span>
            <span :class="integrityClass(item.integrity)">{{ integrityLabel(item.integrity) }}</span>
            <span :class="item.enabled && item.integrity !== 'failed' ? 'enabled' : 'disabled'">{{ item.enabled && item.integrity !== 'failed' ? '已启用' : '已停用' }}</span>
          </div>
        </button>
        <div class="workflow-actions">
          <el-switch
            :model-value="item.enabled && item.integrity !== 'failed'"
            :disabled="item.source !== 'installed' || item.integrity === 'failed'"
            :aria-label="`${item.name}启用状态`"
            @change="workflow.setEnabled(item, Boolean($event))"
          />
          <el-button
            v-if="item.source === 'installed'"
            type="danger"
            text
            data-testid="remove-workflow"
            @click="confirmRemove(item)"
          >
            移除
          </el-button>
        </div>
      </article>
    </div>
  </section>
</template>

<script setup lang="ts">
import { Operation, Refresh, Upload } from '@element-plus/icons-vue'
import { ElMessageBox } from 'element-plus'
import type { WorkflowSummary } from '@autoforge/shared'
import { computed, onMounted } from 'vue'
import { useWorkflowStore } from '../stores/workflow'

const workflow = useWorkflowStore()
const importLabel = computed(() => workflow.importStage
  ? ({ registering: '选择项目…', building: '正在构建…', validating: '正在校验…', installing: '正在安装…' })[workflow.importStage]
  : '导入项目')
onMounted(() => { if (!workflow.items.length && !workflow.loading) void workflow.load() })
const integrityLabel = (value: WorkflowSummary['integrity']) => ({ valid: '完整性通过', failed: '完整性失败', unchecked: '未校验' })[value]
const integrityClass = (value: WorkflowSummary['integrity']) => value === 'valid' ? 'enabled' : value === 'failed' ? 'failed' : 'disabled'
async function confirmRemove(item: WorkflowSummary) {
  try {
    await ElMessageBox.confirm(`将从本机移除“${item.name}” ${item.version}，开发项目不会被删除。`, '移除工作流', { confirmButtonText: '确认移除', cancelButtonText: '取消', type: 'warning' })
    await workflow.remove(item)
  } catch (error) {
    if (error !== 'cancel' && error !== 'close') return
  }
}
</script>

<style scoped>
.page { padding: 18px; }.page-toolbar { display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px; }.page-toolbar > div { display: flex; align-items: center; gap: 9px; }.page-toolbar span { color: var(--af-text-muted); font-size: 0.75rem; }
.workflow-list { border: 1px solid var(--af-border); background: var(--af-surface); }.workflow-row { display: grid; grid-template-columns: 38px minmax(0, 1fr) auto; gap: 12px; align-items: center; padding: 15px; }.workflow-row + .workflow-row { border-top: 1px solid var(--af-border); }.workflow-row:hover { background: var(--af-hover); }
.workflow-icon { display: grid; width: 34px; height: 34px; place-items: center; border-radius: 7px; color: var(--af-cobalt); background: var(--af-cobalt-soft); }.workflow-main { min-width: 0; border: 0; padding: 0; color: inherit; background: transparent; cursor: pointer; text-align: left; }.workflow-title { display: flex; align-items: center; gap: 8px; }.workflow-title span { color: var(--af-text-muted); font-family: ui-monospace, monospace; font-size: 0.6875rem; }.workflow-main p { margin: 5px 0 8px; color: var(--af-text-muted); font-size: 0.75rem; overflow-wrap: anywhere; }
.workflow-meta { display: flex; flex-wrap: wrap; gap: 10px; font-size: 0.6875rem; }.workflow-meta span { color: var(--af-text-muted); }.workflow-meta .enabled { color: var(--af-success); }.workflow-meta .failed { color: var(--af-danger); }.workflow-meta .disabled { color: var(--af-warning); }.workflow-actions { display: flex; align-items: center; gap: 6px; }
.af-error p { margin: 5px 0 10px; }.af-empty h2 { color: var(--af-graphite); font-size: 1.125rem; }.af-empty p { font-size: 0.8125rem; }
</style>
