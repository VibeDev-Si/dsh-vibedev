/**
 * Audio generation requests — music, podcasts and speech — checked against what
 * the chosen model declares in the catalog's `audio` block, and turned into the
 * body of `POST /v1/audio/generations`.
 *
 * Each kind sends only its own fields:
 *
 * | kind    | wire fields                                                     |
 * | ------- | --------------------------------------------------------------- |
 * | music   | model, prompt, lyrics, genre, mood, gender                      |
 * | podcast | model, prompt, source_url                                       |
 * | speech  | as declared; Seed: model, text_prompt, references, audio_config, watermark |
 *
 * The main text goes in the model's `prompt_field`. A field the model does not
 * declare in `request_fields` is refused before anything is uploaded or charged;
 * music and podcasts never take speech references, output formats, sample rates
 * or a duration. Speech references, formats and sample rates come from the
 * catalog only (count, size, length, mutual exclusions, the sample rates of
 * each format), never from a fixed list.
 * @module dsh-vibedev/audio/request
 */

import { randomUUID } from 'node:crypto'
import type { AudioCapabilities, AudioGenerationKind, MediaModel } from '../gateway/catalog.js'
import { MediaError } from '../gateway/errors.js'
import type { UploadedAsset } from '../gateway/assets.js'
import { quoteAudio } from '../pricing.js'
import type { AudioQuote } from '../pricing.js'
import type { MediaCall, MediaRuntime } from '../runtime.js'
import type { TaskRecord } from '../tasks/store.js'

/** The kinds of audio a generation request makes. */
export type AudioMakeKind = Exclude<AudioGenerationKind, 'transcription'>
export const AUDIO_MAKE_KINDS: readonly AudioMakeKind[] = ['music', 'podcast', 'speech']

/** What to generate. Unset fields are not sent. */
export interface AudioRequest {
  /** What to make; with a named model it must match the model's declared kind. */
  readonly kind?: AudioMakeKind
  /** A model id or alias; otherwise the pinned or first model of the kind. */
  readonly model?: string
  /** The main text: a song description, a podcast topic, or the words to speak. */
  readonly prompt?: string
  /** Music. */
  readonly lyrics?: string
  readonly genre?: string
  readonly mood?: string
  readonly gender?: string
  /** Podcast: an http(s) page for the hosts to discuss. */
  readonly sourceUrl?: string
  /** Speech: reference audio (a voice to imitate) — workspace paths, links or `chat:` attachments. */
  readonly references?: readonly string[]
  /** Speech: an output format the model declares (`wav`, `mp3`, …). */
  readonly format?: string
  /** Speech: a sample rate the model declares for that format. */
  readonly sampleRate?: number
  /** Speech: whether the provider adds its watermark, when the model takes the field. */
  readonly watermark?: boolean
  /** Not an audio-generation parameter; refused for music and podcasts, and for speech unless declared. */
  readonly duration?: number
  /**
   * One user operation's key: the same key always answers with the same task,
   * so a repeated click or a retried call never creates a second one. Letters,
   * digits, `-` and `_`, at most 80. Generated when absent.
   */
  readonly operationId?: string
}

/** The standard wire fields of a kind, for a model that declares none (speech declares its own). */
const STANDARD_FIELDS: Readonly<Record<AudioMakeKind, readonly string[]>> = {
  music: ['model', 'prompt', 'lyrics', 'genre', 'mood', 'gender'],
  podcast: ['model', 'prompt', 'source_url'],
  speech: [],
}

/** Fields that belong to speech only: references, the output format and sample rate, a duration. */
const SPEECH_ONLY = ['references', 'format', 'sampleRate', 'duration'] as const

/** Default limit on one reference file when the catalog states none. */
const DEFAULT_REFERENCE_BYTES = 20 * 1024 * 1024
const OPERATION_ID = /^[\w-]{1,80}$/

const has = (value: string | undefined): value is string => value !== undefined && value.trim() !== ''

/**
 * What an audio model makes, from its declaration only.
 * @param model - the model.
 * @returns the kind, or undefined when the catalog does not declare it.
 */
export function audioKindOf(model: MediaModel): AudioMakeKind | undefined {
  return model.kind === 'audio' ? model.audioKind : undefined
}

/** The wire fields a model takes. */
export function requestFieldsOf(model: MediaModel): readonly string[] {
  const kind = audioKindOf(model)
  const declared = model.audio?.requestFields ?? []
  if (declared.length > 0) return declared
  return kind === undefined ? [] : STANDARD_FIELDS[kind]
}

