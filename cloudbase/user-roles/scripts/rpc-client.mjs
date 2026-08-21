/* global fetch, process */

export function readRpcConfig(env = process.env) {
  const baseUrl = env.AUTOFORGE_PG_RPC_BASE_URL?.trim()
  const serviceKey = env.AUTOFORGE_PG_SERVICE_KEY?.trim()
  if (!baseUrl || !serviceKey) {
    throw new Error('AUTOFORGE_PG_RPC_BASE_URL and AUTOFORGE_PG_SERVICE_KEY are required')
  }
  return { baseUrl: baseUrl.replace(/\/$/, ''), serviceKey }
}

export async function callRpc(name, parameters, config = readRpcConfig()) {
  const response = await fetch(`${config.baseUrl}/rpc/${name}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${config.serviceKey}`,
      apikey: config.serviceKey,
      'content-type': 'application/json',
    },
    body: JSON.stringify(parameters),
  })
  const body = await response.json().catch(() => undefined)
  if (!response.ok) {
    const code = body && typeof body === 'object' && typeof body.message === 'string'
      ? body.message
      : `HTTP_${response.status}`
    throw new Error(`PostgreSQL RPC failed: ${code}`)
  }
  return body
}
