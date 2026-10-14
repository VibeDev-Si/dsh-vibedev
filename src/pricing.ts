/**
 * Price estimates from the catalog's `media_pricing` (selling prices with the
 * account multiplier applied). The gateway estimates the same way at admission:
 * per-second video prices times billed seconds, where billed seconds are the
 * output length plus the summed reference video length, rounded up once.
 * Estimates are for the user's information; the gateway's receipt is the charge.
 *
 * Video models priced per video Token (`video_pricing`) are quoted by
 * {@link quoteVideo}: the matching rule's per-second estimate times the output
 * length plus every reference video's length, in exact decimals. The final
 * charge is the provider's billable Tokens times the rule's Token price, so a
 * Token price is never shown as an unconditional per-second price, never as
 * 未定价 and never as free — and what cannot be estimated says so.
 *
 * A model without a price is "not priced" (未定价), never free: only a price the
 * catalog states as zero is shown as ¥0.
 * @module dsh-vibedev/pricing
 */

import { effectiveVideoModes } from './gateway/catalog.js'
import type { MediaKind, MediaModel, MediaPriceTier, MediaPricing, PriceUnit, VideoTokenPricing, VideoTokenRule } from './gateway/catalog.js'
import { ZERO, add, ceil, decimal, format, multiply, roundHalfUp, toNumber } from './util/decimal.js'
import type { Decimal } from './util/decimal.js'

/** One estimate. */
export interface Estimate {
  readonly amountCny: number
  /** How it was reached, such as `¥0.99/s × 5 s`. */
  readonly basis: string
}

/** Text in both languages the plugin speaks. */
export interface Bilingual {
  readonly en: string
  readonly zh: string
}

/** Shown wherever the catalog gives no price. */
export const UNPRICED: Bilingual = { en: 'not priced', zh: '未定价' }

/** Seconds the gateway bills when a request names no duration. */
const DEFAULT_BILLED_SECONDS = 8

/**
 * Format an amount in yuan: two decimals, more when a small unit price needs them (`¥0.015`).
 * @param amount - the amount.
 * @returns `¥4.95`.
 */
export function yuan(amount: number): string {
  if (amount !== 0 && Math.abs(amount) < 0.1) {
    const precise = amount.toFixed(4).replace(/0+$/, '')
    if (precise.split('.')[1]!.length > 2) return `¥${precise}`
  }
  return `¥${amount.toFixed(2)}`
}

function tierFor(pricing: MediaPricing, wanted: string | undefined): MediaPriceTier | { unit: PriceUnit; amount: number } | undefined {
  if (wanted !== undefined) {
    const match = pricing.tiers.find(tier => tier.tier.toLowerCase() === wanted.toLowerCase())
    if (match !== undefined) return match
  }
  if (pricing.default !== undefined) return pricing.default
  return pricing.tiers.length === 1 ? pricing.tiers[0] : undefined
}

/**
 * The unit after a price: `/s`, `/原始秒`, `/次`.
 * @param unit - the price unit.
 * @param kind - the kind of model, which names a generation (an image, a video, a request).
 * @returns the suffix in both languages.
 */
export function unitSuffix(unit: PriceUnit, kind: MediaKind): Bilingual {
  switch (unit) {
    case 'second': return { en: '/s', zh: '/秒' }
    case 'original_second': return { en: '/s of original audio', zh: '/原始秒' }
    case 'minute': return { en: '/min', zh: '/分钟' }
    default: return kind === 'image' ? { en: ' per image', zh: '/张' } : { en: ' per generation', zh: '/次' }
  }
}

/** Shown for a model whose `video_pricing` this plugin cannot use. */
const VIDEO_PRICING_UNSUPPORTED: Bilingual = {
  en: 'this plugin version does not support this video pricing mode: estimate unavailable; billed by actual video Token usage',
  zh: '当前插件版本暂不支持此视频计价方式的预估；按实际视频 Token 用量结算',
}

/** `480p 无参考视频、有参考音频` / `480p without reference video and with reference audio`. */
function describeRuleConditions(rule: VideoTokenRule, lang: keyof Bilingual): string {
  const conditions: Array<[boolean | undefined, string, string]> = [
    [rule.referenceVideo, 'reference video', '参考视频'], [rule.referenceAudio, 'reference audio', '参考音频'], [rule.referenceImage, 'reference image', '参考图'],
  ]
  const parts = conditions.flatMap(([value, en, zh]) => value === undefined ? [] : [lang === 'zh' ? `${value ? '有' : '无'}${zh}` : `${value ? 'with' : 'without'} ${en}`])
  return parts.length === 0 ? rule.resolution : `${rule.resolution} ${parts.join(lang === 'zh' ? '、' : ' and ')}`
}

