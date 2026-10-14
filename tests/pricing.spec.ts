import { describe, expect, it } from 'vitest'
import { parseMediaCatalog } from '../src/gateway/catalog.js'
import { describePrice, estimateImages, estimateVideo, quoteAudio, quoteVideo } from '../src/pricing.js'
import { CATALOG, LIVE_CATALOG, SD25_TC_PRICING, TOKEN_CATALOG, tokenVideoBlock } from './fixtures.js'

const models = parseMediaCatalog(CATALOG)
const model = (id: string) => {
  const found = models.find(item => item.id === id)
  if (found === undefined) throw new Error(`missing ${id}`)
  return found
}

describe('pricing', () => {
  it('describes catalog prices', () => {
    expect(describePrice(model('gpt-image-2.5-flare'))).toBe('¥0.10 per image (1K)')
    expect(describePrice(model('seedance-2.0'))).toBe('¥0.99/s (720p)')
    expect(describePrice(model('doubao-music-vibedev'))).toBe('¥0.50 per generation')
    // No price is not a free model.
    expect(describePrice(model('doubao-podcast-vibedev'))).toBe('not priced')
    expect(describePrice(model('doubao-podcast-vibedev'), 'zh')).toBe('未定价')
  })

  it('estimates images per image', () => {
    expect(estimateImages(model('gpt-image-2.5-flare'), 3)).toEqual({ amountCny: 0.30000000000000004, basis: '¥0.10 × 3 images' })
  })

  it('estimates video seconds like the gateway: output plus reference video, rounded up once', () => {
    expect(estimateVideo(model('seedance-2.0'), 5, undefined)).toMatchObject({ basis: '¥0.99/s × 5 s' })
    expect(estimateVideo(model('seedance-2.0'), 5, '720p')?.amountCny).toBeCloseTo(4.95)
    expect(estimateVideo(model('seedance-2.0'), 5, '720p', 8_080)).toMatchObject({ basis: '¥0.99/s × (5 s output + 9 s of reference video)' })
    expect(estimateVideo(model('seedance-2.0'), undefined, undefined)?.amountCny).toBeCloseTo(7.92)
    expect(estimateVideo(model('legacy-video'), 6, '1080p')).toBeUndefined()
  })

  it('estimates music per request and gives up without a price', () => {
    expect(quoteAudio(model('doubao-music-vibedev'))).toMatchObject({ priced: true, unit: 'generation', amountCny: 0.5, label: { zh: '¥0.50/次' } })
    expect(quoteAudio(model('doubao-podcast-vibedev'))).toMatchObject({ priced: false, label: { zh: '未定价', en: 'not priced' } })
    expect(quoteAudio(model('doubao-podcast-vibedev')).amountCny).toBeUndefined()
  })
})

const token = parseMediaCatalog(TOKEN_CATALOG)
const tokenModel = (id: string) => {
  const found = token.find(item => item.id === id)
  if (found === undefined) throw new Error(`missing ${id}`)
  return found
}
const live = parseMediaCatalog(LIVE_CATALOG)
const liveModel = (id: string) => {
  const found = live.find(item => item.id === id)
  if (found === undefined) throw new Error(`missing ${id}`)
  return found
}
/** A Token-priced video model with these rules (fixture values). */
const withRules = (rules: unknown[], resolutions = ['480p', '720p']) => parseMediaCatalog({
  data: [{ id: 'video-rules', media_type: 'video', video: tokenVideoBlock(resolutions, [5]), video_pricing: { ...SD25_TC_PRICING, rules } }],
})[0]!
const SD25 = 'video-sd-2.5(TC)'
/** Never 未定价, never free: a conditional Token price that cannot be estimated says so. */
const honest = (value: unknown) => expect(JSON.stringify(value)).not.toMatch(/未定价|not priced|免费|\bfree\b/i)

