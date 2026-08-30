<template>
  <section class="user-management">
    <header class="user-overview">
      <div>
        <span class="section-eyebrow">USER DIRECTORY</span>
        <h2>用户与权限</h2>
        <p>查找用户并维护角色与会员状态，联系方式仅展示脱敏信息。</p>
      </div>
      <div class="overview-stat" aria-label="用户总数">
        <span>当前用户</span>
        <strong>{{ store.total }}</strong>
      </div>
    </header>

    <div class="filter-panel">
      <div class="filter-heading">
        <div class="filter-icon"><el-icon><Filter /></el-icon></div>
        <div>
          <strong>筛选用户</strong>
          <span>支持跨用户名、昵称、用户 ID、邮箱和手机号搜索</span>
        </div>
      </div>
      <div class="user-toolbar" role="search">
        <el-select
          v-model="searchField"
          class="search-field"
          aria-label="查询字段"
          data-testid="user-search-field"
        >
          <el-option label="全部字段" value="keyword" />
          <el-option label="用户名" value="username" />
          <el-option label="显示名称" value="displayName" />
          <el-option label="用户 ID" value="userId" />
          <el-option label="邮箱" value="email" />
          <el-option label="手机号" value="phone" />
        </el-select>
        <el-input
          v-model="searchValue"
          class="search-input"
          data-testid="user-search-value"
          aria-label="查询内容"
          :placeholder="searchPlaceholder"
          clearable
          @keyup.enter="search"
        >
          <template #prefix><el-icon><Search /></el-icon></template>
        </el-input>
        <el-button
          type="primary"
          :icon="Search"
          data-testid="user-search-submit"
          :loading="store.loading"
          @click="search"
        >
          搜索
        </el-button>
        <el-button
          data-testid="user-search-reset"
          :disabled="!store.filter && !searchValue"
          @click="clearSearch"
        >
          重置
        </el-button>
        <el-button class="refresh-button" :icon="Refresh" :loading="store.loading" @click="store.load()">
          刷新
        </el-button>
      </div>
    </div>

    <el-alert v-if="store.error" :title="store.error" type="error" :closable="false" show-icon />

    <div class="user-list-card">
      <div class="list-heading">
        <div>
          <strong>用户列表</strong>
          <span v-if="store.filter">“{{ store.filter.value }}”的搜索结果</span>
          <span v-else>共 {{ store.total }} 位用户</span>
        </div>
        <span v-if="store.filter" class="active-filter">
          <el-icon><Search /></el-icon>{{ fieldLabel(store.filter.field) }}
        </span>
      </div>

      <el-table :data="store.items" v-loading="store.loading" row-key="userId">
        <el-table-column label="用户" min-width="260">
          <template #default="{ row }">
            <div class="user-cell">
              <span class="user-avatar">{{ userInitial(row) }}</span>
              <div>
                <strong>{{ row.displayName || row.username }}</strong>
                <small>@{{ row.username }}</small>
                <code>{{ row.userId }}</code>
              </div>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="联系方式" min-width="190">
          <template #default="{ row }">
            <div class="contact-cell">
              <span>{{ row.maskedEmail || '未绑定邮箱' }}</span>
              <small>{{ row.maskedPhone || '未绑定手机号' }}</small>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="100">
          <template #default="{ row }">
            <el-tag :type="row.status === 'active' ? 'success' : 'info'" effect="light" round>
              <span class="status-dot" />{{ row.status === 'active' ? '正常' : '已停用' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="角色" min-width="130">
          <template #default="{ row }">
            <span :class="['role-badge', { admin: row.role === 'super_admin' }]">{{ roleLabel(row.role) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="注册时间" min-width="180">
          <template #default="{ row }"><time>{{ formatTime(row.createdAt) }}</time></template>
        </el-table-column>
        <el-table-column label="操作" width="200" fixed="right" align="right">
          <template #default="{ row }">
            <div class="row-actions">
              <el-button
                link
                type="primary"
                :data-testid="`edit-role-${row.userId}`"
                :disabled="!canEdit(row)"
                @click="openRoleDialog(row)"
              >
                修改角色
              </el-button>
              <el-button
                link
                type="primary"
                :data-testid="`edit-membership-${row.userId}`"
                @click="openMembershipDialog(row)"
              >
                设置会员
              </el-button>
            </div>
          </template>
        </el-table-column>
        <template #empty>
          <div class="empty-users">
            <el-icon><User /></el-icon>
            <strong>没有找到匹配的用户</strong>
            <span>请尝试更换关键词或重置筛选条件</span>
          </div>
        </template>
      </el-table>

      <footer class="pagination-footer">
        <span>第 {{ store.page }} 页 · 共 {{ store.total }} 条</span>
        <el-pagination
          class="user-pagination"
          background
          layout="sizes, prev, pager, next"
          :total="store.total"
          :current-page="store.page"
          :page-size="store.pageSize"
          :page-sizes="[20, 50, 100]"
          @current-change="changePage"
          @size-change="changePageSize"
        />
      </footer>
    </div>

    <el-dialog
      v-model="dialogOpen"
      class="role-dialog"
      data-testid="role-confirm-dialog"
      width="560px"
      align-center
      append-to-body
    >
      <template #header>
        <div class="role-dialog-header">
          <span class="role-dialog-icon"><el-icon><Lock /></el-icon></span>
          <div>
            <h2>修改用户角色</h2>
            <p>为用户选择合适的权限范围</p>
          </div>
        </div>
      </template>
      <div v-if="selectedUser" class="role-dialog-body">
        <section class="role-user-summary">
          <span class="role-user-avatar">{{ userInitial(selectedUser) }}</span>
          <div>
            <strong>{{ selectedUser.displayName || selectedUser.username }}</strong>
            <span>@{{ selectedUser.username }}</span>
          </div>
          <span :class="['role-current-badge', { admin: selectedUser.role === 'super_admin' }]">
            当前：{{ roleLabel(selectedUser.role) }}
          </span>
        </section>

        <fieldset class="role-options" data-testid="role-select">
          <legend>选择角色</legend>
          <label :class="['role-option', { selected: selectedRole === 'user' }]" data-testid="role-option-user">
            <input v-model="selectedRole" type="radio" value="user" />
            <span class="role-option-icon"><el-icon><User /></el-icon></span>
            <span class="role-option-copy">
              <strong>普通用户</strong>
              <small>使用常规功能，不具备用户与会员管理权限</small>
            </span>
            <span class="role-option-check" aria-hidden="true" />
          </label>
          <label
            :class="['role-option', 'admin', { selected: selectedRole === 'super_admin' }]"
            data-testid="role-option-super-admin"
          >
            <input v-model="selectedRole" type="radio" value="super_admin" />
            <span class="role-option-icon"><el-icon><Lock /></el-icon></span>
            <span class="role-option-copy">
              <strong>超级管理员</strong>
              <small>可管理用户角色、会员状态及平台关键配置</small>
            </span>
            <span class="role-option-check" aria-hidden="true" />
          </label>
        </fieldset>

        <div :class="['role-impact-note', { warning: roleChanged && selectedRole === 'super_admin' }]">
          <el-icon><component :is="roleChanged && selectedRole === 'super_admin' ? WarningFilled : InfoFilled" /></el-icon>
          <span>{{ roleImpactMessage }}</span>
        </div>
      </div>
      <template #footer>
        <div class="role-dialog-footer">
          <el-button @click="dialogOpen = false">取消</el-button>
          <el-button
            type="primary"
            data-testid="confirm-role-update"
            :loading="store.updating"
            :disabled="!roleChanged"
            @click="confirmRoleUpdate"
          >
            确认调整
          </el-button>
        </div>
      </template>
    </el-dialog>

    <el-dialog
      v-model="membershipDialogOpen"
      class="membership-dialog"
      data-testid="membership-dialog"
      width="700px"
      align-center
      append-to-body
    >
      <template #header>
        <div class="membership-dialog-header">
          <span class="membership-dialog-icon"><el-icon><Medal /></el-icon></span>
          <div>
            <h2>设置会员</h2>
            <p v-if="selectedUser">
              {{ selectedUser.displayName || selectedUser.username }} · @{{ selectedUser.username }}
            </p>
          </div>
        </div>
      </template>
      <div v-loading="membership.loading" class="membership-dialog-body">
        <el-alert v-if="membership.error" :title="membership.error" type="error" :closable="false" show-icon />
        <div v-if="membership.selected" :class="['membership-current', membership.selected.planId]">
          <div class="membership-plan">
            <span class="membership-plan-icon"><el-icon><Medal /></el-icon></span>
            <div>
              <span>当前会员方案</span>
              <strong>{{ membership.selected.planId === 'pro' ? 'Pro 会员' : '免费版' }}</strong>
            </div>
          </div>
          <dl class="membership-meta">
            <div>
              <dt>会员状态</dt>
              <dd :class="`status-${membership.selected.effectiveStatus}`">
                <span class="membership-status-dot" />
                {{ membershipStatusLabel(membership.selected.effectiveStatus) }}
              </dd>
            </div>
            <div>
              <dt>有效期至</dt>
              <dd>{{ membership.selected.termEndsAt ? formatTime(membership.selected.termEndsAt) : '长期有效' }}</dd>
            </div>
          </dl>
        </div>

        <section class="membership-section">
          <header class="membership-section-heading">
            <div>
              <h3>会员变更</h3>
              <p>选择操作、有效期与原因</p>
            </div>
          </header>
          <div class="membership-form">
            <label>
              <span>会员操作</span>
              <select v-model="membershipOperation" data-testid="membership-operation">
                <option value="grant">开通 Pro</option>
                <option value="extend">续期</option>
                <option value="set_expiry">修改到期时间</option>
                <option value="revoke">撤销会员</option>
                <option value="correct">纠正会员状态</option>
              </select>
            </label>
            <label v-if="membershipOperation === 'correct'">
              <span>纠正方案</span>
              <select v-model="membershipCorrectionPlan">
                <option value="free">免费版</option>
                <option value="pro">Pro</option>
              </select>
            </label>
            <label v-if="membershipOperation === 'correct'">
              <span>纠正状态</span>
              <select v-model="membershipCorrectionState">
                <option value="active">有效</option>
                <option value="revoked">已撤销</option>
              </select>
            </label>
            <label v-if="membershipOperation !== 'revoke' && !(membershipOperation === 'correct' && membershipCorrectionPlan === 'free')">
              <span>到期时间</span>
              <input v-model="membershipTerm" type="datetime-local">
            </label>
            <label v-if="membershipOperation === 'grant' || (membershipOperation === 'correct' && membershipCorrectionPlan === 'pro')">
              <span>开通类型</span>
              <select v-model="membershipGrantKind">
                <option value="manual_grant">人工开通</option>
                <option value="manual_trial">试用</option>
              </select>
            </label>
            <label>
              <span>操作原因</span>
              <select v-model="membershipReason">
                <option value="manual_payment_confirmed">已确认线下付款</option>
                <option value="internal_grant">内部赠送</option>
                <option value="customer_compensation">客户补偿</option>
                <option value="trial">试用</option>
                <option value="renewal">续期</option>
                <option value="refund_revocation">退款撤销</option>
                <option value="risk_revocation">风险撤销</option>
                <option value="operator_correction">运营纠错</option>
              </select>
            </label>
            <label class="membership-note">
              <span>操作备注 <em>选填，请勿填写敏感信息</em></span>
              <textarea v-model.trim="membershipNote" maxlength="500" rows="2" placeholder="补充本次操作的必要说明" />
              <small>{{ membershipNote.length }} / 500</small>
            </label>
          </div>
          <div v-if="membershipOperation === 'revoke'" class="membership-submit-note danger">
            <el-icon><WarningFilled /></el-icon>
            <span>撤销后该用户将立即失去 Pro 会员权益，请确认操作原因无误。</span>
          </div>
        </section>

        <details class="membership-audit-disclosure">
          <summary>
            <div>
              <h3>最近操作记录</h3>
              <p>查看该用户的会员变更历史</p>
            </div>
            <strong>{{ membership.auditTotal }} 条</strong>
          </summary>
          <el-table class="membership-audit" :data="membership.audit" size="small" max-height="220">
            <el-table-column label="时间" width="155">
              <template #default="{ row }"><time>{{ formatTime(row.createdAt) }}</time></template>
            </el-table-column>
            <el-table-column label="操作" width="110">
              <template #default="{ row }"><span class="audit-action">{{ membershipActionLabel(row.action) }}</span></template>
            </el-table-column>
            <el-table-column label="原因" min-width="150">
              <template #default="{ row }">{{ membershipReasonLabel(row.reasonCode) }}</template>
            </el-table-column>
            <el-table-column label="操作人" min-width="150">
              <template #default="{ row }"><code>{{ row.actorUserId }}</code></template>
            </el-table-column>
            <template #empty>
              <div class="membership-audit-empty">
                <el-icon><DocumentChecked /></el-icon>
                <span>暂无会员操作记录</span>
              </div>
            </template>
          </el-table>
        </details>
      </div>
      <template #footer>
        <div class="membership-dialog-footer">
          <el-button @click="membershipDialogOpen = false">取消</el-button>
          <el-button
            :type="membershipOperation === 'revoke' ? 'danger' : 'primary'"
            data-testid="confirm-membership-update"
            :loading="membership.updating"
            :disabled="!membership.selected"
            @click="confirmMembershipUpdate"
          >
            {{ membershipConfirmLabel }}
          </el-button>
        </div>
      </template>
    </el-dialog>
  </section>
</template>

<script setup lang="ts">
import {
  DocumentChecked,
  Filter,
  InfoFilled,
  Lock,
  Medal,
  Refresh,
  Search,
  User,
  WarningFilled,
} from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import { computed, onMounted, ref } from 'vue'
import type {
  AssignableRole,
  MembershipEffectiveStatus,
  MembershipGrantKind,
  MembershipMutationRequest,
  MembershipPlanId,
  MembershipReasonCode,
  MembershipState,
  UserAdminFilter,
  UserAdminListItem,
} from '@autoforge/shared'
import { useAuthStore } from '../stores/auth'
import { useUserAdminStore } from '../stores/user-admin'
import { useMembershipStore } from '../stores/membership'

const auth = useAuthStore()
const store = useUserAdminStore()
const membership = useMembershipStore()
const searchField = ref<UserAdminFilter['field']>('keyword')
const searchValue = ref('')
const dialogOpen = ref(false)
const selectedUser = ref<UserAdminListItem>()
const selectedRole = ref<AssignableRole>('user')
const membershipDialogOpen = ref(false)
const membershipOperation = ref<MembershipMutationRequest['action']>('grant')
const membershipTerm = ref('')
const membershipGrantKind = ref<Extract<MembershipGrantKind, 'manual_grant' | 'manual_trial'>>('manual_grant')
const membershipCorrectionPlan = ref<MembershipPlanId>('free')
const membershipCorrectionState = ref<MembershipState>('active')
const membershipReason = ref<MembershipReasonCode>('manual_payment_confirmed')
const membershipNote = ref('')

const assignableRoles = new Set<string>(['user', 'super_admin'])
const canEdit = (user: UserAdminListItem) => (
  user.userId !== auth.session?.user.id && assignableRoles.has(user.role)
)
const roleLabel = (role: string) => (
  role === 'user' ? '普通用户' : role === 'super_admin' ? '超级管理员' : role
)
const fieldLabel = (field: UserAdminFilter['field']) => ({
  keyword: '全部字段', username: '用户名', displayName: '显示名称',
  userId: '用户 ID', email: '邮箱', phone: '手机号',
})[field]
const searchPlaceholder = computed(() => searchField.value === 'keyword'
  ? '输入关键词搜索用户'
  : `输入${fieldLabel(searchField.value)}进行搜索`)
const userInitial = (user: UserAdminListItem) => (
  user.displayName || user.username
).trim().slice(0, 1).toLocaleUpperCase()
const formatTime = (value: string) => new Date(value).toLocaleString('zh-CN', { hour12: false })
const membershipStatusLabel = (status: MembershipEffectiveStatus) => ({
  active: '有效', offline_grace: '离线宽限', expired: '已到期',
  revoked: '已撤销', unavailable: '不可用',
}[status])
const membershipActionLabel = (action: string) => ({
  grant: '开通', extend: '续期', set_expiry: '修改到期', revoke: '撤销', correct: '纠正',
}[action] ?? action)
const membershipReasonLabel = (reason: MembershipReasonCode) => ({
  manual_payment_confirmed: '已确认线下付款', internal_grant: '内部赠送',
  customer_compensation: '客户补偿', trial: '试用', renewal: '续期',
  refund_revocation: '退款撤销', risk_revocation: '风险撤销', operator_correction: '运营纠错',
}[reason])
const membershipConfirmLabel = computed(() => ({
  grant: '确认开通', extend: '确认续期', set_expiry: '确认修改',
  revoke: '确认撤销', correct: '确认纠正',
}[membershipOperation.value]))
const roleChanged = computed(() => Boolean(
  selectedUser.value && selectedUser.value.role !== selectedRole.value,
))
const roleImpactMessage = computed(() => {
  if (!roleChanged.value) return '当前选择与原角色一致，请选择其他角色后再确认调整。'
  return selectedRole.value === 'super_admin'
    ? '超级管理员拥有高权限，请确认该用户确实需要管理能力。'
    : '调整后，该用户将无法继续访问用户、会员等管理功能。'
})

async function search() {
  const keyword = searchValue.value.trim()
  searchValue.value = keyword
  await store.search(keyword
    ? { field: searchField.value, value: keyword }
    : undefined)
}
async function clearSearch() {
  searchValue.value = ''
  await store.search(undefined)
}
async function changePage(page: number) {
  store.page = page
  await store.load()
}
async function changePageSize(size: number) {
  if (size !== 20 && size !== 50 && size !== 100) return
  store.pageSize = size
  store.page = 1
  await store.load()
}
function openRoleDialog(user: UserAdminListItem) {
  if (!canEdit(user)) return
  selectedUser.value = user
  selectedRole.value = user.role === 'super_admin' ? 'super_admin' : 'user'
  dialogOpen.value = true
}
async function confirmRoleUpdate() {
  if (!selectedUser.value) return
  if (await store.updateRole(selectedUser.value, selectedRole.value)) dialogOpen.value = false
}
async function openMembershipDialog(user: UserAdminListItem) {
  selectedUser.value = user
  membershipOperation.value = 'grant'
  membershipReason.value = 'manual_payment_confirmed'
  membershipNote.value = ''
  membershipCorrectionPlan.value = 'free'
  membershipCorrectionState.value = 'active'
  const initial = new Date(Date.now() + 365 * 24 * 60 * 60 * 1_000)
  membershipTerm.value = new Date(initial.getTime() - initial.getTimezoneOffset() * 60_000)
    .toISOString().slice(0, 16)
  membershipDialogOpen.value = true
  await membership.loadTarget(user.userId)
}
async function confirmMembershipUpdate() {
  const current = membership.selected
  if (!current || !selectedUser.value) return
  const base = {
    requestId: globalThis.crypto.randomUUID(), targetUserId: selectedUser.value.userId,
    expectedVersion: current.version, reasonCode: membershipReason.value,
    ...(membershipNote.value ? { note: membershipNote.value } : {}),
  }
  let input: MembershipMutationRequest
  if (membershipOperation.value === 'revoke') {
    input = { ...base, action: 'revoke' }
  } else if (membershipOperation.value === 'correct' && membershipCorrectionPlan.value === 'free') {
    input = {
      ...base, action: 'correct', planId: 'free', state: membershipCorrectionState.value,
      grantKind: null, termEndsAt: null,
    }
  } else {
    const parsed = new Date(membershipTerm.value)
    if (!membershipTerm.value || Number.isNaN(parsed.getTime())) {
      ElMessage.error('请选择有效的到期时间')
      return
    }
    const termEndsAt = parsed.toISOString()
    input = membershipOperation.value === 'correct'
      ? {
          ...base, action: 'correct', planId: 'pro', state: membershipCorrectionState.value,
          grantKind: membershipGrantKind.value, termEndsAt,
        }
      : membershipOperation.value === 'grant'
      ? { ...base, action: 'grant', grantKind: membershipGrantKind.value, termEndsAt }
      : { ...base, action: membershipOperation.value, termEndsAt }
  }
  if (await membership.mutate(input)) ElMessage.success('会员状态已更新')
}

onMounted(() => { void store.load() })
</script>

<style scoped>
.user-management { display: grid; max-width: 1600px; margin: 0 auto; gap: 16px; padding: 22px 24px 40px; }
.user-overview { display: flex; align-items: flex-end; justify-content: space-between; gap: 24px; }
.section-eyebrow { color: var(--af-cobalt); font-size: 10px; font-weight: 750; letter-spacing: .12em; }
.user-overview h2 { margin: 4px 0 5px; color: var(--af-graphite); font-size: 22px; font-weight: 720; letter-spacing: -.02em; }
.user-overview p { margin: 0; color: var(--af-text-muted); font-size: 12px; }
.overview-stat { display: grid; min-width: 112px; gap: 2px; border-left: 1px solid var(--af-border); padding-left: 18px; }
.overview-stat span { color: var(--af-text-muted); font-size: 11px; }
.overview-stat strong { color: var(--af-graphite); font-size: 24px; font-weight: 720; line-height: 1.1; }
.filter-panel, .user-list-card { overflow: hidden; border: 1px solid var(--af-border); border-radius: 12px; background: var(--af-surface); box-shadow: 0 4px 18px rgb(32 36 43 / 4%); }
.filter-panel { display: grid; grid-template-columns: minmax(220px, auto) minmax(500px, 1fr); align-items: center; gap: 24px; padding: 16px 18px; }
.filter-heading { display: flex; min-width: 0; align-items: center; gap: 11px; }
.filter-heading > div:last-child { display: grid; min-width: 0; gap: 3px; }
.filter-heading strong { color: var(--af-graphite); font-size: 13px; }
.filter-heading span { color: var(--af-text-muted); font-size: 11px; line-height: 1.4; }
.filter-icon { display: grid; width: 34px; height: 34px; flex: none; place-items: center; border-radius: 9px; color: var(--af-cobalt); background: var(--af-cobalt-soft); }
.user-toolbar { display: flex; min-width: 0; align-items: center; justify-content: flex-end; gap: 8px; }
.search-field { width: 126px; flex: none; }
.search-input { min-width: 180px; max-width: 390px; flex: 1; }
.user-toolbar :deep(.el-select__wrapper), .user-toolbar :deep(.el-input__wrapper) { min-height: 38px; border-radius: 8px; box-shadow: 0 0 0 1px var(--af-border) inset; }
.user-toolbar :deep(.el-select__wrapper:hover), .user-toolbar :deep(.el-input__wrapper:hover) { box-shadow: 0 0 0 1px var(--af-border-strong) inset; }
.user-toolbar :deep(.el-select__wrapper.is-focused), .user-toolbar :deep(.el-input__wrapper.is-focus) { box-shadow: 0 0 0 1px var(--af-cobalt) inset, var(--af-focus); }
.user-toolbar :deep(.el-button) { min-height: 38px; border-radius: 8px; }
.refresh-button { margin-left: 2px; }
.list-heading { display: flex; min-height: 58px; align-items: center; justify-content: space-between; gap: 16px; border-bottom: 1px solid var(--af-border); padding: 12px 16px; }
.list-heading > div { display: grid; gap: 2px; }
.list-heading strong { color: var(--af-graphite); font-size: 14px; }
.list-heading span { color: var(--af-text-muted); font-size: 11px; }
.active-filter { display: inline-flex !important; align-items: center; gap: 5px; border: 1px solid color-mix(in srgb, var(--af-cobalt) 20%, var(--af-border)); border-radius: 999px; padding: 4px 9px; color: var(--af-cobalt) !important; background: var(--af-cobalt-soft); font-weight: 650; }
.user-list-card :deep(.el-table) { --el-table-border-color: var(--af-border); --el-table-header-bg-color: var(--af-surface-muted); --el-table-row-hover-bg-color: color-mix(in srgb, var(--af-cobalt-soft) 55%, var(--af-surface)); color: var(--af-text); }
.user-list-card :deep(.el-table th.el-table__cell) { height: 44px; color: var(--af-text-muted); font-size: 11px; font-weight: 700; }
.user-list-card :deep(.el-table td.el-table__cell) { height: 72px; }
.user-list-card :deep(.el-table .cell) { padding: 0 16px; }
.user-cell { display: flex; min-width: 0; align-items: center; gap: 11px; }
.user-cell > div, .contact-cell { display: grid; min-width: 0; gap: 2px; }
.user-avatar { display: grid; width: 36px; height: 36px; flex: none; place-items: center; border: 1px solid color-mix(in srgb, var(--af-cobalt) 18%, var(--af-border)); border-radius: 10px; color: var(--af-cobalt); background: var(--af-cobalt-soft); font-size: 14px; font-weight: 750; }
.user-cell strong { overflow: hidden; color: var(--af-graphite); font-size: 13px; font-weight: 680; text-overflow: ellipsis; white-space: nowrap; }
.user-cell small, .contact-cell small { color: var(--af-text-muted); font-size: 11px; }
.user-cell code { overflow: hidden; color: var(--af-text-muted); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 9px; text-overflow: ellipsis; white-space: nowrap; }
.contact-cell span { color: var(--af-text); font-size: 12px; }
.status-dot { display: inline-block; width: 5px; height: 5px; margin-right: 5px; border-radius: 50%; background: currentColor; vertical-align: 1px; }
.role-badge { display: inline-flex; align-items: center; border: 1px solid var(--af-border); border-radius: 6px; padding: 4px 8px; color: var(--af-text); background: var(--af-surface-muted); font-size: 11px; font-weight: 650; }
.role-badge.admin { border-color: color-mix(in srgb, var(--af-cobalt) 22%, var(--af-border)); color: var(--af-cobalt); background: var(--af-cobalt-soft); }
.user-list-card time { color: var(--af-text-muted); font-size: 11px; }
.row-actions { display: flex; justify-content: flex-end; gap: 2px; }
.empty-users { display: grid; min-height: 210px; place-items: center; align-content: center; gap: 7px; color: var(--af-text-muted); }
.empty-users > .el-icon { width: 38px; height: 38px; border-radius: 50%; color: var(--af-cobalt); background: var(--af-cobalt-soft); font-size: 18px; }
.empty-users strong { color: var(--af-graphite); font-size: 13px; }
.empty-users span { font-size: 11px; }
.pagination-footer { display: flex; min-height: 62px; align-items: center; justify-content: space-between; gap: 16px; border-top: 1px solid var(--af-border); padding: 10px 16px; background: var(--af-surface-muted); }
.pagination-footer > span { color: var(--af-text-muted); font-size: 11px; }
.user-pagination { justify-content: flex-end; }
:deep(.role-dialog) { overflow: hidden; border-radius: 16px; background: var(--af-surface); box-shadow: 0 24px 70px rgb(15 23 42 / 24%); }
:deep(.role-dialog .el-dialog__header) { margin: 0; border-bottom: 1px solid var(--af-border); padding: 20px 24px 18px; background: linear-gradient(135deg, var(--af-surface) 55%, var(--af-cobalt-soft)); }
:deep(.role-dialog .el-dialog__headerbtn) { top: 18px; right: 18px; width: 34px; height: 34px; border-radius: 9px; }
:deep(.role-dialog .el-dialog__headerbtn:hover) { background: color-mix(in srgb, var(--af-cobalt-soft) 65%, transparent); }
:deep(.role-dialog .el-dialog__body) { padding: 20px 22px; }
:deep(.role-dialog .el-dialog__footer) { border-top: 1px solid var(--af-border); padding: 14px 22px; background: var(--af-surface-muted); }
.role-dialog-header { display: flex; align-items: center; gap: 13px; padding-right: 44px; }
.role-dialog-icon { display: grid; width: 42px; height: 42px; flex: none; place-items: center; border: 1px solid color-mix(in srgb, var(--af-cobalt) 20%, var(--af-border)); border-radius: 12px; color: var(--af-cobalt); background: var(--af-cobalt-soft); font-size: 19px; }
.role-dialog-header > div { display: grid; gap: 2px; }
.role-dialog-header h2 { margin: 0; color: var(--af-graphite); font-size: 18px; font-weight: 720; letter-spacing: -.01em; }
.role-dialog-header p { margin: 1px 0 0; color: var(--af-text-muted); font-size: 11px; }
.role-dialog-body { display: grid; gap: 14px; }
.role-user-summary { display: flex; min-width: 0; align-items: center; gap: 11px; border: 1px solid var(--af-border); border-radius: 12px; padding: 12px 13px; background: var(--af-surface-muted); }
.role-user-avatar { display: grid; width: 40px; height: 40px; flex: none; place-items: center; border: 1px solid color-mix(in srgb, var(--af-cobalt) 20%, var(--af-border)); border-radius: 11px; color: var(--af-cobalt); background: var(--af-cobalt-soft); font-size: 15px; font-weight: 750; }
.role-user-summary > div { display: grid; min-width: 0; flex: 1; gap: 1px; }
.role-user-summary strong { overflow: hidden; color: var(--af-graphite); font-size: 13px; font-weight: 700; text-overflow: ellipsis; white-space: nowrap; }
.role-user-summary > div > span { color: var(--af-text-muted); font-size: 10px; }
.role-current-badge { flex: none; border: 1px solid var(--af-border); border-radius: 999px; padding: 5px 9px; color: var(--af-text); background: var(--af-surface); font-size: 9px; font-weight: 650; }
.role-current-badge.admin { border-color: color-mix(in srgb, var(--af-cobalt) 22%, var(--af-border)); color: var(--af-cobalt); background: var(--af-cobalt-soft); }
.role-options { display: grid; margin: 0; border: 0; padding: 0; gap: 8px; }
.role-options legend { margin-bottom: 7px; padding: 0; color: var(--af-graphite); font-size: 11px; font-weight: 700; }
.role-option { position: relative; display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 11px; border: 1px solid var(--af-border); border-radius: 11px; padding: 11px 12px; background: var(--af-surface); cursor: pointer; transition: border-color .16s ease, background .16s ease, box-shadow .16s ease, transform .16s ease; }
.role-option:hover { border-color: color-mix(in srgb, var(--af-cobalt) 34%, var(--af-border)); background: color-mix(in srgb, var(--af-cobalt-soft) 30%, var(--af-surface)); transform: translateY(-1px); }
.role-option.selected { border-color: color-mix(in srgb, var(--af-cobalt) 55%, var(--af-border)); background: color-mix(in srgb, var(--af-cobalt-soft) 60%, var(--af-surface)); box-shadow: 0 0 0 3px color-mix(in srgb, var(--af-cobalt) 8%, transparent); }
.role-option input { position: absolute; width: 1px; height: 1px; overflow: hidden; opacity: 0; }
.role-option-icon { display: grid; width: 34px; height: 34px; place-items: center; border-radius: 9px; color: var(--af-text-muted); background: var(--af-surface-muted); font-size: 16px; }
.role-option.selected .role-option-icon { color: var(--af-cobalt); background: var(--af-surface); }
.role-option-copy { display: grid; min-width: 0; gap: 2px; }
.role-option-copy strong { color: var(--af-graphite); font-size: 12px; font-weight: 700; }
.role-option-copy small { color: var(--af-text-muted); font-size: 9px; line-height: 1.45; }
.role-option-check { width: 15px; height: 15px; border: 1px solid var(--af-border-strong); border-radius: 50%; background: var(--af-surface); box-shadow: inset 0 0 0 4px var(--af-surface); }
.role-option.selected .role-option-check { border-color: var(--af-cobalt); background: var(--af-cobalt); }
.role-impact-note { display: flex; align-items: flex-start; gap: 7px; border-radius: 9px; padding: 9px 11px; color: var(--af-text-muted); background: var(--af-surface-muted); font-size: 9px; line-height: 1.5; }
.role-impact-note > .el-icon { margin-top: 1px; flex: none; color: var(--af-cobalt); }
.role-impact-note.warning { color: color-mix(in srgb, var(--af-warning) 78%, var(--af-graphite)); background: color-mix(in srgb, var(--af-warning) 10%, var(--af-surface)); }
.role-impact-note.warning > .el-icon { color: var(--af-warning); }
.role-dialog-footer { display: flex; align-items: center; justify-content: flex-end; gap: 8px; }
.role-dialog-footer :deep(.el-button) { min-height: 36px; border-radius: 8px; }
:deep(.membership-dialog) { overflow: hidden; border-radius: 16px; background: var(--af-surface); box-shadow: 0 24px 70px rgb(15 23 42 / 24%); }
:deep(.membership-dialog .el-dialog__header) { margin: 0; border-bottom: 1px solid var(--af-border); padding: 20px 24px 18px; background: linear-gradient(135deg, var(--af-surface) 55%, var(--af-cobalt-soft)); }
:deep(.membership-dialog .el-dialog__headerbtn) { top: 18px; right: 18px; width: 34px; height: 34px; border-radius: 9px; }
:deep(.membership-dialog .el-dialog__headerbtn:hover) { background: color-mix(in srgb, var(--af-cobalt-soft) 65%, transparent); }
:deep(.membership-dialog .el-dialog__body) { max-height: calc(100vh - 205px); overflow-y: auto; padding: 18px 22px 20px; }
:deep(.membership-dialog .el-dialog__footer) { border-top: 1px solid var(--af-border); padding: 14px 22px; background: var(--af-surface-muted); }
.membership-dialog-header { display: flex; align-items: center; gap: 13px; padding-right: 44px; }
.membership-dialog-icon { display: grid; width: 42px; height: 42px; flex: none; place-items: center; border: 1px solid color-mix(in srgb, var(--af-cobalt) 20%, var(--af-border)); border-radius: 12px; color: var(--af-cobalt); background: var(--af-cobalt-soft); font-size: 20px; }
.membership-dialog-header > div { display: grid; gap: 2px; }
.membership-dialog-header h2 { margin: 0; color: var(--af-graphite); font-size: 18px; font-weight: 720; letter-spacing: -.01em; }
.membership-dialog-header p { margin: 1px 0 0; color: var(--af-text-muted); font-size: 11px; }
.membership-dialog-body { display: grid; gap: 12px; min-height: 180px; }
.membership-current { display: grid; grid-template-columns: minmax(170px, .85fr) minmax(0, 1.15fr); align-items: stretch; overflow: hidden; border: 1px solid var(--af-border); border-radius: 12px; background: var(--af-surface-muted); }
.membership-current.pro { border-color: color-mix(in srgb, var(--af-cobalt) 22%, var(--af-border)); background: linear-gradient(135deg, var(--af-cobalt-soft), var(--af-surface-muted) 56%); }
.membership-plan { display: flex; align-items: center; gap: 10px; border-right: 1px solid var(--af-border); padding: 14px 16px; }
.membership-plan-icon { display: grid; width: 34px; height: 34px; flex: none; place-items: center; border-radius: 10px; color: var(--af-cobalt); background: var(--af-surface); box-shadow: 0 2px 8px rgb(32 36 43 / 6%); }
.membership-plan > div { display: grid; gap: 2px; }
.membership-plan span { color: var(--af-text-muted); font-size: 10px; }
.membership-plan strong { color: var(--af-graphite); font-size: 15px; font-weight: 720; }
.membership-meta { display: grid; grid-template-columns: .75fr 1.25fr; align-items: center; margin: 0; padding: 11px 14px; }
.membership-meta > div { display: grid; min-width: 0; gap: 4px; padding: 0 12px; }
.membership-meta > div + div { border-left: 1px solid var(--af-border); }
.membership-meta dt { color: var(--af-text-muted); font-size: 9px; font-weight: 650; }
.membership-meta dd { display: flex; min-width: 0; align-items: center; margin: 0; overflow: hidden; color: var(--af-text); font-size: 11px; font-weight: 650; text-overflow: ellipsis; white-space: nowrap; }
.membership-meta dd.status-active { color: var(--af-success); }
.membership-meta dd.status-expired, .membership-meta dd.status-revoked, .membership-meta dd.status-unavailable { color: var(--af-danger); }
.membership-meta dd.status-offline_grace { color: var(--af-warning); }
.membership-status-dot { width: 6px; height: 6px; margin-right: 6px; border-radius: 50%; background: currentColor; box-shadow: 0 0 0 3px color-mix(in srgb, currentColor 12%, transparent); }
.membership-section { overflow: hidden; border: 1px solid var(--af-border); border-radius: 12px; background: var(--af-surface); }
.membership-section-heading { display: flex; align-items: center; gap: 10px; border-bottom: 1px solid var(--af-border); padding: 11px 14px; background: var(--af-surface-muted); }
.membership-section-heading > div { display: grid; min-width: 0; gap: 1px; }
.membership-section-heading h3 { margin: 0; color: var(--af-graphite); font-size: 12px; font-weight: 700; }
.membership-section-heading p { margin: 0; color: var(--af-text-muted); font-size: 9px; }
.membership-form { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px 14px; padding: 14px; }
.membership-form label { display: grid; min-width: 0; gap: 6px; color: var(--af-text); font-size: 11px; font-weight: 650; }
.membership-form label > span { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.membership-form label em { color: var(--af-text-muted); font-size: 9px; font-style: normal; font-weight: 500; }
.membership-form select, .membership-form input, .membership-form textarea { width: 100%; border: 1px solid var(--af-border-strong); border-radius: 8px; padding: 8px 10px; color: var(--af-graphite); background: var(--af-surface); transition: border-color .16s ease, box-shadow .16s ease; }
.membership-form select, .membership-form input { min-height: 38px; }
.membership-form select:hover, .membership-form input:hover, .membership-form textarea:hover { border-color: var(--af-control-hover); }
.membership-form select:focus, .membership-form input:focus, .membership-form textarea:focus { border-color: var(--af-cobalt); outline: none; box-shadow: var(--af-focus); }
.membership-form textarea { min-height: 68px; resize: vertical; line-height: 1.5; }
.membership-form textarea::placeholder { color: var(--af-text-muted); opacity: .72; }
.membership-note { position: relative; grid-column: 1 / -1; }
.membership-note small { position: absolute; right: 9px; bottom: 7px; color: var(--af-text-muted); font-size: 9px; font-weight: 500; }
.membership-submit-note { display: flex; align-items: flex-start; gap: 7px; border-top: 1px solid var(--af-border); padding: 9px 14px; color: var(--af-text-muted); background: color-mix(in srgb, var(--af-cobalt-soft) 45%, var(--af-surface)); font-size: 10px; line-height: 1.5; }
.membership-submit-note > .el-icon { margin-top: 1px; flex: none; color: var(--af-cobalt); }
.membership-submit-note.danger { color: var(--af-danger); background: var(--af-danger-soft); }
.membership-submit-note.danger > .el-icon { color: var(--af-danger); }
.membership-audit-disclosure { overflow: hidden; border: 1px solid var(--af-border); border-radius: 11px; background: var(--af-surface); }
.membership-audit-disclosure summary { display: flex; align-items: center; gap: 12px; padding: 11px 14px; color: var(--af-graphite); background: var(--af-surface-muted); cursor: pointer; list-style: none; }
.membership-audit-disclosure summary::-webkit-details-marker { display: none; }
.membership-audit-disclosure summary > div { display: grid; min-width: 0; flex: 1; gap: 1px; }
.membership-audit-disclosure summary h3 { margin: 0; font-size: 11px; font-weight: 700; }
.membership-audit-disclosure summary p { margin: 0; color: var(--af-text-muted); font-size: 9px; }
.membership-audit-disclosure summary strong { border: 1px solid var(--af-border); border-radius: 999px; padding: 3px 8px; color: var(--af-text-muted); background: var(--af-surface); font-size: 9px; font-weight: 650; }
.membership-audit-disclosure summary::after { color: var(--af-text-muted); font-size: 12px; content: '⌄'; transition: transform .16s ease; }
.membership-audit-disclosure[open] summary::after { transform: rotate(180deg); }
.membership-audit-disclosure :deep(.el-table) { --el-table-border-color: var(--af-border); --el-table-header-bg-color: var(--af-surface); --el-table-row-hover-bg-color: var(--af-surface-muted); color: var(--af-text); }
.membership-audit-disclosure :deep(.el-table th.el-table__cell) { height: 34px; color: var(--af-text-muted); font-size: 9px; font-weight: 700; }
.membership-audit-disclosure :deep(.el-table td.el-table__cell) { height: 38px; font-size: 10px; }
.membership-audit time { color: var(--af-text-muted); font-size: 9px; }
.membership-audit code { color: var(--af-text-muted); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 9px; }
.audit-action { display: inline-flex; border-radius: 6px; padding: 3px 7px; color: var(--af-cobalt); background: var(--af-cobalt-soft); font-size: 9px; font-weight: 650; }
.membership-audit-empty { display: grid; min-height: 92px; place-items: center; align-content: center; gap: 6px; color: var(--af-text-muted); font-size: 10px; }
.membership-audit-empty > .el-icon { width: 28px; height: 28px; border-radius: 50%; color: var(--af-cobalt); background: var(--af-cobalt-soft); font-size: 14px; }
.membership-dialog-footer { display: flex; align-items: center; justify-content: flex-end; gap: 8px; }
.membership-dialog-footer :deep(.el-button) { min-height: 36px; border-radius: 8px; }
@media (max-width: 1180px) {
  .filter-panel { grid-template-columns: 1fr; gap: 12px; }
  .user-toolbar { justify-content: flex-start; }
  .search-input { max-width: none; }
  .refresh-button { margin-left: auto; }
}
</style>
