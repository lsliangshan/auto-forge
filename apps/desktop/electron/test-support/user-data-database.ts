import { join } from 'node:path'
import { openAppDatabase } from '../main/database/client.js'
import { UserDataStoreManager } from '../main/database/user-data-client.js'

export function openTestUserDataDatabase(
  root: string,
  userId = 'test_user',
) {
  const legacy = openAppDatabase(join(root, 'app.sqlite'))
  const manager = new UserDataStoreManager(join(root, 'user-caches'))
  const userData = manager.open(userId)
  let closed = false
  return {
    ...legacy,
    ...userData,
    close() {
      if (closed) return
      closed = true
      manager.close()
      legacy.close()
    },
  }
}

export type TestUserDataDatabase = ReturnType<typeof openTestUserDataDatabase>
