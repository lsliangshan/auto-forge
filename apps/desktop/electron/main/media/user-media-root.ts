import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'

const USER_MEDIA_DOMAIN = 'autoforge-user-media-v1\0'
const USER_CONVERSION_DOMAIN = 'autoforge-user-conversion-v1\0'

function resolveScopedRoot(dataRoot: string, parentName: string, domain: string, userId: string): string {
  if (userId.length === 0 || userId.length > 512 || userId.trim() !== userId || userId.includes('\0')) {
    throw new Error('Invalid user ID for managed storage')
  }

  const parent = resolve(dataRoot, parentName)
  const scope = createHash('sha256').update(domain).update(userId).digest('hex')
  const root = resolve(join(parent, scope))
  if (dirname(root) !== parent) throw new Error('Invalid user storage root')
  return root
}

export function resolveUserMediaRoot(dataRoot: string, userId: string): string {
  return resolveScopedRoot(dataRoot, 'user-media', USER_MEDIA_DOMAIN, userId)
}

export function resolveUserConversionRoot(dataRoot: string, userId: string): string {
  return resolveScopedRoot(dataRoot, 'conversion-artifacts', USER_CONVERSION_DOMAIN, userId)
}
