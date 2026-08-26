import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'

const USER_MEDIA_DOMAIN = 'autoforge-user-media-v1\0'

export function resolveUserMediaRoot(dataRoot: string, userId: string): string {
  if (userId.length === 0 || userId.length > 512 || userId.trim() !== userId || userId.includes('\0')) {
    throw new Error('Invalid user ID for media storage')
  }

  const parent = resolve(dataRoot, 'user-media')
  const scope = createHash('sha256').update(USER_MEDIA_DOMAIN).update(userId).digest('hex')
  const root = resolve(join(parent, scope))
  if (dirname(root) !== parent) throw new Error('Invalid user media root')
  return root
}
