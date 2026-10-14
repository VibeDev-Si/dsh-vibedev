/**
 * The media models of the VibeDev gateway catalog (`GET /v1/models`): image,
 * video, music/podcast and transcription models, with each model's declared
 * capabilities and price. Chat models and models the client drives itself
 * (`internal_role`) are left out.
 *
 * Video capabilities follow the gateway's `video` block: model-level limits plus
 * the versioned per-mode declarations (`modes_schema_version: 1`). A mode the
 * model does not list is unsupported; an unknown schema version makes the model
 * unusable rather than guessed at.
 *
 * Audio capabilities follow the `audio` block: `generation_kind` (music,
 * podcast, speech or transcription), `prompt_field`, `request_fields`,
 * `billing_unit` and the declared limits (references, output formats and their
 * sample rates). An audio model that declares no kind is listed but cannot be
 * chosen for generation: neither its name nor its id decides what it makes.
 * @module dsh-vibedev/gateway/catalog
 */

/** What a media model produces. */
export type MediaKind = 'image' | 'video' | 'audio' | 'transcription'

/** The video generation modes of catalog schema v1, under their wire names. */
export const VIDEO_MODES = ['text_to_video', 'first_frame', 'first_last_frame', 'omni_reference'] as const
export type VideoMode = typeof VIDEO_MODES[number]

/** The inputs a video request can carry, under the gateway's request field names. */
export const VIDEO_INPUTS = ['firstFrame', 'lastFrame', 'referenceImages', 'referenceVideos', 'referenceAudios'] as const
export type VideoInput = typeof VIDEO_INPUTS[number]

/** How many of one input a mode accepts, and whether it must be a gateway-hosted asset. */
export interface VideoInputLimit {
  readonly min: number
  readonly max: number
  /** The input must be uploaded to the gateway media library first. */
  readonly hosted: boolean
}

/** One mode's declaration. Lists that are absent inherit the model-level lists. */
export interface VideoModeConstraint {
  readonly inputs: Partial<Record<VideoInput, VideoInputLimit>>
  /** At least one group must be fully present (each input at least once). Empty: no requirement. */
  readonly requiredAnyOf: readonly (readonly VideoInput[])[]
  readonly ratios?: readonly string[]
  readonly resolutions?: readonly string[]
  readonly durations?: readonly number[]
}

/** One allowed duration/ratio/resolution combination. */
export interface VideoCombination {
  readonly duration?: number
  readonly ratio?: string
  readonly resolution?: string
}

/** A video model's declared capabilities. */
export interface VideoCapabilities {
  /**
   * Per-mode declarations. `undefined` for a legacy entry without modes, whose
   * modes are derived from the model-level fields by {@link effectiveVideoModes}.
   */
  readonly modes?: Partial<Record<VideoMode, VideoModeConstraint>>
  /** A modes block was present but its schema version is not one this plugin reads. */
  readonly unreadableModesVersion?: number
  readonly ratios?: readonly string[]
  readonly resolutions?: readonly string[]
  readonly durations?: readonly number[]
  readonly combinations?: readonly VideoCombination[]
  readonly nativeAudio?: boolean
  readonly textToVideo?: boolean
  readonly imageToVideo?: boolean
  readonly firstFrame?: boolean
  readonly lastFrame?: boolean
  readonly maxReferenceImages?: number
  readonly maxReferenceVideos?: number
  readonly maxReferenceAudios?: number
  readonly allowedImageMimes?: readonly string[]
  readonly allowedVideoMimes?: readonly string[]
  readonly allowedAudioMimes?: readonly string[]
  readonly maxReferenceImageBytes?: number
  readonly maxReferenceVideoBytes?: number
  readonly maxReferenceAudioBytes?: number
  readonly maxAssetBytes?: number
  readonly minReferenceVideoSeconds?: number
  readonly maxReferenceVideoSeconds?: number
  readonly maxTotalReferenceVideoSeconds?: number
  /**
   * Declared limits on a reference AUDIO's own measured length. They are read
   * from the model, never assumed: a lane that declares nothing is not held to
   * another lane's range (some providers take 1–15 s, others take minutes).
   */
  readonly minReferenceAudioSeconds?: number
  readonly maxReferenceAudioSeconds?: number
  /** References must be relayed through the gateway media library. */
  readonly gatewayRelayRequired?: boolean
}

