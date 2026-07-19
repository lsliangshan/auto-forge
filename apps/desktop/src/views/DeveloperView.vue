<template>
  <section class="developer-placeholder">
    <div
      class="placeholder-grid"
      aria-hidden="true"
    >
      <div class="file-column" /><div class="editor-column">
        <span /><span /><span />
      </div><div class="output-column" />
    </div>
    <div class="placeholder-copy">
      <span class="af-panel-heading">开发工作台</span><h2>开发模式将在下一阶段实现</h2><p>Task 11 将接入 Monaco、项目文件树、实时校验、调试输入、日志与结果。当前页面不会伪造编辑器或项目数据。</p>
    </div>
  </section>
</template>

<style scoped>
.developer-placeholder { display: grid; min-height: 100%; place-items: center; padding: 32px; }.placeholder-copy { max-width: 510px; margin-top: -20px; text-align: center; }.placeholder-copy h2 { margin: 8px 0; color: var(--af-graphite); font-size: 20px; }.placeholder-copy p { color: var(--af-text-muted); font-size: 13px; line-height: 1.7; }
.placeholder-grid { display: grid; width: min(620px, 80%); height: 220px; grid-template-columns: 120px 1fr 150px; border: 1px solid var(--af-border); opacity: .65; background: var(--af-surface); }.file-column { border-right: 1px solid var(--af-border); background: var(--af-surface-muted); }.editor-column { padding: 38px; }.editor-column span { display: block; width: 68%; height: 7px; margin-bottom: 16px; background: #dfe6ef; }.editor-column span:nth-child(2) { width: 86%; }.editor-column span:nth-child(3) { width: 48%; }.output-column { border-left: 1px solid var(--af-border); background: var(--af-surface-muted); }
</style>
