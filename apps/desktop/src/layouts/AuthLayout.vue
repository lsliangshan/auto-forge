<template>
  <main class="auth-shell">
    <section
      class="auth-card"
      aria-labelledby="auth-title"
    >
      <div class="auth-brand">
        <img
          :src="logoUrl"
          alt=""
          class="auth-brand-logo"
          data-testid="auth-brand-logo"
        >
        <strong>AutoForge</strong>
      </div>
      <slot />
    </section>
  </main>
</template>

<script setup lang="ts">
import logoUrl from '../../resources/branding/autoforge-logo.png'
</script>

<style scoped>
.auth-shell { display: grid; width: 100%; height: 100%; place-items: center; padding: 24px; background: var(--af-canvas); }
.auth-card { width: min(420px, calc(100vw - 48px)); border: 1px solid var(--af-border); border-radius: 14px; padding: 32px; background: var(--af-surface); box-shadow: 0 18px 50px rgb(32 36 43 / 9%); }
.auth-brand { display: flex; align-items: center; gap: 10px; margin-bottom: 30px; color: var(--af-graphite); }
.auth-brand-logo { display: block; width: 34px; height: 34px; object-fit: contain; }
.auth-brand strong { font-size: 1.0625rem; letter-spacing: -.01em; }
</style>
