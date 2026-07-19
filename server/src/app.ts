import { createPrivateKey, randomUUID } from 'node:crypto'
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify'
import cors from '@fastify/cors'
import jwt from '@fastify/jwt'
import multipart from '@fastify/multipart'
import type { PrismaClient } from '@prisma/client'
import { z } from 'zod'
import {
  parseWorkflowManifest, type ReleaseManifest, type WorkflowManifest
} from '@autoforge/workflow-contracts'
import { signReleaseManifest } from '@autoforge/workflow-contracts/node'
import type { ServerConfig } from './config.js'
import type { ObjectStore } from './storage/object-store.js'
import { hashPassword, verifyPassword } from './security/password.js'
import { issueSession, tokenHash } from './security/tokens.js'
import { buildSourceArchive, createReleaseArchive, hashBuffer } from './workflows/source-builder.js'

const credentials = z.object({ email: z.string().email().transform((v) => v.toLowerCase()), password: z.string().min(12).max(128) })
const registerBody = credentials.extend({ displayName: z.string().trim().min(2).max(80) })
const pageQuery = z.object({ page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(50).default(20), search: z.string().max(100).optional(), category: z.string().optional() })

function apiError(code: string, message: string, statusCode: number) {
  return Object.assign(new Error(message), { code, statusCode })
}

function requireAuth(request: FastifyRequest) { return request.jwtVerify() }
async function requireAdmin(request: FastifyRequest) { await request.jwtVerify(); if (request.user.role !== 'ADMIN') throw apiError('FORBIDDEN', 'Administrator role required', 403) }
function audit(prisma: PrismaClient, request: FastifyRequest, action: string, resourceType: string, resourceId: string, metadata?: object) {
  return prisma.auditLog.create({ data: { actorId: request.user?.sub, action, resourceType, resourceId, requestId: request.id, metadata: metadata as never } })
}

export interface AppDependencies { config: ServerConfig; prisma: PrismaClient; store: ObjectStore }

