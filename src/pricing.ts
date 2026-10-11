/**
 * Price estimates from the catalog's `media_pricing` (selling prices with the
 * account multiplier applied). The gateway estimates the same way at admission:
 * per-second video prices times billed seconds, where billed seconds are the
 * output length plus the summed reference video length, rounded up once.
 * Estimates are for the user's information; the gateway's receipt is the charge.
 *
 * A model without a price is "not priced" (未定价), never free: only a price the
 * catalog states as zero is shown as ¥0.
 * @module dsh-vibedev/pricing
 */

import type { MediaKind, MediaModel, MediaPriceTier, MediaPricing, PriceUnit } from './gateway/catalog.js'

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

/**
 * A one-line price for listings: `¥0.10 per image`, `¥0.99/s (720p)`; `not priced` without a price.
 * @param model - the model.
 * @param lang - the language.
 * @returns the price line.
 */
export function describePrice(model: MediaModel, lang: keyof Bilingual = 'en'): string {
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

/**
 * Estimate a video request.
 * @param model - the video model.
 * @param duration - the requested length in seconds, when given.
 * @param resolution - the requested resolution, when given.
 * @param referenceMs - the summed length of the reference videos.
 * @returns the estimate, or undefined without a price.
 */
export function estimateVideo(model: MediaModel, duration: number | undefined, resolution: string | undefined, referenceMs = 0): Estimate | undefined {
  if (model.pricing === undefined) return undefined
  const only = model.video?.resolutions?.length === 1 ? model.video.resolutions[0] : undefined
  const price = tierFor(model.pricing, resolution ?? only)
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
