import { createPublicKey } from 'node:crypto'
import { Buffer } from 'node:buffer'
import { mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL, URL } from 'node:url'
import {
  canonicalBytes,
  fail,
  isPathInsideRoot,
  parseArguments,
  readStableRegularFile,
  requireAbsolutePath,
} from './pack-tooling-lib.mjs'
import { isDisallowedProductionConverterRootKey } from './root-key-policy.mjs'

const desktopRoot = fileURLToPath(new URL('../..', import.meta.url))
const checkedInRoot = join(desktopRoot, 'resources', 'converter-packs')

function validateIndexUrl(value) {
  let parsed
  try { parsed = new URL(value) } catch { fail('Production index URL must be canonical HTTPS.') }
  if (
    parsed.protocol !== 'https:'
    || parsed.username !== ''
    || parsed.password !== ''
    || parsed.search !== ''
    || parsed.hash !== ''
    || !parsed.pathname.endsWith('/index.json')
    || parsed.href !== value
  ) fail('Production index URL must be canonical HTTPS.')
  return parsed.href
}

export async function createProductionBootstrap({ indexUrl, publicKeyPath, output }) {
  const canonicalIndexUrl = validateIndexUrl(indexUrl)
  requireAbsolutePath(publicKeyPath, 'Root public key')
  requireAbsolutePath(output, 'Bootstrap output')
  const protectedRoot = await realpath(checkedInRoot)
  if (isPathInsideRoot(protectedRoot, output)) fail('Bootstrap output must not use the checked-in resource root.')
  if (await realpath(dirname(output)).catch(() => undefined) !== dirname(output)) {
    fail('Bootstrap output parent must be a canonical directory.')
  }
  const keyBytes = await readStableRegularFile(publicKeyPath, 'Root public key', 64 * 1024)
  if (/-----BEGIN [^-]*PRIVATE KEY-----/u.test(keyBytes.toString('utf8'))) fail('Root key must be a public key.')
  let publicKey
  try { publicKey = createPublicKey(keyBytes) } catch { fail('Root public key is invalid.') }
  if (publicKey.asymmetricKeyType !== 'ed25519') fail('Root public key must use Ed25519.')
  if (isDisallowedProductionConverterRootKey(publicKey)) fail('Development or test root keys are forbidden in production metadata.')
  const canonicalPublicKey = Buffer.from(publicKey.export({ type: 'spki', format: 'pem' }), 'utf8')
  const schemaBytes = await readStableRegularFile(join(protectedRoot, 'index.schema.json'), 'Pinned index schema')
  let schema
  try { schema = JSON.parse(schemaBytes.toString('utf8')) } catch { fail('Pinned index schema is invalid.') }
  if (!schemaBytes.equals(canonicalBytes(schema))) fail('Pinned index schema is not canonical.')

  await mkdir(output, { mode: 0o700 })
  try {
    await Promise.all([
      writeFile(join(output, 'bootstrap.json'), canonicalBytes({
        schemaVersion: 1,
        downloadsEnabled: true,
        indexUrl: canonicalIndexUrl,
        rootPublicKeyFile: 'root-public-key.pem',
        requiredPackFamilies: ['image-icon', 'document', 'pdf', 'media'],
        supportedTargets: ['darwin-arm64', 'darwin-x64'],
      }), { flag: 'wx', mode: 0o600 }),
      writeFile(join(output, 'index.schema.json'), schemaBytes, { flag: 'wx', mode: 0o600 }),
      writeFile(join(output, 'root-public-key.pem'), canonicalPublicKey, { flag: 'wx', mode: 0o600 }),
    ])
  } catch (error) {
    await rm(output, { recursive: true, force: true })
    throw error
  }
}

const entry = process.argv[1]
if (entry && import.meta.url === pathToFileURL(entry).href) {
  const args = parseArguments(process.argv.slice(2), ['--index-url', '--public-key', '--output'])
  await createProductionBootstrap({
    indexUrl: args['--index-url'], publicKeyPath: args['--public-key'], output: args['--output'],
  })
  process.stdout.write('created production converter bootstrap metadata\n')
}
