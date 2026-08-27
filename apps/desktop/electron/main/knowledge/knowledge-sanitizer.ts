const LOCATION = '[REDACTED_LOCATION]'

export function sanitizeKnowledgeText(value: string): string {
  return value
    .replace(/(?:https?|file):\/\/[^\s<>"']+/giu, LOCATION)
    .replace(/\\\\[^\\\s<>"']+\\[^\\\s<>"']+(?:\\[^\\\s<>"']+)*/gu, LOCATION)
    .replace(/[A-Za-z]:\\(?:[^\\\s<>"']+\\)*[^\\\s<>"']+/gu, LOCATION)
    .replace(/(^|[\s([{'"“‘])\/(?:[^/\s<>"']+\/)*[^/\s<>"']+/gu, `$1${LOCATION}`)
}
