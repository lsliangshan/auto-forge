const LOCATION = '[REDACTED_LOCATION]'

function redactAbsolutePosix(_match: string, prefix: string, path: string): string {
  const followsHanText = /\p{Script=Han}/u.test(prefix)
  const hasNestedSegment = path.indexOf('/', 1) >= 0
  if (followsHanText && !hasNestedSegment && /^\/\p{Script=Han}+$/u.test(path)) {
    return `${prefix}${path}`
  }
  return `${prefix}${LOCATION}`
}

export function sanitizeKnowledgeText(value: string): string {
  return value
    .replace(/(?:https?|file):\/\/[^\s<>"']+/giu, LOCATION)
    .replace(/\\\\[^\\\s<>"']+\\[^\\\s<>"']+(?:\\[^\\\s<>"']+)*/gu, LOCATION)
    .replace(/[A-Za-z]:\\(?:[^\\\s<>"']+\\)*[^\\\s<>"']+/gu, LOCATION)
    .replace(
      /(^|[^A-Za-z0-9._-])(\/(?:[^/\s<>"'，。！？；;:=()[\]{}]+\/)*[^/\s<>"'，。！？；;:=()[\]{}]+)/gu,
      redactAbsolutePosix,
    )
}
