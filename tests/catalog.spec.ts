import { describe, expect, it } from 'vitest'
import { effectiveVideoModes, parseMediaCatalog } from '../src/gateway/catalog.js'
import { CATALOG, LIVE_CATALOG, TOKEN_CATALOG } from './fixtures.js'

const models = parseMediaCatalog(CATALOG)
const byId = (id: string) => {
  const model = models.find(item => item.id === id)
  if (model === undefined) throw new Error(`missing ${id}`)
  return model
}

describe('parseMediaCatalog', () => {
  it('keeps media models with their kind and leaves chat and internal models out', () => {
    expect(models.map(model => [model.id, model.kind, model.audioKind])).toEqual([
      ['gpt-image-2.5-flare', 'image', undefined],
      ['seedance-2.0', 'video', undefined],
      ['seedance-2.5-vibedev', 'video', undefined],
      ['legacy-video', 'video', undefined],
      ['lec-ty-wan-3-0-1050-480p', 'video', undefined],
      ['future-video', 'video', undefined],
      ['doubao-music-vibedev', 'audio', 'music'],
      ['doubao-podcast-vibedev', 'audio', 'podcast'],
      ['doubao-asr-vibedev', 'transcription', undefined],
    ])
  })

  it('reads names, descriptions and selling prices', () => {
    expect(byId('gpt-image-2.5-flare')).toMatchObject({
      name: 'GPT Image 2.5 Flare', description: 'Fast photoreal images.',
      pricing: { currency: 'CNY', tiers: [{ tier: '1K', unit: 'generation', amount: 0.1 }], default: { unit: 'generation', amount: 0.1 } },
    })
    expect(byId('doubao-music-vibedev').pricing).toEqual({ currency: 'CNY', tiers: [], default: { unit: 'generation', amount: 0.5 } })
    expect(byId('doubao-podcast-vibedev').pricing).toBeUndefined()
  })

  it('reads the Seedance 2.0 video block: modes, hosted inputs and reference limits', () => {
    const video = byId('seedance-2.0').video
    expect(video?.modes?.omni_reference).toEqual({
      inputs: {
        referenceImages: { min: 0, max: 9, hosted: false },
        referenceVideos: { min: 0, max: 3, hosted: true },
        referenceAudios: { min: 0, max: 3, hosted: false },
      },
      requiredAnyOf: [['referenceImages'], ['referenceVideos']],
    })
    expect(Object.keys(video?.modes ?? {})).toEqual(['text_to_video', 'first_frame', 'first_last_frame', 'omni_reference'])
    expect(video).toMatchObject({
      resolutions: ['720p'], nativeAudio: true, maxReferenceImages: 9, maxReferenceVideos: 3, maxReferenceAudios: 3,
      allowedImageMimes: ['image/jpeg', 'image/png', 'image/webp'], allowedVideoMimes: ['video/mp4', 'video/quicktime'],
      minReferenceVideoSeconds: 2, maxReferenceVideoSeconds: 15, maxTotalReferenceVideoSeconds: 15, gatewayRelayRequired: true,
    })
    // An empty MIME list states no restriction rather than "nothing allowed".
    expect(video?.allowedAudioMimes).toBeUndefined()
    // Zero byte limits mean "no limit".
    expect(video?.maxAssetBytes).toBeUndefined()
  })

  it('derives conservative modes for a legacy entry without a modes block', () => {
    const modes = effectiveVideoModes(byId('legacy-video').video ?? {})
    expect(Object.keys(modes)).toEqual(['text_to_video', 'first_frame', 'omni_reference'])
    expect(modes.omni_reference).toEqual({
      inputs: { referenceImages: { min: 0, max: 4, hosted: false }, referenceAudios: { min: 0, max: 1, hosted: false } },
      requiredAnyOf: [['referenceImages']],
    })
    expect(byId('legacy-video').video?.combinations).toEqual([
      { duration: 6, resolution: '1080p' }, { duration: 10, resolution: '720p' }, { duration: 6, resolution: '720p' },
    ])
  })

  it('serves no mode from a modes block of an unknown version', () => {
    const video = byId('future-video').video ?? {}
    expect(video.unreadableModesVersion).toBe(2)
    expect(effectiveVideoModes(video)).toEqual({})
  })
})

