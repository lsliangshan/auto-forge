<template>
  <section class="page workflows-page">
    <div class="workflow-overview">
      <div class="overview-copy">
        <span class="overview-eyebrow">LOCAL AUTOMATION</span>
        <div class="overview-title">
          <strong>本地工作流</strong><span>{{ workflow.items.length }} 项</span>
        </div>
        <p>集中管理可调用的自动化能力、适用城市与运行状态。</p>
      </div>
      <div
        class="overview-stats"
        aria-label="工作流概览"
      >
        <div><strong>{{ enabledCount }}</strong><span>可用</span></div>
        <div><strong>{{ citySpecificCount }}</strong><span>城市专属</span></div>
      </div>
      <div class="toolbar-actions">
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
        :class="{
          selected: workflow.selectedKey === `${item.id}@${item.version}`,
          unavailable: item.integrity === 'failed',
        }"
      >
        <div class="workflow-icon">
          <el-icon><Operation /></el-icon>
        </div>
        <button
          class="workflow-main"
          :aria-label="`查看${item.name}详情`"
          :aria-pressed="workflow.selectedKey === `${item.id}@${item.version}`"
          @click="workflow.select(item)"
        >
          <div class="workflow-title">
            <strong class="af-truncate">{{ item.name }}</strong><span>v{{ item.version }}</span>
          </div>
          <p>{{ item.description }}</p>
          <div class="workflow-meta">
            <span>{{ item.source === 'installed' ? '已安装' : '开发中' }}</span>
            <span>{{ item.category }}</span>
            <span
              class="workflow-city"
              :data-testid="`workflow-city-${item.id}`"
              :title="fullCityLabel(item)"
              :aria-label="`适用城市：${fullCityLabel(item)}`"
            ><el-icon><LocationInformation /></el-icon>{{ cityLabel(item) }}</span>
            <span :class="integrityClass(item.integrity)">{{ integrityLabel(item.integrity) }}</span>
          </div>
        </button>
        <div class="workflow-actions">
          <span :class="['workflow-state', item.enabled && item.integrity !== 'failed' ? 'enabled' : 'disabled']">
            <i />{{ item.enabled && item.integrity !== 'failed' ? '已启用' : '已停用' }}
          </span>
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
import { LocationInformation, Operation, Refresh, Upload } from '@element-plus/icons-vue'
import { ElMessageBox } from 'element-plus'
import type { WorkflowSummary } from '@autoforge/shared'
import { computed, onMounted } from 'vue'
import { useWorkflowStore } from '../stores/workflow'

const workflow = useWorkflowStore()
const importLabel = computed(() => workflow.importStage
  ? ({ registering: '选择项目…', building: '正在构建…', validating: '正在校验…', installing: '正在安装…' })[workflow.importStage]
  : '导入项目')
