<template>
  <form
    class="composer"
    @submit.prevent="submit"
  >
    <textarea
      v-model="content"
      rows="2"
      :disabled="disabled"
      aria-label="消息内容"
      placeholder="描述你想完成的任务…"
      @compositionstart="composing = true"
      @compositionend="composing = false"
      @keydown="onKeydown"
    />
    <div class="composer-footer">
      <span>Enter 发送 · Shift+Enter 换行</span>
      <el-button
        v-if="running"
        type="danger"
        plain
        :disabled="disabled"
        @click="$emit('cancel')"
      >
        取消生成
      </el-button>
      <el-button
        v-else
        native-type="submit"
        type="primary"
        :disabled="disabled || !content.trim()"
      >
        发送
      </el-button>
    </div>
  </form>
</template>

<script setup lang="ts">
import { ref } from 'vue'

const props = defineProps<{ disabled: boolean; running: boolean }>()
const emit = defineEmits<{ submit: [content: string]; cancel: [] }>()
const content = ref('')
const composing = ref(false)

function submit() {
  if (props.disabled || props.running) return
  const clean = content.value.trim()
  if (!clean) return
  emit('submit', clean)
  content.value = ''
}
function onKeydown(event: KeyboardEvent) {
  if (event.key !== 'Enter' || event.shiftKey || composing.value || event.isComposing) return
  event.preventDefault()
  submit()
}
</script>

<style scoped>
.composer { border-top: 1px solid var(--af-border); padding: 12px 16px 14px; background: var(--af-surface); }
textarea { display: block; width: 100%; min-height: 66px; max-height: 180px; resize: vertical; border: 1px solid var(--af-border-strong); border-radius: 7px; padding: 10px 12px; color: var(--af-text); background: white; line-height: 1.5; }
textarea:hover:not(:disabled) { border-color: #9aa6b5; }
textarea:disabled { cursor: not-allowed; background: var(--af-surface-muted); }
.composer-footer { display: flex; align-items: center; justify-content: space-between; margin-top: 8px; }
.composer-footer span { color: var(--af-text-muted); font-size: 11px; }
</style>
