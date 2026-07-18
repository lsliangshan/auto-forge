<template>
  <div class="empty-state">
    <span class="empty-state__icon"><Search /></span>
    <h3>没有找到匹配的工具</h3>
    <p>尝试更换关键词或清除当前分类。</p>
    <el-button @click="$emit('clear')">清除筛选</el-button>
  </div>
</template>

<script setup lang="ts">
import { Search } from '@element-plus/icons-vue'
defineEmits<{ clear: [] }>()
</script>
