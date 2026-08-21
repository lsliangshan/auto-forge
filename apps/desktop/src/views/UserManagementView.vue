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
      <el-table-column label="操作" width="110" fixed="right">
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
  </section>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import type { AssignableRole, UserAdminFilter, UserAdminListItem } from '@autoforge/shared'
import { useAuthStore } from '../stores/auth'
import { useUserAdminStore } from '../stores/user-admin'

const auth = useAuthStore()
const store = useUserAdminStore()
const searchField = ref<UserAdminFilter['field']>('username')
const searchValue = ref('')
const dialogOpen = ref(false)
const selectedUser = ref<UserAdminListItem>()
const selectedRole = ref<AssignableRole>('user')

const assignableRoles = new Set<string>(['user', 'super_admin'])
const canEdit = (user: UserAdminListItem) => (
  user.userId !== auth.session?.user.id && assignableRoles.has(user.role)
)
const roleLabel = (role: string) => (
  role === 'user' ? '普通用户' : role === 'super_admin' ? '超级管理员' : role
)
const formatTime = (value: string) => new Date(value).toLocaleString('zh-CN', { hour12: false })

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
</style>
