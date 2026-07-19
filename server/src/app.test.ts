import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from './app.js'

let app: FastifyInstance | undefined
afterEach(async () => app?.close())

function fakePrisma() {
  const users: any[] = []; const tokens: any[] = []
  return {
    user: {
      create: async ({ data }: any) => { const user = { id: randomUUID(), role: 'USER', ...data }; users.push(user); return user },
      findUnique: async ({ where, select }: any) => { const user = users.find((item) => item.email === where.email || item.id === where.id); if (!user || !select) return user; return Object.fromEntries(Object.keys(select).map((key) => [key, user[key]])) }
    },
    refreshToken: {
      create: async ({ data }: any) => { const token = { id: randomUUID(), revokedAt: null, ...data }; tokens.push(token); return token },
      findUnique: async ({ where }: any) => { const token = tokens.find((item) => item.tokenHash === where.tokenHash); return token ? { ...token, user: users.find((item) => item.id === token.userId) } : null },
      update: async ({ where, data }: any) => Object.assign(tokens.find((item) => item.id === where.id), data),
      updateMany: async ({ where, data }: any) => { const found = tokens.filter((item) => item.tokenHash === where.tokenHash && item.revokedAt === null); found.forEach((item) => Object.assign(item, data)); return { count: found.length } }
    }
  } as never
}

describe('auth API', () => {
  it('registers, logs in, rotates refresh tokens and rejects reuse', async () => {
    const privateKey = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
    app = await buildApp({
      config: { DATABASE_URL: 'postgresql://test', JWT_SECRET: 'x'.repeat(32), S3_ENDPOINT: 'http://127.0.0.1:9000', S3_REGION: 'test', S3_BUCKET: 'test-bucket', S3_ACCESS_KEY: 'test', S3_SECRET_KEY: 'test', RELEASE_KEY_ID: 'test', RELEASE_PRIVATE_KEY: privateKey, HOST: '127.0.0.1', PORT: 4310, LOG_LEVEL: 'silent' },
      prisma: fakePrisma(), store: { put: async () => {}, get: async () => Buffer.alloc(0), delete: async () => {}, ticket: async () => '', ready: async () => {} }
    })
    const registration = await app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: { email: 'dev@example.com', displayName: 'Developer', password: 'correct horse battery' } })
    expect(registration.statusCode).toBe(201); const first = registration.json()
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: 'dev@example.com', password: 'correct horse battery' } })
    expect(login.statusCode).toBe(200)
    const rotated = await app.inject({ method: 'POST', url: '/api/v1/auth/refresh', payload: { refreshToken: first.refreshToken } })
    expect(rotated.statusCode).toBe(200); expect(rotated.json().refreshToken).not.toBe(first.refreshToken)
    const reused = await app.inject({ method: 'POST', url: '/api/v1/auth/refresh', payload: { refreshToken: first.refreshToken } })
    expect(reused.statusCode).toBe(401)
  })
})