describe('video Token pricing (video_pricing, schema 1)', () => {
  const token = parseMediaCatalog(TOKEN_CATALOG)
  const tokenModel = (id: string) => {
    const model = token.find(item => item.id === id)
    if (model === undefined) throw new Error(`missing ${id}`)
    return model
  }
  const one = (pricing: unknown) => parseMediaCatalog({ data: [{ id: 'v', media_type: 'video', video_pricing: pricing }] })[0]!
  const base = { schema_version: 1, currency: 'CNY', final_basis: 'provider_tokens', estimate_basis: 'output_plus_reference_video_seconds', estimate_only: true }

  it('reads the rules, keeping false conditions and leaving null or absent ones out (any)', () => {
    const model = tokenModel('video-sd-2.5(TC)')
    expect(model.videoPricingIssue).toBeUndefined()
    expect(model.pricing).toBeUndefined()
    expect(model.videoPricing).toStrictEqual({
      schemaVersion: 1, currency: 'CNY', finalBasis: 'provider_tokens', estimateBasis: 'output_plus_reference_video_seconds', estimateOnly: true,
      rules: [
        { resolution: '480p', referenceVideo: false, pricePerMillionTokensCny: 60.06, estimatedPricePerSecondCny: 0.5819 },
        { resolution: '480p', referenceVideo: true, pricePerMillionTokensCny: 36.036, estimatedPricePerSecondCny: 0.6952 },
        { resolution: '720p', referenceVideo: false, pricePerMillionTokensCny: 70, estimatedPricePerSecondCny: 1.25 },
        { resolution: '720p', referenceVideo: true, pricePerMillionTokensCny: 42, estimatedPricePerSecondCny: 1.5 },
      ],
    })
    // null on the wire is "any": no key at all, while false stays false.
    const rule = tokenModel('video-sd-2.0(TC)').videoPricing?.rules[0]
    expect(rule).toStrictEqual({ resolution: '480p', referenceVideo: false, pricePerMillionTokensCny: 40.04, estimatedPricePerSecondCny: 0.3971 })
    expect(Object.hasOwn(rule ?? {}, 'referenceAudio')).toBe(false)
    expect(Object.hasOwn(rule ?? {}, 'referenceImage')).toBe(false)
    // An absent per-second estimate stays absent (unknown), never zero.
    expect(tokenModel('video-token-no-estimate').videoPricing?.rules).toStrictEqual([{ resolution: '480p', pricePerMillionTokensCny: 50 }])
  })

  it('accepts camelCase like the other catalog fields, and zero prices', () => {
    expect(one({
      schemaVersion: 1, currency: 'CNY', finalBasis: 'provider_tokens', estimateBasis: 'output_plus_reference_video_seconds', estimateOnly: false,
      rules: [{ resolution: '720p', referenceImage: true, referenceAudio: false, pricePerMillionTokens: 0, estimatedPricePerSecond: 0 }],
    }).videoPricing).toStrictEqual({
      schemaVersion: 1, currency: 'CNY', finalBasis: 'provider_tokens', estimateBasis: 'output_plus_reference_video_seconds', estimateOnly: false,
      rules: [{ resolution: '720p', referenceAudio: false, referenceImage: true, pricePerMillionTokensCny: 0, estimatedPricePerSecondCny: 0 }],
    })
  })

  it('keeps the id and the pricing when only the display name changes', () => {
    const entry = TOKEN_CATALOG.data[0]!
    const renamed = parseMediaCatalog({ data: [{ ...entry, display_name: 'Seedance 2.5 renamed' }] })[0]!
    expect(renamed.id).toBe('video-sd-2.5(TC)')
    expect(renamed.name).toBe('Seedance 2.5 renamed')
    expect(renamed.videoPricing?.rules).toHaveLength(4)
    expect(renamed.videoPricing).toStrictEqual(tokenModel('video-sd-2.5(TC)').videoPricing)
  })

  it('marks an unknown schema version instead of reading it, and keeps the legacy price apart', () => {
    const model = tokenModel('video-token-future')
    expect(model.videoPricingIssue).toBe('unknown-schema')
    expect(model.videoPricing).toBeUndefined()
    expect(model.pricing).toEqual({ currency: 'CNY', tiers: [], default: { unit: 'second', amount: 0.5 } })
    expect(one({ ...base, schema_version: '1', rules: [] }).videoPricingIssue).toBe('unknown-schema')
    expect(one({ ...base, schema_version: undefined, rules: [] }).videoPricingIssue).toBe('unknown-schema')
  })

  it('marks the whole object invalid when one rule is unreadable, rather than dropping the rule', () => {
    expect(tokenModel('video-token-broken')).toMatchObject({ videoPricingIssue: 'invalid' })
    expect(tokenModel('video-token-broken').videoPricing).toBeUndefined()
  })

  const rule = { resolution: '480p', price_per_million_tokens: 60.06, estimated_price_per_second: 0.5819 }
  it.each([
    ['a non-object', 'per second'],
    ['an array', []],
    ['rules missing', { ...base }],
    ['rules empty', { ...base, rules: [] }],
    ['rules not a list', { ...base, rules: { 0: rule } }],
    ['a rule not an object', { ...base, rules: [rule, 'x'] }],
    ['another currency', { ...base, currency: 'USD', rules: [rule] }],
    ['another final basis', { ...base, final_basis: 'seconds', rules: [rule] }],
    ['another estimate basis', { ...base, estimate_basis: 'output_seconds', rules: [rule] }],
    ['estimate_only missing', { ...base, estimate_only: undefined, rules: [rule] }],
    ['an empty resolution', { ...base, rules: [{ ...rule, resolution: ' ' }] }],
    ['a condition that is not a boolean', { ...base, rules: [{ ...rule, reference_audio: 1 }] }],
    ['a missing Token price', { ...base, rules: [{ resolution: '480p', estimated_price_per_second: 0.5 }] }],
    ['a negative Token price', { ...base, rules: [{ ...rule, price_per_million_tokens: -1 }] }],
    ['a Token price as text', { ...base, rules: [{ ...rule, price_per_million_tokens: '60.06' }] }],
    ['a negative per-second estimate', { ...base, rules: [{ ...rule, estimated_price_per_second: -0.1 }] }],
    ['a per-second estimate as text', { ...base, rules: [{ ...rule, estimated_price_per_second: '0.5' }] }],
  ])('marks %s invalid', (_label, pricing) => {
    const model = one(pricing)
    expect(model.videoPricingIssue).toBe('invalid')
    expect(model.videoPricing).toBeUndefined()
  })

  it('treats a null video_pricing as absent', () => {
    const model = one(null)
    expect(Object.hasOwn(model, 'videoPricing')).toBe(false)
    expect(Object.hasOwn(model, 'videoPricingIssue')).toBe(false)
  })

  it('leaves models with only a legacy media_pricing exactly as before', () => {
    for (const model of [...models, ...parseMediaCatalog(LIVE_CATALOG)]) {
      expect(Object.hasOwn(model, 'videoPricing')).toBe(false)
      expect(Object.hasOwn(model, 'videoPricingIssue')).toBe(false)
    }
    expect(byId('seedance-2.0').pricing).toEqual({ currency: 'CNY', tiers: [{ tier: '720p', unit: 'second', amount: 0.99 }] })
  })
})

