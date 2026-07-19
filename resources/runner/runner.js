const query = new URLSearchParams(location.search)
const executionId = query.get('executionId')
const entry = query.get('entry')
const call = (method, ...args) => window.workflowSdk.call(executionId, method, args)
const controller = new AbortController()
const context = {
  signal: controller.signal,
  navigate: (url) => call('navigate', url), waitFor: (selector, timeout) => call('waitFor', selector, timeout),
  exists: (selector) => call('exists', selector), readText: (selector) => call('readText', selector),
  readValue: (selector) => call('readValue', selector), click: (selector) => call('click', selector),
  fill: (selector, value) => call('fill', selector, value), selectOption: (selector, value) => call('selectOption', selector, value),
  check: (selector, checked = true) => call('check', selector, checked), downloadByClick: (selector) => call('downloadByClick', selector),
  log: (level, message, data) => void call('log', level, message, data)
}
try {
  const module = await import(entry)
  if (typeof module.run !== 'function') throw new Error('Workflow entry must export run(context)')
  await call('complete', await module.run(context))
} catch (error) { await call('failed', error instanceof Error ? error.message : String(error)) }
