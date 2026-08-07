<template>
  <AuthLayout>
    <h1 id="auth-title">注册本地账号</h1>
    <p class="auth-description">账号只保存在这台设备上，注册成功后将自动登录。</p>
    <form
      data-testid="register-form"
      class="auth-form"
      @submit.prevent="submit"
    >
      <label for="register-account">账号</label>
      <el-input
        id="register-account"
        v-model="account"
        data-testid="register-account"
        autocomplete="username"
        :disabled="auth.submitting"
      />
      <label for="register-password">密码</label>
      <el-input
        id="register-password"
        v-model="password"
        data-testid="register-password"
        type="password"
        autocomplete="new-password"
        show-password
        :disabled="auth.submitting"
      />
      <label for="register-confirm">确认密码</label>
      <el-input
        id="register-confirm"
        v-model="confirmation"
        data-testid="register-confirm"
        type="password"
        autocomplete="new-password"
        show-password
        :disabled="auth.submitting"
      />
      <p
        v-if="formError"
        class="auth-error"
        role="alert"
      >
        {{ formError }}
      </p>
      <el-button
        type="primary"
        native-type="submit"
        :loading="auth.submitting"
        :disabled="auth.submitting"
      >
        注册并登录
      </el-button>
    </form>
    <p class="auth-switch">
      已有本地账号？<RouterLink to="/login">返回登录</RouterLink>
    </p>
  </AuthLayout>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { authCredentialsSchema } from '@autoforge/shared'
import AuthLayout from '../layouts/AuthLayout.vue'
import { useAuthStore } from '../stores/auth'

const auth = useAuthStore()
const router = useRouter()
const account = ref('')
const password = ref('')
const confirmation = ref('')
const validationError = ref('')
const formError = computed(() => validationError.value || auth.error)

async function submit() {
  if (auth.submitting) return
  validationError.value = ''
  auth.error = ''
  if (password.value !== confirmation.value) {
    validationError.value = '两次输入的密码不一致'
    return
  }
  const parsed = authCredentialsSchema.safeParse({ account: account.value, password: password.value })
  if (!parsed.success) {
    validationError.value = parsed.error.issues.some(({ path }) => path[0] === 'account')
      ? '账号需为 3–32 位字母、数字或下划线'
      : '密码长度须为 8–72 个字符'
    return
  }
  if (await auth.register(parsed.data)) await router.replace('/chat')
}
</script>

<style scoped>
h1 { margin: 0; color: var(--af-graphite); font-size: 26px; }
.auth-description { margin: 8px 0 24px; color: var(--af-text-muted); font-size: 14px; line-height: 1.55; }
.auth-form { display: grid; gap: 10px; }
.auth-form label { margin-top: 6px; color: var(--af-text); font-size: 13px; font-weight: 650; }
.auth-form .el-button { width: 100%; margin-top: 10px; }
.auth-error { margin: 2px 0 0; color: var(--af-danger); font-size: 13px; line-height: 1.45; }
.auth-switch { margin: 22px 0 0; color: var(--af-text-muted); font-size: 13px; text-align: center; }
.auth-switch a { color: var(--af-cobalt); text-decoration: none; }
</style>
