import { sign, verify, type KeyLike } from 'node:crypto'
import { canonicalize, type ReleaseManifest } from './index.js'
export function signReleaseManifest(manifest: ReleaseManifest, privateKey: KeyLike): string { return sign(null, Buffer.from(canonicalize(manifest)), privateKey).toString('base64') }
export function verifyReleaseManifest(manifest: ReleaseManifest, signature: string, publicKey: KeyLike): boolean { try { return verify(null, Buffer.from(canonicalize(manifest)), publicKey, Buffer.from(signature, 'base64')) } catch { return false } }
