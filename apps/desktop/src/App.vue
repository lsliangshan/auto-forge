<template>
  <RouterView />
</template>

<script setup lang="ts">
import { watch } from 'vue'
import { applyAppFontSize } from './services/font-size'
import { useSettingsStore } from './stores/settings'

const settings = useSettingsStore()
watch(() => settings.settings?.fontSize, (fontSize) => {
  if (fontSize) applyAppFontSize(fontSize)
})
</script>

<style>
input:focus-visible,
textarea:focus-visible {
  box-shadow: none !important;
}
</style>
