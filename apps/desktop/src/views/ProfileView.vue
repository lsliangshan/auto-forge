<template>
  <section class="profile-page">
    <div
      v-if="profile.loading && !profile.profile"
      class="af-empty"
    >
      正在加载个人资料…
    </div>
    <form
      v-else
      class="profile-card"
      @submit.prevent="save"
    >
      <header class="profile-avatar-section">
        <img
          v-if="draft.avatarUrl"
          data-testid="profile-avatar"
          class="profile-avatar"
          :src="draft.avatarUrl"
          alt="当前头像"
        >
        <span
          v-else
          class="profile-avatar profile-avatar-fallback"
        >{{ accountInitial }}</span>
        <div>
          <h2>头像</h2>
          <p>支持 JPEG、PNG 和 WebP，文件不超过 5 MiB。</p>
          <el-button
            data-testid="change-avatar"
            :loading="profile.uploadingAvatar"
            :disabled="profile.uploadingAvatar"
            @click="changeAvatar"
          >
            更换头像
          </el-button>
        </div>
      </header>

      <section class="profile-section">
        <header><h2>基本资料</h2><p>账号是登录身份标识，不能在此修改。</p></header>
        <div class="profile-grid">
          <label>账号<input
            data-testid="profile-account"
            aria-label="账号"
            :value="profile.profile?.account ?? auth.session?.user.account ?? ''"
            readonly
          ></label>
          <label>显示名称<input
            v-model="draft.displayName"
            data-testid="profile-display-name"
            aria-label="显示名称"
            maxlength="100"
            autocomplete="name"
          ></label>
          <label>性别<select
            v-model="draft.gender"
            data-testid="profile-gender"
            aria-label="性别"
          >
            <option value="">未设置</option>
            <option value="male">男</option>
            <option value="female">女</option>
            <option value="other">其他</option>
            <option value="prefer_not_to_say">不愿透露</option>
          </select></label>
          <label>生日<input
            v-model="draft.birthDate"
            data-testid="profile-birth-date"
            aria-label="生日"
            type="date"
            :max="today"
          ></label>
        </div>
      </section>

      <section class="profile-section">
        <header><h2>联系方式</h2><p>来自 CloudBase 账号，修改需验证码。</p></header>
        <div class="profile-grid">
          <label>邮箱<input
            v-model="draft.email"
            data-testid="profile-email"
            aria-label="邮箱"
            type="email"
            readonly
          ></label>
          <label>手机号<input
            v-model="draft.phone"
            data-testid="profile-phone"
            aria-label="手机号"
            type="tel"
            readonly
          ></label>
        </div>
      </section>

      <section class="profile-section membership-section" data-testid="membership-card">
        <header><h2>会员与用量</h2><p>会员状态由 AutoForge 服务端签名确认。</p></header>
        <div v-if="membership.current" class="membership-summary">
          <div><span>当前版本</span><strong>{{ planLabel }}</strong></div>
          <div><span>状态</span><strong>{{ membershipStatusLabel }}</strong></div>
          <div><span>到期时间</span><strong>{{ membershipExpiry }}</strong></div>
          <div><span>知识库用量</span><strong>{{ knowledge.bases.length }} / {{ membership.current.limits.knowledgeBases }}</strong></div>
          <div><span>文件用量</span><strong>{{ documentUsage }} / {{ membership.current.limits.knowledgeDocuments }}</strong></div>
          <div><span>单文件上限</span><strong>{{ formatBytes(membership.current.limits.knowledgeFileBytes) }}</strong></div>
        </div>
        <p
          v-else-if="membership.error"
          class="membership-unavailable"
          role="status"
        >
          {{ membership.error }}
        </p>
        <p v-else class="membership-loading">正在加载会员信息…</p>
      </section>

      <p
        v-if="formError || profile.error"
        class="profile-error"
        role="alert"
      >
        {{ formError || profile.error }}
      </p>
      <footer class="profile-actions">
        <el-button
          type="primary"
          native-type="submit"
          data-testid="save-profile"
          :loading="profile.saving"
          :disabled="!dirty || profile.loading || profile.saving"
        >
          保存资料
        </el-button>
      </footer>
    </form>
  </section>
</template>

<script setup lang="ts">
import { ElMessage } from 'element-plus'
import { computed, onMounted, reactive, ref, watch } from 'vue'
import type { ProfileGender, UserProfile, UserProfileUpdate } from '@autoforge/shared'
import { useAuthStore } from '../stores/auth'
import { useProfileStore } from '../stores/profile'
import { useKnowledgeStore } from '../stores/knowledge'
import { useMembershipStore } from '../stores/membership'

interface ProfileDraft {
  avatarUrl: string
  displayName: string
  gender: '' | ProfileGender
  birthDate: string
  email: string
  phone: string
}

const auth = useAuthStore()
const profile = useProfileStore()
const knowledge = useKnowledgeStore()
const membership = useMembershipStore()
const formError = ref('')
const draft = reactive<ProfileDraft>({
  avatarUrl: '', displayName: '', gender: '', birthDate: '', email: '', phone: '',
})
const baseline = ref('')

function editableDraft(value: ProfileDraft) {
  return {
    avatarUrl: value.avatarUrl,
    displayName: value.displayName,
    gender: value.gender,
    birthDate: value.birthDate,
  }
}

function profileDraft(value: UserProfile | null): ProfileDraft {
  return {
    avatarUrl: value?.avatarUrl ?? '',
    displayName: value?.displayName ?? '',
    gender: value?.gender ?? '',
    birthDate: value?.birthDate ?? '',
    email: value?.email ?? '',
    phone: value?.phone ?? '',
  }
}

