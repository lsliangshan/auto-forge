/* global fetch */

import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import process from 'node:process'

const ENV_ID = 'autoforge-d1gkhyfb419ba8455'
const REGION = 'ap-shanghai'
const SOURCE_FUNCTION = 'autoforge-user-roles'
const CANARY_FINGERPRINT = '3f289aeb40e1'
const ADMIN_FINGERPRINT = '98ad26b8c62a'
const NOTE = 'production dark launch canary'
const EXPECTED_LIMITS = Object.freeze({
  free: Object.freeze({ knowledgeBases: 1, knowledgeDocuments: 1, knowledgeFileBytes: 64 * 1024 * 1024 }),
  pro: Object.freeze({ knowledgeBases: 20, knowledgeDocuments: 500, knowledgeFileBytes: 64 * 1024 * 1024 }),
})

function run(executable, args) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(executable, args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
    child.once('error', rejectRun)
    child.once('close', code => resolveRun({ code: code ?? 1, stdout, stderr }))
  })
}

function jsonOutput(output) {
  const start = output.indexOf('{')
  const end = output.lastIndexOf('}')
  if (start < 0 || end < start) throw new Error('CloudBase CLI did not return JSON')
  return JSON.parse(output.slice(start, end + 1))
}

function fingerprint(value) {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 12)
}

function sameLimits(actual, expected) {
  return actual?.knowledgeBases === expected.knowledgeBases
    && actual?.knowledgeDocuments === expected.knowledgeDocuments
    && actual?.knowledgeFileBytes === expected.knowledgeFileBytes
}

function assertMembership(value, { planId, state, effectiveStatus, version, limitsPlanId = planId }) {
  if (value?.planId !== planId || value?.state !== state
    || value?.effectiveStatus !== effectiveStatus || value?.version !== version
    || value?.planVersion !== 1 || !sameLimits(value?.limits, EXPECTED_LIMITS[limitsPlanId])) {
    throw new Error(`unexpected ${planId} membership at version ${version}`)
  }
}

