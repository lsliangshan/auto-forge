import { describe, expect, it } from 'vitest'
import {
  CONVERSION_TARGET_FORMATS,
  conversionArtifactViewSchema,
  conversionJobStatusSchema,
  conversionTargetFormatSchema,
  fileConvertRequestSchema,
} from './index'

describe('file conversion contracts', () => {
  it('defines the complete approved conversion target-format catalog', () => {
    expect(CONVERSION_TARGET_FORMATS).toEqual([
      'png', 'jpeg', 'webp', 'avif', 'tiff', 'bmp', 'gif', 'ico', 'icns',
      'pdf', 'xlsx', 'mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus',
      'mp4', 'webm', 'mov',
    ])
    expect(conversionTargetFormatSchema.safeParse('docx').success).toBe(false)
    expect(conversionJobStatusSchema.options).toEqual([
      'queued', 'downloading_component', 'converting', 'verifying',
      'completed', 'failed', 'cancelled', 'interrupted',
    ])
  })

  it('accepts an exact file conversion capability request within its declared format scope', () => {
    const request = {
      capability: 'file.convert' as const,
      scope: { formats: ['png', 'webp'] },
      arguments: { attachmentIndex: 0, targetFormat: 'png', preset: 'default' as const, background: true },
    }

    expect(fileConvertRequestSchema.parse(request)).toEqual(request)
  })

  it('projects exact scale-specific ICNS representation metadata to the artifact view', () => {
    const artifact = {
      artifactId: 'artifact_ic11', status: 'ready' as const, displayName: 'representation-002.png',
      detectedFormat: 'png' as const, mimeType: 'image/png', byteSize: 100,
      metadata: {
        iconRepresentation: {
          sourceType: 'ic11' as const,
          logicalWidth: 16, logicalHeight: 16,
          pixelWidth: 32, pixelHeight: 32,
          scale: 2,
        },
      },
    }
    expect(conversionArtifactViewSchema.parse(artifact)).toEqual(artifact)
    expect(conversionArtifactViewSchema.safeParse({
      ...artifact,
      metadata: { iconRepresentation: { ...artifact.metadata.iconRepresentation, sourceType: 'icp5' } },
    }).success).toBe(false)
  })

  it('projects ordered ICO representation metadata to the artifact view', () => {
    const artifact = {
      artifactId: 'artifact_ico_4', status: 'ready' as const, displayName: 'icon-16x16@1x.png',
      detectedFormat: 'png' as const, mimeType: 'image/png', byteSize: 100,
      metadata: {
        iconRepresentation: {
          sourceType: 'ico' as const, sourceIndex: 4,
          logicalWidth: 16, logicalHeight: 16,
          pixelWidth: 16, pixelHeight: 16,
          scale: 1,
        },
      },
    }
    expect(conversionArtifactViewSchema.parse(artifact)).toEqual(artifact)
    expect(conversionArtifactViewSchema.safeParse({
      ...artifact,
      metadata: { iconRepresentation: { ...artifact.metadata.iconRepresentation, scale: 2 } },
    }).success).toBe(false)
  })

  it.each([
    { scope: { formats: [] }, arguments: { attachmentIndex: 0, targetFormat: 'png' } },
    { scope: { formats: ['png', 'png'] }, arguments: { attachmentIndex: 0, targetFormat: 'png' } },
    { scope: { formats: ['png'] }, arguments: { attachmentIndex: 0, targetFormat: 'docx' } },
    { scope: { formats: ['png'] }, arguments: { attachmentIndex: 0, targetFormat: 'webp' } },
    { scope: { formats: ['png'], origins: ['https://example.com'] }, arguments: { attachmentIndex: 0, targetFormat: 'png' } },
    { scope: { formats: ['png'], paths: ['/tmp'] }, arguments: { attachmentIndex: 0, targetFormat: 'png' } },
    { scope: { formats: ['png'] }, arguments: { attachmentIndex: -1, targetFormat: 'png' } },
    { scope: { formats: ['png'] }, arguments: { attachmentIndex: 0, targetFormat: 'png', preset: 'print' } },
    { scope: { formats: ['png'] }, arguments: { attachmentIndex: 0, targetFormat: 'png', outputPath: '/tmp/out.png' } },
  ])('rejects an unsafe or invalid file conversion request %#', (patch) => {
    expect(fileConvertRequestSchema.safeParse({ capability: 'file.convert', ...patch }).success).toBe(false)
  })
})
