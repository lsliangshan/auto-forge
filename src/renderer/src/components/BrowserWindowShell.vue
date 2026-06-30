<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { ArrowLeft, Loader2, RotateCw } from '@lucide/vue'
import type { BrowserViewState } from '@shared/contracts'

const address = ref('')
const state = ref<BrowserViewState>({
  url: '',
  title: '',
  canGoBack: false,
  loading: false
})

const currentAddress = computed(() => address.value || state.value.url)

let unsubscribe: (() => void) | null = null

async function loadAddress() {
  const nextAddress = currentAddress.value.trim()
  if (!nextAddress) {
    return
  }

  state.value = await window.autoForge.browser.loadUrl(nextAddress)
  address.value = state.value.url
}

async function goBack() {
  state.value = await window.autoForge.browser.goBack()
  address.value = state.value.url
}

onMounted(async () => {
  state.value = await window.autoForge.browser.getState()
  address.value = state.value.url
  unsubscribe = window.autoForge.browser.onStateChanged((nextState) => {
    state.value = nextState
    address.value = nextState.url
  })
})

onUnmounted(() => {
  unsubscribe?.()
})
</script>

<template>
  <div class="flex h-screen flex-col overflow-hidden bg-white text-forge-ink">
    <form class="flex h-14 shrink-0 items-center gap-2 border-b border-forge-line px-3" @submit.prevent="loadAddress">
      <button
        type="button"
        class="grid h-9 w-9 shrink-0 place-items-center rounded border border-forge-line text-slate-600 disabled:cursor-default disabled:opacity-40"
        :disabled="!state.canGoBack"
        title="返回"
        @click="goBack"
      >
        <ArrowLeft :size="17" />
      </button>
      <div class="relative min-w-0 flex-1">
        <input
          v-model="address"
          class="h-9 w-full rounded border border-forge-line bg-slate-50 px-3 pr-10 text-sm text-slate-700 outline-none focus:border-forge-mint focus:bg-white"
          placeholder="输入网址或搜索内容"
        />
        <Loader2
          v-if="state.loading"
          :size="16"
          class="absolute right-3 top-2.5 animate-spin text-slate-400"
        />
      </div>
      <button
        type="submit"
        class="grid h-9 w-9 shrink-0 place-items-center rounded bg-forge-mint text-white hover:bg-[#0b877a]"
        title="打开"
      >
        <RotateCw :size="17" />
      </button>
    </form>
  </div>
</template>
