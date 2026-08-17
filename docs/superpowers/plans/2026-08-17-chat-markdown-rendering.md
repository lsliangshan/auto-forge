# Chat Markdown Rendering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render all desktop chat text blocks as safe Markdown and syntax-highlight common fenced code languages.

**Architecture:** Add a focused `renderMarkdown(text: string): string` module beside the chat components. `MessageBlock.vue` delegates only text blocks to that module; message storage, streaming, IPC, and every non-text block remain unchanged.

**Tech Stack:** Vue 3.5, TypeScript 6, markdown-it 15.0.0, highlight.js 11.12.0, Vitest 4, Vue Test Utils.

## Global Constraints

- Apply Markdown rendering to both user and assistant text blocks.
- Disable raw Markdown HTML; tags render as text and never create live elements.
- Preserve chat-friendly line breaks.
- Highlight TypeScript, JavaScript, JSON, shell, Python, HTML/XML, CSS, SQL, YAML, and Markdown, including registered aliases.
- Unknown or missing language identifiers render escaped plain code without throwing.
- Do not change message storage, streaming, provider contracts, IPC, database records, non-text blocks, message width, or chat layout.

---

## File Structure

- Create `apps/desktop/src/components/chat/markdown.ts`: Markdown parsing, raw-HTML policy, language registration, and highlighting.
- Modify `apps/desktop/src/components/chat/MessageBlock.vue`: text-block integration and chat Markdown styles.
- Modify `apps/desktop/tests/components/chat.test.ts`: component-level Markdown, security, fallback, and highlighting coverage.
- Modify `apps/desktop/package.json` and `pnpm-lock.yaml`: exact direct renderer dependencies.

### Task 1: Safe Markdown and fenced-code highlighting

**Files:**
- Create: `apps/desktop/src/components/chat/markdown.ts`
- Modify: `apps/desktop/src/components/chat/MessageBlock.vue`
- Modify: `apps/desktop/tests/components/chat.test.ts`
- Modify: `apps/desktop/package.json`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Consumes: `UiChatBlock` text blocks whose `text` field contains Markdown source.
- Produces: `renderMarkdown(text: string): string`, returning parser-generated HTML with raw input HTML escaped and known fenced languages highlighted.

- [ ] **Step 1: Add exact direct dependencies**

Run:

```bash
pnpm --filter @autoforge/desktop add markdown-it@15.0.0 highlight.js@11.12.0
```

Expected: both exact versions appear in `apps/desktop/package.json`, and `pnpm-lock.yaml` records them under the desktop importer.

- [ ] **Step 2: Write failing component tests**

Insert these tests before the existing media-rendering tests in `apps/desktop/tests/components/chat.test.ts`:

```ts
  it('renders common Markdown as semantic chat content', () => {
    const wrapper = mount(MessageBlock, {
      props: { block: {
        id: 'message_1:block_text',
        type: 'text',
        text: '# 标题\n\n**重点**\n\n- 第一项\n- 第二项\n\n使用 `pnpm test`',
      } },
    })

    expect(wrapper.get('h1').text()).toBe('标题')
    expect(wrapper.get('strong').text()).toBe('重点')
    expect(wrapper.findAll('li').map((item) => item.text())).toEqual(['第一项', '第二项'])
    expect(wrapper.get('p code').text()).toBe('pnpm test')
  })

  it('escapes raw HTML instead of creating live chat elements', () => {
    const wrapper = mount(MessageBlock, {
      props: { block: {
        id: 'message_1:block_text',
        type: 'text',
        text: '<script>window.compromised = true</script>\n\n<img src=x onerror="window.compromised = true">',
      } },
    })

    expect(wrapper.find('script').exists()).toBe(false)
    expect(wrapper.find('img').exists()).toBe(false)
    expect(wrapper.text()).toContain('<script>window.compromised = true</script>')
    expect(wrapper.text()).toContain('<img src=x onerror="window.compromised = true">')
  })

  it('renders an unknown fenced language as escaped plain code', () => {
    const wrapper = mount(MessageBlock, {
      props: { block: {
        id: 'message_1:block_text',
        type: 'text',
        text: '```unknownlang\n<unsafe>& value\n```',
      } },
    })

    const code = wrapper.get('pre code')
    expect(code.classes()).toContain('language-unknownlang')
    expect(code.element.textContent).toBe('<unsafe>& value\n')
    expect(code.find('unsafe').exists()).toBe(false)
  })

  it('renders and highlights a fenced TypeScript code block', () => {
    const source = [
      '```ts',
      '// singleton.ts',
      'class MyService {',
      '  public doWork(): void {',
      '    console.log("Working...");',
      '  }',
      '}',
      'export const myService = new MyService();',
      '```',
    ].join('\n')
    const wrapper = mount(MessageBlock, {
      props: { block: {
        id: 'message_1:block_text',
        type: 'text',
        text: source,
      } },
    })

    const code = wrapper.get('pre code')
    expect(code.classes()).toContain('hljs')
    expect(code.classes()).toContain('language-ts')
    expect(code.find('.hljs-keyword').exists()).toBe(true)
    expect(code.element.textContent).toContain('  public doWork(): void {')
    expect(code.element.textContent).toContain('    console.log("Working...");')
    expect(wrapper.text()).not.toContain('```ts')
  })