/** Every rule of a video Token pricing, each with its Token price and its per-second estimate (or that it has none). */
function describeTokenPricing(pricing: VideoTokenPricing, lang: keyof Bilingual): string {
  const rules = pricing.rules.map((rule) => {
    const where = describeRuleConditions(rule, lang)
    const perMillion = exactYuan(rule.pricePerMillionTokensCny)
    const perSecond = rule.estimatedPricePerSecondCny === undefined ? undefined : exactYuan(rule.estimatedPricePerSecondCny)
    return lang === 'zh'
      ? `${where} ${perMillion}/百万 Token（${perSecond === undefined ? '暂无每秒预估' : `预计 ${perSecond}/秒`}）`
      : `${where} ${perMillion} per million Tokens (${perSecond === undefined ? 'no per-second estimate' : `about ${perSecond}/s`})`
  })
  return lang === 'zh' ? `视频 Token 计价：${rules.join('；')}` : `video Token pricing (billed by actual video Tokens): ${rules.join(', ')}`
}

/**
 * A one-line price for listings: `¥0.10 per image`, `¥0.99/s (720p)`; `not priced` without a price.
 * A video Token price lists its rules (`视频 Token 计价：480p 无参考视频 ¥60.06/百万 Token（预计 ¥0.5819/秒）…`).
 * @param model - the model.
 * @param lang - the language.
 * @returns the price line.
 */
export function describePrice(model: MediaModel, lang: keyof Bilingual = 'en'): string {
  // Video Token pricing decides on its own: an unreadable one never falls back to the legacy price.
  if (model.videoPricingIssue !== undefined) return VIDEO_PRICING_UNSUPPORTED[lang]
  if (model.videoPricing !== undefined) return describeTokenPricing(model.videoPricing, lang)
  const pricing = model.pricing
  if (pricing === undefined) return UNPRICED[lang]
  const per = (unit: PriceUnit) => unitSuffix(unit, model.kind)[lang]
  const parts = pricing.tiers.map(tier => `${yuan(tier.amount)}${per(tier.unit)} (${tier.tier})`)
  if (pricing.default !== undefined && (pricing.tiers.length === 0 || !pricing.tiers.some(tier => tier.amount === pricing.default?.amount && tier.unit === pricing.default.unit))) {
    parts.push(`${yuan(pricing.default.amount)}${per(pricing.default.unit)}${pricing.tiers.length === 0 ? '' : lang === 'zh' ? '（其他）' : ' otherwise'}`)
  }
  return parts.length === 0 ? UNPRICED[lang] : parts.join(', ')
}

/**
 * Estimate an image request.
 * @param model - the image model.
 * @param count - images requested.
 * @returns the estimate, or undefined without a price.
 */
export function estimateImages(model: MediaModel, count: number): Estimate | undefined {
  const price = model.pricing === undefined ? undefined : tierFor(model.pricing, undefined)
  if (price === undefined || price.unit !== 'generation') return undefined
  return { amountCny: price.amount * count, basis: count === 1 ? `${yuan(price.amount)} per image` : `${yuan(price.amount)} × ${count} images` }
}

/** The legacy `media_pricing` price a video request pays: its resolution's tier, the only offered one, or the default. */
function legacyVideoPrice(model: MediaModel, resolution: string | undefined): MediaPriceTier | { unit: PriceUnit; amount: number } | undefined {
  if (model.pricing === undefined) return undefined
  const only = model.video?.resolutions?.length === 1 ? model.video.resolutions[0] : undefined
  return tierFor(model.pricing, resolution ?? only)
}

/**
 * Estimate a video request.
 * @param model - the video model.
 * @param duration - the requested length in seconds, when given.
 * @param resolution - the requested resolution, when given.
 * @param referenceMs - the summed length of the reference videos.
 * @returns the estimate, or undefined without a price.
 */
