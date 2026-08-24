/* global exports, process, require */

const { createPostgresRpcClient, createUserDataHandler } = require('./user-data-handler.js')

let handler

async function main(event, context) {
  if (!handler) {
    try {
      const rpc = createPostgresRpcClient({
        baseUrl: process.env.AUTOFORGE_PG_RPC_BASE_URL,
        serviceKey: process.env.AUTOFORGE_PG_SERVICE_KEY,
      })
      handler = createUserDataHandler({ rpc })
    } catch {
      return { ok: false, error: { code: 'SERVICE_UNAVAILABLE' } }
    }
  }
  return handler(event, context)
}

exports.main = main
