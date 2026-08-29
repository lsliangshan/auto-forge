/* global exports, process, require */

const { randomUUID } = require('node:crypto')
const { createPostgresRpcClient, createTokenHubClient } = require('../function/knowledge-handler.js')
const { createKnowledgeJobProcess } = require('./job-process.js')
const { createKnowledgeWorker, createWorkerStorageClient } = require('./knowledge-worker.js')
const { createKnowledgeParserProcess } = require('./parser-process.js')
const { createKnowledgeSettlementProcess } = require('./settlement-process.js')

let worker

function configuredWorker() {
  if (worker) return worker
  const serviceKey = process.env.AUTOFORGE_PG_SERVICE_KEY
  const mutationPermitPortVersion = process.env.AUTOFORGE_KNOWLEDGE_MUTATION_PERMIT_PORT_VERSION
  const rpc = createPostgresRpcClient({
    baseUrl: process.env.AUTOFORGE_PG_RPC_BASE_URL,
    serviceKey,
  })
  createWorkerStorageClient({
    baseUrl: process.env.AUTOFORGE_PG_STORAGE_BASE_URL,
    serviceKey,
    mutationPermitPortVersion,
  })
  createKnowledgeParserProcess()
  const tokenHubEndpoint = process.env.AUTOFORGE_TOKENHUB_EMBEDDING_URL
  const tokenHubApiKey = process.env.AUTOFORGE_TOKENHUB_API_KEY
  if (tokenHubEndpoint && tokenHubApiKey) {
    createTokenHubClient({
      endpoint: tokenHubEndpoint, apiKey: tokenHubApiKey,
      requireMutationPermitPort: true, mutationPermitPortVersion,
    })
  }
  const configuredId = process.env.AUTOFORGE_KNOWLEDGE_WORKER_ID
  const workerId = configuredId && /^[A-Za-z0-9_-]{1,96}$/u.test(configuredId)
    ? configuredId
    : `worker_${randomUUID()}`
  worker = createKnowledgeWorker({
    rpc, jobExecution: createKnowledgeJobProcess(),
    settlementExecution: createKnowledgeSettlementProcess(), workerId,
  })
  return worker
}

async function main() {
  try {
    return await configuredWorker().runOnce()
  } catch {
    throw Object.assign(new Error('Knowledge worker run failed'), {
      code: 'TRANSIENT_FAILURE',
    })
  }
}

exports.main = main
