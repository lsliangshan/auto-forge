export function normalizeBrowserUrl(input: string): string {
  const value = input.trim()

  if (/^https?:\/\//i.test(value)) {
    return value
  }

  if (/^(localhost|\d{1,3}(?:\.\d{1,3}){3})(:\d+)?(\/.*)?$/i.test(value)) {
    return new URL(`http://${value}`).toString()
  }

  if (/^[^\s]+\.[^\s]+$/.test(value)) {
    return new URL(`https://${value}`).toString()
  }

  const params = new URLSearchParams({ q: value })
  return `https://duckduckgo.com/?${params.toString()}`
}
