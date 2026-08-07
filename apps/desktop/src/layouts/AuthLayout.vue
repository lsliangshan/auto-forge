<template>
  <main class="auth-shell">
    <section
      class="auth-card"
      aria-labelledby="auth-title"
    >
      <div class="auth-brand">
        <span aria-hidden="true">AF</span>
        <strong>AutoForge</strong>
      </div>
      <slot />
    </section>
  </main>
</template>

<style scoped>
.auth-shell { display: grid; width: 100%; height: 100%; place-items: center; padding: 24px; background: var(--af-canvas); }
.auth-card { width: min(420px, calc(100vw - 48px)); border: 1px solid var(--af-border); border-radius: 14px; padding: 32px; background: var(--af-surface); box-shadow: 0 18px 50px rgb(32 36 43 / 9%); }
.auth-brand { display: flex; align-items: center; gap: 10px; margin-bottom: 30px; color: var(--af-graphite); }
.auth-brand span { display: grid; width: 34px; height: 34px; place-items: center; border-radius: 8px; color: white; background: var(--af-graphite); font-size: 11px; font-weight: 800; letter-spacing: .08em; }
.auth-brand strong { font-size: 17px; letter-spacing: -.01em; }
</style>
