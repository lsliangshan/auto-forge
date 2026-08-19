<template>
  <section
    id="billing"
    class="billing-panel settings-section"
    data-testid="billing-panel"
  >
    <header class="billing-header">
      <div>
        <h2>用量与消费</h2>
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
          >
            <dt>
              <span
                class="billing-summary-marker"
                aria-hidden="true"
                :style="{ backgroundColor: tokenColors.input }"
              />
              输入 Token
            </dt>
            <dd :style="{ color: tokenColors.total }">
              {{ formatTokens(activeUsage.inputTokens) }}
            </dd>
          </div>
          <div
            data-testid="billing-summary-output"
          >
            <dt>
              <span
                class="billing-summary-marker"
                aria-hidden="true"
                :style="{ backgroundColor: tokenColors.output }"
              />
              输出 Token
            </dt>
            <dd :style="{ color: tokenColors.total }">
              {{ formatTokens(activeUsage.outputTokens) }}
            </dd>
          </div>
          <div
            data-testid="billing-summary-total"
          >
            <dt>
              <span
                class="billing-summary-marker"
                aria-hidden="true"
                :style="{ backgroundColor: tokenColors.total }"
              />
              总 Token
            </dt>
            <dd :style="{ color: tokenColors.total }">
              {{ formatTokens(activeUsage.totalTokens) }}
            </dd>
          </div>
          <div
            data-testid="billing-summary-cost"
          >
            <dt>OpenRouter 消费</dt>
            <dd>{{ formatUsd(activeUsage.openRouterCostUsd) }}</dd>
            <p data-testid="billing-summary-known">
              已确认 {{ formatTokens(activeUsage.openRouterKnownCostCount) }} 笔
            </p>
            <p
              v-if="activeUsage.openRouterUnknownCostCount > 0"
              data-testid="billing-cost-warning"
              class="billing-cost-warning"
            >
              有 {{ formatTokens(activeUsage.openRouterUnknownCostCount) }} 笔费用待确认
              <el-tooltip
                :content="pendingCostExplanation"
                :trigger="['hover', 'focus']"
                placement="top"
              >
                <el-icon
                  class="billing-cost-help"
                  data-testid="billing-cost-help"
                  tabindex="0"
                  role="img"
                  aria-label="查看待确认费用说明"
                >
                  <QuestionFilled />
                </el-icon>
              </el-tooltip>
            </p>
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
              aria-label="模型用量与 OpenRouter 消费"
            >
              <thead>
                <tr>
                  <th scope="col">
                    Provider
                  </th>
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
                  <th scope="col">
                    OpenRouter 消费
                  </th>
                  <th scope="col">
                    已确认
                  </th>
                  <th scope="col">
                    待确认
                  </th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="model in activeUsage.models"
                  :key="`${model.provider}:${model.model}`"
                >
                  <td>{{ providerLabels[model.provider] }}</td>
                  <td>{{ model.model }}</td>
                  <td>{{ formatTokens(model.inputTokens) }}</td>
                  <td>{{ formatTokens(model.outputTokens) }}</td>
                  <td>{{ formatTokens(model.totalTokens) }}</td>
                  <td>{{ model.provider === 'openrouter' ? formatUsd(model.openRouterCostUsd) : '—' }}</td>
                  <td>{{ formatTokens(model.openRouterKnownCostCount) }}</td>
                  <td>{{ formatTokens(model.openRouterUnknownCostCount) }}</td>
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
import { QuestionFilled, Refresh } from '@element-plus/icons-vue'
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
  openRouterCostUsd: '0',
  openRouterKnownCostCount: 0,
  openRouterUnknownCostCount: 0,
  models: [],
  trend: [],
}
const activeUsage = computed(() => props.usage?.[activePeriod.value] ?? emptyPeriod)
const hasUsage = computed(() => activeUsage.value.totalTokens > 0 || activeUsage.value.models.length > 0)
const providerLabels = {
  openrouter: 'OpenRouter',
  deepseek: 'DeepSeek',
} as const
const pendingCostExplanation = '这表示部分 OpenRouter 调用暂未取得准确费用。当前显示的消费金额不包含这些费用，无需手动确认，系统会自动尝试查询。'
const tokenFormatter = new Intl.NumberFormat('zh-CN')
const rangeFormatter = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
})
const formatTokens = (value: number) => tokenFormatter.format(value)
const formatUsd = (decimal: string) => {
  const [integer, fraction] = decimal.split('.')
  const grouped = integer!.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `$${fraction === undefined ? grouped : `${grouped}.${fraction}`}`
}
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
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--af-text-muted);
  font-size: 12px;
}

.billing-summary-marker {
  width: 8px;
  height: 8px;
  flex: 0 0 auto;
  border-radius: 50%;
}

.billing-summary dd {
  margin: 6px 0 0;
  font-size: 20px;
  font-weight: 700;
}

.billing-summary p {
  margin: 6px 0 0;
  color: var(--af-text-muted);
  font-size: 12px;
}

.billing-summary .billing-cost-warning {
  display: flex;
  align-items: center;
  gap: 4px;
  color: var(--af-danger);
}

.billing-cost-help {
  flex: 0 0 auto;
  cursor: help;
  outline-offset: 2px;
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
  min-width: 960px;
  border-collapse: collapse;
}

.billing-table th,
.billing-table td {
  padding: 10px 12px;
  border-bottom: 1px solid var(--af-border);
  text-align: right;
}

.billing-table th:first-child,
.billing-table td:first-child,
.billing-table th:nth-child(2),
.billing-table td:nth-child(2) {
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
