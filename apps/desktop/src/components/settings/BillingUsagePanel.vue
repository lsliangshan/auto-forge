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
            label="本月"
            name="month"
          />
          <el-tab-pane
            label="累计"
            name="allTime"
          />
        </el-tabs>
        <p
          v-if="activePeriod === 'month'"
          class="billing-period"
        >
          统计自 {{ formatMonthStart(usage.monthStartedAt) }}
        </p>
        <dl class="billing-summary">
          <div>
            <dt>输入 Token</dt>
            <dd>{{ formatTokens(activeUsage.inputTokens) }}</dd>
          </div>
          <div>
            <dt>输出 Token</dt>
            <dd>{{ formatTokens(activeUsage.outputTokens) }}</dd>
          </div>
          <div data-testid="billing-summary-total">
            <dt>总 Token</dt>
            <dd>{{ formatTokens(activeUsage.totalTokens) }}</dd>
          </div>
        </dl>
        <p
          v-if="!activeUsage.models.length"
          class="billing-empty"
        >
          暂无 Token 用量记录
        </p>
        <div
          v-else
          class="billing-table-wrap"
        >
          <table class="billing-table">
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
    </div>
  </section>
</template>

<script setup lang="ts">
import { Refresh } from '@element-plus/icons-vue'
import type { TokenUsagePeriod, TokenUsageSnapshot } from '@autoforge/shared'
import { computed, ref } from 'vue'

const props = defineProps<{
  usage?: TokenUsageSnapshot
  loading: boolean
  error: string
}>()
defineEmits<{ refresh: [] }>()

const activePeriod = ref<'month' | 'allTime'>('month')
const emptyPeriod: TokenUsagePeriod = {
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  models: [],
}
const activeUsage = computed(() => props.usage?.[activePeriod.value] ?? emptyPeriod)
const tokenFormatter = new Intl.NumberFormat('zh-CN')
const monthFormatter = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: 'long',
  day: 'numeric',
})
const formatTokens = (value: number) => tokenFormatter.format(value)
const formatMonthStart = (value: string) => monthFormatter.format(new Date(value))
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
  font-size: 20px;
  font-weight: 700;
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
}
</style>
