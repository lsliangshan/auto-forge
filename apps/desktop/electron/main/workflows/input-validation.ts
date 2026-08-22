import Ajv, { type AnySchema, type ErrorObject } from 'ajv'
import addFormats from 'ajv-formats'

export type WorkflowInputValidationResult =
  | { valid: true }
  | { valid: false; message: string }

function jsonPointerSegments(pointer: string): string[] {
  return pointer.replace(/^#/, '').split('/').slice(1).map((segment) => {
    let decoded = segment
    try { decoded = decodeURIComponent(segment) } catch { /* AJV-generated pointers are normally URI encoded. */ }
    return decoded.replaceAll('~1', '/').replaceAll('~0', '~')
  })
}

function schemaNodeAt(schema: unknown, segments: string[]): unknown {
  let node = schema
  for (const segment of segments) {
    if (Array.isArray(node)) node = node[Number(segment)]
    else node = typeof node === 'object' && node !== null ? (node as Record<string, unknown>)[segment] : undefined
  }
  return node
}

function resolveLocalSchema(schema: unknown, node: unknown): unknown {
  const visited = new Set<string>()
  let resolved = node
  while (typeof resolved === 'object' && resolved !== null) {
    const reference = (resolved as Record<string, unknown>).$ref
    if (typeof reference !== 'string' || !reference.startsWith('#/') || visited.has(reference)) break
    visited.add(reference)
    resolved = schemaNodeAt(schema, jsonPointerSegments(reference))
  }
  return resolved
}

function schemaTitle(schema: unknown, node: unknown): string | undefined {
  const resolved = resolveLocalSchema(schema, node)
  const title = typeof resolved === 'object' && resolved !== null
    ? (resolved as Record<string, unknown>).title
    : undefined
  return typeof title === 'string' && title.trim() ? title.trim() : undefined
}

function instanceSchemaBoundaryLength(segments: string[]): number {
  let boundary = 0
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]
    if (segment === 'properties' || segment === 'patternProperties' || segment === 'prefixItems') {
      boundary = Math.max(boundary, index + 2)
    } else if (segment === 'items' || segment === 'additionalProperties'
      || segment === 'contains' || segment === 'propertyNames') {
      boundary = Math.max(boundary, index + 1)
    }
  }
  return boundary
}

function errorSchemaTitle(schema: unknown, error: ErrorObject, missingProperty: string | undefined): string | undefined {
  const parentSegments = jsonPointerSegments(error.schemaPath).slice(0, -1)
  const parentNode = schemaNodeAt(schema, parentSegments)
  if (missingProperty) {
    const resolvedParent = resolveLocalSchema(schema, parentNode)
    const properties = typeof resolvedParent === 'object' && resolvedParent !== null
      ? (resolvedParent as Record<string, unknown>).properties
      : undefined
    const propertyNode = typeof properties === 'object' && properties !== null
      ? (properties as Record<string, unknown>)[missingProperty]
      : undefined
    const title = schemaTitle(schema, propertyNode)
    if (title) return title
    return undefined
  }
  const minimumLength = Math.max(error.instancePath ? 1 : 0, instanceSchemaBoundaryLength(parentSegments))
  for (let length = parentSegments.length; length >= minimumLength; length -= 1) {
    const title = schemaTitle(schema, schemaNodeAt(schema, parentSegments.slice(0, length)))
    if (title) return title
  }
  return undefined
}

function boundedLabel(value: string | undefined, fallback: string): string {
  const normalize = (label: string | undefined) => label
    ? [...label]
        .map((character) => {
          const code = character.charCodeAt(0)
          return code <= 31 || code === 127 ? ' ' : character
        })
        .join('')
        .replace(/\s+/gu, ' ')
        .trim()
    : undefined
  return (normalize(value) || normalize(fallback) || '输入内容').slice(0, 100)
}

function inputSchemaNode(schema: unknown, segments: string[]): unknown {
  let schemaNode = schema
  for (const segment of segments) {
    const record = typeof schemaNode === 'object' && schemaNode !== null ? schemaNode as Record<string, unknown> : undefined
    const properties = typeof record?.properties === 'object' && record.properties !== null
      ? record.properties as Record<string, unknown>
      : undefined
    schemaNode = properties?.[segment] ?? (Array.isArray(record?.items) ? record.items[Number(segment)] : record?.items)
  }
  return schemaNode
}