/**
 * What a price is charged per: one generation, one second of output, one
 * second of ORIGINAL audio (speech is billed on the provider's original length,
 * not on what plays back after processing), or one minute of input audio.
 */
export type PriceUnit = 'generation' | 'second' | 'original_second' | 'minute'

/** One price tier: video tiers are resolutions (`720p`), image tiers size buckets (`1K`). */
export interface MediaPriceTier {
  readonly tier: string
  readonly unit: PriceUnit
  readonly amount: number
}

/** A model's selling price, account multiplier included. */
export interface MediaPricing {
  readonly currency: string
  readonly tiers: readonly MediaPriceTier[]
  readonly default?: { readonly unit: PriceUnit; readonly amount: number }
}

/**
 * One video Token price rule (`video_pricing.rules[]`). A condition that is
 * absent matches anything; `false` means the request must carry none of that
 * reference, `true` at least one. First and last frames count as images.
 */
export interface VideoTokenRule {
  /** The exact resolution tier, such as `480p`. */
  readonly resolution: string
  readonly referenceVideo?: boolean
  readonly referenceAudio?: boolean
  readonly referenceImage?: boolean
  /** The final selling price: CNY per 1,000,000 billable video Tokens (>= 0). */
  readonly pricePerMillionTokensCny: number
  /** The provisional estimate per second of output plus reference video; absent is unknown, never zero. */
  readonly estimatedPricePerSecondCny?: number
}

/**
 * A video model's Token pricing (`video_pricing`, schema 1): the charge is the
 * provider's billable video Tokens times the matching rule's price; the
 * per-second figure only estimates it before the task runs.
 */
export interface VideoTokenPricing {
  readonly schemaVersion: 1
  readonly currency: 'CNY'
  readonly finalBasis: 'provider_tokens'
  readonly estimateBasis: 'output_plus_reference_video_seconds'
  readonly estimateOnly: boolean
  readonly rules: readonly VideoTokenRule[]
}

/** Why a model's `video_pricing` cannot be used: a schema this plugin does not read, or a malformed object. */
export type VideoPricingIssue = 'unknown-schema' | 'invalid'

/** What an audio model does, as the catalog declares it (`audio.generation_kind`). */
export const AUDIO_GENERATION_KINDS = ['music', 'podcast', 'speech', 'transcription'] as const
export type AudioGenerationKind = typeof AUDIO_GENERATION_KINDS[number]

/** How an audio model is billed (`audio.billing_unit`). */
export type AudioBillingUnit = 'generation' | 'original_second' | 'minute'

/** The reference audio a speech model takes (a voice to imitate), as the catalog declares it. */
export interface AudioReferenceLimits {
  readonly min: number
  readonly max: number
  readonly maxBytes?: number
  readonly minSeconds?: number
  readonly maxSeconds?: number
  readonly maxTotalSeconds?: number
  /** Accepted MIME types; absent states no restriction. */
  readonly mimes?: readonly string[]
  /** Request fields that may not be sent together with references. */
  readonly exclusiveWith?: readonly string[]
  /** The media-library purpose references are uploaded under, when the catalog names one. */
  readonly purpose?: string
}

/** One output format a speech model can write, with the sample rates it takes in that format. */
export interface AudioOutputFormat {
  readonly format: string
  readonly sampleRates: readonly number[]
  readonly defaultSampleRate?: number
}

/**
 * An audio model's declared capabilities. Nothing here is assumed: a field the
 * catalog does not declare is absent, and a model without `generationKind`
 * cannot be chosen for any kind of generation.
 */
export interface AudioCapabilities {
  readonly generationKind?: AudioGenerationKind
  /** The request field the main text goes in (`prompt`, `text_prompt`, …). */
  readonly promptField?: string
  /** The request fields the model accepts, under their wire names. */
  readonly requestFields: readonly string[]
  readonly billingUnit?: AudioBillingUnit
  readonly references?: AudioReferenceLimits
  readonly outputFormats?: readonly AudioOutputFormat[]
  readonly defaultFormat?: string
  /** Declared choices for enumerated fields (`gender`, `genre`, …), under their wire names. */
  readonly choices?: Readonly<Record<string, readonly string[]>>
  readonly maxPromptChars?: number
  /** Transcription input limits. */
  readonly maxInputBytes?: number
  readonly maxInputSeconds?: number
  readonly inputMimes?: readonly string[]
  readonly languages?: readonly string[]
}

