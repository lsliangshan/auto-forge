<template>
  <aside
    data-testid="inspector-panel"
    :data-open="open"
    :class="['inspector', { open }]"
    aria-label="检查器"
  >
    <header>
      <div><span class="af-panel-heading">检查器</span><strong>{{ inspectorTitle }}</strong></div>
      <button
        aria-label="关闭检查器"
        @click="$emit('close')"
      >
        <el-icon><Close /></el-icon>
      </button>
    </header>
    <div class="inspector-content af-scrollbar">
      <template v-if="route.name === 'knowledge'">
        <div v-if="knowledge.versionsLoading" class="inspector-state">正在加载版本…</div>
        <template v-else-if="knowledge.selectedDocument">
          <section>
            <span class="af-panel-heading">文件</span>
            <p class="breakable">{{ knowledge.selectedDocument.name }}</p>
            <p class="muted">{{ knowledge.selectedDocument.mimeType }}</p>
          </section>
          <section>
            <span class="af-panel-heading">处理与索引</span>
            <p>{{ knowledgeDocumentStatus }}</p>
            <p class="muted">处理位置：{{ knowledge.selectedBase?.kind === 'cloud' ? 'CloudBase' : '本机' }}</p>
            <p class="muted">检索：{{ knowledgeRetrievalStatus }}</p>
            <p
              v-if="knowledge.selectedBase?.kind === 'cloud'"
              class="muted"
            >
              TokenHub（广州）：{{ embeddingConsentLabel }}
            </p>
          </section>
          <section>
            <span class="af-panel-heading">不可变版本</span>
            <ol v-if="knowledge.versions.length" class="version-list">
              <li v-for="version in knowledge.versions" :key="version.id">
                <span>版本 {{ version.number }}</span>
                <small>{{ versionStatusLabel(version.status) }} · {{ new Date(version.createdAt).toLocaleString('zh-CN') }}</small>
              </li>
            </ol>
            <p v-else class="muted">暂无可见版本</p>
          </section>
          <section v-if="knowledge.selectedDocument.status === 'failed'" class="knowledge-error-detail">
            <span class="af-panel-heading">可操作错误</span>
            <p v-if="hasReadyVersion">新版本处理失败，原有已就绪版本仍可用；可替换文件重试，或移入回收站。</p>
            <p v-else>处理失败，当前没有可检索的已就绪版本；可替换文件重试，或移入回收站。</p>
          </section>
          <section v-if="knowledge.operationError" class="knowledge-error-detail" role="alert">
            <span class="af-panel-heading">操作失败</span><p>{{ knowledge.operationError }}</p>
          </section>
        </template>
        <div v-else class="inspector-state">选择文件后查看元数据、版本、同步和错误状态。</div>
      </template>
      <template v-else-if="route.name === 'executions' || execution.selectedId">
        <div
          v-if="execution.selectedDetailLoading"
          class="inspector-state"
        >
          正在加载执行详情…
        </div>
        <div
          v-else-if="execution.selectedDetailError"
          class="inspector-error"
          role="alert"
        >
          {{ execution.selectedDetailError }}
        </div>
        <template v-else-if="execution.selectedDetail">
          <section><span class="af-panel-heading">状态</span><p>{{ statusLabel(execution.selectedDetail.status) }}</p></section>
          <section>
            <span class="af-panel-heading">工作流</span><p class="breakable">
              {{ execution.selectedDetail.workflowId }} · {{ execution.selectedDetail.workflowVersion }}
            </p>
          </section>
          <section>
            <span class="af-panel-heading">输入</span><pre class="data-preview">{{ formatData(execution.selectedDetail.input) }}</pre>
          </section>
          <section>
            <span class="af-panel-heading">输出</span><pre class="data-preview">{{ formatData(execution.selectedDetail.output) }}</pre>
          </section>
          <section v-if="execution.selectedDetail.error">
            <span class="af-panel-heading">错误</span><p class="execution-error">
              {{ execution.selectedDetail.error.code }} · {{ execution.selectedDetail.error.message }}
            </p>
          </section>
          <section>
            <span class="af-panel-heading">步骤</span>
            <ol
              v-if="execution.selectedDetail.steps.length"
              class="step-list"
            >
              <li
                v-for="step in execution.selectedDetail.steps"
                :key="step.id"
              >
                <span :class="['af-status-dot', step.status === 'completed' ? 'success' : step.status === 'failed' ? 'danger' : 'warning']" />{{ step.label }}
              </li>
            </ol>
            <p
              v-else
              class="muted"
            >
              暂无步骤
            </p>
          </section>
          <section>
            <span class="af-panel-heading">实时日志</span>
            <div
              v-if="execution.selectedDetail.logs.length"
              class="logs"
            >
              <p
                v-for="log in execution.selectedDetail.logs"
                :key="log.id"
              >
                <b>{{ log.level }}</b> {{ log.message }}
              </p>
            </div>
            <p
              v-else
              class="muted"
            >
              暂无日志
            </p>
          </section>
          <el-button
            v-if="isCancellable"
            type="danger"
            plain
            @click="execution.cancel(execution.selectedId)"
          >
            取消执行
          </el-button>
        </template>
        <div
          v-else
          class="inspector-state"
        >
          选择一条执行记录查看参数、步骤、日志和结果。
        </div>
      </template>
      <template v-else-if="route.name === 'chat'">
        <section><span class="af-panel-heading">当前任务</span><p>{{ chat.isRunning ? '模型正在处理当前请求' : '暂无运行中的请求' }}</p></section>
        <section>
          <span class="af-panel-heading">使用提示</span><p class="muted">
            工作流运行时，参数、步骤和实时日志会显示在这里。
          </p>
        </section>
      </template>
      <template v-else-if="route.name === 'workflows'">
        <div
          v-if="workflow.detailLoading"
          class="inspector-state"
        >
          正在加载工作流详情…
        </div>
        <template v-else-if="workflow.selectedDetail">
          <section><span class="af-panel-heading">工作流</span><p>{{ workflow.selectedDetail.name }} · {{ workflow.selectedDetail.version }}</p></section>
          <section><span class="af-panel-heading">Manifest</span><p class="breakable">{{ workflow.selectedDetail.id }}<br>{{ workflow.selectedDetail.author }} · {{ workflow.selectedDetail.category }} · {{ workflow.selectedDetail.source === 'installed' ? '已安装' : '开发中' }}</p></section>
          <section><span class="af-panel-heading">代码 Hash</span><p class="breakable hash">{{ workflow.selectedDetail.codeSha256 ?? '未提供' }}</p></section>
          <section>
            <span class="af-panel-heading">权限</span>
            <ul
              v-if="workflow.selectedDetail.permissions.length"
              class="permission-list"
            >
              <li
                v-for="permission in workflow.selectedDetail.permissions"
                :key="`${permission.capability}:${JSON.stringify(permission.scope)}`"
              >
                {{ permission.capability }}<small>{{ formatScope(permission.scope) }}</small>
              </li>
            </ul>
            <p
              v-else
              class="muted"
            >
              未声明宿主权限
            </p>
          </section>
          <section><span class="af-panel-heading">超时限制</span><p>{{ workflow.selectedDetail.timeoutMs }} ms</p></section>
          <section><span class="af-panel-heading">最近执行</span><ul v-if="workflow.recentExecutions[workflow.selectedKey]?.length" class="recent-list"><li v-for="item in workflow.recentExecutions[workflow.selectedKey]" :key="item.id">{{ statusLabel(item.status) }}<small>{{ new Date(item.createdAt).toLocaleString('zh-CN') }}</small></li></ul><p v-else class="muted">暂无执行记录</p></section>
        </template>
        <template v-else>
          <section><span class="af-panel-heading">工作流状态</span><p>共 {{ workflow.items.length }} 个真实本地工作流</p></section>
          <section>
            <span class="af-panel-heading">完整性</span><p class="muted">
              完整性校验失败的工作流会被停用，无法执行。
            </p>
          </section>
        </template>
      </template>
      <template v-else-if="route.name === 'developer'">
        <DebugPanel />
      </template>
      <template v-else>
        <div class="inspector-state">
          暂无可显示的检查器内容。
        </div>
      </template>
    </div>
  </aside>
