<template>
  <section
    class="original-preview"
    data-testid="knowledge-original-preview"
  >
    <header class="preview-toolbar">
      <div>
        <strong>原始文件</strong>
        <small>{{ previewLabel }}</small>
      </div>
      <div
        v-if="isPdf && !error"
        class="pdf-controls"
      >
        <span v-if="pageCount">{{ currentPage }} / {{ pageCount }} 页</span>
        <button
          type="button"
          aria-label="缩小 PDF"
          :disabled="loading"
          @click="zoomBy(-0.15)"
        >
          −
        </button>
        <button
          type="button"
          :disabled="loading"
          @click="fitWidth"
        >
          适合宽度
        </button>
        <button
          type="button"
          aria-label="放大 PDF"
          :disabled="loading"
          @click="zoomBy(0.15)"
        >
          ＋
        </button>
      </div>
    </header>

    <div
      v-if="isPdf"
      ref="pdfContainer"
      class="pdf-container"
      @scroll.passive="renderVisiblePdfPages"
    >
      <div
        v-for="page in pdfPages"
        :key="page.number"
        class="pdf-page"
        :data-page-number="page.number"
        :style="pdfPageStyle(page)"
      >
        <canvas :ref="element => capturePdfCanvas(page.number, element)" />
        <span>第 {{ page.number }} 页</span>
      </div>
      <div
        v-if="loading"
        class="preview-overlay"
      >
        正在加载原始 PDF…
      </div>
      <div
        v-else-if="error"
        class="preview-fallback"
      >
        <strong>原始 PDF 暂时无法渲染</strong>
        <pre v-if="preview.fallback">{{ preview.fallback.content }}</pre>
        <p v-else>
          请稍后重试，或替换此文件。
        </p>
      </div>
    </div>

    <div
      v-else-if="loading"
      class="preview-overlay standalone"
    >
      正在读取原始文件…
    </div>
    <!-- The HTML is reduced to a local allowlist with all active attributes removed. -->
    <!-- eslint-disable vue/no-v-html -->
    <article
      v-else-if="safeHtml && !error"
      class="document-page rich-document"
      v-html="safeHtml"
    />
    <!-- eslint-enable vue/no-v-html -->
    <pre
      v-else-if="originalText && !error"
      class="document-page original-text"
    >{{ originalText }}</pre>
    <div
      v-else
      class="preview-fallback standalone"
    >
      <strong>原始文件暂时无法渲染</strong>
      <pre v-if="preview.fallback">{{ preview.fallback.content }}</pre>
      <p v-else>
        请稍后重试，或替换此文件。
      </p>
    </div>
  </section>
</template>

<script setup lang="ts">
/* global document, Element, HTMLCanvasElement, HTMLDivElement, HTMLElement, HTMLImageElement, TextDecoder */
import type { KnowledgeDocumentPreview } from '@autoforge/shared'
import pdfWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.mjs?url'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch, type ComponentPublicInstance } from 'vue'

type OriginalPreview = Extract<KnowledgeDocumentPreview, { kind: 'original' }>
type PdfLoadingTask = ReturnType<typeof import('pdfjs-dist/legacy/build/pdf.mjs')['getDocument']>
type PdfDocument = Awaited<PdfLoadingTask['promise']>
type PdfRenderTask = ReturnType<Awaited<ReturnType<PdfDocument['getPage']>>['render']>
interface PdfPageLayout { number: number; width: number; height: number }

const props = defineProps<{ preview: OriginalPreview }>()

const pdfContainer = ref<HTMLDivElement>()
const loading = ref(true)
const error = ref(false)
const originalText = ref('')
const safeHtml = ref('')
const pageCount = ref(0)
const currentPage = ref(1)
const pdfPages = ref<PdfPageLayout[]>([])
const pdfScale = ref(1)
let loadGeneration = 0
let pdfLoadingTask: PdfLoadingTask | undefined
let pdfDocument: PdfDocument | undefined
let renderScheduled = false
const pdfCanvases = new Map<number, HTMLCanvasElement>()
const pdfRenderTasks = new Map<number, PdfRenderTask>()
const renderedPdfScales = new Map<number, number>()

const isPdf = computed(() => props.preview.mimeType === 'application/pdf')
const previewLabel = computed(() => {
  if (props.preview.mimeType === 'application/pdf') return 'PDF 原页预览'
  if (props.preview.mimeType.includes('wordprocessingml')) return 'Word 原文预览'
  if (props.preview.mimeType === 'text/markdown') return 'Markdown 原文'
  if (props.preview.mimeType === 'text/html') return 'HTML 原文预览'
  return '文本原文'
})