export async function buildApp({ config, prisma, store }: AppDependencies) {
  const app = Fastify({ logger: { level: config.LOG_LEVEL }, requestIdHeader: 'x-request-id' })
  await app.register(cors, { origin: false })
  await app.register(jwt, { secret: config.JWT_SECRET })
  await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 5 } })

  app.setErrorHandler((error, request, reply) => {
    const typed = error as Error & { code?: string; statusCode?: number }
    const status = typed.statusCode && typed.statusCode >= 400 ? typed.statusCode : 500
    if (status >= 500) request.log.error({ err: error }, 'request failed')
    return reply.status(status).send({ error: { code: status === 500 ? 'INTERNAL_ERROR' : typed.code ?? 'INVALID_INPUT', message: status === 500 ? 'Internal server error' : typed.message, requestId: request.id } })
  })

  app.get('/health/live', async () => ({ status: 'ok' }))
  app.get('/health/ready', async (_request, reply) => {
    try { await prisma.$queryRaw`SELECT 1`; await store.ready(); return { status: 'ready' } }
    catch { return reply.status(503).send({ status: 'not-ready' }) }
  })

  app.post('/api/v1/auth/register', async (request, reply) => {
    const body = registerBody.parse(request.body)
    const user = await prisma.user.create({ data: { email: body.email, displayName: body.displayName, passwordHash: await hashPassword(body.password) } })
    return reply.status(201).send(await issueSession(app, prisma, user))
  })
  app.post('/api/v1/auth/login', async (request) => {
    const body = credentials.parse(request.body)
    const user = await prisma.user.findUnique({ where: { email: body.email } })
    if (!user || !(await verifyPassword(body.password, user.passwordHash))) throw apiError('AUTH_REQUIRED', 'Invalid email or password', 401)
    return issueSession(app, prisma, user)
  })
  app.post('/api/v1/auth/refresh', async (request) => {
    const { refreshToken } = z.object({ refreshToken: z.string().min(20) }).parse(request.body)
    const stored = await prisma.refreshToken.findUnique({ where: { tokenHash: tokenHash(refreshToken) }, include: { user: true } })
    if (!stored || stored.revokedAt || stored.expiresAt <= new Date()) throw apiError('AUTH_REQUIRED', 'Refresh token is invalid', 401)
    const next = await issueSession(app, prisma, stored.user, stored.familyId)
    await prisma.refreshToken.update({ where: { id: stored.id }, data: { revokedAt: new Date(), replacedBy: tokenHash(next.refreshToken) } })
    return next
  })
  app.post('/api/v1/auth/logout', async (request, reply) => {
    const { refreshToken } = z.object({ refreshToken: z.string() }).parse(request.body)
    await prisma.refreshToken.updateMany({ where: { tokenHash: tokenHash(refreshToken), revokedAt: null }, data: { revokedAt: new Date() } })
    return reply.status(204).send()
  })
  app.get('/api/v1/auth/me', { preHandler: requireAuth }, async (request) => prisma.user.findUnique({ where: { id: request.user.sub }, select: { id: true, email: true, displayName: true, role: true } }))

  app.get('/api/v1/categories', async () => prisma.category.findMany({ where: { active: true }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] }))
  app.get('/api/v1/workflows', async (request) => {
    const query = pageQuery.parse(request.query); const skip = (query.page - 1) * query.pageSize
    const where = { releases: { some: {} }, ...(query.category ? { category: { slug: query.category } } : {}), ...(query.search ? { OR: [
      { name: { contains: query.search, mode: 'insensitive' as const } }, { description: { contains: query.search, mode: 'insensitive' as const } },
      { slug: { contains: query.search, mode: 'insensitive' as const } }, { author: { displayName: { contains: query.search, mode: 'insensitive' as const } } }
    ] } : {}) }
    const [items, total] = await prisma.$transaction([
      prisma.workflow.findMany({ where, include: { author: true, category: true, releases: { orderBy: { publishedAt: 'desc' }, take: 1 } }, skip, take: query.pageSize, orderBy: { updatedAt: 'desc' } }),
      prisma.workflow.count({ where })
    ])
    return { items: items.map((item) => ({ ...item, authorName: item.author.displayName, ...item.releases[0] })), page: query.page, pageSize: query.pageSize, total }
  })
  app.get('/api/v1/workflows/:id', async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params)
    const workflow = await prisma.workflow.findFirst({ where: { id, releases: { some: {} } }, include: { author: true, category: true, releases: { orderBy: { publishedAt: 'desc' } } } })
    if (!workflow) throw apiError('NOT_FOUND', 'Workflow not found', 404)
    return workflow
  })
  app.post('/api/v1/workflows/:id/releases/:version/download-ticket', { preHandler: requireAuth }, async (request) => {
    const { id, version } = z.object({ id: z.string(), version: z.string() }).parse(request.params)
    const release = await prisma.release.findUnique({ where: { workflowId_version: { workflowId: id, version } } })
    if (!release) throw apiError('NOT_FOUND', 'Release not found', 404)
    await prisma.release.update({ where: { id: release.id }, data: { downloadCount: { increment: 1 } } })
    return { keyId: release.keyId, manifest: release.manifest, signature: release.signature, downloadUrl: await store.ticket(release.packageObjectKey, 300), expiresAt: new Date(Date.now() + 300_000).toISOString() }
  })

  app.post('/api/v1/developer/workflows', { preHandler: requireAuth }, async (request, reply) => {
    const manifest = parseWorkflowManifest(request.body)
    const existing = await prisma.workflow.findUnique({ where: { slug: manifest.slug } })
    if (existing) {
      if (existing.authorId !== request.user.sub) throw apiError('CONFLICT', 'Workflow slug is already registered', 409)
      return existing
    }
    const category = await prisma.category.findUnique({ where: { slug: manifest.categorySlug } })
    if (!category?.active) throw apiError('INVALID_INPUT', 'Category is not active', 400)
    const workflow = await prisma.workflow.create({ data: { slug: manifest.slug, name: manifest.name, description: manifest.description, authorId: request.user.sub, categoryId: category.id } })
    await audit(prisma, request, 'workflow.create', 'workflow', workflow.id)
    return reply.status(201).send(workflow)
  })
  app.post('/api/v1/developer/workflows/:id/submissions', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params)
    const workflow = await prisma.workflow.findFirst({ where: { id, authorId: request.user.sub } })
    if (!workflow) throw apiError('NOT_FOUND', 'Workflow not found', 404)
    const part = await request.file(); if (!part) throw apiError('INVALID_SOURCE', 'Source ZIP is required', 400)
    const archive = Buffer.from(await part.toBuffer()); const built = await buildSourceArchive(archive)
    if (built.manifest.slug !== workflow.slug) throw apiError('INVALID_MANIFEST', 'Manifest slug does not match workflow', 400)
    const category = await prisma.category.findUnique({ where: { slug: built.manifest.categorySlug } })
    if (!category?.active) throw apiError('INVALID_INPUT', 'Category is not active', 400)
    const released = await prisma.release.findUnique({ where: { workflowId_version: { workflowId: id, version: built.manifest.version } } })
    if (released) throw apiError('CONFLICT', 'This version is already released', 409)
    const latest = await prisma.submission.findFirst({ where: { workflowId: id, version: built.manifest.version }, orderBy: { revision: 'desc' } })
    if (latest?.status === 'PENDING') throw apiError('CONFLICT', 'This version already has a pending submission', 409)
    const revision = (latest?.revision ?? 0) + 1; const submissionId = randomUUID(); const sourceObjectKey = `submissions/${id}/${built.manifest.version}/${submissionId}.zip`
    await store.put(sourceObjectKey, archive, 'application/zip')
    try {
      const clientHash = typeof request.headers['x-code-sha256'] === 'string' ? request.headers['x-code-sha256'] : undefined
      const submission = await prisma.submission.create({ data: { id: submissionId, workflowId: id, authorId: request.user.sub, categoryId: category.id, version: built.manifest.version, revision, manifest: built.manifest as never, sourceObjectKey, sourceSha256: hashBuffer(archive), clientCodeSha256: clientHash, serverCodeSha256: built.codeSha256 } })
      await audit(prisma, request, 'submission.create', 'submission', submission.id, { revision })
      return reply.status(201).send(submission)
    } catch (error) { await store.delete(sourceObjectKey); throw error }
  })
  app.get('/api/v1/developer/submissions', { preHandler: requireAuth }, async (request) => prisma.submission.findMany({ where: { authorId: request.user.sub }, include: { workflow: true }, orderBy: { createdAt: 'desc' } }))
  app.delete('/api/v1/developer/submissions/:id', { preHandler: requireAuth }, async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params)
    const updated = await prisma.submission.updateMany({ where: { id, authorId: request.user.sub, status: 'PENDING' }, data: { status: 'CANCELLED' } })
    if (!updated.count) throw apiError('CONFLICT', 'Only a pending submission can be cancelled', 409)
    await audit(prisma, request, 'submission.cancel', 'submission', id); return { id, status: 'CANCELLED' }
  })

  app.get('/api/v1/admin/submissions', { preHandler: requireAdmin }, async () => prisma.submission.findMany({ where: { status: 'PENDING' }, include: { workflow: true, author: { select: { displayName: true, email: true } } }, orderBy: { createdAt: 'asc' } }))
  app.get('/api/v1/admin/submissions/:id', { preHandler: requireAdmin }, async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params)
    const submission = await prisma.submission.findUnique({ where: { id }, include: { workflow: true, author: { select: { displayName: true, email: true } } } })
    if (!submission) throw apiError('NOT_FOUND', 'Submission not found', 404)
    const built = await buildSourceArchive(await store.get(submission.sourceObjectKey)); const history = await prisma.submission.findMany({ where: { workflowId: submission.workflowId, version: submission.version }, select: { id: true, revision: true, status: true, reviewComment: true, reviewedAt: true, createdAt: true }, orderBy: { revision: 'desc' } }); return { ...submission, source: built.source, history }
  })
  app.post('/api/v1/admin/submissions/:id/trial-ticket', { preHandler: requireAdmin }, async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params); const submission = await prisma.submission.findUnique({ where: { id } })
    if (!submission) throw apiError('NOT_FOUND', 'Submission not found', 404)
    return { downloadUrl: await store.ticket(submission.sourceObjectKey, 300), expiresAt: new Date(Date.now() + 300_000).toISOString() }
  })
  app.post('/api/v1/admin/submissions/:id/reject', { preHandler: requireAdmin }, async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params); const { comment } = z.object({ comment: z.string().trim().min(2).max(2000) }).parse(request.body)
    const updated = await prisma.submission.updateMany({ where: { id, status: 'PENDING' }, data: { status: 'REJECTED', reviewComment: comment, reviewerId: request.user.sub, reviewedAt: new Date() } })
    if (!updated.count) throw apiError('CONFLICT', 'Submission is no longer pending', 409)
    await audit(prisma, request, 'submission.reject', 'submission', id, { comment }); return { id, status: 'REJECTED' }
  })
  app.post('/api/v1/admin/submissions/:id/approve', { preHandler: requireAdmin }, async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params)
    const submission = await prisma.submission.findUnique({ where: { id }, include: { workflow: true } })
    if (!submission || submission.status !== 'PENDING') throw apiError('CONFLICT', 'Submission is no longer pending', 409)
    const built = await buildSourceArchive(await store.get(submission.sourceObjectKey)); const packageBody = createReleaseArchive(built.manifest, built.code); const packageSha256 = hashBuffer(packageBody)
    const publishedAt = new Date(); const releaseManifest: ReleaseManifest = { schemaVersion: 1, workflowId: submission.workflowId, slug: submission.workflow.slug, version: submission.version, entry: 'dist/index.mjs', codeSha256: built.codeSha256, packageSha256, permissions: built.manifest.permissions, targetHosts: built.manifest.targetHosts, publishedAt: publishedAt.toISOString() }
    const signature = signReleaseManifest(releaseManifest, createPrivateKey(config.RELEASE_PRIVATE_KEY.replace(/\\n/g, '\n'))); const key = `releases/${submission.workflowId}/${submission.version}/${submission.id}-${packageSha256}.zip`
    await store.put(key, packageBody, 'application/zip')
    try {
      const release = await prisma.$transaction(async (tx) => {
        const changed = await tx.submission.updateMany({ where: { id, status: 'PENDING' }, data: { status: 'APPROVED', reviewerId: request.user.sub, reviewedAt: publishedAt } })
        if (!changed.count) throw apiError('CONFLICT', 'Submission is no longer pending', 409)
        await tx.workflow.update({ where: { id: submission.workflowId }, data: { name: built.manifest.name, description: built.manifest.description, categoryId: submission.categoryId } })
        return tx.release.create({ data: { workflowId: submission.workflowId, submissionId: id, version: submission.version, manifest: releaseManifest as never, keyId: config.RELEASE_KEY_ID, signature, codeSha256: built.codeSha256, packageSha256, packageObjectKey: key, publishedAt } })
      })
      await audit(prisma, request, 'submission.approve', 'submission', id, { releaseId: release.id }); return release
    } catch (error) { await store.delete(key); throw error }
  })

  app.post('/api/v1/admin/categories', { preHandler: requireAdmin }, async (request, reply) => {
    const body = z.object({ slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/), name: z.string().min(1).max(80), sortOrder: z.number().int().default(0) }).parse(request.body)
    const category = await prisma.category.create({ data: body }); await audit(prisma, request, 'category.create', 'category', category.id); return reply.status(201).send(category)
  })
  app.get('/api/v1/admin/categories', { preHandler: requireAdmin }, async () => prisma.category.findMany({ orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] }))
  app.patch('/api/v1/admin/categories/:id', { preHandler: requireAdmin }, async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params); const body = z.object({ name: z.string().min(1).max(80).optional(), sortOrder: z.number().int().optional(), active: z.boolean().optional() }).parse(request.body)
    const category = await prisma.category.update({ where: { id }, data: body }); await audit(prisma, request, 'category.update', 'category', id, body); return category
  })
  app.delete('/api/v1/admin/categories/:id', { preHandler: requireAdmin }, async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params); const count = await prisma.workflow.count({ where: { categoryId: id } })
    if (count) throw apiError('CATEGORY_IN_USE', 'Referenced category cannot be deleted', 409)
    await prisma.category.delete({ where: { id } }); await audit(prisma, request, 'category.delete', 'category', id); return reply.status(204).send()
  })

  return app
}