export function estimateVideo(model: MediaModel, duration: number | undefined, resolution: string | undefined, referenceMs = 0): Estimate | undefined {
  const price = legacyVideoPrice(model, resolution)
  if (price === undefined) return undefined
  if (price.unit === 'generation') return { amountCny: price.amount, basis: `${yuan(price.amount)} per video` }
  if (price.unit !== 'second') return undefined
  const output = duration ?? DEFAULT_BILLED_SECONDS
  const reference = Math.ceil(referenceMs / 1000)
  const seconds = output + reference
  return {
    amountCny: price.amount * seconds,
    basis: `${yuan(price.amount)}/s × ${reference === 0 ? `${output} s` : `(${output} s output + ${reference} s of reference video)`}`,
  }
}

/** What an audio request costs, as far as it can be known before it runs. */
export interface AudioQuote {
  /** The catalog states a price. */
  readonly priced: boolean
  readonly unit?: PriceUnit
  readonly unitPriceCny?: number
  /**
   * The amount, when it is known before the request runs: per generation, or
   * per minute of an input whose length was measured. Speech billed per
   * original second is known only once the provider reports that length.
   */
  readonly amountCny?: number
  /** The unit price: `¥0.50/次`, `¥0.02/原始秒`, `¥0.30/分钟`, or `未定价`. */
  readonly label: Bilingual
  /** How the charge is reached. */
  readonly basis: Bilingual
}

/**
 * Quote an audio request: music, podcast and speech generation, or a transcription.
 * @param model - the audio or transcription model.
 * @param inputSeconds - for a transcription, the measured length of the input, when known.
 * @returns the quote; `priced: false` (未定价) when the catalog gives no usable price.
 */
export function quoteAudio(model: MediaModel, inputSeconds?: number): AudioQuote {
  const price = model.pricing === undefined ? undefined : tierFor(model.pricing, undefined)
  const unit = price?.unit ?? model.audio?.billingUnit
  if (price === undefined || unit === undefined || unit === 'second') {
    return {
      priced: false, ...unit === undefined ? {} : { unit }, label: UNPRICED,
      basis: { en: 'The catalog states no price for this model; the gateway receipt shows the charge.', zh: '目录未给出价格，以网关结算为准。' },
    }
  }
  const suffix = unitSuffix(unit, model.kind)
  const label = { en: `${yuan(price.amount)}${suffix.en}`, zh: `${yuan(price.amount)}${suffix.zh}` }
  const base = { priced: true, unit, unitPriceCny: price.amount, label }
  if (unit === 'generation') {
    return { ...base, amountCny: price.amount, basis: { en: `${label.en}, charged only if it succeeds`, zh: `${label.zh}，成功才扣费` } }
  }
  if (unit === 'original_second') {
    return {
      ...base,
      basis: {
        en: `${label.en}: billed on the original length the provider reports, which can differ from the playback length`,
        zh: `${label.zh}：按服务商返回的原始时长计费，可能与播放时长不同`,
      },
    }
  }
  if (inputSeconds !== undefined && inputSeconds > 0) {
    const minutes = inputSeconds / 60
    return {
      ...base, amountCny: price.amount * minutes,
      basis: { en: `${label.en} × ${minutes.toFixed(2)} min`, zh: `${label.zh} × ${minutes.toFixed(2)} 分钟` },
    }
  }
  return { ...base, basis: { en: `${label.en} of input audio`, zh: `${label.zh}，按音频时长计费` } }
}

/** A video request to quote, before anything is uploaded or submitted. */
export interface VideoQuoteRequest {
  /** The canonical model id or an alias. */
  readonly model: string
  /** When absent and the catalog offers exactly one resolution for the model, that one. */
  readonly resolution?: string
  /** The requested output length. */
  readonly durationSeconds?: number
  readonly references?: {
    /** One entry per reference video; an absent `durationSeconds` is unknown, not zero. */
    readonly videos?: readonly { readonly durationSeconds?: number }[]
    /** Image references, first and last frames included. */
    readonly images?: number
    /** Reference audios (generating audio is not a reference audio). */
    readonly audios?: number
  }
}

/** The conditions of the rule a quote used. */
export interface VideoQuoteRule {
  readonly resolution: string
  readonly referenceVideo?: boolean
  readonly referenceAudio?: boolean
  readonly referenceImage?: boolean
}

/** Why a video request has no estimate. */
export type VideoQuoteReason = 'no-price' | 'unknown-schema' | 'invalid-pricing' | 'no-matching-rule' | 'ambiguous-rules'
  | 'missing-resolution' | 'missing-duration' | 'unknown-reference-duration' | 'no-estimated-price' | 'invalid-request'

