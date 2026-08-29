import { createPrivateKey, sign } from 'node:crypto'
import { open, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import {
  canonicalBytes,
  fail,
  parseArguments,
  requireAbsolutePath,
  requireRegularFile,
  validateIndex,
} from './pack-tooling-lib.mjs'

export async function signConverterPackIndex({ indexPath, privateKeyPath }) {
  requireAbsolutePath(indexPath, 'Index path')
  requireAbsolutePath(privateKeyPath, 'Private key path')
  await requireRegularFile(indexPath, 'Index')
  const keyMetadata = await requireRegularFile(privateKeyPath, 'Private key')
  if (process.platform !== 'win32' && (keyMetadata.mode & 0o077) !== 0) fail('Private key permissions must be 0600 or stricter.')
  const indexBytes = await readFile(indexPath)
  let index
  try { index = validateIndex(JSON.parse(indexBytes.toString('utf8'))) } catch { fail('Index is invalid or non-canonical.') }
  if (!indexBytes.equals(canonicalBytes(index))) fail('Index is invalid or non-canonical.')
  let privateKey
  try {
    privateKey = createPrivateKey(await readFile(privateKeyPath))
  } catch {
    fail('Private key is invalid.')
  }
  if (privateKey.asymmetricKeyType !== 'ed25519') fail('Private key is invalid.')
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
  const args = parseArguments(process.argv.slice(2), ['--index', '--private-key'])
  await signConverterPackIndex({ indexPath: args['--index'], privateKeyPath: args['--private-key'] })
}
