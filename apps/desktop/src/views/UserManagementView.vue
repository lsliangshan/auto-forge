<template>
  <section class="user-management">
    <div class="user-toolbar">
      <select v-model="searchField" aria-label="查询字段" data-testid="user-search-field">
        <option value="username">用户名</option>
        <option value="displayName">显示名称</option>
        <option value="userId">用户 ID</option>
        <option value="email">邮箱</option>
        <option value="phone">手机号</option>
      </select>
      <input
        v-model.trim="searchValue"
        data-testid="user-search-value"
        aria-label="查询内容"
        placeholder="输入精确用户信息"
        @keyup.enter="search"
      >
      <el-button data-testid="user-search-submit" :loading="store.loading" @click="search">
        查询
      </el-button>
      <el-button :disabled="!store.filter" @click="clearSearch">清除</el-button>
    </div>

    <el-alert v-if="store.error" :title="store.error" type="error" :closable="false" show-icon />

    <el-table :data="store.items" v-loading="store.loading" row-key="userId">
      <el-table-column label="用户" min-width="180">
        <template #default="{ row }">
          <strong>{{ row.displayName || row.username }}</strong>
          <small>{{ row.username }} · {{ row.userId }}</small>
        </template>
      </el-table-column>
      <el-table-column label="联系方式" min-width="180">
        <template #default="{ row }">
          <span>{{ row.maskedEmail || '—' }}</span>
          <small>{{ row.maskedPhone || '—' }}</small>
        </template>
      </el-table-column>
      <el-table-column label="状态" width="90">
        <template #default="{ row }">{{ row.status === 'active' ? '正常' : '已停用' }}</template>
      </el-table-column>
      <el-table-column label="角色" min-width="140">
        <template #default="{ row }">{{ roleLabel(row.role) }}</template>
      </el-table-column>
      <el-table-column label="注册时间" min-width="170">
        <template #default="{ row }">{{ formatTime(row.createdAt) }}</template>
      </el-table-column>
      <el-table-column label="操作" width="190" fixed="right">
        <template #default="{ row }">
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
            :disabled="row.userId === auth.session?.user.id"
            @click="openMembershipDialog(row)"
          >
            设置会员
          </el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-pagination
      class="user-pagination"
      background
      layout="total, sizes, prev, pager, next"
      :total="store.total"
      :current-page="store.page"
      :page-size="store.pageSize"
      :page-sizes="[20, 50, 100]"
      @current-change="changePage"
      @size-change="changePageSize"
    />

    <el-dialog
      v-model="dialogOpen"
      data-testid="role-confirm-dialog"
      title="确认修改用户角色"
      width="420px"
      append-to-body
    >
      <p v-if="selectedUser">
        将 {{ selectedUser.displayName || selectedUser.username }} 的角色修改为：
      </p>
      <select v-model="selectedRole" data-testid="role-select" aria-label="新角色">
        <option value="user">普通用户</option>
        <option value="super_admin">超级管理员</option>
      </select>
      <template #footer>
        <el-button @click="dialogOpen = false">取消</el-button>
        <el-button
          type="primary"
          data-testid="confirm-role-update"
          :loading="store.updating"
          @click="confirmRoleUpdate"
        >
          确认修改
        </el-button>
      </template>
    </el-dialog>

    <el-dialog
      v-model="membershipDialogOpen"
      data-testid="membership-dialog"
      title="会员设置与审计"
      width="680px"
      append-to-body
    >
      <div v-loading="membership.loading" class="membership-dialog-body">
        <el-alert v-if="membership.error" :title="membership.error" type="error" :closable="false" show-icon />
        <div v-if="membership.selected" class="membership-current">
          <strong>{{ membership.selected.planId === 'pro' ? 'Pro 会员' : '免费版' }}</strong>
          <span>状态：{{ membershipStatusLabel(membership.selected.effectiveStatus) }}</span>
          <span>版本：{{ membership.selected.version }}</span>
          <span>到期：{{ membership.selected.termEndsAt ? formatTime(membership.selected.termEndsAt) : '长期有效' }}</span>
        </div>
        <div class="membership-form">
          <label>操作<select v-model="membershipOperation" data-testid="membership-operation">
            <option value="grant">开通 Pro</option>
            <option value="extend">续期</option>
            <option value="set_expiry">修改到期时间</option>
            <option value="revoke">撤销会员</option>
            <option value="correct">纠正会员状态</option>
          </select></label>
          <label v-if="membershipOperation === 'correct'">纠正方案<select v-model="membershipCorrectionPlan">
            <option value="free">免费版</option>
            <option value="pro">Pro</option>
          </select></label>
          <label v-if="membershipOperation === 'correct'">纠正状态<select v-model="membershipCorrectionState">
            <option value="active">有效</option>
            <option value="revoked">已撤销</option>
          </select></label>
          <label v-if="membershipOperation !== 'revoke' && !(membershipOperation === 'correct' && membershipCorrectionPlan === 'free')">到期时间<input v-model="membershipTerm" type="datetime-local"></label>
          <label v-if="membershipOperation === 'grant' || (membershipOperation === 'correct' && membershipCorrectionPlan === 'pro')">开通类型<select v-model="membershipGrantKind">
            <option value="manual_grant">人工开通</option>
            <option value="manual_trial">试用</option>
          </select></label>
          <label>原因<select v-model="membershipReason">
            <option value="manual_payment_confirmed">已确认线下付款</option>
            <option value="internal_grant">内部赠送</option>
            <option value="customer_compensation">客户补偿</option>
            <option value="trial">试用</option>
            <option value="renewal">续期</option>
            <option value="refund_revocation">退款撤销</option>
            <option value="risk_revocation">风险撤销</option>
            <option value="operator_correction">运营纠错</option>
          </select></label>
          <label class="membership-note">备注（可选，勿填写敏感信息）<textarea v-model.trim="membershipNote" maxlength="500" rows="2" /></label>
        </div>
        <div class="membership-audit">
          <h3>最近操作记录（{{ membership.auditTotal }}）</h3>
          <el-table :data="membership.audit" size="small" max-height="220">
            <el-table-column label="时间" width="170"><template #default="{ row }">{{ formatTime(row.createdAt) }}</template></el-table-column>
            <el-table-column prop="action" label="操作" width="100" />
            <el-table-column prop="reasonCode" label="原因" min-width="180" />
            <el-table-column prop="actorUserId" label="操作人" min-width="130" />
          </el-table>
        </div>
      </div>
      <template #footer>
        <el-button @click="membershipDialogOpen = false">关闭</el-button>
        <el-button type="primary" data-testid="confirm-membership-update" :loading="membership.updating" :disabled="!membership.selected" @click="confirmMembershipUpdate">
          确认执行
        </el-button>
      </template>
    </el-dialog>
  </section>