/** An estimate under video Token pricing; the final charge is the actual video Tokens times the Token price. */
export interface VideoTokenEstimate {
  readonly status: 'estimate'
  readonly mode: 'video_token'
  readonly model: string
  readonly currency: 'CNY'
  /** Exact decimal, never rounded (`2.9095`); labels round half up to two decimals. */
  readonly amountCny: string
  readonly estimatedPricePerSecondCny: number
  readonly pricePerMillionTokensCny: number
  readonly outputSeconds: number
  readonly referenceVideoSeconds: number
  readonly billedSeconds: number
  readonly rule: VideoQuoteRule
  readonly estimateOnly: true
  readonly finalBasis: 'provider_tokens'
  /** `预计 ¥8.34 · 最终按实际视频 Token 结算`. */
  readonly label: Bilingual
  /** `¥0.6952/秒 × (7 秒输出 + 5 秒参考视频)，¥36.036/百万 Token`. */
  readonly basis: Bilingual
}

/** An estimate from a legacy `media_pricing` price (per second or per generation). */
export interface VideoLegacyEstimate {
  readonly status: 'estimate'
  readonly mode: 'legacy'
  readonly model: string
  readonly currency: 'CNY'
  readonly amountCny: string
  readonly label: Bilingual
  readonly basis: Bilingual
}

/** No estimate, and why. Under Token pricing this is never "not priced" and never free. */
export interface VideoQuoteUnavailable {
  readonly status: 'unavailable'
  readonly mode: 'video_token' | 'legacy' | 'none'
  readonly model: string
  readonly reason: VideoQuoteReason
  /** The matched rule's Token price, when a rule matched but the amount cannot be estimated. */
  readonly pricePerMillionTokensCny?: number
  readonly label: Bilingual
  readonly basis: Bilingual
}

/** What a video request is expected to cost. */
export type VideoQuote = VideoTokenEstimate | VideoLegacyEstimate | VideoQuoteUnavailable

/** Shown wherever video Token pricing gives no estimate. */
const TOKEN_UNAVAILABLE: Bilingual = { en: 'estimate unavailable; billed by actual video Token usage', zh: '无法预估；按实际视频 Token 用量结算' }
const BILLED_BY_TOKENS: Bilingual = { en: 'billed by actual video Token usage', zh: '按实际视频 Token 用量结算' }

/** An exact price: `¥0.6952`, `¥36.036`, `¥60.00` (at least two decimals, never rounded). */
function exactYuan(amount: number): string {
  return `¥${format(decimal(amount), 2)}`
}

/** A display amount: half up to two decimals (`2.9095` → `¥2.91`). */
function roundedYuan(amount: Decimal): string {
  return `¥${format(roundHalfUp(amount, 2), 2)}`
}

const positiveSeconds = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0
const wholeCount = (value: unknown): boolean => value === undefined || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)

/** What is wrong with a request, in both languages, or undefined when it can be quoted. */
function requestProblem(model: MediaModel, request: VideoQuoteRequest): Bilingual | undefined {
  if (model.kind !== 'video') return { en: `${model.id} is not a video model.`, zh: `${model.id} 不是视频模型。` }
  if (request.durationSeconds !== undefined && !positiveSeconds(request.durationSeconds)) {
    return { en: 'The output duration must be a positive number of seconds.', zh: '输出时长必须是正数秒。' }
  }
  if (request.resolution !== undefined && typeof request.resolution !== 'string') return { en: 'The resolution must be text.', zh: '分辨率必须是文本。' }
  const references = request.references
  if (references === undefined) return undefined
  if (typeof references !== 'object' || references === null) return { en: 'references must be an object.', zh: 'references 必须是对象。' }
  if (!wholeCount(references.images) || !wholeCount(references.audios)) {
    return { en: 'Reference image and audio counts must be whole numbers of at least 0.', zh: '参考图和参考音频的数量必须是不小于 0 的整数。' }
  }
  if (references.videos !== undefined) {
    if (!Array.isArray(references.videos)) return { en: 'references.videos must be a list.', zh: 'references.videos 必须是列表。' }
    for (const [index, video] of references.videos.entries()) {
      if (typeof video !== 'object' || video === null || (video.durationSeconds !== undefined && !positiveSeconds(video.durationSeconds))) {
        return { en: `Reference video ${index + 1} must give its length as a positive number of seconds, or none when unknown.`, zh: `第 ${index + 1} 个参考视频的时长必须是正数秒（未知时不填）。` }
      }
    }
  }
  return undefined
}

