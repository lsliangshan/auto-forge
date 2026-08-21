/* global console, process */

import { callRpc } from './rpc-client.mjs'

const args = new Set(process.argv.slice(2))
if (args.has('--help')) {
  console.log('Usage: node backfill-users.mjs [--apply]')
  console.log('Default is a server-side dry run. --apply inserts missing ordinary-user roles.')
  process.exit(0)
}
const unknown = [...args].filter((arg) => arg !== '--apply')
if (unknown.length > 0) throw new Error(`Unknown option: ${unknown[0]}`)

const apply = args.has('--apply')
const result = await callRpc('autoforge_backfill_user_roles', { p_apply: apply })
console.log(JSON.stringify(result, null, 2))
