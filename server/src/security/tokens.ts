import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type { PrismaClient, User } from '@prisma/client'

const refreshLifetime = 30 * 24 * 60 * 60 * 1000
export const tokenHash = (value: string) => createHash('sha256').update(value).digest('hex')

export async function issueSession(app: FastifyInstance, prisma: PrismaClient, user: Pick<User, 'id' | 'email' | 'displayName' | 'role'>, familyId: string = randomUUID()) {
  const refreshToken = randomBytes(48).toString('base64url')
  const expiresAt = new Date(Date.now() + refreshLifetime)
  await prisma.refreshToken.create({ data: { userId: user.id, tokenHash: tokenHash(refreshToken), familyId, expiresAt } })
  return {
    accessToken: app.jwt.sign({ sub: user.id, email: user.email, name: user.displayName, role: user.role }, { expiresIn: '15m' }),
    refreshToken,
    expiresIn: 900,
    user: { id: user.id, email: user.email, displayName: user.displayName, role: user.role }
  }
}