/** One media model of the catalog. */
export interface MediaModel {
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly kind: MediaKind
  /** Other ids the gateway answers to for this model. */
  readonly aliases?: readonly string[]
  /** For audio models: what they produce, from `audio.generation_kind` only; absent when undeclared. */
  readonly audioKind?: Exclude<AudioGenerationKind, 'transcription'>
  /** Endpoints the catalog lists for the model. */
  readonly endpoints: readonly string[]
  readonly inputModalities: readonly string[]
  readonly pricing?: MediaPricing
  /** Video Token pricing (`video_pricing`); a model with it is never quoted from `pricing`. */
  readonly videoPricing?: VideoTokenPricing
  /**
   * Set instead of `videoPricing` when the catalog sends `video_pricing` this plugin
   * cannot use. Such a model has no estimate at all: it never falls back to `pricing`.
   */
  readonly videoPricingIssue?: VideoPricingIssue
  readonly video?: VideoCapabilities
  readonly audio?: AudioCapabilities
}

type Json = Record<string, unknown>

const record = (value: unknown): Json | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Json : undefined

const text = (value: unknown): string | undefined => typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined

const strings = (value: unknown): string[] | undefined =>
  Array.isArray(value) && value.every(item => typeof item === 'string') ? value as string[] : undefined

const count = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined

const positive = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined

/** Read a field under its snake_case name, falling back to camelCase. */
function field(raw: Json, snake: string): unknown {
  if (Object.hasOwn(raw, snake)) return raw[snake]
  const camel = snake.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase())
  return raw[camel]
}

function bool(raw: Json, snake: string): boolean | undefined {
  const value = field(raw, snake)
  return typeof value === 'boolean' ? value : undefined
}

function list(raw: Json, snake: string): string[] | undefined {
  const value = strings(field(raw, snake))
  return value === undefined ? undefined : value.map(item => item.trim()).filter(item => item !== '')
}

function durationList(value: unknown): number[] | undefined {
  return Array.isArray(value) && value.every(item => positive(item) !== undefined) ? [...value as number[]] : undefined
}

/**
 * Parse the versioned modes block of a `video` capability block.
 * @param raw - the `video` block.
 * @returns the modes, an unreadable version, or nothing when the block declares no modes.
 */
function parseModes(raw: Json): Pick<VideoCapabilities, 'modes' | 'unreadableModesVersion'> {
  const version = field(raw, 'modes_schema_version')
  const modesRaw = raw.modes
  if (version === undefined && modesRaw === undefined) return {}
  if (version !== 1 || record(modesRaw) === undefined) return { unreadableModesVersion: typeof version === 'number' ? version : 0 }
  const modes: Partial<Record<VideoMode, VideoModeConstraint>> = {}
  for (const mode of VIDEO_MODES) {
    const entry = record((modesRaw as Json)[mode])
    if (entry === undefined) continue
    const inputsRaw = record(entry.inputs) ?? {}
    const inputs: Partial<Record<VideoInput, VideoInputLimit>> = {}
    for (const [key, limitRaw] of Object.entries(inputsRaw)) {
      const limit = record(limitRaw)
      const min = count(limit?.min)
      const max = count(limit?.max)
      if (!(VIDEO_INPUTS as readonly string[]).includes(key) || limit === undefined || min === undefined || max === undefined || min > max) {
        return { unreadableModesVersion: 1 }
      }
      inputs[key as VideoInput] = { min, max, hosted: limit.source === 'gateway_media_asset' }
    }
    const groupsRaw = field(entry, 'required_any_of')
    const requiredAnyOf: VideoInput[][] = []
    if (Array.isArray(groupsRaw)) {
      for (const group of groupsRaw) {
        const keys = strings(group)
        if (keys === undefined || keys.length === 0 || !keys.every(key => (inputs[key as VideoInput]?.max ?? 0) > 0)) {
          return { unreadableModesVersion: 1 }
        }
        requiredAnyOf.push(keys as VideoInput[])
      }
    }
    const ratios = list(entry, 'ratios')
    const resolutions = list(entry, 'resolutions')
    const durations = durationList(field(entry, 'durations_seconds'))
    modes[mode] = {
      inputs, requiredAnyOf,
      ...ratios === undefined ? {} : { ratios },
      ...resolutions === undefined ? {} : { resolutions },
      ...durations === undefined ? {} : { durations },
    }
  }
  return { modes }
}