function inputValue(input: unknown, segments: string[]): unknown {
  let value = input
  for (const segment of segments) {
    value = typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[segment] : undefined
  }
  return value
}

function validationMessage(schema: unknown, input: unknown, error: ErrorObject): string {
  const instanceSegments = jsonPointerSegments(error.instancePath)
  const missingProperty = error.keyword === 'required' && typeof error.params.missingProperty === 'string'
    ? error.params.missingProperty
    : undefined
  const additionalProperty = error.keyword === 'additionalProperties' && typeof error.params.additionalProperty === 'string'
    ? error.params.additionalProperty
    : undefined
  const targetSegments = [...instanceSegments, ...(missingProperty ? [missingProperty] : [])]
  const schemaNode = inputSchemaNode(schema, targetSegments)
  const title = boundedLabel(
    errorSchemaTitle(schema, error, missingProperty) ?? schemaTitle(schema, schemaNode),
    targetSegments.at(-1) ?? '输入内容',
  )
  const safeAdditionalProperty = boundedLabel(additionalProperty, title)
  const value = inputValue(input, instanceSegments)
  const limit = typeof error.params.limit === 'number' ? error.params.limit : undefined
  const multipleOf = typeof error.params.multipleOf === 'number' ? error.params.multipleOf : undefined

  if (error.keyword === 'required') return `${title}不能为空`
  if (error.keyword === 'minLength' && value === '') return `${title}不能为空`
  if (error.keyword === 'minLength' && limit !== undefined) return `${title}长度不能少于 ${limit} 个字符`
  if (error.keyword === 'maxLength' && limit !== undefined) return `${title}长度不能超过 ${limit} 个字符`
  if (error.keyword === 'format' || error.keyword === 'pattern') return `${title}格式不正确`
  if (error.keyword === 'minimum' && limit !== undefined) return `${title}不能小于 ${limit}`
  if (error.keyword === 'maximum' && limit !== undefined) return `${title}不能大于 ${limit}`
  if (error.keyword === 'exclusiveMinimum' && limit !== undefined) return `${title}必须大于 ${limit}`
  if (error.keyword === 'exclusiveMaximum' && limit !== undefined) return `${title}必须小于 ${limit}`
  if (error.keyword === 'multipleOf' && multipleOf !== undefined) return `${title}必须是 ${multipleOf} 的倍数`
  if (error.keyword === 'enum' || error.keyword === 'const') return `${title}必须选择允许的值`
  if (error.keyword === 'additionalProperties') return `${safeAdditionalProperty}是不支持的字段`
  if (error.keyword === 'type') {
    const expected = typeof error.params.type === 'string' ? error.params.type : ''
    const typeLabel: Record<string, string> = {
      string: '文本', number: '数字', integer: '整数', boolean: '布尔值', array: '数组', object: '对象', null: '空值',
    }
    return `${title}必须是${typeLabel[expected] ?? '正确的类型'}`
  }
  if (error.keyword === 'minItems' && limit !== undefined) return `${title}至少需要 ${limit} 项`
  if (error.keyword === 'maxItems' && limit !== undefined) return `${title}最多允许 ${limit} 项`
  if (error.keyword === 'uniqueItems') return `${title}不能包含重复项`
  if (error.keyword === 'minProperties' && limit !== undefined) return `${title}至少需要 ${limit} 个字段`
  if (error.keyword === 'maxProperties' && limit !== undefined) return `${title}最多允许 ${limit} 个字段`
  return `${title}输入无效`
}

export function validateWorkflowInput(schema: unknown, input: unknown): WorkflowInputValidationResult {
  const ajv = new Ajv({ strict: false })
  addFormats(ajv)
  const validate = ajv.compile(schema as AnySchema)
  if (validate(input)) return { valid: true }
  const error = validate.errors?.[0]
  const message = error ? validationMessage(schema, input, error) : '输入内容无效'
  return { valid: false, message: message.slice(0, 500) }
}