</template>

<script setup lang="ts">
import { Close } from '@element-plus/icons-vue'
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { useChatStore } from '../stores/chat'
import { useExecutionStore } from '../stores/execution'
import { useKnowledgeStore } from '../stores/knowledge'
import { useWorkflowStore } from '../stores/workflow'
import DebugPanel from './developer/DebugPanel.vue'

defineProps<{ open: boolean }>()
defineEmits<{ close: [] }>()
const route = useRoute()
const chat = useChatStore()
const execution = useExecutionStore()
const knowledge = useKnowledgeStore()
const workflow = useWorkflowStore()
const inspectorTitle = computed(() => route.name === 'knowledge' ? '文件详情' : route.name === 'executions' ? '执行详情' : route.name === 'workflows' ? '工作流信息' : route.name === 'developer' ? '开发输出' : '任务详情')
const knowledgeDocumentStatus = computed(() => ({
  queued: '排队中', copying: '复制中', uploading: '上传中', parsing: '解析中', indexing: '索引中',
  ready: '已就绪', failed: '处理失败', paused: '已暂停', deleted: '已删除',
})[knowledge.selectedDocument?.status ?? 'ready'])
const hasReadyVersion = computed(() => knowledge.versions.some(({ status }) => status === 'ready'))
const embeddingConsentLabel = computed(() => ({
  unknown: '未选择', granted: '已同意', denied: '未同意', revoked: '已撤回',
})[knowledge.consent?.embedding.status ?? 'unknown'])
const knowledgeRetrievalStatus = computed(() => {
  const base = knowledge.selectedBase
  const document = knowledge.selectedDocument
  if (!base || !document) return '不可用'
  if (document.status === 'deleted') return '不可检索（文件已删除）'
  if (base.status === 'read_only') return '不可检索（只读保留）'
  if (!knowledge.entitlement
    || !['active', 'offline_grace'].includes(knowledge.entitlement.status)) {
    return knowledge.entitlement?.status === 'expired'
      ? '不可检索（会员已过期）'
      : '不可检索（权益不可用）'
  }
  const scopeAvailable = base.kind === 'local'
    ? knowledge.availability?.local.available
    : knowledge.availability?.cloud.available && knowledge.entitlement.cloudEnabled
  if (!scopeAvailable) return '不可检索（当前范围不可用）'
  if (!base.searchable || !hasReadyVersion.value) return '不可检索（没有已就绪版本）'
  if (document.status === 'failed') return '仅原有已就绪版本可检索'
  if (base.status === 'processing') {
    return base.kind === 'cloud'
      ? '同步中，仅已发布版本可检索'
      : '本地处理中，仅已发布版本可检索'
  }
  if (base.status === 'paused') {
    return base.kind === 'cloud'
      ? '同步已暂停，仅已发布版本可检索'
      : '本地处理已暂停，仅已发布版本可检索'
  }
  if (base.kind === 'local') return '仅本地关键词检索'
  if (knowledge.consent?.embedding.retrievalMode === 'hybrid') return '已同步 · 混合检索'
  if (knowledge.consent?.embedding.retrievalMode === 'reindexing') return '已同步 · 向量重建中，暂用关键词检索'
  return '关键词检索'
})
const versionStatusLabel = (status: string) => ({ staging: '处理中', ready: '已就绪', failed: '失败', retired: '已退役' })[status] ?? status
const isCancellable = computed(() => execution.selectedDetail && ['queued', 'awaiting_approval', 'running'].includes(execution.selectedDetail.status))
const statusLabel = (status: string) => ({ queued: '排队中', awaiting_approval: '等待授权', running: '执行中', completed: '已完成', failed: '失败', cancelled: '已取消', interrupted: '已中断' })[status] ?? status
const formatScope = (scope: { origins?: string[]; paths?: string[] }) => scope.origins?.join('、') ?? scope.paths?.join('、') ?? '无附加范围'
const formatData = (value: unknown) => {
  if (value === undefined) return '—'
  try { return JSON.stringify(value, null, 2) }
  catch { return '无法显示' }
}
</script>