/** The resolutions the catalog offers for a model, across its usable modes. */
function offeredResolutions(model: MediaModel): string[] {
  const video = model.video
  if (video === undefined) return []
  const modes = Object.values(effectiveVideoModes(video))
  const lists = modes.length === 0 ? [video.resolutions ?? []] : modes.map(mode => mode?.resolutions ?? video.resolutions ?? [])
  const offered = new Map<string, string>()
  for (const list of lists) for (const item of list) if (!offered.has(item.toLowerCase())) offered.set(item.toLowerCase(), item)
  return [...offered.values()]
}

interface Presence { readonly video: boolean; readonly audio: boolean; readonly image: boolean }

function describePresence(resolution: string, presence: Presence): Bilingual {
  const has = (present: boolean, en: string, zh: string): Bilingual => ({ en: `${present ? 'with' : 'without'} ${en}`, zh: `${present ? '有' : '无'}${zh}` })
  const parts = [has(presence.video, 'reference video', '参考视频'), has(presence.audio, 'reference audio', '参考音频'), has(presence.image, 'reference image', '参考图')]
  return { en: `${resolution} ${parts.map(part => part.en).join(', ')}`, zh: `${resolution}、${parts.map(part => part.zh).join('、')}` }
}

const specificity = (rule: VideoTokenRule): number => [rule.referenceVideo, rule.referenceAudio, rule.referenceImage].filter(item => item !== undefined).length

const matches = (expected: boolean | undefined, present: boolean): boolean => expected === undefined || expected === present

function ruleOf(rule: VideoTokenRule): VideoQuoteRule {
  return {
    resolution: rule.resolution,
    ...rule.referenceVideo === undefined ? {} : { referenceVideo: rule.referenceVideo },
    ...rule.referenceAudio === undefined ? {} : { referenceAudio: rule.referenceAudio },
    ...rule.referenceImage === undefined ? {} : { referenceImage: rule.referenceImage },
  }
}

/** Seconds as written: `7`, `7.5`. */
const secondsText = (value: Decimal): string => format(value)

