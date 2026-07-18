<template>
  <div class="tool-table" role="table" aria-label="自动化工具列表">
    <div class="tool-table__header" role="row">
      <span>工具名称</span>
      <span>用途</span>
      <span class="platform-column">兼容性</span>
      <span class="download-column">下载量</span>
      <span>操作</span>
    </div>
    <div
      v-for="tool in tools"
      :key="tool.id"
      :class="['tool-row', { 'tool-row--installed': installedIds.has(tool.id) }]"
      data-testid="tool-row"
    >
      <span class="tool-name-cell">
        <span class="tool-icon" :class="`tool-icon--${toolIconColors[tool.id as keyof typeof toolIconColors] ?? 'blue'}`">
          <component :is="toolIcons[tool.id as keyof typeof toolIcons]" />
        </span>
        <span><strong>{{ tool.name }}</strong></span>
      </span>
      <span class="tool-purpose">{{ tool.description }}</span>
      <span class="platform-column platform-icons">
        <Monitor v-if="tool.platforms.includes('windows')" title="Windows" />
        <Platform v-if="tool.platforms.includes('macos')" title="macOS" />
        <Operation v-if="tool.platforms.includes('linux')" title="Linux" />
      </span>
      <span class="download-column">{{ formatDownloads(tool.downloads) }}</span>
      <span class="tool-action">
        <el-button
          v-if="installedIds.has(tool.id)"
          plain
          size="small"
          @click.stop
        >已安装</el-button>
        <el-button
          v-else
          plain
          type="primary"
          size="small"
          :loading="installingId === tool.id"
          @click.stop="$emit('install', tool)"
        >安装</el-button>
        <button
          class="tool-details-button"
          type="button"
          :aria-label="`查看${tool.name}详情`"
          @click="$emit('select', tool)"
        >
          <ArrowRight />
        </button>
      </span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ArrowRight, Monitor, Operation, Platform } from '@element-plus/icons-vue'
import type { ToolSummary } from '../../../../shared/catalog'
import { toolIconColors, toolIcons } from './tool-icons'

defineProps<{ tools: ToolSummary[]; installedIds: Set<string>; installingId: string | null }>()
defineEmits<{ select: [tool: ToolSummary]; install: [tool: ToolSummary] }>()

function formatDownloads(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(1)}K` : `${value}`
}
</script>