/** The field the main text goes in. */
export function promptFieldOf(model: MediaModel): string | undefined {
  const declared = model.audio?.promptField
  if (declared !== undefined) return declared
  const fields = requestFieldsOf(model)
  return ['prompt', 'text_prompt', 'text', 'input'].find(name => fields.includes(name))
}

function refuse(message: string, field?: string): never {
  throw new MediaError(message, 'AUDIO_OPTION_INVALID', field === undefined ? {} : { field })
}

/** Check one value against the model's declared choices for a field. */
function checkChoice(audio: AudioCapabilities | undefined, wire: string, value: string): void {
  const choices = audio?.choices?.[wire]
  if (choices !== undefined && !choices.some(choice => choice.toLowerCase() === value.toLowerCase())) {
    refuse(`${wire} "${value}" is not offered by this model; it takes ${choices.join(', ')}.`, wire)
  }
}

/** The output format and sample rate a speech request uses, from the declared formats only. */
export function audioConfigOf(model: MediaModel, format: string | undefined, sampleRate: number | undefined): { format: string; sample_rate?: number } | undefined {
  const formats = model.audio?.outputFormats ?? []
  if (formats.length === 0) {
    if (format !== undefined || sampleRate !== undefined) refuse(`${model.id} declares no output formats, so format and sample_rate cannot be chosen.`, 'format')
    return undefined
  }
  const wanted = format?.trim().toLowerCase()
  const chosen = wanted === undefined || wanted === ''
    ? formats.find(item => item.format === model.audio?.defaultFormat) ?? formats[0]!
    : formats.find(item => item.format === wanted)
  if (chosen === undefined) refuse(`${model.id} writes ${formats.map(item => item.format).join(', ')}, not "${format}".`, 'format')
  if (sampleRate !== undefined) {
    if (chosen.sampleRates.length > 0 && !chosen.sampleRates.includes(sampleRate)) {
      refuse(`${chosen.format.toUpperCase()} from ${model.id} takes a sample rate of ${chosen.sampleRates.join(', ')} Hz, not ${sampleRate}.`, 'sample_rate')
    }
    return { format: chosen.format, sample_rate: sampleRate }
  }
  const fallback = chosen.defaultSampleRate
  return { format: chosen.format, ...fallback === undefined ? {} : { sample_rate: fallback } }
}

/**
 * Check a request against the model and build the body, without references
 * (they are uploaded first; their URLs are added by {@link prepareAudioTask}).
 * @param model - the chosen model.
 * @param request - what to generate.
 * @returns the body without references, and the wire fields the request uses.
 * @throws {@link MediaError} for a field the model does not take, a missing text, or a value outside the declared choices.
 */
