<template>
  <section
    class="approval-card"
    aria-live="polite"
  >
    <div class="approval-heading">
      <el-icon aria-hidden="true">
        <Lock />
      </el-icon>
      <div>
        <strong>需要授权</strong>
        <p>{{ capabilityLabel }}</p>
      </div>
    </div>
    <dl>
      <dt>工作流</dt><dd>{{ approval.workflowName }}</dd>
      <dt>标识</dt><dd>{{ approval.workflowId }}</dd>
      <dt>版本</dt><dd>{{ approval.workflowVersion }}</dd>
      <dt>来源</dt><dd>{{ sourceLabel }}</dd>
      <template v-if="approval.buildHash">
        <dt>构建</dt><dd>{{ approval.buildHash }}</dd>
      </template>
      <dt>城市</dt><dd>{{ approval.city ?? '不限城市' }}</dd>
      <dt>操作</dt><dd>{{ approval.actionSummary }}</dd>
      <dt>能力</dt><dd>{{ approval.capability }}</dd>
      <dt>范围</dt><dd>{{ scopeLabel }}</dd>
    </dl>
    <p
      v-if="error"
      class="approval-error"
      role="alert"
    >
      {{ error }}
    </p>
    <div class="approval-actions">
      <el-button
        data-testid="deny-approval"
        :disabled="busy || submitted || approval.state !== 'pending'"
        @click="decide('deny')"
      >
        拒绝
      </el-button>
      <el-button
        type="primary"
        data-testid="approve-once"
        :disabled="busy || submitted || approval.state !== 'pending'"
        @click="decide('once')"
      >
        仅本次允许
      </el-button>
    </div>
    <span
      v-if="approvalStateLabel"
      class="decision-result"
      data-testid="approval-state"
    >{{ approvalStateLabel }}</span>
  </section>
</template>

<script setup lang="ts">
import { Lock } from '@element-plus/icons-vue'
import type { ApprovalDecision, ChatBlock } from '@autoforge/shared'
import { computed, ref } from 'vue'
import { displayError, getDesktopApi } from '../../services/desktop-api'

type ApprovalBlock = Extract<ChatBlock, { type: 'approval' }>
const props = defineProps<{ approval: ApprovalBlock }>()
const busy = ref(false)
const submitted = ref(false)
const error = ref('')

const capabilityLabel = computed(() => props.approval.capability.startsWith('browser.') ? '工作流希望控制自动化浏览器' : '工作流请求受控宿主能力')
const sourceLabel = computed(() => props.approval.source === 'development' ? '开发版本' : '已安装')
const approvalStateLabel = computed(() => ({
  pending: '',
  approved: '已允许本次',
  denied: '已拒绝',
  expired: '审批已过期',
  cancelled: '审批已取消',
  invalidated: '审批已失效',
})[props.approval.state])
const scopeLabel = computed(() => {
  if ('origins' in props.approval.scope) return props.approval.scope.origins.join('、')
  if ('paths' in props.approval.scope) return props.approval.scope.paths.join('、')
  return '不包含附加范围'
})

async function decide(decision: 'once' | 'deny') {
  if (busy.value || submitted.value || props.approval.state !== 'pending') return
  busy.value = true
  error.value = ''
  const base = {
    executionId: props.approval.executionId,
    permissionIndex: props.approval.permissionIndex,
    scopeHash: props.approval.scopeHash,
  }
  const input: ApprovalDecision = { ...base, decision }
  try {
    await getDesktopApi().executions.decide(input)
    submitted.value = true
  } catch (caught) { error.value = displayError(caught, '审批提交失败') }
  finally { busy.value = false }
}
</script>

<style scoped>
.approval-card { max-width: 640px; border: 1px solid #f2c48f; border-left: 3px solid var(--af-warning); padding: 14px; background: var(--af-warning-soft); }
.approval-heading { display: flex; align-items: flex-start; gap: 10px; color: var(--af-warning-text); }
.approval-heading strong { font-size: 14px; }
.approval-heading p { margin: 2px 0 0; color: var(--af-text-muted); font-size: 12px; }
dl { display: grid; grid-template-columns: 48px minmax(0, 1fr); gap: 5px 12px; margin: 12px 0; font-size: 12px; }
dt { color: var(--af-text-muted); } dd { min-width: 0; margin: 0; overflow-wrap: anywhere; }
.approval-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }
.approval-error { color: var(--af-danger); font-size: 12px; }
.decision-result { display: block; margin-top: 8px; color: var(--af-success); font-size: 12px; text-align: right; }
</style>