```

- [ ] **Step 3: Run the tests and verify the existing plain-text renderer fails**

Run:

```bash
pnpm --dir apps/desktop exec vitest run --config vitest.config.ts tests/components/chat.test.ts -t "renders common Markdown|escapes raw HTML|renders an unknown fenced language|renders and highlights a fenced TypeScript code block"
```

Expected: 4 tests fail because the current component emits one `.message-text` paragraph and creates no Markdown or highlighted-code elements.

- [ ] **Step 4: Create the Markdown renderer**

Create `apps/desktop/src/components/chat/markdown.ts`:

```ts
import hljs from 'highlight.js/lib/core'
import bash from 'highlight.js/lib/languages/bash'
import css from 'highlight.js/lib/languages/css'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import markdownLanguage from 'highlight.js/lib/languages/markdown'
import python from 'highlight.js/lib/languages/python'
import sql from 'highlight.js/lib/languages/sql'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml'
import yaml from 'highlight.js/lib/languages/yaml'
import MarkdownIt from 'markdown-it'

hljs.registerLanguage('bash', bash)
hljs.registerLanguage('css', css)
hljs.registerLanguage('javascript', javascript)
hljs.registerLanguage('json', json)
hljs.registerLanguage('markdown', markdownLanguage)
hljs.registerLanguage('python', python)
hljs.registerLanguage('sql', sql)
hljs.registerLanguage('typescript', typescript)
hljs.registerLanguage('xml', xml)
hljs.registerLanguage('yaml', yaml)

function highlightCode(code: string, language: string): string {
  if (!language || !hljs.getLanguage(language)) return ''
  const languageClass = language.replace(/[^a-z0-9_-]/gi, '')
  const highlighted = hljs.highlight(code, { language, ignoreIllegals: true }).value
  return `<pre><code class="hljs language-${languageClass}">${highlighted}</code></pre>`
}

const markdown = new MarkdownIt({
  html: false,
  breaks: true,
  linkify: true,
  highlight: highlightCode,
})

export function renderMarkdown(text: string): string {
  return markdown.render(text)
}
```

- [ ] **Step 5: Route only text blocks through the renderer**

Replace the text-block `<p>` in `apps/desktop/src/components/chat/MessageBlock.vue` with:

```vue
    <!-- eslint-disable-next-line vue/no-v-html -->
    <div
      v-if="block.type === 'text'"
      class="message-markdown"
      v-html="renderMarkdown(block.text)"
    />
