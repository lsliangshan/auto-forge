<template>
  <el-drawer
    :model-value="Boolean(tool)"
    size="460px"
    direction="rtl"
    :with-header="false"
    class="tool-drawer"
    @close="$emit('close')"
  >
    <div v-if="tool" class="drawer-content">
      <button class="drawer-close" type="button" aria-label="关闭详情" @click="$emit('close')"><Close /></button>
      <div class="drawer-tool-heading">
        <span class="tool-icon tool-icon--blue tool-icon--large"><component :is="toolIcons[tool.id as keyof typeof toolIcons]" /></span>
        <div><span class="eyebrow">自动化工具</span><h2>{{ tool.name }}</h2><p>{{ tool.developer }}</p></div>
      </div>
      <p class="drawer-description">{{ tool.description }}</p>
      <div class="drawer-meta"><span>版本 {{ tool.version }}</span><span>{{ formatDownloads(tool.downloads) }} 次下载</span></div>

      <section class="drawer-section">
        <h3>权限说明</h3>
        <div v-if="tool.permissions.length" class="permission-list">
          <div v-for="permission in tool.permissions" :key="permission.id" class="permission-item">
            <CircleCheck /><span><strong>{{ permission.label }}</strong><small>{{ permission.description }}</small></span>
          </div>
        </div>
        <p v-else class="muted">此工具不需要额外权限。</p>
      </section>

      <section class="drawer-section"><h3>更新说明</h3><p class="muted">优化执行稳定性，并改进对动态网页内容的识别能力。</p></section>
      <div class="drawer-footer">
        <el-button v-if="installed" size="large" disabled>已安装</el-button>
        <el-button v-else type="primary" size="large" :loading="installing" @click="$emit('install', tool)">安装工具</el-button>
      </div>
    </div>
  </el-drawer>
</template>

<script setup lang="ts">
import { CircleCheck, Close } from '@element-plus/icons-vue'
import type { ToolSummary } from '../../../../shared/catalog'
import { toolIcons } from './tool-icons'

defineProps<{ tool: ToolSummary | null; installed: boolean; installing: boolean }>()
defineEmits<{ close: []; install: [tool: ToolSummary] }>()

function formatDownloads(value: number): string {
  return value >= 10000 ? `${(value / 10000).toFixed(1)}万` : `${value}`
}
</script>
