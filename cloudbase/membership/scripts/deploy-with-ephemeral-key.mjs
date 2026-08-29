import { generateKeyPairSync } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdtemp, rmdir, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'

const ENV_ID = 'autoforge-d1gkhyfb419ba8455'
const REGION = 'ap-shanghai'
const SOURCE_FUNCTION = 'autoforge-user-roles'
const TARGET_FUNCTION = 'autoforge-membership'
const KEY_ID = 'membership-2026-08'
const REQUIRED_SOURCE_VARIABLES = [
  'AUTOFORGE_PG_RPC_BASE_URL',
  'AUTOFORGE_PG_SERVICE_KEY',
]

function fail(message) {
  process.stderr.write(`${message}\n`)
  process.exitCode = 1
}

function run(executable, args, environment = process.env) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(executable, args, {
      cwd: process.cwd(),
      env: environment,
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

async function runWithConfig(executable, argsForPath, config, environment) {
  const directory = await mkdtemp(join(tmpdir(), 'autoforge-membership-'))
  const configPath = join(directory, 'cloudbaserc.json')
  try {
    await writeFile(configPath, JSON.stringify(config), 'utf8')
    return await run(executable, argsForPath(configPath), environment)
  } finally {
    await unlink(configPath).catch(() => undefined)
    await rmdir(directory).catch(() => undefined)
  }
}

function jsonOutput(output) {
  const start = output.indexOf('{')
  const end = output.lastIndexOf('}')
  if (start < 0 || end < start) throw new Error('CloudBase CLI did not return JSON')
  return JSON.parse(output.slice(start, end + 1))
}

function environmentVariables(detail, expectedNames = REQUIRED_SOURCE_VARIABLES) {
  const variables = detail?.data?.Environment?.Variables
  if (!Array.isArray(variables)) throw new Error('Source function environment is unavailable')
  const entries = variables.map(entry => [entry?.Key, entry?.Value])
  if (entries.some(([key, value]) => typeof key !== 'string' || typeof value !== 'string')) {
    throw new Error('Source function environment is malformed')
  }
  const result = Object.fromEntries(entries)
  if (Object.keys(result).sort().join('\n') !== [...expectedNames].sort().join('\n')) {
    throw new Error('Source function environment contains an unexpected variable set')
  }
  return result
}

function redactedFailure(result, secrets = []) {
  let output = `${result.stderr}\n${result.stdout}`.trim()
  for (const secret of secrets) {
    if (secret) output = output.split(secret).join('[REDACTED]')
  }
  return output.slice(-4_000)
}

const [, , cliPath, applyFlag] = process.argv
if (!cliPath || applyFlag !== '--apply') {
  fail('Usage: node deploy-with-ephemeral-key.mjs <absolute-tcb-path> --apply')
} else {
  try {
    const executable = resolve(cliPath)
    const existing = await run(executable, [
      'fn', 'detail', TARGET_FUNCTION, '-e', ENV_ID, '--region', REGION, '--json',
    ])
    if (existing.code === 0) throw new Error(`${TARGET_FUNCTION} already exists; refusing to rotate its key`)

    const source = await run(executable, [
      'fn', 'detail', SOURCE_FUNCTION, '-e', ENV_ID, '--region', REGION, '--json',
    ])
    if (source.code !== 0) throw new Error(redactedFailure(source))
    const postgres = environmentVariables(jsonOutput(source.stdout))

    const { publicKey, privateKey } = generateKeyPairSync('ed25519')
    const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' })
    const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' })
    const config = {
      envId: ENV_ID,
      functions: [{
        name: TARGET_FUNCTION,
        dir: 'cloudbase/membership/function',
        runtime: 'Nodejs18.15',
        handler: 'index.main',
        timeout: 20,
        memorySize: 256,
        installDependency: false,
        envVariables: {
          AUTOFORGE_PG_RPC_BASE_URL: '{{env.AUTOFORGE_DEPLOY_PG_RPC_BASE_URL}}',
          AUTOFORGE_PG_SERVICE_KEY: '{{env.AUTOFORGE_DEPLOY_PG_SERVICE_KEY}}',
          AUTOFORGE_MEMBERSHIP_SIGNING_KEY_ID: '{{env.AUTOFORGE_DEPLOY_SIGNING_KEY_ID}}',
          AUTOFORGE_MEMBERSHIP_SIGNING_PRIVATE_KEY: '{{env.AUTOFORGE_DEPLOY_SIGNING_PRIVATE_KEY}}',
        },
      }],
    }
    const deployEnvironment = {
      ...process.env,
      AUTOFORGE_DEPLOY_PG_RPC_BASE_URL: postgres.AUTOFORGE_PG_RPC_BASE_URL,
      AUTOFORGE_DEPLOY_PG_SERVICE_KEY: postgres.AUTOFORGE_PG_SERVICE_KEY,
      AUTOFORGE_DEPLOY_SIGNING_KEY_ID: KEY_ID,
      AUTOFORGE_DEPLOY_SIGNING_PRIVATE_KEY: privateKeyPem,
    }
    const deployed = await runWithConfig(executable, configPath => [
      '--config-file', configPath, '--yes',
      'fn', 'deploy', TARGET_FUNCTION, '-e', ENV_ID, '--region', REGION,
      '--install-dependency', 'false',
    ], config, deployEnvironment)
    if (deployed.code !== 0) {
      throw new Error(redactedFailure(deployed, [...Object.values(postgres), privateKeyPem]))
    }
    const verification = await run(executable, [
      'fn', 'detail', TARGET_FUNCTION, '-e', ENV_ID, '--region', REGION, '--json',
    ])
    if (verification.code !== 0) throw new Error('Membership function was not created')
    const expectedNames = [
      ...REQUIRED_SOURCE_VARIABLES,
      'AUTOFORGE_MEMBERSHIP_SIGNING_KEY_ID',
      'AUTOFORGE_MEMBERSHIP_SIGNING_PRIVATE_KEY',
    ]
    const deployedVariables = environmentVariables(jsonOutput(verification.stdout), expectedNames)
    if (deployedVariables.AUTOFORGE_MEMBERSHIP_SIGNING_KEY_ID !== KEY_ID) {
      throw new Error('Membership function environment verification failed')
    }
    process.stdout.write(`${JSON.stringify({
      envId: ENV_ID,
      region: REGION,
      functionName: TARGET_FUNCTION,
      keyId: KEY_ID,
      publicKeyPem,
    }, null, 2)}\n`)
  } catch (error) {
    fail(error instanceof Error ? error.message : 'Membership function deployment failed')
  }
}