const enabledCount = computed(() => workflow.items.filter((item) => item.enabled && item.integrity !== 'failed').length)
const citySpecificCount = computed(() => workflow.items.filter((item) => item.cities.length > 0).length)
onMounted(() => { if (!workflow.items.length && !workflow.loading) void workflow.load() })
const integrityLabel = (value: WorkflowSummary['integrity']) => ({ valid: '完整性通过', failed: '完整性失败', unchecked: '未校验' })[value]
const integrityClass = (value: WorkflowSummary['integrity']) => value === 'valid' ? 'enabled' : value === 'failed' ? 'failed' : 'disabled'
const fullCityLabel = (item: WorkflowSummary) => item.cities.length ? item.cities.join('、') : '不限城市'
const cityLabel = (item: WorkflowSummary) => item.cities.length > 2
  ? `${item.cities.slice(0, 2).join('、')}等 ${item.cities.length} 城`
  : fullCityLabel(item)
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
.page { padding: 20px 22px 28px; }
.workflow-overview { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; align-items: center; gap: 24px; margin-bottom: 18px; border: 1px solid var(--af-border); border-radius: 16px; padding: 18px 20px; background: linear-gradient(118deg, var(--af-surface) 0%, var(--af-surface) 64%, color-mix(in srgb, var(--af-cobalt-soft) 54%, var(--af-surface)) 100%); box-shadow: 0 10px 30px rgb(32 36 43 / 5%); }
.overview-copy { min-width: 0; }.overview-eyebrow { display: block; margin-bottom: 5px; color: var(--af-cobalt); font-size: 0.5625rem; font-weight: 750; letter-spacing: .14em; }.overview-title { display: flex; align-items: center; gap: 9px; }.overview-title strong { color: var(--af-graphite); font-size: 1.0625rem; font-weight: 730; letter-spacing: -.015em; }.overview-title span { border: 1px solid var(--af-border); border-radius: 999px; padding: 3px 8px; color: var(--af-text-muted); background: var(--af-surface-muted); font-size: 0.625rem; font-weight: 650; }.overview-copy p { margin: 5px 0 0; color: var(--af-text-muted); font-size: 0.6875rem; line-height: 1.5; }
.overview-stats { display: grid; grid-template-columns: repeat(2, minmax(62px, auto)); border: 1px solid color-mix(in srgb, var(--af-border) 85%, transparent); border-radius: 12px; background: color-mix(in srgb, var(--af-surface) 78%, transparent); }.overview-stats div { display: grid; gap: 2px; padding: 9px 13px; text-align: center; }.overview-stats div + div { border-left: 1px solid var(--af-border); }.overview-stats strong { color: var(--af-graphite); font-size: 1rem; line-height: 1.1; }.overview-stats span { color: var(--af-text-muted); font-size: 0.5625rem; white-space: nowrap; }.toolbar-actions { display: flex; align-items: center; gap: 8px; }.toolbar-actions .el-button { min-height: 38px; margin: 0; border-radius: 9px; font-weight: 650; }.toolbar-actions .el-button--primary { box-shadow: 0 6px 16px color-mix(in srgb, var(--af-cobalt) 20%, transparent); }
.workflow-list { display: grid; gap: 10px; background: transparent; }.workflow-row { position: relative; display: grid; grid-template-columns: 46px minmax(0, 1fr) auto; gap: 14px; align-items: center; overflow: hidden; border: 1px solid var(--af-border); border-radius: 14px; padding: 15px 16px; background: var(--af-surface); box-shadow: 0 4px 16px rgb(32 36 43 / 3%); transition: border-color .16s ease, box-shadow .16s ease, transform .16s ease, background-color .16s ease; }.workflow-row::before { position: absolute; top: 11px; bottom: 11px; left: 0; width: 3px; border-radius: 0 3px 3px 0; background: transparent; content: ''; transition: background-color .16s ease; }.workflow-row:hover { border-color: color-mix(in srgb, var(--af-cobalt) 22%, var(--af-border)); box-shadow: 0 10px 26px rgb(32 36 43 / 7%); transform: translateY(-1px); }.workflow-row.selected { border-color: color-mix(in srgb, var(--af-cobalt) 36%, var(--af-border)); background: linear-gradient(90deg, color-mix(in srgb, var(--af-cobalt-soft) 52%, var(--af-surface)), var(--af-surface) 34%); box-shadow: 0 10px 28px color-mix(in srgb, var(--af-cobalt) 9%, transparent); }.workflow-row.selected::before { background: var(--af-cobalt); }.workflow-row.unavailable { border-color: color-mix(in srgb, var(--af-danger) 18%, var(--af-border)); }
.workflow-icon { display: grid; width: 42px; height: 42px; place-items: center; border: 1px solid color-mix(in srgb, var(--af-cobalt) 16%, var(--af-border)); border-radius: 12px; color: var(--af-cobalt); background: var(--af-cobalt-soft); font-size: 1.0625rem; box-shadow: inset 0 1px rgb(255 255 255 / 38%); }.workflow-row.unavailable .workflow-icon { border-color: color-mix(in srgb, var(--af-danger) 18%, var(--af-border)); color: var(--af-danger); background: var(--af-danger-soft); }
.workflow-main { min-width: 0; border: 0; padding: 0; color: inherit; background: transparent; cursor: pointer; text-align: left; }.workflow-title { display: flex; min-width: 0; align-items: center; gap: 8px; }.workflow-title strong { color: var(--af-graphite); font-size: 0.8125rem; font-weight: 700; }.workflow-title span { flex: none; color: var(--af-text-muted); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.5625rem; }.workflow-main p { margin: 5px 0 9px; color: var(--af-text-muted); font-size: 0.6875rem; line-height: 1.5; overflow-wrap: anywhere; }
.workflow-meta { display: flex; min-width: 0; flex-wrap: wrap; align-items: center; gap: 6px; font-size: 0.5625rem; }.workflow-meta > span { display: inline-flex; max-width: 100%; align-items: center; gap: 4px; border: 1px solid var(--af-border); border-radius: 999px; padding: 3px 7px; color: var(--af-text-muted); background: var(--af-surface-muted); line-height: 1.35; }.workflow-meta .workflow-city { color: var(--af-cobalt); background: color-mix(in srgb, var(--af-cobalt-soft) 64%, var(--af-surface)); }.workflow-meta .workflow-city .el-icon { flex: none; }.workflow-meta .enabled { border-color: color-mix(in srgb, var(--af-success) 16%, var(--af-border)); color: var(--af-success); background: var(--af-success-soft); }.workflow-meta .failed { border-color: color-mix(in srgb, var(--af-danger) 18%, var(--af-border)); color: var(--af-danger); background: var(--af-danger-soft); }.workflow-meta .disabled { color: var(--af-warning); background: var(--af-warning-soft); }
.workflow-actions { display: flex; align-items: center; gap: 10px; padding-left: 4px; }.workflow-state { display: inline-flex; min-width: 47px; align-items: center; gap: 5px; color: var(--af-text-muted); font-size: 0.5625rem; font-weight: 650; }.workflow-state i { width: 6px; height: 6px; border-radius: 50%; background: currentColor; box-shadow: 0 0 0 3px color-mix(in srgb, currentColor 10%, transparent); }.workflow-state.enabled { color: var(--af-success); }.workflow-state.disabled { color: var(--af-warning); }.workflow-actions :deep(.el-switch__core) { border-color: var(--af-border-strong); }.workflow-actions .el-button { margin: 0; border-radius: 8px; }
.af-error { border: 1px solid var(--af-danger-border); border-left-width: 3px; border-radius: 10px; box-shadow: 0 6px 18px color-mix(in srgb, var(--af-danger) 6%, transparent); }.af-error p { margin: 5px 0 10px; }.af-empty { border: 1px dashed var(--af-border-strong); border-radius: 14px; background: color-mix(in srgb, var(--af-surface) 68%, transparent); }.af-empty h2 { color: var(--af-graphite); font-size: 1.125rem; }.af-empty p { font-size: 0.8125rem; }
@media (max-width: 1120px) { .workflow-overview { grid-template-columns: minmax(0, 1fr) auto; gap: 16px; }.overview-stats { display: none; }.workflow-row { grid-template-columns: 42px minmax(0, 1fr); }.workflow-actions { grid-column: 2; justify-content: flex-end; padding-left: 0; } }
</style>
