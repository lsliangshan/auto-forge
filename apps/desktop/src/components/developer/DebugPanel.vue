<template>
  <div class="debug-panel">
    <section>
      <span class="af-panel-heading">校验与构建</span>
      <div class="debug-actions"><el-button size="small" @click="developer.validateProject">校验</el-button><el-button size="small" @click="developer.buildProject">构建</el-button></div>
      <p :class="developer.validationValid ? 'valid' : 'invalid'">{{ developer.validationValid ? '当前校验通过' : `${developer.diagnostics.length} 个问题` }}</p>
      <ul v-if="developer.diagnostics.length" class="diagnostics">
        <li v-for="(item, index) in developer.diagnostics" :key="`${item.path}:${index}`"><b>{{ item.path }}</b> {{ item.message }}</li>
      </ul>
    </section>

    <section>
      <span class="af-panel-heading">调试输入</span>
      <p v-if="!manifest" class="muted">workflow.json 不是有效 JSON，无法生成调试表单。</p>
      <template v-else-if="objectFields.length">
        <label v-for="field in objectFields" :key="field.name" class="debug-field">
          <span>{{ field.title }}<em v-if="field.required">必填</em></span>
          <span v-if="field.control === 'file-picker'" :data-testid="`debug-file-picker-${field.name}`" class="file-picker">
            <button type="button" :data-testid="`debug-pick-files-${field.name}`" :disabled="developer.developerAttachments.length >= 5" @click="developer.pickDeveloperAttachments">选择文件</button>
            <small>{{ developer.developerAttachments.length }} / 5</small>
            <ul><li v-for="draft in developer.developerAttachments" :key="draft.id" :data-testid="`debug-file-${field.name}-${draft.id}`"><span>{{ draft.name }} · {{ formatBytes(draft.byteSize) }}</span><button type="button" :data-testid="`debug-remove-file-${draft.id}`" @click="developer.removeDeveloperAttachment(draft.id)">移除</button></li></ul>
          </span>
          <select v-else-if="field.enumValues" :data-testid="`debug-field-${field.name}`" :required="field.required" :value="enumIndex(field)" @change="setPrimitive(field, ($event.target as HTMLSelectElement).value)">
            <option value="">请选择</option><option v-for="(value, index) in field.enumValues" :key="index" :value="String(index)">{{ enumLabel(value) }}</option>
          </select>
          <input v-else-if="field.kind === 'boolean'" :data-testid="`debug-field-${field.name}`" type="checkbox" :required="field.required" :checked="fieldValue(field.name) === true" @change="setField(field.name, ($event.target as HTMLInputElement).checked)">
          <input v-else-if="field.kind === 'string'" :data-testid="`debug-field-${field.name}`" type="text" :required="field.required" :value="typeof fieldValue(field.name) === 'string' ? fieldValue(field.name) : ''" @input="setField(field.name, ($event.target as HTMLInputElement).value)">
          <input v-else-if="field.kind === 'number' || field.kind === 'integer'" :data-testid="`debug-field-${field.name}`" type="number" :step="field.kind === 'integer' ? '1' : 'any'" :required="field.required" :value="typeof fieldValue(field.name) === 'number' ? fieldValue(field.name) : ''" @input="setNumber(field.name, ($event.target as HTMLInputElement).value, field.kind === 'integer')">
          <span v-else :data-testid="`debug-field-${field.name}-json`" class="json-field"><small>复杂 Schema，请输入 JSON</small><textarea :value="complexDrafts[field.name] ?? ''" @input="setComplex(field, ($event.target as HTMLTextAreaElement).value)" /><small v-if="draftErrors[field.name]" class="draft-error" role="alert">{{ draftErrors[field.name] }}</small></span>
        </label>
      </template>
      <label v-else class="debug-field"><span>输入 JSON</span><textarea data-testid="debug-root-json" :value="rootDraft" @input="setRoot(($event.target as HTMLTextAreaElement).value)" /><small v-if="draftErrors.$root" class="draft-error" role="alert">{{ draftErrors.$root }}</small></label>
    </section>

    <section v-if="manifest">
      <span class="af-panel-heading">声明权限</span>
      <ul class="permissions"><li v-for="permission in manifest.permissions" :key="`${permission.capability}:${JSON.stringify(permission.scope)}`"><b>{{ permission.capability }}</b><small>{{ formatScope(permission.scope) }}</small></li></ul>
    </section>

    <section>
      <div class="run-heading"><span class="af-panel-heading">调试运行</span><small>{{ statusLabel }}</small></div>
      <div class="debug-actions">
        <el-button size="small" type="primary" :disabled="!manifest || active" @click="developer.runDebug">运行</el-button>
        <el-button size="small" :disabled="!active || !developer.debugExecutionId" @click="developer.cancelDebug">取消</el-button>
      </div>
      <p v-if="developer.debugError" class="invalid" role="alert">{{ developer.debugError }}</p>
      <div v-if="developer.pendingApproval && developer.pendingApproval.executionId === developer.debugExecutionId" class="approval">
        <strong>需要授权：{{ developer.pendingApproval.capability }}</strong>
        <div><el-button size="small" @click="developer.decideApproval('once')">仅本次</el-button><el-button size="small" @click="developer.decideApproval('always')">始终允许</el-button><el-button size="small" type="danger" @click="developer.decideApproval('deny')">拒绝</el-button></div>
      </div>
      <div v-if="developer.debugEvents.length" class="debug-log">
        <p v-for="(event, index) in developer.debugEvents" :key="`${event.type}:${event.occurredAt}:${index}`">{{ eventLine(event) }}</p>
      </div>
      <ol v-if="developer.debugDetail?.steps.length" class="debug-steps"><li v-for="step in developer.debugDetail.steps" :key="step.id">{{ step.label }} · {{ step.status }}</li></ol>
      <div v-if="developer.debugDetail?.logs.length && !hasLiveLogs" class="debug-log"><p v-for="log in developer.debugDetail.logs" :key="log.id">[{{ log.level }}] {{ log.message }}</p></div>
      <pre v-if="developer.debugDetail?.output !== undefined">{{ JSON.stringify(developer.debugDetail.output, null, 2) }}</pre>
      <ConversionBlock
        v-if="developer.debugExecutionId && hasFileConversion"
        :block="developerConversionBlock"
      />
    </section>
  </div>