export function audioRequestBody(model: MediaModel, request: AudioRequest): Record<string, unknown> {
  const kind = audioKindOf(model)
  if (kind === undefined) {
    throw new MediaError(`${model.id} does not declare what kind of audio it makes, so it cannot be used for generation.`, 'AUDIO_KIND_UNDECLARED', { field: 'model' })
  }
  const audio = model.audio
  const fields = requestFieldsOf(model)
  if (fields.length === 0) {
    throw new MediaError(`${model.id} declares no request fields, so no request can be built for it.`, 'AUDIO_FIELDS_UNDECLARED', { field: 'model' })
  }
  if (kind !== 'speech') {
    for (const name of SPEECH_ONLY) {
      const value = request[name]
      if (value !== undefined && !(Array.isArray(value) && value.length === 0)) {
        refuse(`${name === 'sampleRate' ? 'sample_rate' : name} is for speech; ${kind === 'music' ? 'music' : 'a podcast'} does not take it.`, name)
      }
    }
  }
  const takes = (wire: string) => fields.includes(wire)
  const body: Record<string, unknown> = { model: model.id }
  const promptField = promptFieldOf(model)
  const prompt = request.prompt?.trim()
  if (has(prompt)) {
    if (promptField === undefined) refuse(`${model.id} takes no text prompt.`, 'prompt')
    if (audio?.maxPromptChars !== undefined && [...prompt].length > audio.maxPromptChars) {
      refuse(`The text is ${[...prompt].length} characters; ${model.id} takes at most ${audio.maxPromptChars}.`, promptField)
    }
    body[promptField] = prompt
  }
  const plain: Array<[keyof AudioRequest, string]> = [['lyrics', 'lyrics'], ['genre', 'genre'], ['mood', 'mood'], ['gender', 'gender'], ['sourceUrl', 'source_url']]
  for (const [key, wire] of plain) {
    const value = (request[key] as string | undefined)?.trim()
    if (!has(value)) continue
    if (!takes(wire)) refuse(`${model.id} does not take ${wire}; it takes ${fields.filter(name => name !== 'model').join(', ')}.`, wire)
    checkChoice(audio, wire, value)
    if (wire === 'source_url' && !/^https?:\/\//i.test(value)) refuse('source_url must be an http(s) link.', wire)
    body[wire] = value
  }
  if (request.duration !== undefined) {
    if (!takes('duration')) refuse(`${model.id} does not take a duration.`, 'duration')
    body.duration = request.duration
  }
  if (request.watermark !== undefined) {
    if (!takes('watermark')) refuse(`${model.id} does not take watermark.`, 'watermark')
    body.watermark = request.watermark
  }
  if (request.format !== undefined || request.sampleRate !== undefined || takes('audio_config')) {
    if (!takes('audio_config')) refuse(`${model.id} does not take an output format or sample rate.`, 'format')
    const config = audioConfigOf(model, request.format, request.sampleRate)
    if (config !== undefined) body.audio_config = config
  }
  if ((request.references?.length ?? 0) > 0 && !takes('references')) refuse(`${model.id} does not take reference audio.`, 'references')
  // What each kind cannot do without.
  if (kind === 'music' && !has(prompt)) {
    throw new MediaError('Music needs a prompt describing the song.', 'AUDIO_PROMPT_REQUIRED', { field: 'prompt' })
  }
  if (kind === 'podcast' && !has(prompt) && body.source_url === undefined) {
    throw new MediaError('A podcast needs a prompt (the topic), a source_url, or both.', 'AUDIO_PROMPT_REQUIRED', { field: 'prompt' })
  }
  if (kind === 'speech' && !has(prompt)) {
    throw new MediaError('Speech needs the text to speak.', 'AUDIO_PROMPT_REQUIRED', { field: promptField ?? 'prompt' })
  }
  return body
}

/** One reference after it was loaded, checked and uploaded. */
interface CheckedReference {
  readonly source: string
  readonly asset: UploadedAsset
}

/** Load, check and upload the reference audio of a speech request; their measured lengths are checked too. */
async function uploadReferences(runtime: MediaRuntime, call: MediaCall, model: MediaModel, sources: readonly string[], body: Record<string, unknown>): Promise<CheckedReference[]> {
  const limits = model.audio?.references
  if (limits === undefined) refuse(`${model.id} does not take reference audio.`, 'references')
  if (sources.length < limits.min || sources.length > limits.max) {
    refuse(limits.min === limits.max ? `${model.id} takes exactly ${limits.max} reference audio file(s); ${sources.length} were given.`
      : `${model.id} takes ${limits.min}–${limits.max} reference audio file(s); ${sources.length} were given.`, 'references')
  }
  const clash = (limits.exclusiveWith ?? []).filter(name => body[name] !== undefined)
  if (clash.length > 0) refuse(`Reference audio cannot be combined with ${clash.join(', ')} on ${model.id}.`, 'references')
  const maxBytes = limits.maxBytes ?? DEFAULT_REFERENCE_BYTES
  const loaded = []
  for (const source of sources) {
    const media = await runtime.load(call, source, 'audio', maxBytes)
    if (limits.mimes !== undefined && !limits.mimes.includes(media.mime)) {
      throw new MediaError(`"${media.source}" is ${media.mime}; ${model.id} takes reference audio as ${limits.mimes.join(', ')}.`, 'REFERENCE_MEDIA_TYPE_UNSUPPORTED', { field: 'references' })
    }
    loaded.push(media)
  }
  const checked: CheckedReference[] = []
  let totalSeconds = 0
  for (const media of loaded) {
    // The library refreshes an asset whose link is about to expire, and uploads it again when it cannot.
    const asset = await runtime.library.upload(media, limits.purpose ?? 'audio_reference', call.signal)
    const seconds = asset.durationMs === undefined ? undefined : asset.durationMs / 1000
    if (seconds === undefined && (limits.minSeconds !== undefined || limits.maxSeconds !== undefined || limits.maxTotalSeconds !== undefined)) {
      throw new MediaError(`The gateway could not measure the length of "${media.source}". Export it as a standard WAV or MP3 and try again.`, 'REFERENCE_DURATION_UNKNOWN', { field: 'references' })
    }
    if (seconds !== undefined) {
      if (limits.minSeconds !== undefined && seconds < limits.minSeconds) {
        throw new MediaError(`"${media.source}" is ${seconds.toFixed(1)} s; ${model.id} needs reference audio of at least ${limits.minSeconds} s.`, 'REFERENCE_AUDIO_TOO_SHORT', { field: 'references' })
      }
      if (limits.maxSeconds !== undefined && seconds > limits.maxSeconds) {
        throw new MediaError(`"${media.source}" is ${seconds.toFixed(1)} s; ${model.id} takes reference audio of at most ${limits.maxSeconds} s.`, 'REFERENCE_AUDIO_TOO_LONG', { field: 'references' })
      }
      totalSeconds += seconds
    }
    checked.push({ source: media.source, asset })
  }
  if (limits.maxTotalSeconds !== undefined && totalSeconds > limits.maxTotalSeconds) {
    throw new MediaError(`The reference audio adds up to ${totalSeconds.toFixed(1)} s; ${model.id} takes at most ${limits.maxTotalSeconds} s in total.`, 'REFERENCE_TOTAL_TOO_LONG', { field: 'references' })
  }
  return checked
}

/**
 * Choose the model for a request: the one named (an id or an alias), else the
 * pinned or first model of the kind. A named model must make the kind asked for.
 */
export async function chooseAudioModel(runtime: MediaRuntime, request: Pick<AudioRequest, 'kind' | 'model'>, signal?: AbortSignal): Promise<MediaModel> {
  if (request.kind === undefined && !has(request.model)) {
    throw new MediaError('Say what to make (music, podcast or speech), or name a model.', 'AUDIO_KIND_REQUIRED', { field: 'type' })
  }
  if (request.kind !== undefined) return runtime.pickModel('audio', request.kind, request.model, undefined, signal)
  const model = await runtime.findModel(request.model as string, signal)
  if (model.kind !== 'audio') throw new MediaError(`${model.id} is not an audio generation model.`, 'MODEL_KIND_MISMATCH', { field: 'model' })
  if (audioKindOf(model) === undefined) {
    throw new MediaError(`${model.id} does not declare what kind of audio it makes, so it cannot be used for generation.`, 'AUDIO_KIND_UNDECLARED', { field: 'model' })
  }
  return model
}

/** A checked, priced audio task ready to submit. */
export interface PreparedAudio {
  readonly model: MediaModel
  readonly kind: AudioMakeKind
  readonly quote: AudioQuote
  readonly draft: TaskRecord
}

/**
 * Everything before an audio submission: choose the model, check every field
 * against its declaration, upload and measure speech references, price it,
 * confirm the spending, and build the task under the operation's key.
 * @param runtime - the media runtime.
 * @param call - the tool call or host call.
 * @param request - what to generate.
 * @param save - where the result goes.
 * @returns the prepared task.
 */
export async function prepareAudioTask(runtime: MediaRuntime, call: MediaCall, request: AudioRequest,
  save: { readonly folder: string; readonly stem: string }): Promise<PreparedAudio> {
  if (request.operationId !== undefined && !OPERATION_ID.test(request.operationId)) {
    throw new MediaError('operationId may hold only letters, digits, "-" and "_" (at most 80).', 'AUDIO_OPTION_INVALID', { field: 'operationId' })
  }
  const model = await chooseAudioModel(runtime, request, call.signal)
  const kind = audioKindOf(model) as AudioMakeKind
  const body = audioRequestBody(model, request)
  const references = request.references ?? []
  if (references.length > 0) {
    const checked = await uploadReferences(runtime, call, model, references, body)
    body.references = checked.map(item => item.asset.referenceUrl)
  } else if ((model.audio?.references?.min ?? 0) > 0) {
    refuse(`${model.id} needs at least ${model.audio?.references?.min} reference audio file(s).`, 'references')
  }
  const quote = quoteAudio(model)
  const what = { music: { en: 'a song', zh: '一首音乐' }, podcast: { en: 'a podcast episode', zh: '一期播客' }, speech: { en: 'speech', zh: '一段语音' } }[kind]
  await runtime.confirmSpending(call, 'audio_generate', {
    en: `Generate ${what.en} with ${model.id}: ${quote.basis.en}.`,
    zh: `用 ${model.id} 生成${what.zh}：${quote.basis.zh}。`,
  })
  const now = runtime.now()
  const prompt = request.prompt?.trim()
  const draft: TaskRecord = {
    id: request.operationId ?? randomUUID(), kind: 'audio', model: model.id,
    label: excerptOf(prompt ?? request.sourceUrl ?? kind), createdAt: now, updatedAt: now,
    ...call.agent === undefined ? {} : { owner: call.agent.id },
    outputDir: save.folder, stem: save.stem, endpoint: '/v1/audio/generations', body, status: 'submitting',
    audioKind: kind,
    ...quote.amountCny === undefined ? {} : { estimatedCny: quote.amountCny.toFixed(2) },
    ...quote.unit === undefined ? {} : { billing: { unit: quote.unit, ...quote.unitPriceCny === undefined ? {} : { unitPriceCny: String(quote.unitPriceCny) } } },
  }
  return { model, kind, quote, draft }
}

function excerptOf(text: string, max = 60): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  const chars = [...flat]
  return chars.length <= max ? flat : `${chars.slice(0, max - 1).join('')}…`
}

