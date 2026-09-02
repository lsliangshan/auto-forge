import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL, URL } from 'node:url'
import { parse } from 'yaml'
import { fail, parseArguments, requireAbsolutePath } from './pack-tooling-lib.mjs'

const repositoryRoot = fileURLToPath(new URL('../../../..', import.meta.url))
const pinnedActions = new Set([
  'actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd',
  'actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e',
  'pnpm/action-setup@d15e628ca66d93ee5f352c71671a7bc6a97af5c9',
  'actions/cache@cdf6c1fa76f9f475f3d7449005a359c84ca0f306',
  'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a',
  'actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c',
])
const commands = [
  'converter-packs:verify-workflows', 'converter-packs:verify-sources', 'converter-packs:acquire',
  'converter-packs:build-native', 'converter-packs:prepare-staging', 'converter-packs:stage',
  'converter-packs:sign-payload', 'converter-packs:verify-evidence', 'converter-packs:build',
  'converter-packs:sign', 'verify:converter-packs', 'converter-packs:publish',
  'converter-packs:create-bootstrap', 'dist:production',
]
const lockMaintenanceCommands = ['converter-packs:capture-lock-target', 'converter-packs:generate-lock']
const lockedInputHash = "hashFiles('apps/desktop/converter-packs/sources.lock.json', 'apps/desktop/converter-packs/closures/darwin-arm64.lock.json', 'apps/desktop/converter-packs/closures/darwin-x64.lock.json')"
const forbiddenHomebrewResolution = /\bbrew\s+(?:install|fetch|info|deps)\b/u

function record(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function workflow(path, label) {
  requireAbsolutePath(path, label)
  const bytes = await readFile(path)
  if (bytes.byteLength === 0 || bytes.byteLength > 256 * 1024) fail(`${label} has an invalid size.`)
  let value
  try { value = parse(bytes.toString('utf8'), { maxAliasCount: 10 }) } catch { fail(`${label} is invalid YAML.`) }
  if (!record(value) || !record(value.jobs)) fail(`${label} has an invalid schema.`)
  return { value, source: bytes.toString('utf8') }
}

function exactReadPermissions(value, label) {
  if (!record(value) || Object.keys(value).join('\0') !== 'contents' || value.contents !== 'read') {
    fail(`${label} must use contents: read permissions only.`)
  }
}

function actionSteps(value) {
  const steps = []
  for (const job of Object.values(value.jobs)) {
    if (!record(job) || !Array.isArray(job.steps)) fail('Converter workflow job steps are invalid.')
    steps.push(...job.steps)
  }
  return steps
}

function validateActions(value) {
  for (const step of actionSteps(value)) {
    if (!record(step) || typeof step.uses !== 'string') continue
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[a-f0-9]{40}$/u.test(step.uses) || !pinnedActions.has(step.uses)) {
      fail(`Converter workflow action is not approved and pinned: ${step.uses}`)
    }
    if (step.uses.startsWith('actions/checkout@') && step.with?.['persist-credentials'] !== false) {
      fail('Converter workflow checkout must not persist credentials.')
    }
    if (step.uses.startsWith('actions/upload-artifact@') && step.with?.['retention-days'] !== 1) {
      fail('Converter workflow artifacts must use one-day retention.')
    }
  }
}

function noSecrets(value, label) {
  if (JSON.stringify(value).includes('secrets.')) fail(`${label} must not access production secrets.`)
}

