<template>
  <section
    id="billing"
    class="billing-panel settings-section"
    data-testid="billing-panel"
  >
    <header class="billing-header">
      <div>
        <h2>Token 账单</h2>
        <p>统计来自本机当前保留的模型调用记录。</p>
      </div>
      <el-button
        :icon="Refresh"
        :loading="loading"
        data-testid="billing-refresh"
        @click="$emit('refresh')"
      >
        刷新
      </el-button>
    </header>
    <div class="billing-body">
      <p
        v-if="error"
        class="billing-error"
        role="alert"
      >
        {{ error }}
      </p>
      <p
        v-if="!usage && loading"
        class="billing-empty"
      >
        正在加载 Token 用量…
      </p>
      <template v-else-if="usage">
        <el-tabs
          v-model="activePeriod"
          data-testid="billing-tabs"
        >
          <el-tab-pane
            v-for="option in periodOptions"
            :key="option.key"
            :label="option.label"
            :name="option.key"
          />
        </el-tabs>
        <p
          data-testid="billing-period-range"
          class="billing-period"
        >
          {{ formatRange(activeUsage, activePeriod) }}
        </p>
        <dl class="billing-summary">
          <div
            data-testid="billing-summary-input"
            :style="{ '--billing-summary-color': tokenColors.input }"
          >
            <dt>输入 Token</dt>
            <dd>{{ formatTokens(activeUsage.inputTokens) }}</dd>
          </div>
          <div
            data-testid="billing-summary-output"
            :style="{ '--billing-summary-color': tokenColors.output }"
          >
            <dt>输出 Token</dt>
            <dd>{{ formatTokens(activeUsage.outputTokens) }}</dd>
          </div>
          <div
            data-testid="billing-summary-total"
            :style="{ '--billing-summary-color': tokenColors.total }"
          >
            <dt>总 Token</dt>
            <dd>{{ formatTokens(activeUsage.totalTokens) }}</dd>
          </div>
        </dl>
        <template v-if="hasUsage">
          <section
            class="billing-chart-section"
            aria-labelledby="token-trend-title"
          >
            <h3 id="token-trend-title">
              Token 趋势
            </h3>
            <TokenUsageLineChart
              :period="activeUsage"
              :period-key="activePeriod"
            />
          </section>
          <section
            class="billing-chart-section"
            aria-labelledby="token-model-title"
          >
            <h3 id="token-model-title">
              模型用量
            </h3>
            <TokenUsageBarChart :models="activeUsage.models" />
          </section>
          <div class="billing-table-wrap">
            <table
              class="billing-table"
              aria-label="模型 Token 精确用量"
            >
              <thead>
                <tr>
                  <th scope="col">
                    模型
                  </th>
                  <th scope="col">
                    输入 Token
                  </th>
                  <th scope="col">
                    输出 Token
                  </th>
                  <th scope="col">
                    总 Token
                  </th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="model in activeUsage.models"
                  :key="model.model"
                >
                  <td>{{ model.model }}</td>
                  <td>{{ formatTokens(model.inputTokens) }}</td>
                  <td>{{ formatTokens(model.outputTokens) }}</td>
                  <td>{{ formatTokens(model.totalTokens) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </template>
        <p
          v-else
          class="billing-empty"
        >
          暂无 Token 用量记录
        </p>
      </template>
    </div>
  </section>
</template>

<script setup lang="ts">
import { Refresh } from '@element-plus/icons-vue'
import type { TokenUsagePeriod, TokenUsagePeriodKey, TokenUsageSnapshot } from '@autoforge/shared'
import { computed, ref } from 'vue'
import TokenUsageBarChart from './TokenUsageBarChart.vue'
import TokenUsageLineChart from './TokenUsageLineChart.vue'
import { tokenColors } from './token-usage-chart-options'

const props = defineProps<{
  usage?: TokenUsageSnapshot
  loading: boolean
  error: string
}>()
defineEmits<{ refresh: [] }>()

const periodOptions: Array<{ key: TokenUsagePeriodKey; label: string }> = [
  { key: 'today', label: '今日' },
  { key: 'yesterday', label: '昨日' },
  { key: 'week', label: '本周' },
  { key: 'month', label: '本月' },
  { key: 'allTime', label: '累计' },
]
const activePeriod = ref<TokenUsagePeriodKey>('today')
const emptyPeriod: TokenUsagePeriod = {
  startedAt: new Date(0).toISOString(),
  endedAt: new Date(0).toISOString(),
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  models: [],
  trend: [],
}
const activeUsage = computed(() => props.usage?.[activePeriod.value] ?? emptyPeriod)
const hasUsage = computed(() => activeUsage.value.totalTokens > 0)
const tokenFormatter = new Intl.NumberFormat('zh-CN')
const rangeFormatter = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
})
const formatTokens = (value: number) => tokenFormatter.format(value)
const formatRange = (usage: TokenUsagePeriod, key: TokenUsagePeriodKey) => {
  if (key === 'allTime' && usage.totalTokens === 0 && usage.models.length === 0) {
    return '暂无保留记录'
  }
  const start = rangeFormatter.format(new Date(usage.startedAt))
  const rawEnd = Date.parse(usage.endedAt)
  const end = rangeFormatter.format(new Date(key === 'yesterday' ? rawEnd - 1 : rawEnd))
  return `${start} — ${end}`
}
</script>

