import { describe, expect, it } from 'vitest'
import type {
  ConversationGenerationPreferences,
  GenerationOptions,
  ModelInfo,
  ModelProviderId,
  ProviderDefaultModels,
} from '@autoforge/shared'
import type { ResolvedMediaAsset } from '../media/media-asset-service.js'
import {
  mergeOpenRouterModels,
  parseOpenRouterModels,
  parseOpenRouterVideoModels,
} from './model-provider.js'
import { resolveChatRoute } from './multimodal-router.js'

const generation: GenerationOptions = {
  image: { count: 1, resolution: '1K', aspectRatio: 'auto', format: 'png' },
  audio: { format: 'mp3' },
  video: { durationSeconds: 5, resolution: '720p', aspectRatio: 'auto', generateAudio: false },
}

function model(overrides: Partial<ModelInfo> & Pick<ModelInfo, 'id'>): ModelInfo {
  return {
    id: overrides.id,
    name: overrides.name ?? overrides.id,
    ...(overrides.contextLength === undefined ? {} : { contextLength: overrides.contextLength }),
    inputModalities: overrides.inputModalities ?? ['text'],
    outputModalities: overrides.outputModalities ?? ['text'],
    supportsTools: overrides.supportsTools ?? false,
    generation: overrides.generation ?? {},
  }
}

function asset(kind: ResolvedMediaAsset['kind'], overrides: Partial<ResolvedMediaAsset> = {}): ResolvedMediaAsset {
  return {
    id: overrides.id ?? `asset_${kind}`,
    kind,
    mimeType: overrides.mimeType ?? `${kind}/example`,
    name: overrides.name ?? `${kind}.example`,
    byteSize: overrides.byteSize ?? 1024,
    conversationId: overrides.conversationId ?? 'conversation_1',
    absolutePath: overrides.absolutePath ?? `/tmp/${kind}.example`,
    relativePath: overrides.relativePath ?? `${kind}.example`,
    inlineSafe: overrides.inlineSafe ?? true,
  }
}

function input(overrides: Partial<Parameters<typeof resolveChatRoute>[0]> = {}) {
  const models = overrides.models ?? [model({ id: 'text/model', supportsTools: true })]
  return {
    provider: 'openrouter' as ModelProviderId,
    requestedOutput: 'auto' as const,
    requestedGeneration: generation,
    defaults: {
      deepseek: { text: 'deepseek-chat' },
      openrouter: { text: 'text/model' },
    } satisfies ProviderDefaultModels,
    conversationPreferences: {
      outputType: 'auto',
      models: {},
      generation,
    } satisfies ConversationGenerationPreferences,
    models,
    assets: [],
    ...overrides,
  }
}