/** One field of an audio form, for interfaces that build their form from the catalog. */
export interface AudioFormField {
  /** The {@link AudioRequest} key. */
  readonly key: 'prompt' | 'lyrics' | 'genre' | 'mood' | 'gender' | 'sourceUrl' | 'references' | 'format' | 'sampleRate' | 'watermark'
  /** The wire field it is sent as. */
  readonly wire: string
  readonly required: boolean
  /** Declared choices. */
  readonly choices?: readonly string[]
  /** For `sampleRate`: the rates of each format. */
  readonly sampleRates?: Readonly<Record<string, readonly number[]>>
  /** For `references`: the declared limits. */
  readonly limits?: NonNullable<AudioCapabilities['references']>
  readonly maxChars?: number
}

/** What a form for one audio model shows. */
export interface AudioForm {
  readonly model: string
  readonly name: string
  readonly kind: AudioMakeKind
  readonly fields: readonly AudioFormField[]
  readonly price: AudioQuote
  readonly defaultFormat?: string
}

/**
 * The form an interface shows for one model: only the fields the model
 * declares, with their declared choices and limits.
 * @param model - the model.
 * @returns the form, or undefined for a model that cannot generate audio.
 */
export function audioFormOf(model: MediaModel): AudioForm | undefined {
  const kind = audioKindOf(model)
  if (kind === undefined) return undefined
  const fields = requestFieldsOf(model)
  if (fields.length === 0) return undefined
  const audio = model.audio
  const out: AudioFormField[] = []
  const promptField = promptFieldOf(model)
  if (promptField !== undefined) {
    out.push({ key: 'prompt', wire: promptField, required: kind !== 'podcast', ...audio?.maxPromptChars === undefined ? {} : { maxChars: audio.maxPromptChars } })
  }
  const plain: Array<[AudioFormField['key'], string]> = [['lyrics', 'lyrics'], ['genre', 'genre'], ['mood', 'mood'], ['gender', 'gender'], ['sourceUrl', 'source_url']]
  for (const [key, wire] of plain) {
    if (!fields.includes(wire)) continue
    const choices = audio?.choices?.[wire]
    out.push({ key, wire, required: false, ...choices === undefined ? {} : { choices } })
  }
  if (kind === 'speech') {
    if (fields.includes('references') && audio?.references !== undefined) {
      out.push({ key: 'references', wire: 'references', required: audio.references.min > 0, limits: audio.references })
    }
    const formats = audio?.outputFormats ?? []
    if (fields.includes('audio_config') && formats.length > 0) {
      out.push({ key: 'format', wire: 'audio_config.format', required: false, choices: formats.map(item => item.format) })
      const rates = Object.fromEntries(formats.filter(item => item.sampleRates.length > 0).map(item => [item.format, item.sampleRates]))
      if (Object.keys(rates).length > 0) out.push({ key: 'sampleRate', wire: 'audio_config.sample_rate', required: false, sampleRates: rates })
    }
    if (fields.includes('watermark')) out.push({ key: 'watermark', wire: 'watermark', required: false })
  }
  return {
    model: model.id, name: model.name, kind, fields: out, price: quoteAudio(model),
    ...audio?.defaultFormat === undefined ? {} : { defaultFormat: audio.defaultFormat },
  }
}
