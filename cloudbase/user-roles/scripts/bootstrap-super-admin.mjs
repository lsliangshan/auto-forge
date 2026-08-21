import { callRpc } from './rpc-client.mjs'

function valueAfter(args, name) {
  const index = args.indexOf(name)
  return index === -1 ? undefined : args[index + 1]
}

const args = process.argv.slice(2)
if (args.includes('--help')) {
  console.log('Usage: node bootstrap-super-admin.mjs --user-id <CloudBase UID> [--request-id <id>] [--apply]')
  console.log('Default is a server-side dry run. --apply performs the idempotent promotion.')
  process.exit(0)
}
const userId = valueAfter(args, '--user-id')
if (!userId || !/^[A-Za-z0-9_:@.-]{1,64}$/.test(userId)) {
  throw new Error('--user-id must be an explicit CloudBase UID')
}
const requestId = valueAfter(args, '--request-id') ?? `bootstrap:${userId}`
if (requestId.length > 128) throw new Error('--request-id is too long')
const recognized = new Set(['--user-id', userId, '--request-id', requestId, '--apply'])
const unknown = args.find((arg) => !recognized.has(arg))
if (unknown) throw new Error(`Unknown option: ${unknown}`)

const apply = args.includes('--apply')
const result = await callRpc('autoforge_bootstrap_super_admin', {
  p_target_user_id: userId,
  p_request_id: requestId,
  p_apply: apply,
})
console.log(JSON.stringify(result, null, 2))