describe('resolveChatRoute', () => {
  it.each([
    ['deepseek', [asset('image')], 'text', 'MODEL_MODALITY_UNSUPPORTED'],
    ['openrouter', [], 'image', 'image'],
    ['openrouter', [asset('image')], 'video', 'video'],
    ['openrouter', [asset('audio')], 'image', 'MODEL_MODALITY_UNSUPPORTED'],
  ] as const)('routes %s with attachments to %s', (provider, assets, requestedOutput, expected) => {
    const models = provider === 'deepseek'
      ? [model({ id: 'deepseek-chat', supportsTools: true })]
      : [
          model({
            id: 'text/model',
            inputModalities: ['text', 'image', 'audio'],
            outputModalities: ['text'],
            supportsTools: true,
          }),
          model({
            id: 'image/model',
            inputModalities: ['text', 'image'],
            outputModalities: ['image'],
            generation: { image: { resolutions: ['1K'], aspectRatios: ['auto'], formats: ['png'], maxCount: 1 } },
          }),
          model({
            id: 'video/model',
            inputModalities: ['text', 'image'],
            outputModalities: ['video'],
            generation: { video: { resolutions: ['720p'], aspectRatios: ['auto'], durations: [5], supportsAudio: false, frameImages: ['first_frame'] } },
          }),
        ]
    const defaults: ProviderDefaultModels = {
      deepseek: { text: 'deepseek-chat' },
      openrouter: { text: 'text/model', image: 'image/model', video: 'video/model' },
    }
    const resolve = () => resolveChatRoute(input({ provider, assets: [...assets], requestedOutput, models, defaults }))

    if (expected === 'MODEL_MODALITY_UNSUPPORTED') {
      expect(resolve).toThrow(expect.objectContaining({ code: expected }))
      return
    }
    expect(resolve()).toMatchObject({ provider, model: `${expected}/model`, outputType: expected })
  })

  it('automatically resolves a single-output selected model', () => {
    expect(resolveChatRoute(input({
      requestedModel: 'image/model',
      models: [model({
        id: 'image/model',
        outputModalities: ['image'],
        generation: { image: { resolutions: ['1K'], aspectRatios: ['auto'], formats: ['png'], maxCount: 1 } },
      })],
    }))).toMatchObject({ model: 'image/model', outputType: 'image', supportsTools: false })
  })

  it('carries the selected model context limit into the resolved route', () => {
    const resolved = resolveChatRoute(input({
      models: [model({ id: 'bounded/model', contextLength: 131_072 })],
      requestedModel: 'bounded/model',
      requestedOutput: 'text',
    }))

    expect(resolved).toMatchObject({
      model: 'bounded/model',
      contextLength: 131_072,
    })
  })

  it('marks only advertised image request parameters as supported', () => {
    const route = resolveChatRoute(input({
      requestedModel: 'black-forest-labs/flux.2-flex',
      requestedOutput: 'image',
      models: [model({
        id: 'black-forest-labs/flux.2-flex',
        inputModalities: ['text', 'image'],
        outputModalities: ['image'],
        generation: {
          image: {
            resolutions: [],
            aspectRatios: ['16:9'],
            formats: ['png', 'jpeg'],
            maxCount: 1,
          },
        },
      })],
    }))

    expect(route).toMatchObject({
      outputType: 'image',
      imageParameterSupport: {
        resolution: false,
        aspectRatio: true,
        outputFormat: true,
      },
    })
  })

  it('requires an output choice for a first-use multi-output selected model', () => {
    expect(resolveChatRoute(input({
      requestedModel: 'multi/model',
      models: [model({
        id: 'multi/model',
        outputModalities: ['video', 'text', 'image'],
        generation: {
          image: { resolutions: ['1K'], aspectRatios: ['auto'], formats: ['png'], maxCount: 1 },
          video: { resolutions: ['720p'], aspectRatios: ['auto'], durations: [5], supportsAudio: false, frameImages: [] },
        },
      })],
    }))).toEqual({ selectionRequired: true, compatibleOutputs: ['text', 'image', 'video'] })
  })

  it('uses the remembered output with the compatible remembered model before the provider default', () => {
    const route = resolveChatRoute(input({
      models: [
        model({ id: 'default/image', outputModalities: ['image'], generation: { image: { resolutions: ['1K'], aspectRatios: ['auto'], formats: ['png'], maxCount: 1 } } }),
        model({ id: 'conversation/image', outputModalities: ['image'], generation: { image: { resolutions: ['2K'], aspectRatios: ['1:1'], formats: ['jpeg'], maxCount: 1 } } }),
      ],
      defaults: { deepseek: { text: 'deepseek-chat' }, openrouter: { image: 'default/image' } },
      conversationPreferences: { outputType: 'image', models: { image: 'conversation/image' }, generation },
      requestedGeneration: { ...generation, image: { count: 1, resolution: '2K', aspectRatio: '1:1', format: 'jpeg' } },
    }))

    expect(route).toMatchObject({ model: 'conversation/image', outputType: 'image' })
  })

  it('returns only deterministic compatible models when no explicit-output preference is usable', () => {
    expect(resolveChatRoute(input({
      requestedOutput: 'image',
      models: [
        model({ id: 'z/video', outputModalities: ['video'] }),
        model({ id: 'z/image', outputModalities: ['image'], generation: { image: { resolutions: ['1K'], aspectRatios: ['auto'], formats: ['png'], maxCount: 1 } } }),
        model({ id: 'a/image', outputModalities: ['image'], generation: { image: { resolutions: ['1K'], aspectRatios: ['auto'], formats: ['png'], maxCount: 1 } } }),
      ],
      defaults: { deepseek: { text: 'deepseek-chat' }, openrouter: {} },
    }))).toEqual({
      modelRequired: true,
      outputType: 'image',
      compatibleModels: [
        expect.objectContaining({ id: 'a/image' }),
        expect.objectContaining({ id: 'z/image' }),
      ],
    })
  })

  it('uses an exact requested model only when it supports the requested output', () => {
    expect(() => resolveChatRoute(input({
      requestedModel: 'text/model',
      requestedOutput: 'image',
    }))).toThrow(expect.objectContaining({ code: 'MODEL_MODALITY_UNSUPPORTED' }))
  })

  it('rejects a model that is absent from the active provider catalog', () => {
    expect(() => resolveChatRoute(input({ requestedModel: 'missing/model' }))).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }))
  })

  it('rejects catalog capabilities that conflict with DeepSeek text-only routing', () => {
    expect(() => resolveChatRoute(input({
      provider: 'deepseek',
      requestedModel: 'deepseek-image',
      models: [model({ id: 'deepseek-image', outputModalities: ['image'] })],
      defaults: { deepseek: { text: 'deepseek-image' }, openrouter: {} },
    }))).toThrow(expect.objectContaining({ code: 'MODEL_MODALITY_UNSUPPORTED' }))
  })

  it('accepts all and only the exact advertised media inputs for text understanding', () => {
    const textModel = model({ id: 'understand/model', inputModalities: ['text', 'audio', 'video'], outputModalities: ['text'] })
    expect(resolveChatRoute(input({ requestedModel: textModel.id, models: [textModel], assets: [asset('audio'), asset('video')] }))).toMatchObject({ outputType: 'text' })
    expect(() => resolveChatRoute(input({ requestedModel: textModel.id, models: [textModel], assets: [asset('image')] }))).toThrow(expect.objectContaining({ code: 'MODEL_MODALITY_UNSUPPORTED' }))
  })

  it('allows audio output to use every input modality advertised by its exact model', () => {
    const audioModel = model({
      id: 'audio/model',
      inputModalities: ['text', 'image', 'audio', 'video'],
      outputModalities: ['audio'],
      generation: { audio: { voices: ['alloy'], formats: ['wav'] } },
    })
    expect(resolveChatRoute(input({
      requestedModel: audioModel.id,
      requestedOutput: 'audio',
      models: [audioModel],
      assets: [asset('image'), asset('audio'), asset('video')],
      requestedGeneration: { ...generation, audio: { voice: 'alloy', format: 'wav' } },
    }))).toMatchObject({ outputType: 'audio', supportsTools: false })
  })

  it('enables tools only for text-compatible text routes', () => {
    const modelWithTools = model({ id: 'tool/model', supportsTools: true, outputModalities: ['text', 'audio'], generation: { audio: { voices: [], formats: ['mp3'] } } })
    expect(resolveChatRoute(input({ requestedModel: modelWithTools.id, requestedOutput: 'text', models: [modelWithTools] }))).toMatchObject({ supportsTools: true })
    expect(resolveChatRoute(input({ requestedModel: modelWithTools.id, requestedOutput: 'audio', models: [modelWithTools] }))).toMatchObject({ supportsTools: false })
  })

  it('reports image-input support from the exact selected text model', () => {
    const vision = model({
      id: 'openrouter/vision', inputModalities: ['text', 'image'],
      outputModalities: ['text'], supportsTools: true,
    })
    const textOnly = model({
      id: 'openrouter/text', inputModalities: ['text'],
      outputModalities: ['text'], supportsTools: true,
    })

    expect(resolveChatRoute(input({ requestedModel: vision.id, models: [vision] })))
      .toMatchObject({ supportsImageInput: true })
    expect(resolveChatRoute(input({ requestedModel: textOnly.id, models: [textOnly] })))
      .toMatchObject({ supportsImageInput: false })
  })

  it('validates count, total bytes, duplicate IDs, and resolved asset shape before route selection', () => {
    const many = Array.from({ length: 6 }, (_, index) => asset('image', { id: `asset_${index}` }))
    expect(() => resolveChatRoute(input({ assets: many }))).toThrow(expect.objectContaining({ code: 'MEDIA_ATTACHMENT_LIMIT_EXCEEDED' }))
    expect(() => resolveChatRoute(input({ assets: [asset('image', { byteSize: 250 * 1024 * 1024 + 1 })] }))).toThrow(expect.objectContaining({ code: 'MEDIA_SIZE_LIMIT_EXCEEDED' }))
    expect(() => resolveChatRoute(input({ assets: [asset('image'), asset('image')] }))).toThrow(expect.objectContaining({ code: 'CONFLICT' }))
  })

  it('normalizes only against advertised generation values and leaves caller inputs unchanged', () => {
    const imageModel = model({
      id: 'image/model',
      inputModalities: ['text', 'image'],
      outputModalities: ['image'],
      generation: { image: { resolutions: ['2K'], aspectRatios: ['1:1'], formats: ['jpeg'], maxCount: 1 } },
    })
    const requestedGeneration: GenerationOptions = structuredClone(generation)
    const assets = [asset('image')]
    const route = resolveChatRoute(input({
      requestedModel: imageModel.id,
      requestedOutput: 'image',
      models: [imageModel],
      assets,
      requestedGeneration,
    }))

    expect(route).toMatchObject({ generation: { image: { count: 1, resolution: '2K', aspectRatio: '1:1', format: 'jpeg' } } })
    expect(requestedGeneration).toEqual(generation)
    expect(assets).toEqual([asset('image')])
    if (!('assets' in route)) throw new Error('expected a resolved route')
    expect(route.assets).not.toBe(assets)
  })

  it('carries exact video frame capabilities and rejects excess frame images', () => {
    const bothFrames = model({
      id: 'video/both-frames',
      inputModalities: ['text', 'image'],
      outputModalities: ['video'],
      generation: {
        video: {
          resolutions: ['1080p'],
          aspectRatios: ['16:9'],
          durations: [8],
          supportsAudio: false,
          frameImages: ['first_frame', 'last_frame'],
        },
      },
    })
    const frames = [asset('image', { id: 'first' }), asset('image', { id: 'last' })]

    expect(resolveChatRoute(input({
      requestedModel: bothFrames.id,
      requestedOutput: 'video',
      models: [bothFrames],
      assets: frames,
    }))).toMatchObject({ videoFrameImages: ['first_frame', 'last_frame'] })

    const firstFrameOnly = model({
      ...bothFrames,
      id: 'video/first-frame-only',
      generation: { video: { ...bothFrames.generation.video!, frameImages: ['first_frame'] } },
    })
    expect(() => resolveChatRoute(input({
      requestedModel: firstFrameOnly.id,
      requestedOutput: 'video',
      models: [firstFrameOnly],
      assets: frames,
    }))).toThrow(expect.objectContaining({ code: 'MODEL_MODALITY_UNSUPPORTED' }))
  })

  it('routes one reference image for Sora and rejects excess references', () => {
    const sora = model({
      id: 'openai/sora-2-pro',
      inputModalities: ['text', 'image'],
      outputModalities: ['video'],
      generation: {
        video: {
          resolutions: ['1080p'],
          aspectRatios: ['16:9'],
          durations: [8],
          supportsAudio: true,
          frameImages: [],
          maxReferenceImages: 1,
        },
      },
    })

    expect(resolveChatRoute(input({
      requestedModel: sora.id,
      requestedOutput: 'video',
      models: [sora],
      assets: [asset('image')],
    }))).toMatchObject({
      model: 'openai/sora-2-pro',
      videoFrameImages: [],
      videoUsesInputReferences: true,
    })

    expect(() => resolveChatRoute(input({
      requestedModel: sora.id,
      requestedOutput: 'video',
      models: [sora],
      assets: [asset('image', { id: 'first' }), asset('image', { id: 'second' })],
    }))).toThrow(expect.objectContaining({ code: 'MODEL_MODALITY_UNSUPPORTED' }))
  })

  it('fails locally when selected-output capability metadata cannot support a generation option', () => {
    expect(() => resolveChatRoute(input({
      requestedModel: 'image/model',
      requestedOutput: 'image',
      models: [model({ id: 'image/model', outputModalities: ['image'] })],
    }))).toThrow(expect.objectContaining({ code: 'MODEL_MODALITY_UNSUPPORTED' }))
  })

  it('omits outputs and models that cannot execute their advertised generation mode', () => {
    const brokenImage = model({ id: 'broken/image', outputModalities: ['image'] })
    const image = model({
      id: 'usable/image',
      outputModalities: ['image'],
      generation: { image: { resolutions: ['1K'], aspectRatios: ['auto'], formats: ['png'], maxCount: 1 } },
    })
    expect(resolveChatRoute(input({
      requestedOutput: 'image',
      defaults: { deepseek: { text: 'deepseek-chat' }, openrouter: {} },
      models: [brokenImage, image],
    }))).toEqual({
      modelRequired: true,
      outputType: 'image',
      compatibleModels: [expect.objectContaining({ id: 'usable/image' })],
    })

    expect(resolveChatRoute(input({
      requestedModel: 'mixed/model',
      models: [model({ id: 'mixed/model', outputModalities: ['text', 'image'] })],
    }))).toMatchObject({ outputType: 'text' })
  })

  it('routes parser-produced audio and video capabilities with unpublished option limits', () => {
    const models = mergeOpenRouterModels(parseOpenRouterModels({ data: [
      { id: 'audio/model', name: 'Audio', architecture: { input_modalities: ['text'], output_modalities: ['audio'] } },
      { id: 'video/model', name: 'Video', architecture: { input_modalities: ['text'], output_modalities: ['video'] } },
    ] }), [[], parseOpenRouterVideoModels({ data: [{ id: 'video/model', name: 'Video' }] })])
    const audio = models.find((candidate) => candidate.id === 'audio/model')!
    const video = models.find((candidate) => candidate.id === 'video/model')!

    expect(audio.generation.audio).toEqual({ voices: [], formats: [] })
    expect(video.generation.video).toEqual({ resolutions: [], aspectRatios: [], durations: [], supportsAudio: false, frameImages: [] })
    expect(resolveChatRoute(input({ requestedModel: audio.id, requestedOutput: 'audio', models }))).toMatchObject({
      outputType: 'audio',
      generation: { audio: { format: 'mp3' } },
    })
    expect(resolveChatRoute(input({ requestedModel: video.id, requestedOutput: 'video', models }))).toMatchObject({
      outputType: 'video',
      generation: { video: { durationSeconds: 5, resolution: '720p', aspectRatio: 'auto', generateAudio: false } },
    })
  })

  it('orders compatible model selections with fixed code-point comparison', () => {
    const imageGeneration = { image: { resolutions: ['1K'], aspectRatios: ['auto'], formats: ['png'], maxCount: 1 } }
    expect(resolveChatRoute(input({
      requestedOutput: 'image',
      defaults: { deepseek: { text: 'deepseek-chat' }, openrouter: {} },
      models: [
        model({ id: 'a/image', outputModalities: ['image'], generation: imageGeneration }),
        model({ id: 'Z/image', outputModalities: ['image'], generation: imageGeneration }),
      ],
    }))).toMatchObject({
      compatibleModels: [
        expect.objectContaining({ id: 'Z/image' }),
        expect.objectContaining({ id: 'a/image' }),
      ],
    })
  })
})
