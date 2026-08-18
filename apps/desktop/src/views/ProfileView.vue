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
        <header><h2>联系方式</h2><p>邮箱和手机号暂不进行验证码验证。</p></header>
        <div class="profile-grid">
          <label>邮箱<input
            v-model="draft.email"
            data-testid="profile-email"
            aria-label="邮箱"
            type="email"
            autocomplete="email"
          ></label>
          <label>手机号<input
            v-model="draft.phone"
            data-testid="profile-phone"
            aria-label="手机号"
            type="tel"
            autocomplete="tel"
          ></label>
        </div>
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
const formError = ref('')
const draft = reactive<ProfileDraft>({
  avatarUrl: '', displayName: '', gender: '', birthDate: '', email: '', phone: '',
})
const baseline = ref('')

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
  baseline.value = JSON.stringify(draft)
}

const dirty = computed(() => JSON.stringify(draft) !== baseline.value)
const accountInitial = computed(() => (profile.profile?.account ?? auth.session?.user.account ?? '?').charAt(0).toUpperCase())
const today = computed(() => {
  const now = new Date()
  const year = String(now.getFullYear()).padStart(4, '0')
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
})

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
  const phone = draft.phone.replace(/[ -]/g, '')
  const valid = Array.from(draft.displayName.trim()).length <= 50
    && validDate(draft.birthDate)
    && (!draft.email.trim() || (draft.email.trim().length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(draft.email.trim())))
    && (!phone || /^\+?\d{6,20}$/.test(phone))
  if (!valid) {
    formError.value = '请检查显示名称、生日、邮箱或手机号格式'
    return undefined
  }
  return {
    ...(draft.avatarUrl ? { avatarUrl: draft.avatarUrl } : {}),
    displayName: draft.displayName,
    ...(draft.gender ? { gender: draft.gender } : {}),
    birthDate: draft.birthDate,
    email: draft.email,
    phone: draft.phone,
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
  if (!dirty.value || !baseline.value) replaceDraft(value)
}, { immediate: true })

onMounted(() => {
  if (auth.session) void profile.load(auth.session.user.id)
})
</script>

<style scoped>
.profile-page { width: min(100%, 920px); margin: 0 auto; padding: 24px; }
.profile-card { overflow: hidden; border: 1px solid var(--af-border); border-radius: 12px; background: var(--af-surface); box-shadow: 0 8px 24px rgb(32 36 43 / 5%); }
.profile-avatar-section { display: flex; align-items: center; gap: 20px; border-bottom: 1px solid var(--af-border); padding: 24px; background: var(--af-surface-muted); }
.profile-avatar { width: 88px; height: 88px; flex: none; border: 1px solid var(--af-border); border-radius: 50%; object-fit: cover; background: white; }
.profile-avatar-fallback { display: grid; place-items: center; color: white; background: var(--af-cobalt); font-size: 30px; font-weight: 750; }
.profile-avatar-section h2, .profile-section h2 { margin: 0; color: var(--af-graphite); font-size: 16px; }
.profile-avatar-section p, .profile-section p { margin: 5px 0 12px; color: var(--af-text-muted); font-size: 12px; }
.profile-section { padding: 22px 24px; }
.profile-section + .profile-section { border-top: 1px solid var(--af-border); }
.profile-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px; }
.profile-grid label { display: grid; gap: 7px; color: var(--af-text); font-size: 12px; font-weight: 650; }
.profile-grid input, .profile-grid select { width: 100%; height: 38px; border: 1px solid var(--af-border-strong); border-radius: 6px; padding: 0 11px; color: var(--af-text); background: white; }
.profile-grid input:focus, .profile-grid select:focus { border-color: var(--af-cobalt); outline: none; box-shadow: var(--af-focus); }
.profile-grid input[readonly] { color: var(--af-text-muted); background: var(--af-surface-muted); }
.profile-error { margin: 0 24px; border-left: 3px solid var(--af-danger); padding: 9px 11px; color: var(--af-danger); background: #fff5f5; font-size: 12px; }
.profile-actions { display: flex; justify-content: flex-end; border-top: 1px solid var(--af-border); padding: 16px 24px; }
@media (max-width: 900px) { .profile-grid { grid-template-columns: 1fr; } }
</style>