/**
 * Parse a `video` capability block (or the legacy video fields inside `capabilities`).
 * @param raw - the block.
 * @returns the capabilities found.
 */
export function parseVideoCapabilities(raw: Json): VideoCapabilities {
  const result: Record<string, unknown> = { ...parseModes(raw) }
  const booleans: Array<[keyof VideoCapabilities, string]> = [
    ['textToVideo', 'text_to_video'], ['imageToVideo', 'image_to_video'], ['firstFrame', 'first_frame'],
    ['lastFrame', 'last_frame'], ['nativeAudio', 'native_audio_output'], ['gatewayRelayRequired', 'gateway_relay_required'],
  ]
  for (const [key, snake] of booleans) {
    const value = bool(raw, snake)
    if (value !== undefined) result[key] = value
  }
  const references: Array<[keyof VideoCapabilities, string, string]> = [
    ['maxReferenceImages', 'max_reference_images', 'reference_image_input'],
    ['maxReferenceVideos', 'max_reference_videos', 'reference_video_input'],
    ['maxReferenceAudios', 'max_reference_audios', 'reference_audio_input'],
  ]
  for (const [key, maxSnake, enabledSnake] of references) {
    const enabled = bool(raw, enabledSnake)
    const max = count(field(raw, maxSnake))
    if (enabled === false) result[key] = 0
    else if (max !== undefined) result[key] = max
  }
  // The catalog's own names first, then the names `/v1/models` flattens into `capabilities`.
  for (const [key, ...names] of [['allowedImageMimes', 'allowed_image_mimes'], ['allowedVideoMimes', 'allowed_video_mimes'],
    ['allowedAudioMimes', 'allowed_audio_mimes'], ['ratios', 'ratios', 'supported_aspects', 'aspect_ratios'],
    ['resolutions', 'resolutions', 'supported_resolutions']] as const) {
    const value = names.map(name => list(raw, name)).find(found => found !== undefined && found.length > 0)
    // An empty list states no restriction for MIME types; for ratios/resolutions it means "not declared".
    if (value !== undefined) result[key] = value
  }
  const durations = durationList(field(raw, 'durations_seconds')) ?? durationList(field(raw, 'supported_durations_seconds'))
  if (durations !== undefined && durations.length > 0) result.durations = durations
  for (const [key, snake] of [['maxReferenceImageBytes', 'max_reference_image_bytes'], ['maxReferenceVideoBytes', 'max_reference_video_bytes'],
    ['maxReferenceAudioBytes', 'max_reference_audio_bytes'], ['maxAssetBytes', 'max_asset_bytes'],
    ['minReferenceVideoSeconds', 'min_reference_video_duration_seconds'], ['maxReferenceVideoSeconds', 'max_reference_video_duration_seconds'],
    ['minReferenceAudioSeconds', 'min_reference_audio_duration_seconds'], ['maxReferenceAudioSeconds', 'max_reference_audio_duration_seconds'],
    ['maxTotalReferenceVideoSeconds', 'max_total_reference_video_duration_seconds']] as const) {
    const value = positive(field(raw, snake))
    if (value !== undefined) result[key] = value
  }
  const combinationsRaw = raw.combinations
  if (Array.isArray(combinationsRaw)) {
    const combinations: VideoCombination[] = []
    for (const item of combinationsRaw) {
      const entry = record(item)
      if (entry === undefined) continue
      const duration = positive(field(entry, 'duration_seconds'))
      const ratio = text(entry.ratio)
      const resolution = text(entry.resolution)
      combinations.push({
        ...duration === undefined ? {} : { duration },
        ...ratio === undefined ? {} : { ratio },
        ...resolution === undefined ? {} : { resolution },
      })
    }
    if (combinations.length > 0) result.combinations = combinations
  }
  return result as VideoCapabilities
}