async function main() {
  const mode = process.argv[2]
  if (!['--apply', '--verify'].includes(mode)) {
    throw new Error('Usage: node run-production-canary.mjs <--apply|--verify>')
  }

  const detail = await run('npm', [
    'exec', '--yes', '--package=@cloudbase/cli@3.8.1', '--', 'tcb',
    'fn', 'detail', SOURCE_FUNCTION, '-e', ENV_ID, '--region', REGION, '--json',
  ])
  if (detail.code !== 0) throw new Error('unable to read the production function environment')
  const variables = jsonOutput(detail.stdout)?.data?.Environment?.Variables
  if (!Array.isArray(variables)) throw new Error('production function environment is unavailable')
  const environment = Object.fromEntries(variables.map(entry => [entry?.Key, entry?.Value]))
  const rawBaseUrl = environment.AUTOFORGE_PG_RPC_BASE_URL
  const serviceKey = environment.AUTOFORGE_PG_SERVICE_KEY
  if (typeof rawBaseUrl !== 'string' || typeof serviceKey !== 'string') {
    throw new Error('production PostgreSQL RPC credentials are unavailable')
  }
  const baseUrl = rawBaseUrl.endsWith('/') ? rawBaseUrl.slice(0, -1) : rawBaseUrl
  const headers = {
    authorization: `Bearer ${serviceKey}`,
    apikey: serviceKey,
    'content-type': 'application/json',
  }
  const rawRequest = async (path, init = {}) => {
    const response = await fetch(`${baseUrl}/${path}`, { ...init, headers: { ...headers, ...init.headers } })
    const text = await response.text()
    if (!response.ok) {
      const body = JSON.parse(text || 'null')
      const stableCode = typeof body?.message === 'string' && /^[A-Z_]+$/.test(body.message)
        ? body.message
        : 'SERVICE_UNAVAILABLE'
      throw new Error(`${path} failed with ${response.status} ${stableCode}`)
    }
    return text
  }
  const request = async (path, init = {}) => JSON.parse(await rawRequest(path, init) || 'null')
  const rpc = (name, input) => request(`rpc/${name}`, {
    method: 'POST',
    body: JSON.stringify(input),
  })

  const rolesText = await rawRequest('app_user_roles?select=user_id,role,version&order=user_id.asc')
  const roles = JSON.parse(rolesText.replace(/("user_id"\s*:\s*)(-?\d+)/g, '$1"$2"'))
  if (!Array.isArray(roles)) throw new Error('role preflight returned an invalid response')
  const resolveIdentity = (expectedFingerprint) => {
    const matches = roles.filter(row => fingerprint(row.user_id) === expectedFingerprint)
    if (matches.length !== 1) throw new Error(`expected one role row for fingerprint ${expectedFingerprint}`)
    return matches[0]
  }
  const canary = resolveIdentity(CANARY_FINGERPRINT)
  const admin = resolveIdentity(ADMIN_FINGERPRINT)
  if (canary.role === 'super_admin' || admin.role !== 'super_admin' || canary.user_id === admin.user_id) {
    throw new Error('canary/admin role separation failed')
  }

  const currentInput = { p_caller_user_id: String(canary.user_id) }
  const targetInput = {
    p_caller_user_id: String(admin.user_id),
    p_target_user_id: String(canary.user_id),
  }
  const initial = await rpc('autoforge_membership_get_current', currentInput)
  assertMembership(initial, {
    planId: 'free', state: 'active', effectiveStatus: 'active', version: initial.version,
  })
  const initialAudit = await rpc('autoforge_membership_list_audit', {
    ...targetInput, p_page: 1, p_page_size: 20,
  })
  if (!Number.isInteger(initialAudit?.total)) throw new Error('initial audit response is invalid')
  if (mode === '--verify') {
    const expectedActions = ['correct', 'revoke', 'extend', 'grant']
    const latestItems = initialAudit.items?.slice(0, 4)
    const latestActions = latestItems?.map(item => item.action)
    const latestVersions = latestItems?.map(item => item.resultingVersion)
    const expectedVersions = [0, 1, 2, 3].map(offset => initial.version - offset)
    if (initialAudit.total < 4
      || JSON.stringify(latestActions) !== JSON.stringify(expectedActions)
      || JSON.stringify(latestVersions) !== JSON.stringify(expectedVersions)) {
      throw new Error('latest canary audit sequence is incomplete')
    }
    process.stdout.write(`${JSON.stringify({
      environment: ENV_ID,
      region: REGION,
      canaryFingerprint: CANARY_FINGERPRINT,
      adminFingerprint: ADMIN_FINGERPRINT,
      final: { planId: initial.planId, version: initial.version, limits: initial.limits },
      latestActions,
      auditTotal: initialAudit.total,
    }, null, 2)}\n`)
    return
  }

  const rolloutId = `membership-dark-launch-20260830-${randomUUID()}`
  const mutate = (operation, expectedVersion, overrides = {}) => rpc('autoforge_membership_mutate', {
    ...targetInput,
    p_request_id: `${rolloutId}-${operation}`,
    p_expected_version: expectedVersion,
    p_action: operation,
    p_grant_kind: null,
    p_term_ends_at: null,
    p_reason_code: 'operator_correction',
    p_note: NOTE,
    p_plan_id: null,
    p_state: null,
    ...overrides,
  })

  let latest = initial
  let compensation
  try {
    const firstTerm = new Date(Date.now() + 30 * 24 * 60 * 60 * 1_000).toISOString()
    const extendedTerm = new Date(Date.now() + 60 * 24 * 60 * 60 * 1_000).toISOString()
    latest = (await mutate('grant', latest.version, {
      p_grant_kind: 'manual_trial',
      p_term_ends_at: firstTerm,
      p_reason_code: 'internal_grant',
    })).membership
    assertMembership(latest, {
      planId: 'pro', state: 'active', effectiveStatus: 'active', version: initial.version + 1,
    })

    latest = (await mutate('extend', latest.version, {
      p_term_ends_at: extendedTerm,
      p_reason_code: 'renewal',
    })).membership
    assertMembership(latest, {
      planId: 'pro', state: 'active', effectiveStatus: 'active', version: initial.version + 2,
    })

    latest = (await mutate('revoke', latest.version, {
      p_reason_code: 'risk_revocation',
    })).membership
    assertMembership(latest, {
      planId: 'pro', state: 'revoked', effectiveStatus: 'revoked', version: initial.version + 3,
      limitsPlanId: 'free',
    })

    latest = (await mutate('correct', latest.version, {
      p_plan_id: 'free',
      p_state: 'active',
    })).membership
    assertMembership(latest, {
      planId: 'free', state: 'active', effectiveStatus: 'active', version: initial.version + 4,
    })
  } catch (error) {
    const observed = await rpc('autoforge_membership_get_target', targetInput).catch(() => undefined)
    if (observed && (observed.planId !== 'free' || observed.state !== 'active')) {
      compensation = (await mutate('correct', observed.version, {
        p_request_id: `${rolloutId}-compensate`,
        p_plan_id: 'free',
        p_state: 'active',
      }).catch(() => undefined))?.membership
    }
    if (!compensation || compensation.planId !== 'free' || compensation.state !== 'active') throw error
    throw new Error(`${error instanceof Error ? error.message : 'canary failed'}; compensated to Free`, {
      cause: error,
    })
  }

  const finalCurrent = await rpc('autoforge_membership_get_current', currentInput)
  assertMembership(finalCurrent, {
    planId: 'free', state: 'active', effectiveStatus: 'active', version: initial.version + 4,
  })
  const finalAudit = await rpc('autoforge_membership_list_audit', {
    ...targetInput, p_page: 1, p_page_size: 20,
  })
  const expectedActions = ['correct', 'revoke', 'extend', 'grant']
  const latestActions = finalAudit?.items?.slice(0, 4).map(item => item.action)
  const latestVersions = finalAudit?.items?.slice(0, 4).map(item => item.resultingVersion)
  const expectedVersions = [4, 3, 2, 1].map(offset => initial.version + offset)
  if (finalAudit?.total !== initialAudit.total + 4
    || JSON.stringify(latestActions) !== JSON.stringify(expectedActions)
    || JSON.stringify(latestVersions) !== JSON.stringify(expectedVersions)) {
    throw new Error('canary audit sequence is incomplete')
  }

  process.stdout.write(`${JSON.stringify({
    environment: ENV_ID,
    region: REGION,
    canaryFingerprint: CANARY_FINGERPRINT,
    adminFingerprint: ADMIN_FINGERPRINT,
    initial: { planId: initial.planId, version: initial.version, limits: initial.limits },
    transitions: [
      { action: 'grant', planId: 'pro', version: initial.version + 1 },
      { action: 'extend', planId: 'pro', version: initial.version + 2 },
      { action: 'revoke', effectiveStatus: 'revoked', version: initial.version + 3 },
      { action: 'correct', planId: 'free', version: initial.version + 4 },
    ],
    final: { planId: finalCurrent.planId, version: finalCurrent.version, limits: finalCurrent.limits },
    auditEventsAdded: finalAudit.total - initialAudit.total,
    rolloutId,
  }, null, 2)}\n`)
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'production canary failed'}\n`)
  process.exitCode = 1
})