const allowedElements = new Set([
  'A', 'B', 'BLOCKQUOTE', 'BR', 'CODE', 'DIV', 'EM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'HR', 'I', 'IMG', 'LI', 'OL', 'P', 'PRE', 'S', 'STRONG', 'SUB', 'SUP', 'TABLE', 'TBODY',
  'TD', 'TFOOT', 'TH', 'THEAD', 'TR', 'U', 'UL',
])

function sanitizeDocumentHtml(value: string): string {
  const template = document.createElement('template')
  template.innerHTML = value
  const elements = Array.from(template.content.querySelectorAll('*')).reverse()
  for (const element of elements) {
    if (['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'FORM'].includes(element.tagName)) {
      element.remove()
      continue
    }
    if (!allowedElements.has(element.tagName)) {
      element.replaceWith(...Array.from(element.childNodes))
      continue
    }
    const imageSource = element instanceof HTMLImageElement
      ? (element.getAttribute('data-safe-source') ?? element.getAttribute('src') ?? '').trim()
      : ''
    const imageAlt = element instanceof HTMLImageElement ? element.getAttribute('alt') ?? '' : ''
    const columnSpan = ['TD', 'TH'].includes(element.tagName) ? element.getAttribute('colspan') : null
    const rowSpan = ['TD', 'TH'].includes(element.tagName) ? element.getAttribute('rowspan') : null
    for (const attribute of Array.from(element.attributes)) element.removeAttribute(attribute.name)
    if (element instanceof HTMLImageElement) {
      if (/^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+=*$/u.test(imageSource)) {
        element.src = imageSource
        if (imageAlt) element.alt = imageAlt.slice(0, 500)
      } else {
        element.remove()
      }
    } else if (['TD', 'TH'].includes(element.tagName)) {
      if (/^\d{1,2}$/u.test(columnSpan ?? '')) element.setAttribute('colspan', columnSpan!)
      if (/^\d{1,2}$/u.test(rowSpan ?? '')) element.setAttribute('rowspan', rowSpan!)
    }
  }
  return template.innerHTML
}

function safeEmbeddedImage(contentType: string): string | undefined {
  const normalized = contentType.toLowerCase()
  return ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(normalized)
    ? normalized
    : undefined
}

async function disposePdf(): Promise<void> {
  for (const task of pdfRenderTasks.values()) task.cancel()
  pdfRenderTasks.clear()
  renderedPdfScales.clear()
  pdfCanvases.clear()
  pdfDocument = undefined
  pdfPages.value = []
  const task = pdfLoadingTask
  pdfLoadingTask = undefined
  await task?.destroy().catch(() => undefined)
}

async function loadPdf(generation: number): Promise<void> {
  await nextTick()
  const container = pdfContainer.value
  if (!container) throw new Error('PDF viewer is unavailable')
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  if (generation !== loadGeneration) return
  pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl
  const task = pdfjs.getDocument({
    data: props.preview.bytes.slice(),
    enableXfa: false,
    stopAtErrors: true,
    useWorkerFetch: false,
    verbosity: 0,
  })
  pdfLoadingTask = task
  const pdf = await task.promise
  if (generation !== loadGeneration) {
    await task.destroy().catch(() => undefined)
    return
  }
  pageCount.value = pdf.numPages
  currentPage.value = 1
  pdfDocument = pdf
  const layouts: PdfPageLayout[] = []
  for (let number = 1; number <= pdf.numPages; number += 1) {
    if (generation !== loadGeneration) return
    const page = await pdf.getPage(number)
    const viewport = page.getViewport({ scale: 1 })
    layouts.push({ number, width: viewport.width, height: viewport.height })
    page.cleanup()
  }
  pdfPages.value = layouts
  await nextTick()
  container.scrollTop = 0
  fitWidth()
}

function capturePdfCanvas(number: number, element: Element | ComponentPublicInstance | null): void {
  if (element instanceof HTMLCanvasElement) pdfCanvases.set(number, element)
  else pdfCanvases.delete(number)
}

function pdfPageStyle(page: PdfPageLayout): Record<string, string> {
  return {
    width: `${Math.round(page.width * pdfScale.value)}px`,
    height: `${Math.round(page.height * pdfScale.value)}px`,
  }
}

function resetPdfRendering(): void {
  for (const task of pdfRenderTasks.values()) task.cancel()
  pdfRenderTasks.clear()
  renderedPdfScales.clear()
  for (const canvas of pdfCanvases.values()) {
    canvas.width = 0
    canvas.height = 0
  }
  void nextTick().then(renderVisiblePdfPages)
}

async function renderPdfPage(number: number, generation: number, scale: number): Promise<void> {
  const pdf = pdfDocument
  const canvas = pdfCanvases.get(number)
  if (!pdf || !canvas || renderedPdfScales.get(number) === scale || pdfRenderTasks.has(number)) return
  const page = await pdf.getPage(number)
  if (generation !== loadGeneration || scale !== pdfScale.value) return
  const viewport = page.getViewport({ scale })
  const outputScale = Math.min(globalThis.devicePixelRatio || 1, 2)
  canvas.width = Math.floor(viewport.width * outputScale)
  canvas.height = Math.floor(viewport.height * outputScale)
  canvas.style.width = `${Math.floor(viewport.width)}px`
  canvas.style.height = `${Math.floor(viewport.height)}px`
  const task = page.render({
    canvas,
    viewport,
    transform: outputScale === 1 ? undefined : [outputScale, 0, 0, outputScale, 0, 0],
    annotationMode: 0,
  })
  pdfRenderTasks.set(number, task)
  try {
    await task.promise
    if (generation === loadGeneration && scale === pdfScale.value) renderedPdfScales.set(number, scale)
  } catch (cause) {
    if ((cause as { name?: unknown }).name !== 'RenderingCancelledException') throw cause
  } finally {
    if (pdfRenderTasks.get(number) === task) pdfRenderTasks.delete(number)
    page.cleanup()
  }
}

function renderVisiblePdfPages(): void {
  if (renderScheduled || loading.value || error.value) return
  renderScheduled = true
  globalThis.queueMicrotask(() => {
    renderScheduled = false
    const container = pdfContainer.value
    if (!container || !pdfDocument) return
    const top = container.scrollTop - container.clientHeight
    const bottom = container.scrollTop + container.clientHeight * 2
    const center = container.scrollTop + container.clientHeight / 2
    const generation = loadGeneration
    let nearest = currentPage.value
    let nearestDistance = Number.POSITIVE_INFINITY
    for (const element of Array.from(container.querySelectorAll<HTMLElement>('.pdf-page'))) {
      const number = Number(element.dataset.pageNumber)
      const pageTop = element.offsetTop
      const pageBottom = pageTop + element.offsetHeight
      const distance = Math.abs(pageTop + element.offsetHeight / 2 - center)
      if (distance < nearestDistance) {
        nearest = number
        nearestDistance = distance
      }
      if (pageBottom >= top && pageTop <= bottom) {
        void renderPdfPage(number, generation, pdfScale.value).catch(() => {
          if (generation === loadGeneration) error.value = true
        })
      }
    }
    currentPage.value = nearest
  })
}

async function loadDocx(generation: number): Promise<void> {
  const mammoth = await import('mammoth/mammoth.browser.js')
  const copy = props.preview.bytes.slice()
  try {
    const converted = await mammoth.convertToHtml({ arrayBuffer: copy.buffer as ArrayBuffer }, {
      externalFileAccess: false,
      convertImage: mammoth.images.imgElement(async image => {
        const contentType = safeEmbeddedImage(image.contentType)
        if (!contentType) return { src: '' }
        return { src: `data:${contentType};base64,${await image.read('base64')}` }
      }),
    })
    if (generation !== loadGeneration) return
    const template = document.createElement('template')
    template.innerHTML = converted.value
    for (const image of Array.from(template.content.querySelectorAll('img'))) {
      image.setAttribute('data-safe-source', image.getAttribute('src') ?? '')
    }
    safeHtml.value = sanitizeDocumentHtml(template.innerHTML)
  } finally {
    copy.fill(0)
  }
}

async function loadPreview(): Promise<void> {
  const generation = ++loadGeneration
  await disposePdf()
  loading.value = true
  error.value = false
  originalText.value = ''
  safeHtml.value = ''
  pageCount.value = 0
  currentPage.value = 1
  try {
    if (isPdf.value) {
      await loadPdf(generation)
    } else if (props.preview.mimeType.includes('wordprocessingml')) {
      await loadDocx(generation)
    } else {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(props.preview.bytes)
      if (props.preview.mimeType === 'text/html') safeHtml.value = sanitizeDocumentHtml(text)
      else originalText.value = text
    }
  } catch {
    if (generation === loadGeneration) error.value = true
  } finally {
    if (generation === loadGeneration) {
      loading.value = false
      if (isPdf.value && !error.value) void nextTick().then(renderVisiblePdfPages)
    }
  }
}

function zoomBy(delta: number): void {
  if (!pdfDocument) return
  pdfScale.value = Math.min(2.5, Math.max(0.4, pdfScale.value + delta))
  resetPdfRendering()
}

function fitWidth(): void {
  const container = pdfContainer.value
  const widest = Math.max(...pdfPages.value.map(page => page.width), 1)
  if (!container || !pdfDocument) return
  pdfScale.value = Math.min(2.5, Math.max(0.4, (container.clientWidth - 48) / widest))
  resetPdfRendering()
}

onMounted(() => { void loadPreview() })
watch(() => props.preview, () => { void loadPreview() })
onBeforeUnmount(() => {
  loadGeneration += 1
  void disposePdf()
})
</script>

<style scoped>
.original-preview { position: relative; display: flex; min-height: 100%; flex-direction: column; background: color-mix(in srgb, var(--af-canvas) 94%, var(--af-surface)); }
.preview-toolbar { position: sticky; z-index: 4; top: 0; display: flex; min-height: 42px; flex: none; align-items: center; justify-content: space-between; gap: 12px; border-bottom: 1px solid var(--af-border); padding: 6px 12px; background: color-mix(in srgb, var(--af-surface) 96%, transparent); backdrop-filter: blur(10px); }
.preview-toolbar > div:first-child { display: grid; gap: 1px; }.preview-toolbar strong { color: var(--af-graphite); font-size: 0.625rem; }.preview-toolbar small { color: var(--af-text-muted); font-size: 0.5rem; }
.pdf-controls { display: flex; align-items: center; gap: 5px; color: var(--af-text-muted); font-size: 0.5rem; }
.pdf-controls button { min-height: 26px; border: 1px solid var(--af-border); border-radius: 6px; padding: 3px 7px; color: var(--af-text); background: var(--af-surface); cursor: pointer; font-size: 0.5rem; }.pdf-controls button:disabled { cursor: wait; opacity: .5; }
.pdf-container { position: absolute; inset: 42px 0 0; overflow: auto; padding: 18px 0 26px; background: #e6e8ec; }
.pdf-page { position: relative; margin: 0 auto 16px; overflow: hidden; border: 1px solid rgb(25 31 42 / 14%); background: white; box-shadow: 0 8px 24px rgb(25 31 42 / 12%); }
.pdf-page canvas { display: block; width: 100%; height: 100%; }
.pdf-page > span { position: absolute; right: 8px; bottom: 7px; border-radius: 999px; padding: 3px 7px; color: #586173; background: rgb(255 255 255 / 82%); font-size: 0.4375rem; opacity: 0; transition: opacity .15s ease; }.pdf-page:hover > span { opacity: 1; }
.preview-overlay { position: absolute; z-index: 5; inset: 0; display: grid; place-items: center; color: var(--af-text-muted); background: color-mix(in srgb, var(--af-canvas) 88%, transparent); font-size: 0.625rem; }.preview-overlay.standalone { position: static; min-height: 420px; }
.document-page { width: min(820px, calc(100% - 40px)); min-height: 560px; box-sizing: border-box; margin: 20px auto 32px; border: 1px solid var(--af-border); padding: 44px 52px 60px; color: var(--af-text); background: var(--af-surface); box-shadow: 0 10px 34px rgb(32 36 43 / 10%); }
.original-text { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.6875rem; line-height: 1.75; white-space: pre-wrap; overflow-wrap: anywhere; }
.rich-document { font-size: 0.6875rem; line-height: 1.75; }.rich-document :deep(h1), .rich-document :deep(h2), .rich-document :deep(h3) { color: var(--af-graphite); }.rich-document :deep(table) { width: 100%; border-collapse: collapse; }.rich-document :deep(td), .rich-document :deep(th) { border: 1px solid var(--af-border-strong); padding: 6px 8px; }.rich-document :deep(img) { max-width: 100%; height: auto; }
.preview-fallback { display: grid; min-height: 100%; align-content: center; gap: 10px; padding: 28px; color: var(--af-text-muted); text-align: center; }.preview-fallback.standalone { min-height: 420px; }.preview-fallback strong { color: var(--af-graphite); font-size: 0.6875rem; }.preview-fallback p { margin: 0; font-size: 0.5625rem; }.preview-fallback pre { max-width: 760px; max-height: 480px; margin: 0 auto; overflow: auto; border: 1px solid var(--af-border); border-radius: 8px; padding: 18px; color: var(--af-text); background: var(--af-surface); font: 0.625rem/1.7 inherit; text-align: left; white-space: pre-wrap; }
@media (max-width: 950px) { .document-page { width: calc(100% - 24px); padding: 30px 28px 44px; }.pdf-controls span { display: none; } }
</style>
