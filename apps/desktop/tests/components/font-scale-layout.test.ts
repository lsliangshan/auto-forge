import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const readSource = (relativePath: string) => readFileSync(
  resolve(process.cwd(), 'src', relativePath),
  'utf8',
)

describe('global font scale layout contracts', () => {
  it('uses a larger normal scale and gives enlarged layouts more horizontal room', () => {
    const styles = readSource('styles/index.css')

    expect(styles).toContain(":root[data-font-size='normal'] { font-size: 17px;")
    expect(styles).toContain(":root[data-font-size='large'] { font-size: 19px;")
    expect(styles).toContain(":root[data-font-size='extra-large'] { font-size: 21px;")
    expect(styles).toContain('--af-app-rail-width: 72px;')
    expect(styles).toContain('--af-context-sidebar-width: 288px;')
    expect(styles).toContain('button { white-space: nowrap; }')
  })

  it('keeps navigation and durable-sync actions intact at enlarged scales', () => {
    const appRail = readSource('components/AppRail.vue')
    const contextSidebar = readSource('components/ContextSidebar.vue')

    expect(appRail).toContain('width: var(--af-app-rail-width);')
    expect(appRail).toMatch(/\.rail-item-label\s*\{[^}]*white-space: nowrap;/s)
    expect(contextSidebar).toContain('width: var(--af-context-sidebar-width);')
    expect(contextSidebar).toMatch(/\.durable-sync-warning button\s*\{[^}]*white-space: nowrap;/s)
  })

  it('uses the shared, raised typography scale throughout the knowledge workspace', () => {
    const knowledgeView = readSource('views/KnowledgeView.vue')
    const explorer = readSource('components/knowledge/KnowledgeBaseList.vue')
    const inspector = readSource('components/knowledge/KnowledgeInspector.vue')
    const preview = readSource('components/knowledge/KnowledgeOriginalPreview.vue')

    expect(knowledgeView).toContain('--af-knowledge-font-caption: 0.625rem;')
    expect(knowledgeView).toContain('--af-knowledge-font-document: 0.875rem;')
    expect(explorer).toContain('font-size: var(--af-knowledge-font-body);')
    expect(inspector).toContain('font-size: var(--af-knowledge-font-label);')
    expect(preview).toContain('font-size: var(--af-knowledge-font-document);')
  })

  it('uses one typography hierarchy and line-height system across settings content', () => {
    const settingsView = readSource('views/SettingsView.vue')
    const billingPanel = readSource('components/settings/BillingUsagePanel.vue')

    expect(settingsView).toContain('--af-settings-font-section-title: 1rem;')
    expect(settingsView).toContain('--af-settings-font-card-title: 0.875rem;')
    expect(settingsView).toContain('--af-settings-font-body: 0.8125rem;')
    expect(settingsView).toContain('--af-settings-font-caption: 0.75rem;')
    expect(settingsView).toContain('--af-settings-line-body: 1.55;')
    expect(settingsView).toContain('--af-settings-line-caption: 1.5;')
    expect(settingsView).toMatch(/\.settings-section header p\s*\{[^}]*font-size: var\(--af-settings-font-body\);[^}]*line-height: var\(--af-settings-line-body\);/s)
    expect(settingsView).toMatch(/\.settings-form > label,[^{]+\{[^}]*font-size: var\(--af-settings-font-caption\);[^}]*line-height: var\(--af-settings-line-caption\);/s)
    expect(settingsView).toMatch(/\.developer-impact-card ul\s*\{[^}]*font-size: var\(--af-settings-font-body\);[^}]*line-height: var\(--af-settings-line-body\);/s)
    expect(billingPanel).toContain('font-size: var(--af-settings-font-section-title);')
    expect(billingPanel).toContain('font-size: var(--af-settings-font-body);')
    expect(billingPanel).toContain('line-height: var(--af-settings-line-body);')
  })
})
