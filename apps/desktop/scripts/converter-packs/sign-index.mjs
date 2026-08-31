import { createPrivateKey, createPublicKey, sign } from 'node:crypto'
import { open } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import {
  canonicalBytes,
  fail,
  parseArguments,
  releaseMode,
  requireAbsolutePath,
  validateIndex,
  withStableRegularFile,
} from './pack-tooling-lib.mjs'
import { isDisallowedProductionConverterRootKey } from './root-key-policy.mjs'

export async function signConverterPackIndex({ indexPath, privateKeyPath, mode = 'production' }) {
  mode = releaseMode(mode)
  requireAbsolutePath(indexPath, 'Index path')
  requireAbsolutePath(privateKeyPath, 'Private key path')
  const indexBytes = await withStableRegularFile(indexPath, 'Index', (handle) => handle.readFile())
  const privateKeyBytes = await withStableRegularFile(privateKeyPath, 'Private key', async (handle, metadata) => {
    if (process.platform !== 'win32' && (metadata.mode & 0o077) !== 0) fail('Private key permissions must be 0600 or stricter.')
    return handle.readFile()
  })
  let index
  try { index = validateIndex(JSON.parse(indexBytes.toString('utf8')), mode) } catch { fail('Index is invalid or non-canonical.') }
  if (!indexBytes.equals(canonicalBytes(index))) fail('Index is invalid or non-canonical.')
  let privateKey
  try {
    privateKey = createPrivateKey(privateKeyBytes)
  } catch {
    fail('Private key is invalid.')
  }
  if (privateKey.asymmetricKeyType !== 'ed25519') fail('Private key is invalid.')
  if (mode === 'production' && isDisallowedProductionConverterRootKey(createPublicKey(privateKey))) {
    fail('Production converter root key must not use a development or test key.')
  }
  const signature = sign(null, indexBytes, privateKey).toString('base64')
  const signaturePath = join(dirname(indexPath), 'index.sig')
  const handle = await open(signaturePath, 'wx', 0o600).catch(() => fail('Signature output already exists.'))
  try {
    await handle.writeFile(`${signature}\n`, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  process.stdout.write('signed canonical converter pack index\n')
}

const entry = process.argv[1]
if (entry && import.meta.url === pathToFileURL(entry).href) {
  const args = parseArguments(process.argv.slice(2), ['--index', '--private-key', '--mode'], ['--index', '--private-key'])
  await signConverterPackIndex({ indexPath: args['--index'], privateKeyPath: args['--private-key'], mode: args['--mode'] })
}