/**
 * The modes a model can serve: its declared v1 modes, or for a legacy entry the
 * conservative set its model-level fields imply. An unreadable modes block serves none.
 * @param video - the model's capabilities.
 * @returns the usable modes and their constraints.
 */
export function effectiveVideoModes(video: VideoCapabilities): Partial<Record<VideoMode, VideoModeConstraint>> {
  if (video.unreadableModesVersion !== undefined) return {}
  if (video.modes !== undefined) return video.modes
  const modes: Partial<Record<VideoMode, VideoModeConstraint>> = {}
  if (video.textToVideo !== false) modes.text_to_video = { inputs: {}, requiredAnyOf: [] }
  // `image_to_video` alone is not a first frame: a lane that takes reference images
  // declares it too. Only an explicit `first_frame`, or image-to-video on a lane with
  // no other way to take an image, opens the first-frame mode.
  const images = video.maxReferenceImages ?? 0
  if (video.firstFrame === true || (video.imageToVideo === true && video.firstFrame === undefined && images === 0)) {
    modes.first_frame = { inputs: { firstFrame: { min: 1, max: 1, hosted: false } }, requiredAnyOf: [['firstFrame']] }
  }
  if (video.firstFrame === true && video.lastFrame === true) {
    modes.first_last_frame = {
      inputs: { firstFrame: { min: 1, max: 1, hosted: false }, lastFrame: { min: 1, max: 1, hosted: false } },
      requiredAnyOf: [['firstFrame', 'lastFrame']],
    }
  }
  const videos = video.maxReferenceVideos ?? 0
  const audios = video.maxReferenceAudios ?? 0
  if (images > 0 || videos > 0) {
    const inputs: Partial<Record<VideoInput, VideoInputLimit>> = {}
    const requiredAnyOf: VideoInput[][] = []
    if (images > 0) { inputs.referenceImages = { min: 0, max: images, hosted: false }; requiredAnyOf.push(['referenceImages']) }
    if (videos > 0) {
      inputs.referenceVideos = { min: 0, max: videos, hosted: video.gatewayRelayRequired === true }
      requiredAnyOf.push(['referenceVideos'])
    }
    // Audio is never a reference on its own: it rides an image or a video.
    if (audios > 0) inputs.referenceAudios = { min: 0, max: audios, hosted: false }
    modes.omni_reference = { inputs, requiredAnyOf }
  }
  return modes
}

const PRICE_UNITS: readonly PriceUnit[] = ['generation', 'second', 'original_second', 'minute']

/** The audio block: `entry.audio`, else `capabilities.audio`, else the fields flattened into `capabilities`. */
function audioBlock(entry: Json, capabilities: Json): Json | undefined {
  const own = record(entry.audio) ?? record(capabilities.audio)
  if (own !== undefined) return own
  return field(capabilities, 'generation_kind') !== undefined ? capabilities : undefined
}

function stringChoices(raw: unknown): Record<string, string[]> | undefined {
  const choices = record(raw)
  if (choices === undefined) return undefined
  const out: Record<string, string[]> = {}
  for (const [name, values] of Object.entries(choices)) {
    const items = strings(values)?.map(item => item.trim()).filter(item => item !== '')
    if (items !== undefined && items.length > 0) out[name] = items
  }
  return Object.keys(out).length === 0 ? undefined : out
}

function parseReferenceLimits(raw: Json | undefined): AudioReferenceLimits | undefined {
  if (raw === undefined) return undefined
  const max = count(field(raw, 'max_count')) ?? count(raw.max)
  if (max === undefined || max === 0) return undefined
  const min = count(field(raw, 'min_count')) ?? count(raw.min) ?? 0
  const limits: Record<string, unknown> = { min: Math.min(min, max), max }
  for (const [key, ...names] of [['maxBytes', 'max_bytes', 'max_size_bytes'], ['minSeconds', 'min_duration_seconds', 'min_seconds'],
    ['maxSeconds', 'max_duration_seconds', 'max_seconds'], ['maxTotalSeconds', 'max_total_duration_seconds']] as const) {
    const value = names.map(name => positive(field(raw, name))).find(found => found !== undefined)
    if (value !== undefined) limits[key] = value
  }
  const mimes = list(raw, 'allowed_mimes') ?? list(raw, 'mimes')
  if (mimes !== undefined && mimes.length > 0) limits.mimes = mimes
  const exclusive = list(raw, 'mutually_exclusive_with') ?? list(raw, 'exclusive_with')
  if (exclusive !== undefined && exclusive.length > 0) limits.exclusiveWith = exclusive
  const purpose = text(field(raw, 'asset_purpose')) ?? text(raw.purpose)
  if (purpose !== undefined) limits.purpose = purpose
  return limits as unknown as AudioReferenceLimits
}

