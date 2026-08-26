/* global exports, process, require */

const {
  createKnowledgeHandler,
  createPostgresRpcClient,
  createPostgresStorageClient,
  createTokenHubEmbeddingClient,
} = require('./knowledge-handler.js')

let handler

async function main(event, context) {
  if (!handler) {
    const serviceKey = process.env.AUTOFORGE_PG_SERVICE_KEY
    handler = createKnowledgeHandler({
      rpc: createPostgresRpcClient({
        baseUrl: process.env.AUTOFORGE_PG_RPC_BASE_URL, serviceKey,
      }),
      storage: createPostgresStorageClient({
        baseUrl: process.env.AUTOFORGE_PG_STORAGE_BASE_URL, serviceKey,
      }),
      embeddings: createTokenHubEmbeddingClient({
        baseUrl: process.env.AUTOFORGE_TOKENHUB_BASE_URL,
        apiKey: process.env.AUTOFORGE_TOKENHUB_API_KEY,
      }),
    })
  }
  return handler(event, context)
}

exports.main = main