describe('quoteVideo: video Token pricing', () => {
  it('no reference video, 5 s output: 0.5819 × 5 = 2.9095, at the rule without reference video', () => {
    expect(quoteVideo(tokenModel(SD25), { model: SD25, resolution: '480p', durationSeconds: 5 })).toStrictEqual({
      status: 'estimate', mode: 'video_token', model: SD25, currency: 'CNY', amountCny: '2.9095',
      estimatedPricePerSecondCny: 0.5819, pricePerMillionTokensCny: 60.06,
      outputSeconds: 5, referenceVideoSeconds: 0, billedSeconds: 5,
      rule: { resolution: '480p', referenceVideo: false },
      estimateOnly: true, finalBasis: 'provider_tokens',
      label: { zh: '预计 ¥2.91 · 最终按实际视频 Token 结算', en: 'about ¥2.91 · billed by actual video Tokens' },
      basis: { zh: '¥0.5819/秒 × 5 秒，¥60.06/百万 Token', en: '¥0.5819/s × 5 s, ¥60.06 per million Tokens' },
    })
  })

  it('one 5 s reference video and 7 s output: 0.6952 × (7 + 5) = 8.3424, at the rule with reference video', () => {
    const quote = quoteVideo(tokenModel(SD25), { model: SD25, resolution: '480p', durationSeconds: 7, references: { videos: [{ durationSeconds: 5 }] } })
    expect(quote).toMatchObject({
      status: 'estimate', mode: 'video_token', amountCny: '8.3424', estimatedPricePerSecondCny: 0.6952, pricePerMillionTokensCny: 36.036,
      outputSeconds: 7, referenceVideoSeconds: 5, billedSeconds: 12, rule: { resolution: '480p', referenceVideo: true },
      label: { zh: '预计 ¥8.34 · 最终按实际视频 Token 结算', en: 'about ¥8.34 · billed by actual video Tokens' },
      basis: { zh: '¥0.6952/秒 × (7 秒输出 + 5 秒参考视频)，¥36.036/百万 Token', en: '¥0.6952/s × (7 s output + 5 s of reference video), ¥36.036 per million Tokens' },
    })
  })

  it('one image, 10 s, at the only resolution offered: 0.3971 × 10 = 3.971 — the image adds nothing', () => {
    const quote = quoteVideo(tokenModel('video-sd-2.0(TC)'), { model: 'video-sd-2.0(TC)', durationSeconds: 10, references: { images: 1, audios: 0, videos: [] } })
    expect(quote).toMatchObject({ status: 'estimate', amountCny: '3.971', billedSeconds: 10, rule: { resolution: '480p', referenceVideo: false }, label: { zh: '预计 ¥3.97 · 最终按实际视频 Token 结算' } })
  })

  it('images and audio add nothing to the seconds; the most specific matching rule wins', () => {
    expect(quoteVideo(tokenModel(SD25), { model: SD25, resolution: '480p', durationSeconds: 5, references: { images: 2, audios: 1 } }))
      .toMatchObject({ status: 'estimate', amountCny: '2.9095', billedSeconds: 5, rule: { resolution: '480p', referenceVideo: false } })
    const conditional = withRules([
      { resolution: '480p', reference_video: false, price_per_million_tokens: 10, estimated_price_per_second: 0.1 },
      { resolution: '480p', reference_video: false, reference_audio: true, price_per_million_tokens: 20, estimated_price_per_second: 0.2 },
      { resolution: '480p', reference_video: false, reference_audio: false, reference_image: true, price_per_million_tokens: 30, estimated_price_per_second: 0.3 },
    ])
    expect(quoteVideo(conditional, { model: 'video-rules', resolution: '480p', durationSeconds: 5, references: { images: 1, audios: 1 } }))
      .toMatchObject({ status: 'estimate', amountCny: '1', rule: { resolution: '480p', referenceVideo: false, referenceAudio: true } })
    // false is a condition, not "any": no audio and an image selects the rule that requires exactly that.
    expect(quoteVideo(conditional, { model: 'video-rules', resolution: '480p', durationSeconds: 5, references: { images: 1 } }))
      .toMatchObject({ status: 'estimate', amountCny: '1.5', rule: { resolution: '480p', referenceVideo: false, referenceAudio: false, referenceImage: true } })
    expect(quoteVideo(conditional, { model: 'video-rules', resolution: '480p', durationSeconds: 5 }))
      .toMatchObject({ status: 'estimate', amountCny: '0.5', rule: { resolution: '480p', referenceVideo: false } })
  })

  it('adds the length of every reference video', () => {
    expect(quoteVideo(tokenModel(SD25), { model: SD25, resolution: '480p', durationSeconds: 5, references: { videos: [{ durationSeconds: 3 }, { durationSeconds: 4.5 }] } }))
      .toMatchObject({ status: 'estimate', amountCny: '8.69', outputSeconds: 5, referenceVideoSeconds: 7.5, billedSeconds: 12.5, basis: { zh: '¥0.6952/秒 × (5 秒输出 + 7.5 秒参考视频)，¥36.036/百万 Token' } })
    // Exact decimals, not floating point: 0.1 + 0.2 seconds of reference video.
    expect(quoteVideo(withRules([{ resolution: '480p', price_per_million_tokens: 1, estimated_price_per_second: 0.7 }]), {
      model: 'video-rules', resolution: '480p', durationSeconds: 0.3, references: { videos: [{ durationSeconds: 0.1 }, { durationSeconds: 0.2 }] },
    })).toMatchObject({ amountCny: '0.42', billedSeconds: 0.6 })
  })

  it('a reference video of unknown length is still a reference video, and leaves the estimate unknown — not zero', () => {
    for (const videos of [[{ durationSeconds: 5 }, {}], [{}]]) {
      const quote = quoteVideo(tokenModel(SD25), { model: SD25, resolution: '480p', durationSeconds: 7, references: { videos } })
      expect(quote).toMatchObject({ status: 'unavailable', mode: 'video_token', model: SD25, reason: 'unknown-reference-duration', pricePerMillionTokensCny: 36.036 })
      expect(quote).not.toHaveProperty('amountCny')
      honest(quote)
    }
  })

  it('picks the rule of the requested resolution, trimmed and in any case', () => {
    expect(quoteVideo(tokenModel(SD25), { model: SD25, resolution: '720p', durationSeconds: 4 })).toMatchObject({ amountCny: '5', rule: { resolution: '720p', referenceVideo: false } })
    expect(quoteVideo(tokenModel(SD25), { model: SD25, resolution: '720p', durationSeconds: 4, references: { videos: [{ durationSeconds: 3 }] } }))
      .toMatchObject({ amountCny: '10.5', rule: { resolution: '720p', referenceVideo: true } })
    expect(quoteVideo(tokenModel(SD25), { model: SD25, resolution: ' 480P ', durationSeconds: 5 })).toMatchObject({ amountCny: '2.9095' })
  })

  it('asks for a resolution unless the catalog offers exactly one', () => {
    const quote = quoteVideo(tokenModel(SD25), { model: SD25, durationSeconds: 5 })
    expect(quote).toMatchObject({ status: 'unavailable', mode: 'video_token', reason: 'missing-resolution' })
    honest(quote)
    expect(quoteVideo(tokenModel('video-sd-2.0(TC)'), { model: 'video-sd-2.0(TC)', durationSeconds: 5 })).toMatchObject({ status: 'estimate', rule: { resolution: '480p' } })
  })

  it('reports no matching rule and ambiguous rules as unavailable', () => {
    const none = quoteVideo(tokenModel(SD25), { model: SD25, resolution: '1080p', durationSeconds: 5 })
    expect(none).toMatchObject({ status: 'unavailable', mode: 'video_token', reason: 'no-matching-rule' })
    honest(none)
    const ambiguous = withRules([
      { resolution: '480p', reference_video: false, price_per_million_tokens: 10, estimated_price_per_second: 0.1 },
      { resolution: '480p', reference_audio: false, price_per_million_tokens: 20, estimated_price_per_second: 0.2 },
    ])
    const quote = quoteVideo(ambiguous, { model: 'video-rules', resolution: '480p', durationSeconds: 5 })
    expect(quote).toMatchObject({ status: 'unavailable', mode: 'video_token', reason: 'ambiguous-rules' })
    expect(quote).not.toHaveProperty('pricePerMillionTokensCny')
    honest(quote)
  })

  it('needs the output duration', () => {
    expect(quoteVideo(tokenModel(SD25), { model: SD25, resolution: '480p' }))
      .toMatchObject({ status: 'unavailable', mode: 'video_token', reason: 'missing-duration', pricePerMillionTokensCny: 60.06 })
  })

  it('a rule without a per-second estimate gives the Token price and no amount', () => {
    const quote = quoteVideo(tokenModel('video-token-no-estimate'), { model: 'video-token-no-estimate', durationSeconds: 5 })
    expect(quote).toStrictEqual({
      status: 'unavailable', mode: 'video_token', model: 'video-token-no-estimate', reason: 'no-estimated-price', pricePerMillionTokensCny: 50,
      label: { zh: '无法预估；按实际视频 Token 用量结算', en: 'estimate unavailable; billed by actual video Token usage' },
      basis: {
        zh: '目录未给出每秒预估价；¥50.00/百万 Token，按实际视频 Token 用量结算。',
        en: 'The catalog gives no per-second estimate; ¥50.00 per million Tokens, billed by actual video Token usage.',
      },
    })
  })

  it('tells a stated zero from a missing price', () => {
    expect(quoteVideo(withRules([{ resolution: '480p', price_per_million_tokens: 0, estimated_price_per_second: 0 }]), { model: 'video-rules', resolution: '480p', durationSeconds: 5 }))
      .toMatchObject({ status: 'estimate', amountCny: '0', pricePerMillionTokensCny: 0, estimatedPricePerSecondCny: 0 })
    expect(quoteVideo(withRules([{ resolution: '480p', price_per_million_tokens: 0 }]), { model: 'video-rules', resolution: '480p', durationSeconds: 5 }))
      .toMatchObject({ status: 'unavailable', reason: 'no-estimated-price', pricePerMillionTokensCny: 0 })
  })

  it('an unknown schema or unreadable pricing gives no estimate, and never falls back to the legacy price', () => {
    const future = quoteVideo(tokenModel('video-token-future'), { model: 'video-token-future', resolution: '480p', durationSeconds: 5 })
    expect(future).toMatchObject({ status: 'unavailable', mode: 'video_token', reason: 'unknown-schema', label: { en: 'estimate unavailable; billed by actual video Token usage' } })
    expect(future).not.toHaveProperty('amountCny')
    honest(future)
    expect(quoteVideo(tokenModel('video-token-broken'), { model: 'video-token-broken', resolution: '480p', durationSeconds: 5 }))
      .toMatchObject({ status: 'unavailable', mode: 'video_token', reason: 'invalid-pricing' })
  })

  it.each([
    ['a negative duration', { durationSeconds: -1 }],
    ['a duration that is not a number', { durationSeconds: Number.NaN }],
    ['a fractional image count', { references: { images: 1.5 } }],
    ['a negative audio count', { references: { audios: -1 } }],
    ['a reference video of zero seconds', { references: { videos: [{ durationSeconds: 0 }] } }],
  ])('refuses %s as an invalid request', (_label, request) => {
    expect(quoteVideo(tokenModel(SD25), { model: SD25, resolution: '480p', durationSeconds: 5, ...request }))
      .toMatchObject({ status: 'unavailable', reason: 'invalid-request' })
  })

  it('an image model is not quoted as a video', () => {
    expect(quoteVideo(model('gpt-image-2.5-flare'), { model: 'gpt-image-2.5-flare', durationSeconds: 5 })).toMatchObject({ status: 'unavailable', reason: 'invalid-request' })
  })
})