</template>

<script setup lang="ts">
import type { CapabilityScope, ExecutionEvent } from '@autoforge/shared'
import { computed, reactive, ref, watch } from 'vue'
import ConversionBlock from '../conversion/ConversionBlock.vue'
import { useDeveloperStore } from '../../stores/developer'

type JsonSchema = { type?: string; title?: string; enum?: unknown[]; properties?: Record<string, JsonSchema>; required?: string[]; 'x-autoforge-control'?: unknown }
interface Field { name: string; title: string; kind: string; required: boolean; enumValues?: unknown[]; control?: 'file-picker' }
const developer = useDeveloperStore()
const complexDrafts = reactive<Record<string, string>>({})
const draftErrors = reactive<Record<string, string>>({})
const rootDraft = ref('{}')
const manifest = computed(() => developer.currentManifest)
const hasFileConversion = computed(() => manifest.value?.permissions.some(
  (permission) => permission.capability === 'file.convert',
) ?? false)
const inputSchema = computed(() => manifest.value?.inputSchema as JsonSchema | undefined)
const inputSchemaKey = computed(() => `${developer.selectedProjectId}\n${JSON.stringify(inputSchema.value ?? null)}`)
const objectFields = computed<Field[]>(() => {
  const schema = inputSchema.value
  if (schema?.type !== 'object' || !schema.properties) return []
  return Object.entries(schema.properties).map(([name, field]) => ({
    name, title: field.title || name, kind: field.type ?? 'complex', required: schema.required?.includes(name) ?? false,
    ...(Array.isArray(field.enum) ? { enumValues: field.enum } : {}),
    ...(field.type === 'array' && field['x-autoforge-control'] === 'file-picker' ? { control: 'file-picker' as const } : {}),
  }))
})
const active = computed(() => ['starting', 'queued', 'awaiting_approval', 'running'].includes(developer.debugStatus))
const statusLabel = computed(() => ({ idle: '未运行', starting: '启动中', queued: '排队中', awaiting_approval: '等待授权', running: '运行中', completed: '已完成', failed: '失败', cancelled: '已取消', interrupted: '已中断' })[developer.debugStatus])
const hasLiveLogs = computed(() => developer.debugEvents.some((event) => event.type === 'log'))
const developerConversionBlock = computed(() => ({
  id: `developer:${developer.debugExecutionId}:conversion`,
  type: 'conversion' as const,
  blockId: `developer_${developer.debugExecutionId}_conversion`,
  executionId: developer.debugExecutionId,
  state: active.value ? 'active' as const : 'terminal' as const,
}))