<style scoped>
.inspector { display: none; width: 320px; min-width: 320px; height: 100%; border-left: 1px solid var(--af-border); background: var(--af-surface); }
.inspector.open { display: block; }
.inspector header { display: flex; min-height: 58px; align-items: center; justify-content: space-between; border-bottom: 1px solid var(--af-border); padding: 9px 14px; }
.inspector header > div { display: grid; gap: 2px; }.inspector header strong { font-size: 14px; }
.inspector header button { display: grid; width: 30px; height: 30px; place-items: center; border: 0; border-radius: 5px; color: var(--af-text-muted); background: transparent; cursor: pointer; }
.inspector-content { height: calc(100% - 58px); padding: 16px; overflow: auto; }
.inspector section { border-bottom: 1px solid var(--af-border); padding: 2px 0 14px; }.inspector section + section { padding-top: 14px; }
.inspector p { margin: 7px 0 0; font-size: 13px; line-height: 1.5; }.muted { color: var(--af-text-muted); }.breakable { overflow-wrap: anywhere; }
.step-list { display: grid; gap: 8px; margin: 10px 0 0; padding: 0; list-style: none; }.step-list li { display: flex; align-items: center; gap: 8px; font-size: 12px; }
.logs { max-height: 240px; margin-top: 8px; overflow: auto; color: #cfd7e3; background: #242a32; }.logs p { margin: 0; border-bottom: 1px solid #353d48; padding: 7px 8px; font-family: ui-monospace, monospace; font-size: 11px; overflow-wrap: anywhere; }.logs b { color: #8fb4ff; }
.data-preview { max-height: 220px; margin: 8px 0 0; padding: 8px; overflow: auto; color: var(--af-text); background: var(--af-surface-muted); font-family: ui-monospace, monospace; font-size: 11px; white-space: pre-wrap; overflow-wrap: anywhere; }.execution-error, .inspector-error { color: var(--af-danger); }.inspector-error { padding: 18px 10px; font-size: 12px; }
.permission-list { display: grid; gap: 8px; margin: 9px 0 0; padding: 0; list-style: none; }.permission-list li { font-family: ui-monospace, monospace; font-size: 11px; overflow-wrap: anywhere; }.permission-list small { display: block; margin-top: 2px; color: var(--af-text-muted); font-family: inherit; }
.hash { font-family: ui-monospace, monospace; font-size: 10px !important; }.recent-list { display: grid; gap: 7px; margin: 9px 0 0; padding: 0; list-style: none; }.recent-list li { display: flex; justify-content: space-between; gap: 8px; font-size: 11px; }.recent-list small { color: var(--af-text-muted); }
.inspector-state { padding: 36px 10px; color: var(--af-text-muted); font-size: 13px; line-height: 1.6; text-align: center; }
.version-list { display: grid; gap: 8px; margin: 9px 0 0; padding: 0; list-style: none; }.version-list li { display: grid; gap: 2px; font-size: 12px; }.version-list small { color: var(--af-text-muted); font-size: 10px; }.knowledge-error-detail p { color: var(--af-danger); }
@media (max-width: 1179px) {
  .inspector { position: fixed; z-index: 25; top: 0; right: 0; box-shadow: -12px 0 28px rgb(25 32 44 / 16%); }
  .inspector.open { display: block; }
}
</style>