export async function validateConverterPackWorkflows({ checkPath, releasePath, lockPath, packagePath }) {
  const check = await workflow(checkPath, 'Converter check workflow')
  const release = await workflow(releasePath, 'Converter release workflow')
  const lock = await workflow(lockPath, 'Converter lock workflow')
  requireAbsolutePath(packagePath, 'Desktop package')
  let packageConfig
  try { packageConfig = JSON.parse(await readFile(packagePath, 'utf8')) } catch { fail('Desktop package is invalid JSON.') }
  if (!record(packageConfig) || !record(packageConfig.scripts)) fail('Desktop package scripts are invalid.')
  exactReadPermissions(check.value.permissions, 'Converter check workflow')
  exactReadPermissions(release.value.permissions, 'Converter release workflow')
  exactReadPermissions(lock.value.permissions, 'Converter lock workflow')
  if (!record(check.value.on) || !record(check.value.on.pull_request) || !record(check.value.on.push)) {
    fail('Converter check workflow triggers are invalid.')
  }
  noSecrets(check.value, 'Converter check workflow')
  if (
    !record(release.value.on)
    || Object.keys(release.value.on).join('\0') !== 'workflow_dispatch'
    || release.value.on.workflow_dispatch?.inputs?.version?.required !== true
    || release.value.on.workflow_dispatch?.inputs?.sequence?.required !== true
  ) fail('Converter release workflow inputs are invalid.')
  if (!record(release.value.concurrency) || release.value.concurrency['cancel-in-progress'] !== false) {
    fail('Converter release workflow concurrency is invalid.')
  }
  const arm64 = release.value.jobs.stage_arm64
  const x64 = release.value.jobs.stage_x64
  const production = release.value.jobs.production
  if (
    arm64?.['runs-on'] !== 'macos-15'
    || arm64?.env?.AUTOFORGE_CONVERTER_TARGET !== 'darwin-arm64'
    || x64?.['runs-on'] !== 'macos-15-intel'
    || x64?.env?.AUTOFORGE_CONVERTER_TARGET !== 'darwin-x64'
  ) fail('Converter release architecture mapping is invalid.')
  noSecrets(arm64, 'arm64 staging job')
  noSecrets(x64, 'x64 staging job')
  if (
    production?.environment !== 'production'
    || JSON.stringify(production.needs) !== JSON.stringify(['stage_arm64', 'stage_x64'])
    || !JSON.stringify(production).includes('secrets.')
    || !production.steps?.some((step) => step?.if === 'always()')
  ) fail('Converter production job protection is invalid.')
  validateActions(check.value)
  validateActions(release.value)
  validateActions(lock.value)
  const combined = `${check.source}\n${release.source}`
  const releaseRuns = actionSteps(release.value)
    .map((step) => typeof step?.run === 'string' ? step.run : '')
    .join('\n')
  if (releaseRuns.includes('${{ inputs.')) fail('Converter release inputs must enter shell steps through the environment.')
  for (const command of commands) if (!combined.includes(command)) fail(`Converter workflow command is missing: ${command}`)
  if (!check.source.includes(lockedInputHash) || !release.source.includes(lockedInputHash)) {
    fail('Converter workflow cache keys must authenticate all checked-in locks.')
  }
  const ordinary = `${combined}\n${packageConfig.scripts.predev ?? ''}\n${packageConfig.scripts.dev ?? ''}`
  if (forbiddenHomebrewResolution.test(ordinary)) fail('Ordinary converter workflows must not resolve Homebrew dependencies.')
  for (const command of lockMaintenanceCommands) {
    if (combined.includes(command) || !lock.source.includes(command)) {
      fail(`Converter lock maintenance command has an invalid workflow boundary: ${command}`)
    }
  }
}

const entry = process.argv[1]
if (entry && import.meta.url === pathToFileURL(entry).href) {
  const args = parseArguments(process.argv.slice(2), ['--check', '--release', '--lock', '--package'], [])
  await validateConverterPackWorkflows({
    checkPath: args['--check'] ?? join(repositoryRoot, '.github', 'workflows', 'converter-pack-check.yml'),
    releasePath: args['--release'] ?? join(repositoryRoot, '.github', 'workflows', 'converter-pack-release.yml'),
    lockPath: args['--lock'] ?? join(repositoryRoot, '.github', 'workflows', 'converter-pack-lock.yml'),
    packagePath: args['--package'] ?? join(repositoryRoot, 'apps', 'desktop', 'package.json'),
  })
  process.stdout.write('verified converter pack workflow boundaries\n')
}