/**
 * The output formats, in either declared shape: `output_formats: [{format, sample_rates}]`,
 * or `output_formats: ['wav','mp3']` with `sample_rates: {wav: [...], mp3: [...]}`.
 */
function parseOutputFormats(raw: Json): AudioOutputFormat[] | undefined {
  const declared = field(raw, 'output_formats')
  if (!Array.isArray(declared)) return undefined
  const rates = record(field(raw, 'sample_rates'))
  const formats: AudioOutputFormat[] = []
  for (const item of declared) {
    const entry = record(item)
    const format = (entry === undefined ? text(item) : text(entry.format))?.toLowerCase()
    if (format === undefined || formats.some(known => known.format === format)) continue
    const sampleRates = (entry === undefined ? undefined : field(entry, 'sample_rates')) ?? rates?.[format]
    const valid = Array.isArray(sampleRates) ? sampleRates.filter((rate): rate is number => positive(rate) !== undefined && Number.isInteger(rate)) : []
    const fallback = entry === undefined ? undefined : positive(field(entry, 'default_sample_rate'))
    formats.push({ format, sampleRates: valid, ...fallback !== undefined && valid.includes(fallback) ? { defaultSampleRate: fallback } : {} })
  }
  return formats.length === 0 ? undefined : formats
}

/**
 * Parse an audio capability block.
 * @param raw - the block.
 * @returns the declared capabilities; `generationKind` is absent unless declared.
 */
export function parseAudioCapabilities(raw: Json): AudioCapabilities {
  const kindRaw = text(field(raw, 'generation_kind'))?.toLowerCase()
  const generationKind = (AUDIO_GENERATION_KINDS as readonly string[]).includes(kindRaw ?? '') ? kindRaw as AudioGenerationKind : undefined
  const billingRaw = text(field(raw, 'billing_unit'))?.toLowerCase()
  const billingUnit = billingRaw === 'generation' || billingRaw === 'original_second' || billingRaw === 'minute' ? billingRaw : undefined
  const promptField = text(field(raw, 'prompt_field'))
  const requestFields = list(raw, 'request_fields') ?? []
  const references = parseReferenceLimits(record(field(raw, 'references')) ?? record(field(raw, 'reference_audio')))
  const outputFormats = parseOutputFormats(raw)
  const defaultFormat = text(field(raw, 'default_format'))?.toLowerCase()
  const choices = stringChoices(field(raw, 'choices') ?? field(raw, 'field_options'))
  const result: Record<string, unknown> = { requestFields }
  if (generationKind !== undefined) result.generationKind = generationKind
  if (promptField !== undefined) result.promptField = promptField
  if (billingUnit !== undefined) result.billingUnit = billingUnit
  if (references !== undefined) result.references = references
  if (outputFormats !== undefined) result.outputFormats = outputFormats
  if (defaultFormat !== undefined && outputFormats?.some(format => format.format === defaultFormat) === true) result.defaultFormat = defaultFormat
  if (choices !== undefined) result.choices = choices
  for (const [key, ...names] of [['maxPromptChars', 'max_prompt_chars', 'max_text_chars'], ['maxInputBytes', 'max_input_bytes', 'max_file_bytes'],
    ['maxInputSeconds', 'max_input_seconds', 'max_duration_seconds']] as const) {
    const value = names.map(name => positive(field(raw, name))).find(found => found !== undefined)
    if (value !== undefined) result[key] = value
  }
  const inputMimes = list(raw, 'input_mimes') ?? list(raw, 'allowed_input_mimes')
  if (inputMimes !== undefined && inputMimes.length > 0) result.inputMimes = inputMimes
  const languages = list(raw, 'languages')
  if (languages !== undefined && languages.length > 0) result.languages = languages
  return result as unknown as AudioCapabilities
}

