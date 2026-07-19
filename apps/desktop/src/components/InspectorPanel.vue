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
      <template v-if="route.name === 'executions' || execution.selectedId">
        <div
          v-if="execution.detailLoading"
          class="inspector-state"
        >
          正在加载执行详情…
        </div>
        <template v-else-if="execution.selectedDetail">
          <section><span class="af-panel-heading">状态</span><p>{{ statusLabel(execution.selectedDetail.status) }}</p></section>
          <section>
            <span class="af-panel-heading">工作流</span><p class="breakable">
              {{ execution.selectedDetail.workflowId }} · {{ execution.selectedDetail.workflowVersion }}
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
      <template v-else>
        <div class="inspector-state">
          Task 11 将在这里显示校验问题、调试日志与结果。
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
import { useWorkflowStore } from '../stores/workflow'

defineProps<{ open: boolean }>()
defineEmits<{ close: [] }>()
const route = useRoute()
const chat = useChatStore()
const execution = useExecutionStore()
const workflow = useWorkflowStore()
const inspectorTitle = computed(() => route.name === 'executions' ? '执行详情' : route.name === 'workflows' ? '工作流信息' : route.name === 'developer' ? '开发输出' : '任务详情')
const isCancellable = computed(() => execution.selectedDetail && ['queued', 'awaiting_approval', 'running'].includes(execution.selectedDetail.status))
const statusLabel = (status: string) => ({ queued: '排队中', awaiting_approval: '等待授权', running: '执行中', completed: '已完成', failed: '失败', cancelled: '已取消', interrupted: '已中断' })[status] ?? status
const formatScope = (scope: { origins?: string[]; paths?: string[] }) => scope.origins?.join('、') ?? scope.paths?.join('、') ?? '无附加范围'
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
.permission-list { display: grid; gap: 8px; margin: 9px 0 0; padding: 0; list-style: none; }.permission-list li { font-family: ui-monospace, monospace; font-size: 11px; overflow-wrap: anywhere; }.permission-list small { display: block; margin-top: 2px; color: var(--af-text-muted); font-family: inherit; }
.inspector-state { padding: 36px 10px; color: var(--af-text-muted); font-size: 13px; line-height: 1.6; text-align: center; }
@media (max-width: 1179px) {
  .inspector { position: fixed; z-index: 25; top: 0; right: 0; box-shadow: -12px 0 28px rgb(25 32 44 / 16%); }
  .inspector.open { display: block; }
}
</style>