function quoteTokens(model: MediaModel, pricing: VideoTokenPricing, request: VideoQuoteRequest): VideoQuote {
  const unavailable = (reason: VideoQuoteReason, basis: Bilingual, pricePerMillion?: number): VideoQuoteUnavailable => ({
    status: 'unavailable', mode: 'video_token', model: model.id, reason,
    ...pricePerMillion === undefined ? {} : { pricePerMillionTokensCny: pricePerMillion },
    label: TOKEN_UNAVAILABLE, basis,
  })
  let resolution = request.resolution?.trim()
  if (resolution === undefined || resolution === '') {
    const offered = offeredResolutions(model)
    if (offered.length !== 1) {
      return unavailable('missing-resolution', {
        en: `A resolution is needed to find the video Token price; ${BILLED_BY_TOKENS.en}.`,
        zh: `需要选择分辨率才能确定视频 Token 价格；${BILLED_BY_TOKENS.zh}。`,
      })
    }
    resolution = offered[0] as string
  }
  const videos = request.references?.videos ?? []
  const presence: Presence = { video: videos.length > 0, audio: (request.references?.audios ?? 0) > 0, image: (request.references?.images ?? 0) > 0 }
  const wanted = resolution.toLowerCase()
  const candidates = pricing.rules.filter(rule => rule.resolution.trim().toLowerCase() === wanted
    && matches(rule.referenceVideo, presence.video) && matches(rule.referenceAudio, presence.audio) && matches(rule.referenceImage, presence.image))
  const asked = describePresence(resolution, presence)
  if (candidates.length === 0) {
    return unavailable('no-matching-rule', {
      en: `The catalog has no video Token price for ${asked.en}; ${BILLED_BY_TOKENS.en}.`,
      zh: `目录中没有适用于 ${asked.zh} 的视频 Token 价格；${BILLED_BY_TOKENS.zh}。`,
    })
  }
  const top = Math.max(...candidates.map(specificity))
  const best = candidates.filter(rule => specificity(rule) === top)
  if (best.length > 1) {
    return unavailable('ambiguous-rules', {
      en: `Several video Token prices in the catalog apply equally to ${asked.en}, so the price cannot be determined; ${BILLED_BY_TOKENS.en}.`,
      zh: `目录中有多条视频 Token 价格同样适用于 ${asked.zh}，无法确定价格；${BILLED_BY_TOKENS.zh}。`,
    })
  }
  const rule = best[0] as VideoTokenRule
  const perMillion = rule.pricePerMillionTokensCny
  const tokenPrice: Bilingual = { en: `${exactYuan(perMillion)} per million Tokens`, zh: `${exactYuan(perMillion)}/百万 Token` }
  const perSecond = rule.estimatedPricePerSecondCny
  if (perSecond === undefined) {
    return unavailable('no-estimated-price', {
      en: `The catalog gives no per-second estimate; ${tokenPrice.en}, ${BILLED_BY_TOKENS.en}.`,
      zh: `目录未给出每秒预估价；${tokenPrice.zh}，${BILLED_BY_TOKENS.zh}。`,
    }, perMillion)
  }
  if (request.durationSeconds === undefined) {
    return unavailable('missing-duration', {
      en: `An output duration is needed for an estimate; ${tokenPrice.en}, ${BILLED_BY_TOKENS.en}.`,
      zh: `需要输出时长才能预估；${tokenPrice.zh}，${BILLED_BY_TOKENS.zh}。`,
    }, perMillion)
  }
  if (videos.some(video => video.durationSeconds === undefined)) {
    // Still a reference video (it chose the rule), but its length is unknown — and unknown is not zero.
    return unavailable('unknown-reference-duration', {
      en: `A reference video's length is unknown, so no estimate is possible; ${tokenPrice.en}, ${BILLED_BY_TOKENS.en}.`,
      zh: `参考视频时长未知，无法预估；${tokenPrice.zh}，${BILLED_BY_TOKENS.zh}。`,
    }, perMillion)
  }
  const output = decimal(request.durationSeconds)
  const reference = videos.reduce((sum, video) => add(sum, decimal(video.durationSeconds as number)), ZERO)
  const billed = add(output, reference)
  const amount = multiply(decimal(perSecond), billed)
  const rate = exactYuan(perSecond)
  const seconds: Bilingual = presence.video
    ? { en: `(${secondsText(output)} s output + ${secondsText(reference)} s of reference video)`, zh: `(${secondsText(output)} 秒输出 + ${secondsText(reference)} 秒参考视频)` }
    : { en: `${secondsText(output)} s`, zh: `${secondsText(output)} 秒` }
  return {
    status: 'estimate', mode: 'video_token', model: model.id, currency: 'CNY',
    amountCny: format(amount),
    estimatedPricePerSecondCny: perSecond, pricePerMillionTokensCny: perMillion,
    outputSeconds: request.durationSeconds, referenceVideoSeconds: toNumber(reference), billedSeconds: toNumber(billed),
    rule: ruleOf(rule),
    estimateOnly: true, finalBasis: 'provider_tokens',
    label: { en: `about ${roundedYuan(amount)} · billed by actual video Tokens`, zh: `预计 ${roundedYuan(amount)} · 最终按实际视频 Token 结算` },
    basis: { en: `${rate}/s × ${seconds.en}, ${tokenPrice.en}`, zh: `${rate}/秒 × ${seconds.zh}，${tokenPrice.zh}` },
  }
}