<style scoped>
.billing-panel.settings-section {
  margin-top: 14px;
  overflow: hidden;
  border: 1px solid var(--af-border);
  border-radius: 14px;
  padding: 0;
  background: var(--af-surface);
}

.billing-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  padding: 18px 20px;
  border-bottom: 1px solid var(--af-border);
}

.billing-header h2,
.billing-header p,
.billing-period,
.billing-error,
.billing-empty {
  margin: 0;
}

.billing-header h2 {
  color: var(--af-graphite);
  font-size: 15px;
}

.billing-header p,
.billing-period,
.billing-empty {
  color: var(--af-text-muted);
}

.billing-header p {
  margin-top: 4px;
  font-size: 12px;
}

.billing-body {
  padding: 16px 20px 20px;
}

.billing-error {
  margin-bottom: 12px;
  color: var(--af-danger);
}

.billing-period {
  margin-bottom: 14px;
  font-size: 13px;
}

.billing-summary {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
  margin: 0 0 16px;
}

.billing-summary div {
  padding: 14px;
  border: 1px solid var(--af-border);
  border-radius: 10px;
  background: var(--af-surface-muted);
}

.billing-summary dt {
  color: var(--af-text-muted);
  font-size: 12px;
}

.billing-summary dd {
  margin: 6px 0 0;
  color: var(--billing-summary-color);
  font-size: 20px;
  font-weight: 700;
}

.billing-chart-section {
  margin: 0 0 16px;
  padding: 14px;
  border: 1px solid var(--af-border);
  border-radius: 10px;
  background: var(--af-surface-muted);
}

.billing-chart-section h3 {
  margin: 0 0 8px;
  color: var(--af-graphite);
  font-size: 14px;
}

.billing-table-wrap {
  overflow-x: auto;
}

.billing-table {
  width: 100%;
  min-width: 620px;
  border-collapse: collapse;
}

.billing-table th,
.billing-table td {
  padding: 10px 12px;
  border-bottom: 1px solid var(--af-border);
  text-align: right;
}

.billing-table th:first-child,
.billing-table td:first-child {
  max-width: 320px;
  overflow-wrap: anywhere;
  text-align: left;
}

@media (max-width: 640px) {
  .billing-header {
    align-items: stretch;
    flex-direction: column;
  }

  .billing-summary {
    grid-template-columns: 1fr;
  }

  .billing-chart-section {
    padding: 10px;
  }
}
</style>