function replaceDraft(value: UserProfile | null) {
  Object.assign(draft, profileDraft(value))
  baseline.value = JSON.stringify(editableDraft(draft))
}

const dirty = computed(() => JSON.stringify(editableDraft(draft)) !== baseline.value)
const accountInitial = computed(() => (profile.profile?.account ?? auth.session?.user.account ?? '?').charAt(0).toUpperCase())
const today = computed(() => {
  const now = new Date()
  const year = String(now.getFullYear()).padStart(4, '0')
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
})
const documentUsage = computed(() => knowledge.bases.reduce(
  (total, base) => total + base.documentCount, 0,
))
const planLabel = computed(() => membership.current?.planId === 'pro' ? 'Pro 会员' : '免费版')
const membershipStatusLabel = computed(() => ({
  active: '有效', offline_grace: '离线宽限', expired: '已到期',
  revoked: '已撤销', unavailable: '云端不可用',
}[membership.current?.effectiveStatus ?? 'unavailable']))
const membershipExpiry = computed(() => membership.current?.termEndsAt
  ? new Date(membership.current.termEndsAt).toLocaleString('zh-CN', { hour12: false })
  : '长期有效')
const formatBytes = (bytes: number) => `${Math.round(bytes / 1024 / 1024)} MiB`

function validDate(value: string): boolean {
  if (!value) return true
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match || value > today.value) return false
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const parsed = new Date(year, month - 1, day)
  return parsed.getFullYear() === year && parsed.getMonth() === month - 1 && parsed.getDate() === day
}

function input(): UserProfileUpdate | undefined {
  const valid = Array.from(draft.displayName.trim()).length <= 50
    && validDate(draft.birthDate)
  if (!valid) {
    formError.value = '请检查显示名称或生日格式'
    return undefined
  }
  return {
    ...(draft.avatarUrl ? { avatarUrl: draft.avatarUrl } : {}),
    displayName: draft.displayName,
    ...(draft.gender ? { gender: draft.gender } : {}),
    birthDate: draft.birthDate,
  }
}

async function changeAvatar() {
  formError.value = ''
  const url = await profile.pickAndUploadAvatar()
  if (url) draft.avatarUrl = url
}

async function save() {
  formError.value = ''
  const update = input()
  if (!update) return
  const saved = await profile.update(update)
  if (!saved) return
  replaceDraft(saved)
  ElMessage.success('个人资料已保存')
}

watch(() => profile.profile, (value) => {
  if (!dirty.value || !baseline.value) {
    replaceDraft(value)
    return
  }
  draft.email = value?.email ?? ''
  draft.phone = value?.phone ?? ''
}, { immediate: true })

onMounted(() => {
  if (auth.session) {
    void profile.load(auth.session.user.id)
    if (window.autoForge?.membership) void membership.loadCurrent()
    else membership.error = '会员信息暂时不可用'
    if (window.autoForge?.knowledge) void knowledge.bindOwner(auth.session.user.id)
  }
})
</script>

<style scoped>
.profile-page { width: min(100%, 920px); margin: 0 auto; padding: 24px; }
.profile-card { overflow: hidden; border: 1px solid var(--af-border); border-radius: 12px; background: var(--af-surface); box-shadow: 0 8px 24px rgb(32 36 43 / 5%); }
.profile-avatar-section { display: flex; align-items: center; gap: 20px; border-bottom: 1px solid var(--af-border); padding: 24px; background: var(--af-surface-muted); }
.profile-avatar { width: 88px; height: 88px; flex: none; border: 1px solid var(--af-border); border-radius: 50%; object-fit: cover; background: var(--af-surface); }
.profile-avatar-fallback { display: grid; place-items: center; color: white; background: var(--af-cobalt); font-size: 1.875rem; font-weight: 750; }
.profile-avatar-section h2, .profile-section h2 { margin: 0; color: var(--af-graphite); font-size: 1rem; }
.profile-avatar-section p, .profile-section p { margin: 5px 0 12px; color: var(--af-text-muted); font-size: 0.75rem; }
.profile-section { padding: 22px 24px; }
.profile-section + .profile-section { border-top: 1px solid var(--af-border); }
.profile-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px; }
.profile-grid label { display: grid; gap: 7px; color: var(--af-text); font-size: 0.75rem; font-weight: 650; }
.profile-grid input, .profile-grid select { width: 100%; height: 38px; border: 1px solid var(--af-border-strong); border-radius: 6px; padding: 0 11px; color: var(--af-text); background: var(--af-surface); }
.profile-grid input:focus, .profile-grid select:focus { border-color: var(--af-cobalt); outline: none; box-shadow: var(--af-focus); }
.profile-grid input[readonly] { color: var(--af-text-muted); background: var(--af-surface-muted); }
.profile-error { margin: 0 24px; border-left: 3px solid var(--af-danger); padding: 9px 11px; color: var(--af-danger); background: var(--af-danger-soft); font-size: 0.75rem; }
.membership-summary { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
.membership-summary div { display: grid; gap: 4px; border: 1px solid var(--af-border); border-radius: 8px; padding: 12px; background: var(--af-surface-muted); }
.membership-summary span, .membership-loading { color: var(--af-text-muted); font-size: 0.75rem; }
.membership-unavailable { border-left: 3px solid var(--af-warning); padding: 9px 11px; color: var(--af-text); background: var(--af-warning-soft); }
.membership-summary strong { color: var(--af-graphite); font-size: 0.875rem; }
.profile-actions { display: flex; justify-content: flex-end; border-top: 1px solid var(--af-border); padding: 16px 24px; }
@media (max-width: 900px) { .profile-grid, .membership-summary { grid-template-columns: 1fr; } }
</style>