function quoteLegacy(model: MediaModel, request: VideoQuoteRequest): VideoQuote {
  const resolution = request.resolution?.trim()
  const price = legacyVideoPrice(model, resolution === '' ? undefined : resolution)
  if (price === undefined || (price.unit !== 'generation' && price.unit !== 'second')) {
    return {
      status: 'unavailable', mode: 'legacy', model: model.id, reason: 'no-price', label: UNPRICED,
      basis: { en: 'The catalog states no price for this request; the gateway receipt shows the charge.', zh: '目录未给出此请求的价格，以网关结算为准。' },
    }
  }
  const estimate = (amount: Decimal, basis: Bilingual): VideoLegacyEstimate => {
    const shown = yuan(toNumber(amount))
    return { status: 'estimate', mode: 'legacy', model: model.id, currency: 'CNY', amountCny: format(amount), label: { en: `about ${shown}`, zh: `约 ${shown}` }, basis }
  }
  if (price.unit === 'generation') {
    return estimate(decimal(price.amount), { en: `${yuan(price.amount)} per video`, zh: `${yuan(price.amount)}/次` })
  }
  const videos = request.references?.videos ?? []
  if (videos.some(video => video.durationSeconds === undefined)) {
    return {
      status: 'unavailable', mode: 'legacy', model: model.id, reason: 'unknown-reference-duration',
      label: { en: 'estimate unavailable', zh: '无法预估' },
      basis: {
        en: `A reference video's length is unknown, so ${yuan(price.amount)}/s × (output + reference video seconds) cannot be estimated; the gateway receipt shows the charge.`,
        zh: `参考视频时长未知，无法按 ${yuan(price.amount)}/秒 × (输出 + 参考视频秒数) 预估，以网关结算为准。`,
      },
    }
  }
  // As the gateway bills it: the output plus the summed reference video length, rounded up once.
  const output = decimal(request.durationSeconds ?? DEFAULT_BILLED_SECONDS)
  const reference = ceil(videos.reduce((sum, video) => add(sum, decimal(video.durationSeconds as number)), ZERO))
  const amount = multiply(decimal(price.amount), add(output, reference))
  const plain = reference.units === 0n
  return estimate(amount, {
    en: `${yuan(price.amount)}/s × ${plain ? `${format(output)} s` : `(${format(output)} s output + ${format(reference)} s of reference video)`}`,
    zh: `${yuan(price.amount)}/秒 × ${plain ? `${format(output)} 秒` : `(${format(output)} 秒输出 + ${format(reference)} 秒参考视频)`}`,
  })
}

/**
 * Quote a video request from the catalog alone: no upload, no submission.
 *
 * Video Token pricing: the unique most specific rule for the resolution and
 * the presence of reference video, audio and images; its per-second estimate
 * times the output length plus every reference video's length. A model whose
 * `video_pricing` cannot be read gets no estimate and never falls back to its
 * legacy price. Legacy models are quoted as {@link estimateVideo} always did.
 * @param model - the resolved model.
 * @param request - the request.
 * @returns the quote.
 */
export function quoteVideo(model: MediaModel, request: VideoQuoteRequest): VideoQuote {
  const mode: VideoQuoteUnavailable['mode'] = model.videoPricing !== undefined || model.videoPricingIssue !== undefined ? 'video_token'
    : model.pricing !== undefined ? 'legacy' : 'none'
  const problem = requestProblem(model, request)
  if (problem !== undefined) {
    return {
      status: 'unavailable', mode, model: model.id, reason: 'invalid-request',
      label: mode === 'video_token' ? TOKEN_UNAVAILABLE : { en: 'estimate unavailable', zh: '无法预估' },
      basis: { en: `The request cannot be quoted: ${problem.en}`, zh: `无法预估此请求：${problem.zh}` },
    }
  }
  if (model.videoPricingIssue !== undefined) {
    return {
      status: 'unavailable', mode, model: model.id, reason: model.videoPricingIssue === 'unknown-schema' ? 'unknown-schema' : 'invalid-pricing',
      label: TOKEN_UNAVAILABLE,
      basis: model.videoPricingIssue === 'unknown-schema'
        ? { en: `This plugin version does not support this video pricing mode, so no estimate is possible; ${BILLED_BY_TOKENS.en}.`, zh: `当前插件版本暂不支持此视频计价方式的预估；${BILLED_BY_TOKENS.zh}。` }
        : { en: `The catalog's video Token pricing cannot be read, so no estimate is possible; ${BILLED_BY_TOKENS.en}.`, zh: `目录中的视频 Token 价格无法读取，暂无法预估；${BILLED_BY_TOKENS.zh}。` },
    }
  }
  if (model.videoPricing !== undefined) return quoteTokens(model, model.videoPricing, request)
  if (model.pricing !== undefined) return quoteLegacy(model, request)
  return {
    status: 'unavailable', mode: 'none', model: model.id, reason: 'no-price', label: UNPRICED,
    basis: { en: 'The catalog states no price for this model; the gateway receipt shows the charge.', zh: '目录未给出价格，以网关结算为准。' },
  }
}

/**
 * The estimate a task records: the quote amount half up to two decimals.
 * @param quote - the quote.
 * @returns `8.34`, or undefined without an estimate.
 */
export function quotedCny(quote: VideoQuote): string | undefined {
  return quote.status === 'estimate' ? format(roundHalfUp(decimal(quote.amountCny), 2), 2) : undefined
}

