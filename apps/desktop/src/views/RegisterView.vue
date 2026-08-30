<template>
  <AuthLayout style="overflow-y: auto; place-items: safe center">
    <h1 id="auth-title">注册云端账号</h1>
    <p class="auth-description">通过手机号或邮箱验证，注册成功后将自动登录。</p>
    <div class="register-methods" role="group" aria-label="注册方式">
      <span
        class="register-method-indicator"
        data-testid="register-active-indicator"
        aria-hidden="true"
        :style="{ transform: methodIndicatorTransform }"
      />
      <button
        v-for="item in registerMethods"
        :key="item.value"
        type="button"
        :class="{ active: method === item.value }"
        :data-testid="`register-method-${item.value}`"
        :aria-pressed="method === item.value"
        :disabled="auth.submitting"
        @click="selectMethod(item.value)"
      >
        {{ item.label }}
      </button>
    </div>
    <form
      data-testid="register-form"
      class="auth-form"
      @submit.prevent="submit"
    >
      <label :for="`register-${method}`">{{
        method === "phone" ? "手机号" : "邮箱"
      }}</label>
      <el-input
        :id="`register-${method}`"
        v-model="target"
        :data-testid="`register-${method}`"
        :autocomplete="method === 'phone' ? 'tel' : 'email'"
        :disabled="auth.submitting"
      />
      <label for="register-account">用户名</label>
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
      <label for="register-code">验证码</label>
      <div class="otp-row">
        <el-input
          id="register-code"
          v-model="code"
          data-testid="register-code"
          autocomplete="one-time-code"
          inputmode="numeric"
          maxlength="6"
          :disabled="auth.submitting"
        />
        <el-button
          data-testid="register-send-code"
          native-type="button"
          :loading="auth.sendingOtp"
          :disabled="auth.sendingOtp || auth.submitting || countdown > 0"
          @click="sendCode"
        >
          {{ countdown > 0 ? `${countdown} 秒后重试` : "发送验证码" }}
        </el-button>
      </div>
      <p v-if="formError" class="auth-error" role="alert">
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
      已有云端账号？<RouterLink to="/login"> 返回登录 </RouterLink>
    </p>
  </AuthLayout>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useRouter } from "vue-router";
import {
  authCredentialsSchema,
  authEmailSchema,
  authOtpCodeSchema,
  authPhoneSchema,
} from "@autoforge/shared";
import AuthLayout from "../layouts/AuthLayout.vue";
import { useAuthStore } from "../stores/auth";

type RegisterMethod = "phone" | "email";

const registerMethods: ReadonlyArray<{ value: RegisterMethod; label: string }> =
  [
    { value: "phone", label: "手机号" },
    { value: "email", label: "邮箱" },
  ];
const auth = useAuthStore();
const router = useRouter();
const method = ref<RegisterMethod>("phone");
const methodIndicatorTransform = computed(() =>
  method.value === "phone" ? "translateX(0px)" : "translateX(calc(100% + 4px))"
);
const target = ref("");
const account = ref("");
const password = ref("");
const confirmation = ref("");
const code = ref("");
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

function clearChallenge() {
  stopCountdown();
  code.value = "";
  void auth.cancelOtp();
}

function selectMethod(next: RegisterMethod) {
  if (next === method.value || auth.submitting) return;
  clearChallenge();
  target.value = "";
  validationError.value = "";
  auth.error = "";
  method.value = next;
}

watch([target, account, password, confirmation], () => {
  validationError.value = "";
  auth.error = "";
  if (!auth.sendingOtp && !auth.challenge) return;
  clearChallenge();
});

async function sendCode() {
  if (auth.sendingOtp || auth.submitting || countdown.value > 0) return;
  validationError.value = "";
  auth.error = "";
  if (password.value !== confirmation.value) {
    validationError.value = "两次输入的密码不一致";
    return;
  }

  const credentials = authCredentialsSchema.safeParse({
    account: account.value,
    password: password.value,
  });
  if (!credentials.success) {
    validationError.value = credentials.error.issues.some(
      ({ path }) => path[0] === "account"
    )
      ? "用户名需为 5–24 位字母、数字或下划线"
      : "密码长度须为 8–72 个字符";
    return;
  }

  const sendingMethod = method.value;
  const targetAtSend = target.value;
  const accountAtSend = account.value;
  const passwordAtSend = password.value;
  const schema = sendingMethod === "phone" ? authPhoneSchema : authEmailSchema;
  const parsedTarget = schema.safeParse(targetAtSend);
  if (!parsedTarget.success) {
    validationError.value =
      sendingMethod === "phone" ? "请输入有效的手机号" : "请输入有效的邮箱地址";
    return;
  }

  const challenge = await auth.sendOtp({
    intent: "register",
    channel: sendingMethod,
    target: parsedTarget.data,
    ...credentials.data,
  });
  if (!challenge) return;
  if (
    method.value !== sendingMethod ||
    target.value !== targetAtSend ||
    account.value !== accountAtSend ||
    password.value !== passwordAtSend
  ) {
    await auth.cancelOtp();
    return;
  }
  startCountdown(60);
}

async function submit() {
  if (auth.submitting) return;
  validationError.value = "";
  auth.error = "";
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
  await router.replace("/chat");
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
  font-size: 1.625rem;
}
.auth-description {
  margin: 8px 0 24px;
  color: var(--af-text-muted);
  font-size: 0.875rem;
  line-height: 1.55;
}
.register-methods {
  position: relative;
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 4px;
  margin-bottom: 18px;
  /* border: 1px solid var(--af-border); */
  border-radius: 10px;
  padding: 4px;
  background: var(--af-canvas);
}
.register-method-indicator {
  position: absolute;
  top: 4px;
  bottom: 4px;
  left: 4px;
  width: calc((100% - 12px) / 2);
  border-radius: 7px;
  background: var(--af-surface);
  pointer-events: none;
  transition: transform 180ms cubic-bezier(0.2, 0.8, 0.2, 1);
}
.register-methods button {
  position: relative;
  z-index: 1;
  border: 0;
  border-radius: 7px;
  padding: 8px 6px;
  background: transparent;
  color: var(--af-text-muted);
  font: inherit;
  font-size: 0.8125rem;
  cursor: pointer;
}
.register-methods button.active {
  background: transparent;
  color: var(--af-graphite);
  font-weight: 650;
}
.register-methods button:focus-visible {
  outline: 2px solid var(--af-cobalt);
  outline-offset: 1px;
}
.register-methods button:disabled {
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
  font-size: 0.8125rem;
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
  font-size: 0.8125rem;
  line-height: 1.45;
}
.auth-switch {
  margin: 22px 0 0;
  color: var(--af-text-muted);
  font-size: 0.8125rem;
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