</template>

<script setup lang="ts">
import { ElMessage } from 'element-plus'
import { onMounted, ref } from 'vue'
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
const searchField = ref<UserAdminFilter['field']>('username')
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
const formatTime = (value: string) => new Date(value).toLocaleString('zh-CN', { hour12: false })
const membershipStatusLabel = (status: MembershipEffectiveStatus) => ({
  active: '有效', offline_grace: '离线宽限', expired: '已到期',
  revoked: '已撤销', unavailable: '不可用',
}[status])

async function search() {
  await store.search(searchValue.value
    ? { field: searchField.value, value: searchValue.value }
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
  if (user.userId === auth.session?.user.id) return
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
.user-management { display: grid; gap: 14px; padding: 18px; }
.user-toolbar { display: flex; gap: 8px; align-items: center; }
.user-toolbar select, .user-toolbar input, [data-testid='role-select'] { min-height: 32px; border: 1px solid var(--af-border); border-radius: 5px; padding: 0 10px; color: var(--af-graphite); background: var(--af-surface); }
.user-toolbar input { width: min(360px, 40vw); }
.el-table strong, .el-table small, .el-table span { display: block; }
.el-table small { margin-top: 3px; color: var(--af-text-muted); }
.user-pagination { justify-content: flex-end; }
[data-testid='role-select'] { width: 100%; }
.membership-dialog-body { display: grid; gap: 16px; min-height: 180px; }
.membership-current { display: flex; flex-wrap: wrap; gap: 8px 18px; border: 1px solid var(--af-border); border-radius: 8px; padding: 12px; background: var(--af-surface-muted); }
.membership-form { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.membership-form label { display: grid; gap: 6px; color: var(--af-text); font-size: 12px; font-weight: 650; }
.membership-form select, .membership-form input, .membership-form textarea { border: 1px solid var(--af-border); border-radius: 5px; padding: 7px 9px; color: var(--af-graphite); background: var(--af-surface); }
.membership-note { grid-column: 1 / -1; }
.membership-audit h3 { margin: 0 0 8px; font-size: 14px; }
</style>
