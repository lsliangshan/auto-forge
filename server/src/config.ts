import { z } from 'zod'

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  JWT_SECRET: z.string().min(32),
  S3_ENDPOINT: z.string().url(),
  S3_REGION: z.string().default('us-east-1'),
  S3_BUCKET: z.string().min(3),
  S3_ACCESS_KEY: z.string().min(1),
  S3_SECRET_KEY: z.string().min(1),
  RELEASE_KEY_ID: z.string().min(1),
  RELEASE_PRIVATE_KEY: z.string().min(1),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().positive().default(4310),
  LOG_LEVEL: z.string().default('info')
})

export type ServerConfig = z.infer<typeof schema>
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig { return schema.parse(env) }