```

Add these imports to the component script:

```ts
import 'highlight.js/styles/github-dark.css'
import { renderMarkdown } from './markdown'
```

- [ ] **Step 6: Replace the plain-text rule with complete scoped Markdown styling**

Replace `.message-text` in `MessageBlock.vue` with:

```css
.message-markdown { min-width: 0; overflow-wrap: anywhere; line-height: 1.65; }
.message-markdown > :deep(:first-child) { margin-top: 0; }
.message-markdown > :deep(:last-child) { margin-bottom: 0; }
.message-markdown :deep(p) { margin: 0 0 10px; }
.message-markdown :deep(h1),
.message-markdown :deep(h2),
.message-markdown :deep(h3),
.message-markdown :deep(h4) { margin: 18px 0 8px; line-height: 1.3; }
.message-markdown :deep(h1) { font-size: 1.5em; }
.message-markdown :deep(h2) { font-size: 1.3em; }
.message-markdown :deep(h3) { font-size: 1.15em; }
.message-markdown :deep(ul),
.message-markdown :deep(ol) { margin: 8px 0; padding-left: 24px; }
.message-markdown :deep(blockquote) { margin: 10px 0; border-left: 3px solid var(--af-border-strong); padding-left: 12px; color: var(--af-text-muted); }
.message-markdown :deep(a) { color: var(--af-cobalt); }
.message-markdown :deep(code) { border-radius: 4px; padding: 2px 5px; background: var(--af-surface-muted); font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace; font-size: .92em; }
.message-markdown :deep(pre) { max-width: 100%; margin: 10px 0; overflow-x: auto; border-radius: 8px; padding: 14px 16px; color: #e6edf3; background: #0d1117; }
.message-markdown :deep(pre code) { display: block; overflow-wrap: normal; border-radius: 0; padding: 0; color: inherit; background: transparent; font-size: 12px; line-height: 1.6; white-space: pre; word-break: normal; }
.message-markdown :deep(table) { display: block; max-width: 100%; margin: 10px 0; overflow-x: auto; border-collapse: collapse; }
.message-markdown :deep(th),
.message-markdown :deep(td) { border: 1px solid var(--af-border); padding: 6px 10px; text-align: left; }
.message-markdown :deep(th) { background: var(--af-surface-muted); }
```

- [ ] **Step 7: Run the targeted tests and verify they pass**

Run:

```bash
pnpm --dir apps/desktop exec vitest run --config vitest.config.ts tests/components/chat.test.ts -t "renders common Markdown|escapes raw HTML|renders an unknown fenced language|renders and highlights a fenced TypeScript code block"
```

Expected: 4 tests pass. Known TypeScript has Highlight.js token classes; unknown code remains escaped and unhighlighted.

- [ ] **Step 8: Commit the feature**

```bash
git add apps/desktop/package.json pnpm-lock.yaml apps/desktop/src/components/chat/markdown.ts apps/desktop/src/components/chat/MessageBlock.vue apps/desktop/tests/components/chat.test.ts
git commit -m "feat: render markdown code blocks in chat"
```

### Task 2: Regression and static verification

**Files:**
- Verify: `apps/desktop/tests/components/chat.test.ts`
- Verify: `apps/desktop/src/components/chat/markdown.ts`
- Verify: `apps/desktop/src/components/chat/MessageBlock.vue`

**Interfaces:**
- Consumes: the completed chat Markdown renderer and component integration.
- Produces: evidence that the change is type-safe, lint-clean, and compatible with existing chat behavior.

- [ ] **Step 1: Run the full desktop chat component suite**

```bash
pnpm --dir apps/desktop exec vitest run --config vitest.config.ts tests/components/chat.test.ts
```

Expected: every test in `chat.test.ts` passes with no unhandled errors.

- [ ] **Step 2: Run workspace type checking**

```bash
pnpm typecheck
```

Expected: all workspace TypeScript and Vue checks pass.

- [ ] **Step 3: Run lint**

```bash
pnpm lint
```

Expected: ESLint exits successfully with no errors.

- [ ] **Step 4: Confirm the final diff stays within scope**

```bash
git status --short
git diff --check
git show --stat --oneline HEAD
```

Expected: no whitespace errors, and the feature commit changes only the five approved product files.