describe('the live /v1/models shape', () => {
  const live = parseMediaCatalog(LIVE_CATALOG)
  const liveModel = (id: string) => {
    const model = live.find(item => item.id === id)
    if (model === undefined) throw new Error(`missing ${id}`)
    return model
  }

  it('finds image models without a media type', () => {
    expect(live.map(model => [model.id, model.kind])).toEqual([
      ['seedance-2.0', 'video'], ['seedance-2.0-multi', 'video'], ['seedance-2.5-vibedev', 'video'], ['seedance-2.5-30s-vibedev', 'video'],
      ['gpt-image-2.5-flare', 'image'], ['doubao-music-vibedev', 'audio'],
    ])
  })

  it('reads the flattened supported_* fields', () => {
    expect(liveModel('seedance-2.0').video).toMatchObject({
      durations: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], ratios: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9', 'adaptive'],
      resolutions: ['720p'], maxReferenceVideoSeconds: 15, maxReferenceImages: 9, maxReferenceVideos: 3, maxReferenceAudios: 3,
      firstFrame: true, lastFrame: true, nativeAudio: true, gatewayRelayRequired: true,
    })
    expect(liveModel('seedance-2.0-multi').video).toMatchObject({ resolutions: ['480p', '720p', '1080p'], maxReferenceImageBytes: 5_242_880 })
  })

  it('derives the frame modes only where a first frame is declared', () => {
    expect(Object.keys(effectiveVideoModes(liveModel('seedance-2.0').video ?? {}))).toEqual(['text_to_video', 'first_frame', 'first_last_frame', 'omni_reference'])
    expect(effectiveVideoModes(liveModel('seedance-2.0').video ?? {}).omni_reference).toEqual({
      inputs: {
        referenceImages: { min: 0, max: 9, hosted: false },
        referenceVideos: { min: 0, max: 3, hosted: true },
        referenceAudios: { min: 0, max: 3, hosted: false },
      },
      requiredAnyOf: [['referenceImages'], ['referenceVideos']],
    })
    // The web lane says image_to_video but takes images only as references.
    expect(effectiveVideoModes(liveModel('seedance-2.5-vibedev').video ?? {})).toEqual({
      text_to_video: { inputs: {}, requiredAnyOf: [] },
      omni_reference: { inputs: { referenceImages: { min: 0, max: 10, hosted: false } }, requiredAnyOf: [['referenceImages']] },
    })
  })
})