describe('describePrice: video Token pricing', () => {
  it('lists every rule with its Token price and its per-second estimate — never 未定价, never a plain per-second price', () => {
    expect(describePrice(tokenModel(SD25), 'zh')).toBe('视频 Token 计价：480p 无参考视频 ¥60.06/百万 Token（预计 ¥0.5819/秒）；'
      + '480p 有参考视频 ¥36.036/百万 Token（预计 ¥0.6952/秒）；720p 无参考视频 ¥70.00/百万 Token（预计 ¥1.25/秒）；720p 有参考视频 ¥42.00/百万 Token（预计 ¥1.50/秒）')
    expect(describePrice(tokenModel(SD25))).toBe('video Token pricing (billed by actual video Tokens): '
      + '480p without reference video ¥60.06 per million Tokens (about ¥0.5819/s), 480p with reference video ¥36.036 per million Tokens (about ¥0.6952/s), '
      + '720p without reference video ¥70.00 per million Tokens (about ¥1.25/s), 720p with reference video ¥42.00 per million Tokens (about ¥1.50/s)')
    expect(describePrice(tokenModel('video-token-no-estimate'), 'zh')).toBe('视频 Token 计价：480p ¥50.00/百万 Token（暂无每秒预估）')
    expect(describePrice(tokenModel('video-token-no-estimate'))).toBe('video Token pricing (billed by actual video Tokens): 480p ¥50.00 per million Tokens (no per-second estimate)')
    const conditional = withRules([{ resolution: '480p', reference_video: false, reference_audio: true, reference_image: false, price_per_million_tokens: 1, estimated_price_per_second: 0.1 }])
    expect(describePrice(conditional, 'zh')).toBe('视频 Token 计价：480p 无参考视频、有参考音频、无参考图 ¥1.00/百万 Token（预计 ¥0.10/秒）')
    expect(describePrice(conditional)).toBe('video Token pricing (billed by actual video Tokens): 480p without reference video and with reference audio and without reference image ¥1.00 per million Tokens (about ¥0.10/s)')
  })

  it('says a video pricing it cannot read is not supported by this plugin version, and shows no legacy price instead', () => {
    for (const id of ['video-token-future', 'video-token-broken']) {
      expect(describePrice(tokenModel(id), 'zh')).toBe('当前插件版本暂不支持此视频计价方式的预估；按实际视频 Token 用量结算')
      expect(describePrice(tokenModel(id))).toBe('this plugin version does not support this video pricing mode: estimate unavailable; billed by actual video Token usage')
    }
  })
})

