/* global exports, process, require */

const {
  createKnowledgeHandler,
  createPostgresRpcClient,
  createPostgresStorageClient,
  createTokenHubClient,
} = require('./knowledge-handler.js')

let handler

async function main(event, context) {
  if (!handler) {
    try {
      const serviceKey = process.env.AUTOFORGE_PG_SERVICE_KEY
      const tokenHubEndpoint = process.env.AUTOFORGE_TOKENHUB_EMBEDDING_URL
      const tokenHubApiKey = process.env.AUTOFORGE_TOKENHUB_API_KEY
      handler = createKnowledgeHandler({
        rpc: createPostgresRpcClient({
          baseUrl: process.env.AUTOFORGE_PG_RPC_BASE_URL, serviceKey,
        }),
        storage: createPostgresStorageClient({
          baseUrl: process.env.AUTOFORGE_PG_STORAGE_BASE_URL, serviceKey,
          uploadUrlPrefix: process.env.AUTOFORGE_PG_STORAGE_UPLOAD_URL_PREFIX,
        }),
        uploadUrlPrefix: process.env.AUTOFORGE_PG_STORAGE_UPLOAD_URL_PREFIX,
        tokenHub: tokenHubEndpoint && tokenHubApiKey
          ? createTokenHubClient({ endpoint: tokenHubEndpoint, apiKey: tokenHubApiKey })
          : undefined,
      })
    } catch {
      return { ok: false, error: { code: 'TRANSIENT_FAILURE' } }
    }
  }
  return handler(event, context)
}

exports.main = main
