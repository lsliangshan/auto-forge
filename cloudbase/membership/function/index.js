/* global exports, process, require */

const { createMembershipHandler, createPostgresRpcClient } = require('./membership-handler.js')

const rpc = createPostgresRpcClient({
  baseUrl: process.env.AUTOFORGE_PG_RPC_BASE_URL,
  serviceKey: process.env.AUTOFORGE_PG_SERVICE_KEY,
})
const handler = createMembershipHandler({
  rpc,
  privateKey: process.env.AUTOFORGE_MEMBERSHIP_SIGNING_PRIVATE_KEY,
  keyId: process.env.AUTOFORGE_MEMBERSHIP_SIGNING_KEY_ID,
})

async function main(event, context) {
  return handler(event, context)
}

exports.main = main
