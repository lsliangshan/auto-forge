<template>
  <section class="featured" aria-labelledby="featured-title">
    <div class="featured-visual">
      <img :src="featuredIllustration" alt="网页数据采集工具示意图" />
    </div>
    <div class="featured-copy">
      <div class="featured-heading">
        <span class="tool-icon tool-icon--blue"><Compass /></span>
        <div>
          <div class="title-row">
            <h2 id="featured-title">{{ tool.name }}</h2>
            <span class="hot-badge">热门</span>
          </div>
          <p>{{ tool.description }}</p>
        </div>
      </div>
      <div class="tag-row">
        <span v-for="tag in tool.tags" :key="tag" class="feature-tag">{{ tag }}</span>
      </div>
      <div class="tool-meta">
        <span><User />{{ tool.developer }}</span>
        <span>v{{ tool.version }}</span>
        <span>{{ platformLabel }}</span>
      </div>
      <el-button type="primary" size="large" @click="$emit('select', tool)">
        查看详情 <ArrowRight />
      </el-button>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { ArrowRight, Compass, User } from '@element-plus/icons-vue'
import type { ToolSummary } from '../../../../shared/catalog'
import featuredIllustration from '../../assets/featured-web-collector.png'

const props = defineProps<{ tool: ToolSummary }>()
defineEmits<{ select: [tool: ToolSummary] }>()

const platformLabel = computed(() => {
  const labels = { windows: 'Windows', macos: 'macOS', linux: 'Linux' }
  return `兼容 ${props.tool.platforms.map((platform) => labels[platform]).join(' / ')}`
})
</script>
