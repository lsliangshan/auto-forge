/* global exports, process, require */

const { createPostgresRpcClient, createUserRoleHandler } = require('./user-role-handler.js')

let handler

async function main(event, context) {
  if (!handler) {
    const rpc = createPostgresRpcClient({
      baseUrl: process.env.AUTOFORGE_PG_RPC_BASE_URL,
      serviceKey: process.env.AUTOFORGE_PG_SERVICE_KEY,
    })
    handler = createUserRoleHandler({ rpc })
  }
  return handler(event, context)
}

exports.main = main