function parsePricing(value: unknown, audioUnit?: AudioBillingUnit): MediaPricing | undefined {
  const raw = record(value)
  if (raw === undefined) return undefined
  // An audio model's price is per its declared billing unit; a price that names none is read in that unit.
  const unit = (item: unknown): PriceUnit | undefined => PRICE_UNITS.includes(item as PriceUnit) ? item as PriceUnit
    : item === undefined && audioUnit !== undefined ? audioUnit : undefined
  const tiers: MediaPriceTier[] = []
  if (Array.isArray(raw.tiers)) {
    for (const entry of raw.tiers) {
      const tier = record(entry)
      const name = text(tier?.tier)
      const tierUnit = unit(tier?.unit)
      const amount = typeof tier?.amount === 'number' && Number.isFinite(tier.amount) && tier.amount >= 0 ? tier.amount : undefined
      if (name !== undefined && tierUnit !== undefined && amount !== undefined) tiers.push({ tier: name, unit: tierUnit, amount })
    }
  }
  const fallback = record(raw.default)
  const fallbackUnit = unit(fallback?.unit)
  const fallbackAmount = typeof fallback?.amount === 'number' && Number.isFinite(fallback.amount) && fallback.amount >= 0 ? fallback.amount : undefined
  if (tiers.length === 0 && (fallbackUnit === undefined || fallbackAmount === undefined)) return undefined
  return {
    currency: text(raw.currency) ?? 'CNY',
    tiers,
    ...fallbackUnit === undefined || fallbackAmount === undefined ? {} : { default: { unit: fallbackUnit, amount: fallbackAmount } },
  }
}

const price = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined

/** A rule condition: `null` or absent is "any", a boolean is kept as it is (false included), anything else is unreadable. */
function condition(raw: Json, snake: string): { value?: boolean } | undefined {
  const value = field(raw, snake)
  if (value === undefined || value === null) return {}
  return typeof value === 'boolean' ? { value } : undefined
}

/**
 * Parse `video_pricing`. Every rule is checked: one unreadable rule makes the
 * whole object unusable, since dropping it could make another rule look unique.
 * @param value - the entry's `video_pricing`.
 * @returns the pricing, the reason it cannot be used, or nothing when the entry has none.
 */
export function parseVideoPricing(value: unknown): { videoPricing?: VideoTokenPricing; videoPricingIssue?: VideoPricingIssue } {
  if (value === undefined || value === null) return {}
  const raw = record(value)
  if (raw === undefined) return { videoPricingIssue: 'invalid' }
  if (field(raw, 'schema_version') !== 1) return { videoPricingIssue: 'unknown-schema' }
  const invalid = { videoPricingIssue: 'invalid' } as const
  const estimateOnly = field(raw, 'estimate_only')
  if (field(raw, 'currency') !== 'CNY' || field(raw, 'final_basis') !== 'provider_tokens'
    || field(raw, 'estimate_basis') !== 'output_plus_reference_video_seconds' || typeof estimateOnly !== 'boolean') return invalid
  const rulesRaw = field(raw, 'rules')
  if (!Array.isArray(rulesRaw) || rulesRaw.length === 0) return invalid
  const rules: VideoTokenRule[] = []
  for (const item of rulesRaw) {
    const entry = record(item)
    if (entry === undefined) return invalid
    const resolution = text(field(entry, 'resolution'))
    const perMillion = price(field(entry, 'price_per_million_tokens'))
    const estimateRaw = field(entry, 'estimated_price_per_second')
    const perSecond = estimateRaw === undefined || estimateRaw === null ? undefined : price(estimateRaw)
    const video = condition(entry, 'reference_video')
    const audio = condition(entry, 'reference_audio')
    const image = condition(entry, 'reference_image')
    if (resolution === undefined || perMillion === undefined || (estimateRaw !== undefined && estimateRaw !== null && perSecond === undefined)
      || video === undefined || audio === undefined || image === undefined) return invalid
    rules.push({
      resolution,
      ...video.value === undefined ? {} : { referenceVideo: video.value },
      ...audio.value === undefined ? {} : { referenceAudio: audio.value },
      ...image.value === undefined ? {} : { referenceImage: image.value },
      pricePerMillionTokensCny: perMillion,
      ...perSecond === undefined ? {} : { estimatedPricePerSecondCny: perSecond },
    })
  }
  return {
    videoPricing: {
      schemaVersion: 1, currency: 'CNY', finalBasis: 'provider_tokens', estimateBasis: 'output_plus_reference_video_seconds',
      estimateOnly, rules,
    },
  }
}