describe('quoteVideo: legacy prices', () => {
  it('per second, as estimateVideo always did', () => {
    expect(quoteVideo(model('seedance-2.0'), { model: 'seedance-2.0', durationSeconds: 5 })).toStrictEqual({
      status: 'estimate', mode: 'legacy', model: 'seedance-2.0', currency: 'CNY', amountCny: '4.95',
      label: { en: 'about ¥4.95', zh: '约 ¥4.95' },
      basis: { en: '¥0.99/s × 5 s', zh: '¥0.99/秒 × 5 秒' },
    })
    const referenced = quoteVideo(model('seedance-2.0'), { model: 'seedance-2.0', resolution: '720p', durationSeconds: 5, references: { videos: [{ durationSeconds: 8.08 }] } })
    expect(referenced).toMatchObject({ mode: 'legacy', amountCny: '13.86', basis: { en: '¥0.99/s × (5 s output + 9 s of reference video)', zh: '¥0.99/秒 × (5 秒输出 + 9 秒参考视频)' } })
    expect(Number((referenced as { amountCny: string }).amountCny)).toBeCloseTo(estimateVideo(model('seedance-2.0'), 5, '720p', 8_080)?.amountCny ?? Number.NaN)
    // No duration: the gateway's default billed length, as before.
    expect(quoteVideo(model('seedance-2.0'), { model: 'seedance-2.0' })).toMatchObject({ mode: 'legacy', amountCny: '7.92' })
    expect(quoteVideo(liveModel('seedance-2.0-multi'), { model: 'seedance-2.0-multi', resolution: '480p', durationSeconds: 10 })).toMatchObject({ mode: 'legacy', amountCny: '6.9' })
  })

  it('per generation', () => {
    expect(quoteVideo(liveModel('seedance-2.5-30s-vibedev'), { model: 'seedance-2.5-30s-vibedev', durationSeconds: 30 }))
      .toMatchObject({ status: 'estimate', mode: 'legacy', amountCny: '4', label: { en: 'about ¥4.00' }, basis: { en: '¥4.00 per video', zh: '¥4.00/次' } })
  })

  it('a per-second price with a reference video of unknown length gives no estimate rather than counting it as zero', () => {
    expect(quoteVideo(model('seedance-2.0'), { model: 'seedance-2.0', durationSeconds: 5, references: { videos: [{}] } }))
      .toMatchObject({ status: 'unavailable', mode: 'legacy', reason: 'unknown-reference-duration' })
  })

  it('no price at all is 未定价, not free', () => {
    expect(quoteVideo(model('legacy-video'), { model: 'legacy-video', durationSeconds: 6 })).toStrictEqual({
      status: 'unavailable', mode: 'none', model: 'legacy-video', reason: 'no-price',
      label: { en: 'not priced', zh: '未定价' },
      basis: { en: 'The catalog states no price for this model; the gateway receipt shows the charge.', zh: '目录未给出价格，以网关结算为准。' },
    })
    const tiered = parseMediaCatalog({ data: [{ id: 'tiered', media_type: 'video', media_pricing: { currency: 'CNY', tiers: [{ tier: '720p', unit: 'second', amount: 1 }, { tier: '1080p', unit: 'second', amount: 2 }] } }] })[0]!
    expect(quoteVideo(tiered, { model: 'tiered', resolution: '480p', durationSeconds: 5 })).toMatchObject({ status: 'unavailable', mode: 'legacy', reason: 'no-price' })
  })
})
