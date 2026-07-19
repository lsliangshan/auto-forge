import { PrismaClient } from '@prisma/client'
import { hashPassword } from './security/password.js'

const prisma = new PrismaClient()
const categories = [
  ['data-collection', '数据采集'], ['content-publishing', '内容发布'], ['productivity', '效率工具'],
  ['developer-tools', '开发者工具'], ['business-operations', '业务运营']
] as const
for (const [index, [slug, name]] of categories.entries()) await prisma.category.upsert({ where: { slug }, create: { slug, name, sortOrder: index * 10 }, update: {} })

const email = process.env.INITIAL_ADMIN_EMAIL?.toLowerCase(); const password = process.env.INITIAL_ADMIN_PASSWORD
if (email && password) await prisma.user.upsert({ where: { email }, create: { email, displayName: process.env.INITIAL_ADMIN_NAME ?? 'AutoForge 管理员', passwordHash: await hashPassword(password), role: 'ADMIN' }, update: { role: 'ADMIN' } })
await prisma.$disconnect()