function setPrimitive(field: Field, value: string) {
  if (!value) { delete inputObject()[field.name]; return }
  const matching = field.enumValues?.[Number(value)]
  if (matching !== undefined) setField(field.name, matching)
}
function inputObject(): Record<string, unknown> {
  if (!developer.debugInput || typeof developer.debugInput !== 'object' || Array.isArray(developer.debugInput)) developer.debugInput = {}
  return developer.debugInput as Record<string, unknown>
}
function fieldValue(name: string): unknown {
  return developer.debugInput && typeof developer.debugInput === 'object' && !Array.isArray(developer.debugInput)
    ? (developer.debugInput as Record<string, unknown>)[name]
    : undefined
}
function enumIndex(field: Field): string {
  const current = fieldValue(field.name)
  const index = field.enumValues?.findIndex((value) => Object.is(value, current)) ?? -1
  return index < 0 ? '' : String(index)
}
function setField(name: string, value: unknown) {
  inputObject()[name] = value
}
function setNumber(name: string, value: string, integer: boolean) {
  if (!value) { delete inputObject()[name]; return }
  const parsed = Number(value)
  if (Number.isFinite(parsed) && (!integer || Number.isInteger(parsed))) setField(name, parsed)
}
function syncDraftValidity() {
  const errors = Object.values(draftErrors).filter(Boolean)
  developer.setDebugDraftValidity(errors.length === 0, errors[0] ?? '')
}
function setDraftError(name: string, error = '') {
  if (error) draftErrors[name] = error
  else delete draftErrors[name]
  syncDraftValidity()
}
function setComplex(field: Field, value: string) {
  complexDrafts[field.name] = value
  if (!value.trim()) {
    if (field.required) setDraftError(field.name, `${field.title} 请输入有效 JSON`)
    else { delete inputObject()[field.name]; setDraftError(field.name) }
    return
  }
  try {
    setField(field.name, JSON.parse(value) as unknown)
    setDraftError(field.name)
  } catch { setDraftError(field.name, `${field.title} 请输入有效 JSON`) }
}
function setRoot(value: string) {
  rootDraft.value = value
  try {
    const parsed = JSON.parse(value) as unknown
    developer.debugInput = parsed
    setDraftError('$root')
  } catch { setDraftError('$root', '请输入有效 JSON') }
}
function enumLabel(value: unknown) {
  if (typeof value === 'string') return `${JSON.stringify(value)} (string)`
  return `${String(value)} (${typeof value})`
}
function formatBytes(value: number) {
  if (value < 1024) return `${value} B`
  return `${(value / 1024).toFixed(1)} KiB`
}
function initializeDrafts() {
  Object.keys(complexDrafts).forEach((key) => delete complexDrafts[key])
  Object.keys(draftErrors).forEach((key) => delete draftErrors[key])
  developer.debugInput = {}
  developer.configureDeveloperAttachmentField(objectFields.value.find(({ control }) => control === 'file-picker')?.name ?? '')
  rootDraft.value = '{}'
  if (objectFields.value.length) {
    for (const field of objectFields.value) {
      if (field.kind === 'boolean' && field.required) setField(field.name, false)
      if (field.control === 'file-picker') { developer._syncDeveloperAttachmentInput(); continue }
      if (!['string', 'number', 'integer', 'boolean'].includes(field.kind) && field.required) {
        const value = field.kind === 'array' ? [] : {}
        complexDrafts[field.name] = JSON.stringify(value, null, 2)
        setField(field.name, value)
      }
    }
  }
  syncDraftValidity()
}
function formatScope(scope: CapabilityScope) { return 'origins' in scope ? scope.origins.join('、') : 'paths' in scope ? scope.paths.join('、') : '无附加范围' }
function eventLine(event: ExecutionEvent) {
  if (event.type === 'log') return `[${event.level}] ${event.message}`
  if (event.type === 'step') return `[步骤] ${event.label} · ${event.status}`
  if (event.type === 'result') return `[结果] ${event.summary}`
  if (event.type === 'approval_required') return `[授权] ${event.capability}`
  return `[状态] ${event.status}`
}
watch(inputSchemaKey, initializeDrafts, { immediate: true })
</script>