/** Which kind of media model a catalog entry is, or undefined for a chat or internal model. */
function kindOf(entry: Json, capabilities: Json, audio: AudioCapabilities | undefined): MediaKind | undefined {
  if (text(entry.internal_role) !== undefined) return undefined
  // A declared audio kind decides between generation and transcription.
  if (audio?.generationKind === 'transcription') return 'transcription'
  if (audio?.generationKind !== undefined) return 'audio'
  const mediaType = text(entry.media_type)
  if (mediaType === 'video' || mediaType === 'image' || mediaType === 'audio' || mediaType === 'transcription') return mediaType
  if (capabilities.transcription === true || capabilities.realtime_transcription === true) return 'transcription'
  const outputs = strings(capabilities.output_modalities) ?? strings(entry.output_modalities) ?? []
  if (outputs.includes('video') || capabilities.video_generation === true) return 'video'
  if (outputs.includes('image')) return 'image'
  if (outputs.includes('audio') || capabilities.audio_generation === true) return 'audio'
  const endpoints = strings(capabilities.allowed_endpoints) ?? []
  if (endpoints.some(endpoint => endpoint.startsWith('/v1/videos'))) return 'video'
  if (endpoints.some(endpoint => endpoint.startsWith('/v1/images'))) return 'image'
  if (endpoints.includes('/v1/audio/transcriptions')) return 'transcription'
  if (endpoints.includes('/v1/audio/generations')) return 'audio'
  return undefined
}

/**
 * Parse a `/v1/models` body into its media models.
 * @param body - `{data:[...]}` or a bare array.
 * @returns the media models, in catalog order.
 */
export function parseMediaCatalog(body: unknown): MediaModel[] {
  const entries = Array.isArray(body) ? body : record(body)?.data
  if (!Array.isArray(entries)) return []
  const models: MediaModel[] = []
  const seen = new Set<string>()
  for (const item of entries) {
    const entry = record(item)
    const id = text(entry?.id)
    if (entry === undefined || id === undefined || seen.has(id)) continue
    const capabilities = record(entry.capabilities) ?? {}
    const audioRaw = audioBlock(entry, capabilities)
    const audio = audioRaw === undefined ? undefined : parseAudioCapabilities(audioRaw)
    const kind = kindOf(entry, capabilities, audio)
    if (kind === undefined) continue
    seen.add(id)
    const name = text(entry.display_name) ?? id
    const description = text(entry.description)
    const pricing = parsePricing(entry.media_pricing, audio?.billingUnit)
    // Kept apart from `pricing`: a conditional Token price is never turned into a legacy per-second one.
    const { videoPricing, videoPricingIssue } = parseVideoPricing(field(entry, 'video_pricing'))
    const inputModalities = strings(capabilities.input_modalities) ?? strings(entry.input_modalities) ?? []
    const endpoints = strings(capabilities.allowed_endpoints) ?? []
    const aliases = (strings(entry.aliases) ?? []).map(alias => alias.trim()).filter(alias => alias !== '' && alias !== id)
    let video: VideoCapabilities | undefined
    if (kind === 'video') {
      // The dedicated `video` block takes precedence over legacy fields inside `capabilities`.
      video = { ...parseVideoCapabilities(capabilities), ...parseVideoCapabilities(record(entry.video) ?? {}) }
    }
    // What an audio model makes is read from its declaration only, never guessed from its name.
    const audioKind = audio?.generationKind === undefined || audio.generationKind === 'transcription' ? undefined : audio.generationKind
    models.push({
      id, name, kind, endpoints, inputModalities,
      ...aliases.length === 0 ? {} : { aliases },
      ...description === undefined ? {} : { description },
      ...pricing === undefined ? {} : { pricing },
      ...videoPricing === undefined ? {} : { videoPricing },
      ...videoPricingIssue === undefined ? {} : { videoPricingIssue },
      ...video === undefined ? {} : { video },
      ...audio === undefined ? {} : { audio },
      ...audioKind === undefined ? {} : { audioKind },
    })
  }
  return models
}
