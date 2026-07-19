import { PrismaClient } from '@prisma/client'
import { buildApp } from './app.js'
import { loadConfig } from './config.js'
import { S3ObjectStore } from './storage/object-store.js'

const config = loadConfig()
const prisma = new PrismaClient()
const app = await buildApp({ config, prisma, store: new S3ObjectStore(config) })

const shutdown = async () => { await app.close(); await prisma.$disconnect() }
process.on('SIGINT', () => void shutdown())
process.on('SIGTERM', () => void shutdown())
await app.listen({ host: config.HOST, port: config.PORT })