<style scoped>
.debug-panel { display: grid; gap: 14px; }.debug-panel section { display: grid; gap: 8px; border-bottom: 1px solid var(--af-border); padding-bottom: 14px; }
.debug-actions { display: flex; gap: 6px; }.debug-actions .el-button { margin: 0; }.valid { margin: 0; color: var(--af-success); font-size: 12px; }.invalid { margin: 0; color: var(--af-danger); font-size: 12px; }.muted { margin: 0; color: var(--af-text-muted); font-size: 12px; }
.diagnostics, .permissions { display: grid; gap: 6px; margin: 0; padding: 0; list-style: none; font-size: 11px; }.diagnostics li { color: var(--af-danger); overflow-wrap: anywhere; }.permissions li { display: grid; gap: 2px; }.permissions small { color: var(--af-text-muted); overflow-wrap: anywhere; }
.debug-field { display: grid; gap: 4px; font-size: 11px; }.debug-field > span:first-child { display: flex; justify-content: space-between; font-weight: 600; }.debug-field em { color: var(--af-danger); font-size: 9px; font-style: normal; }.debug-field input:not([type='checkbox']), .debug-field select, .debug-field textarea { width: 100%; border: 1px solid var(--af-border); border-radius: 4px; padding: 6px; color: var(--af-text); background: var(--af-surface); font: inherit; }.debug-field textarea { min-height: 64px; resize: vertical; font-family: ui-monospace, monospace; }.json-field { display: grid !important; gap: 4px; }.json-field small { color: var(--af-text-muted); font-weight: 400; }
.draft-error { color: var(--af-danger) !important; }
.file-picker { display: grid !important; gap: 6px; }.file-picker > button { justify-self: start; }.file-picker ul { display: grid; gap: 4px; margin: 0; padding: 0; list-style: none; }.file-picker li { display: flex; align-items: center; justify-content: space-between; gap: 8px; }.file-picker li span { min-width: 0; overflow-wrap: anywhere; }
.run-heading { display: flex; justify-content: space-between; }.run-heading small { color: var(--af-text-muted); }.approval { display: grid; gap: 7px; border: 1px solid var(--af-warning); border-radius: 5px; padding: 8px; font-size: 11px; }.approval div { display: flex; flex-wrap: wrap; gap: 4px; }.approval .el-button { margin: 0; }
.debug-log { max-height: 180px; overflow: auto; color: #dbe4ef; background: #242a32; }.debug-log p { margin: 0; border-bottom: 1px solid #353d48; padding: 6px; font-family: ui-monospace, monospace; font-size: 10px; overflow-wrap: anywhere; }.debug-panel pre { max-height: 180px; margin: 0; overflow: auto; padding: 8px; background: var(--af-surface-muted); font-size: 10px; white-space: pre-wrap; }
.debug-steps { display: grid; gap: 4px; margin: 0; padding-left: 18px; font-size: 11px; }
</style>
