import { DeleteObjectCommand, GetObjectCommand, HeadBucketCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import type { ServerConfig } from '../config.js'

export interface ObjectStore {
  put(key: string, body: Uint8Array, contentType: string): Promise<void>
  get(key: string): Promise<Buffer>
  delete(key: string): Promise<void>
  ticket(key: string, expiresIn: number): Promise<string>
  ready(): Promise<void>
}

export class S3ObjectStore implements ObjectStore {
  private readonly client: S3Client
  constructor(private readonly config: ServerConfig) {
    this.client = new S3Client({
      endpoint: config.S3_ENDPOINT, region: config.S3_REGION, forcePathStyle: true,
      credentials: { accessKeyId: config.S3_ACCESS_KEY, secretAccessKey: config.S3_SECRET_KEY }
    })
  }
  async put(Key: string, Body: Uint8Array, ContentType: string) { await this.client.send(new PutObjectCommand({ Bucket: this.config.S3_BUCKET, Key, Body, ContentType })) }
  async get(Key: string) {
    const response = await this.client.send(new GetObjectCommand({ Bucket: this.config.S3_BUCKET, Key }))
    if (!response.Body) throw new Error('Object body is missing')
    return Buffer.from(await response.Body.transformToByteArray())
  }
  async delete(Key: string) { await this.client.send(new DeleteObjectCommand({ Bucket: this.config.S3_BUCKET, Key })) }
  ticket(Key: string, expiresIn: number) { return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.config.S3_BUCKET, Key }), { expiresIn }) }
  async ready() { await this.client.send(new HeadBucketCommand({ Bucket: this.config.S3_BUCKET })) }
}
