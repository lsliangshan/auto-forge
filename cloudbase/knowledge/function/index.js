/* global exports, process, require */

const { createKnowledgeHandler, createPostgresRpcClient } = require('./knowledge-handler.js')

let handler

async function main(event, context) {
  if (!handler) {
    handler = createKnowledgeHandler({
      rpc: createPostgresRpcClient({
        baseUrl: process.env.AUTOFORGE_PG_RPC_BASE_URL,
        serviceKey: process.env.AUTOFORGE_PG_SERVICE_KEY,
      }),
    })
  }
  return handler(event, context)
}

exports.main = main
