<template>
  <AuthLayout>
    <h1 id="auth-title">登录 AutoForge</h1>
    <p class="auth-description">使用 AutoForge 云端账号继续。</p>
    <div class="login-methods" role="group" aria-label="登录方式">
      <button
        v-for="item in loginMethods"
        :key="item.value"
        type="button"
        :class="{ active: method === item.value }"
        :data-testid="`login-method-${item.value}`"
        :aria-pressed="method === item.value"
        :disabled="auth.submitting"
        @click="selectMethod(item.value)"
      >
        {{ item.label }}
      </button>
    </div>
    <form data-testid="login-form" class="auth-form" @submit.prevent="submit">
      <template v-if="method !== 'password'">
        <label :for="`login-${method}`">{{
          method === "phone" ? "手机号" : "邮箱"
        }}</label>
        <el-input
          :id="`login-${method}`"
          v-model="target"
          :data-testid="`login-${method}`"
          :autocomplete="method === 'phone' ? 'tel' : 'email'"
          :disabled="auth.submitting"
        />
        <label for="login-code">验证码</label>
        <div class="otp-row">
          <el-input
            id="login-code"
            v-model="code"
            data-testid="login-code"
            autocomplete="one-time-code"
            inputmode="numeric"
            maxlength="6"
            :disabled="auth.submitting"
          />
          <el-button
            data-testid="login-send-code"
            native-type="button"
            :loading="auth.sendingOtp"
            :disabled="auth.sendingOtp || auth.submitting || countdown > 0"
            @click="sendCode"
          >
            {{ countdown > 0 ? `${countdown} 秒后重试` : "发送验证码" }}
          </el-button>
        </div>
      </template>
      <template v-else>
        <label for="login-account">账号</label>
        <el-input
          id="login-account"
          v-model="account"
          data-testid="login-account"
          autocomplete="username"
          :disabled="auth.submitting"
        />
        <label for="login-password">密码</label>
        <el-input
          id="login-password"
          v-model="password"
          data-testid="login-password"
          type="password"
          autocomplete="current-password"
          show-password
          :disabled="auth.submitting"
        />
      </template>
      <p v-if="formError" class="auth-error" role="alert">
        {{ formError }}
      </p>
      <el-button
        type="primary"
        native-type="submit"
        :loading="auth.submitting"
        :disabled="auth.submitting"
      >
        登录
      </el-button>
    </form>
    <p class="auth-switch">
      还没有云端账号？<RouterLink to="/register"> 去注册 </RouterLink>
    </p>
  </AuthLayout>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import {
  authCredentialsSchema,
  authEmailSchema,
  authOtpCodeSchema,
  authPhoneSchema,
} from "@autoforge/shared";
import AuthLayout from "../layouts/AuthLayout.vue";
import { safeRedirect } from "../router";
import { useAuthStore } from "../stores/auth";

type LoginMethod = "phone" | "email" | "password";

const loginMethods: ReadonlyArray<{ value: LoginMethod; label: string }> = [
  { value: "phone", label: "手机号" },
  { value: "email", label: "邮箱" },
  { value: "password", label: "用户名密码" },
];
const auth = useAuthStore();
const route = useRoute();
const router = useRouter();
const method = ref<LoginMethod>("phone");
const target = ref("");
const code = ref("");
const account = ref("");
const password = ref("");
const countdown = ref(0);
const validationError = ref("");
const formError = computed(() => validationError.value || auth.error);
let countdownTimer: number | undefined;

function stopCountdown() {
  if (countdownTimer !== undefined) window.clearInterval(countdownTimer);
  countdownTimer = undefined;
  countdown.value = 0;
}

function startCountdown(seconds: number) {
  stopCountdown();
  countdown.value = seconds;
  countdownTimer = window.setInterval(() => {
    countdown.value -= 1;
    if (countdown.value <= 0) stopCountdown();
  }, 1_000);
}

function selectMethod(next: LoginMethod) {
  if (next === method.value || auth.submitting) return;
  const cancelling = auth.cancelOtp();
  stopCountdown();
  target.value = "";
  code.value = "";
  validationError.value = "";
  auth.error = "";
  method.value = next;
  void cancelling;
}

