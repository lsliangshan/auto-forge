<template>
  <div class="page discover-page">
    <section class="page-intro">
      <div><span class="eyebrow">AUTOMATION MARKETPLACE</span><h1>发现自动化工具</h1><p>探索高效实用的自动化工具，提升你的工作效率。</p></div>
      <div class="search-wrap">
        <Search />
        <input
          ref="searchInput"
          v-model="query"
          data-testid="tool-search"
          type="search"
          placeholder="搜索工具、场景或开发者"
          aria-label="搜索工具、场景或开发者"
        />
        <kbd>{{ shortcutLabel }} K</kbd>
      </div>
    </section>

    <div v-if="error" class="inline-alert" role="alert"><WarningFilled /><span>{{ error }}</span><el-button link @click="load">重新加载</el-button></div>
    <template v-else>
      <div v-if="loading" class="loading-stack"><el-skeleton :rows="8" animated /></div>
      <template v-else>
        <div class="section-heading"><h2>精选推荐</h2><span>编辑精选</span></div>
        <FeaturedTool v-if="featuredTool" :tool="featuredTool" @select="selectedTool = $event" />

        <div class="catalog-toolbar">
          <div class="category-list" aria-label="工具分类">
            <button
              v-for="item in categories"
              :key="item.value"
              type="button"
              :class="['category-chip', { 'category-chip--active': category === item.value }]"
              @click="category = item.value"
            >{{ item.label }}</button>
          </div>
          <span class="result-count">{{ visibleTools.length }} 个工具</span>
        </div>

        <ToolList
          v-if="visibleTools.length"
          :tools="visibleTools"
          :installed-ids="installedIds"
          :installing-id="installingId"
          @select="selectedTool = $event"
          @install="install"
        />
        <EmptyState v-else @clear="clearFilters" />
      </template>
    </template>

    <ToolDetailsDrawer
      :tool="selectedTool"
      :installed="Boolean(selectedTool && installedIds.has(selectedTool.id))"
      :installing="installingId === selectedTool?.id"
      @close="selectedTool = null"
      @install="install"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { Search, WarningFilled } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import { filterTools, type ToolCategory, type ToolSummary } from '../../../shared/catalog'
import { getDesktopApi } from '../services/desktop-api'
import FeaturedTool from '../components/catalog/FeaturedTool.vue'
import ToolList from '../components/catalog/ToolList.vue'
import ToolDetailsDrawer from '../components/catalog/ToolDetailsDrawer.vue'
import EmptyState from '../components/common/EmptyState.vue'

const categories: Array<{ label: string; value: ToolCategory }> = [
  { label: '全部', value: 'all' },
  { label: '数据采集', value: 'data' },
  { label: '内容发布', value: 'publishing' },
  { label: '效率工具', value: 'productivity' },
  { label: '开发者工具', value: 'developer' }
]

const tools = ref<ToolSummary[]>([])
const installedIds = ref(new Set<string>())
const selectedTool = ref<ToolSummary | null>(null)
const installingId = ref<string | null>(null)
const loading = ref(true)
const error = ref('')
const query = ref('')
const category = ref<ToolCategory>('all')
const searchInput = ref<HTMLInputElement | null>(null)
const shortcutLabel = navigator.platform.toLowerCase().includes('mac') ? '⌘' : 'Ctrl +'

const featuredTool = computed(() => tools.value.find(({ featured }) => featured) ?? tools.value[0])
const visibleTools = computed(() => filterTools(tools.value, query.value, category.value))

async function load() {
  loading.value = true
  error.value = ''
  try {
    const api = getDesktopApi()
    const [catalog, installed] = await Promise.all([api.listTools(), api.listInstalledToolIds()])
    tools.value = catalog
    installedIds.value = new Set(installed)
  } catch {
    error.value = '工具目录暂时无法加载。'
  } finally {
    loading.value = false
  }
}

async function install(tool: ToolSummary) {
  if (installedIds.value.has(tool.id) || installingId.value) return
  installingId.value = tool.id
  try {
    await getDesktopApi().installTool({ toolId: tool.id })
    installedIds.value = new Set([...installedIds.value, tool.id])
    ElMessage.success(`${tool.name} 已安装`)
  } catch {
    ElMessage.error('安装失败，请重试。')
  } finally {
    installingId.value = null
  }
}

function clearFilters() {
  query.value = ''
  category.value = 'all'
}

function handleShortcut(event: KeyboardEvent) {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault()
    searchInput.value?.focus()
  }
}

onMounted(() => {
  void load()
  window.addEventListener('keydown', handleShortcut)
})
onBeforeUnmount(() => window.removeEventListener('keydown', handleShortcut))
</script>