watch(target, () => {
  validationError.value = "";
  auth.error = "";
  if (!auth.sendingOtp && !auth.challenge) return;
  stopCountdown();
  code.value = "";
  void auth.cancelOtp();
});

async function sendCode() {
  if (
    method.value === "password" ||
    auth.sendingOtp ||
    auth.submitting ||
    countdown.value > 0
  )
    return;
  validationError.value = "";
  auth.error = "";
  const sendingMethod = method.value;
  const targetAtSend = target.value;
  const schema = sendingMethod === "phone" ? authPhoneSchema : authEmailSchema;
  const parsed = schema.safeParse(targetAtSend);
  if (!parsed.success) {
    validationError.value =
      sendingMethod === "phone" ? "请输入有效的手机号" : "请输入有效的邮箱地址";
    return;
  }

  const challenge = await auth.sendOtp({
    intent: "login",
    channel: sendingMethod,
    target: parsed.data,
  });
  if (!challenge) return;
  if (method.value !== sendingMethod || target.value !== targetAtSend) {
    await auth.cancelOtp();
    return;
  }
  startCountdown(60);
}

async function submit() {
  if (auth.submitting) return;
  validationError.value = "";
  auth.error = "";

  if (method.value === "password") {
    const parsed = authCredentialsSchema.safeParse({
      account: account.value,
      password: password.value,
    });
    if (!parsed.success) {
      validationError.value = parsed.error.issues.some(
        ({ path }) => path[0] === "account"
      )
        ? "账号需为 5–24 位字母、数字或下划线"
        : "密码长度须为 8–72 个字符";
      return;
    }
    if (await auth.loginWithPassword(parsed.data)) {
      await router.replace(safeRedirect(route.query.redirect));
    }
    return;
  }

  if (!auth.challenge) {
    validationError.value = "请先发送验证码";
    return;
  }
  const parsedCode = authOtpCodeSchema.safeParse(code.value);
  if (!parsedCode.success) {
    validationError.value = "请输入 6 位验证码";
    return;
  }
  const session = await auth.verifyOtp(parsedCode.data);
  if (!session) {
    if (!auth.challenge) stopCountdown();
    return;
  }
  await router.replace(safeRedirect(route.query.redirect));
}

onBeforeUnmount(() => {
  stopCountdown();
  void auth.cancelOtp();
});
</script>

<style scoped>
h1 {
  margin: 0;
  color: var(--af-graphite);
  font-size: 26px;
}
.auth-description {
  margin: 8px 0 24px;
  color: var(--af-text-muted);
  font-size: 14px;
  line-height: 1.55;
}
.login-methods {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 4px;
  margin-bottom: 18px;
  border: 1px solid var(--af-border);
  border-radius: 10px;
  padding: 4px;
  background: var(--af-canvas);
}
.login-methods button {
  border: 0;
  border-radius: 7px;
  padding: 8px 6px;
  background: transparent;
  color: var(--af-text-muted);
  font: inherit;
  font-size: 13px;
  cursor: pointer;
}
.login-methods button.active {
  background: var(--af-surface);
  color: var(--af-graphite);
  font-weight: 650;
}
.login-methods button:focus-visible {
  outline: 2px solid var(--af-cobalt);
  outline-offset: 1px;
}
.login-methods button:disabled {
  cursor: not-allowed;
  opacity: 0.65;
}
.auth-form {
  display: grid;
  gap: 10px;
}
.auth-form label {
  margin-top: 6px;
  color: var(--af-text);
  font-size: 13px;
  font-weight: 650;
}
.auth-form .el-button {
  width: 100%;
  margin-top: 10px;
}
.otp-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 8px;
}
.otp-row .el-button {
  width: auto;
  margin-top: 0;
}
.auth-error {
  margin: 2px 0 0;
  color: var(--af-danger);
  font-size: 13px;
  line-height: 1.45;
}
.auth-switch {
  margin: 22px 0 0;
  color: var(--af-text-muted);
  font-size: 13px;
  text-align: center;
}
.auth-switch a {
  color: var(--af-cobalt);
  text-decoration: none;
}

:deep() input:focus-visible,
:deep() textarea:focus-visible {
  box-shadow: none !important;
}
</style>
