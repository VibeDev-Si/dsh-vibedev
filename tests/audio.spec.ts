/**
 * Gateway audio against a simulated gateway: model recognition from the
 * structured `audio` block (aliases, new models, undeclared kinds, account
 * switches), per-kind request fields, speech references and output formats,
 * price units, idempotent submission, task recovery, settlement, cancellation,
 * expired-link refresh and the saved result.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { audioFormOf, audioRequestBody, prepareAudioTask } from '../src/audio/request.js'
import { MediaLibrary } from '../src/gateway/assets.js'
import { parseMediaCatalog } from '../src/gateway/catalog.js'
import { MediaError } from '../src/gateway/errors.js'
import { GatewayHttp } from '../src/gateway/http.js'
import { describePrice, quoteAudio } from '../src/pricing.js'
import { MediaRuntime } from '../src/runtime.js'
import type { ModelSlot } from '../src/runtime.js'
import { MediaHostService } from '../src/service.js'
import { TaskStore } from '../src/tasks/store.js'
import { TaskTracker } from '../src/tasks/tracker.js'
import { AUDIO_CATALOG, MP3, SEED_SPEECH_AUDIO, WAV } from './fixtures.js'
import { json } from './helpers.js'

const ORIGIN = 'https://api.vibedev.test'
const MEDIA = 'https://media.vibedev.test'

let dir: string
let workspace: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-audio-'))
  workspace = join(dir, 'ws')
  await mkdir(workspace, { recursive: true })
})
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

interface Seen { readonly method: string; readonly url: string; readonly headers: Record<string, string>; readonly body: unknown }
type Handler = (request: Seen) => Response | Promise<Response>

/** A simulated gateway: routes by `METHOD URL`, each a handler or a queue of answers; every request is recorded. */
class Gateway {
  readonly seen: Seen[] = []
  private readonly routes = new Map<string, Handler | Handler[]>()
  catalog: unknown = AUDIO_CATALOG

  constructor() {
    this.on('GET', `${ORIGIN}/v1/models`, () => json(200, this.catalog))
  }

  on(method: string, url: string, ...answers: Handler[]): this {
    this.routes.set(`${method} ${url}`, answers.length === 1 ? answers[0] as Handler : answers)
    return this
  }

  count(method: string, url: string): number {
    return this.seen.filter(request => request.method === method && request.url === url).length
  }

  readonly fetch = (async (input: string | URL, init?: RequestInit) => {
    const headers = { ...init?.headers as Record<string, string> | undefined }
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : init?.body
    const request: Seen = { method: init?.method ?? 'GET', url: String(input), headers, body }
    this.seen.push(request)
    const route = this.routes.get(`${request.method} ${request.url}`)
    if (route === undefined) throw new Error(`no route for ${request.method} ${request.url}`)
    const handler = Array.isArray(route) ? (route.length > 1 ? route.shift() : route[0]) : route
    if (handler === undefined) throw new Error(`no answer left for ${request.method} ${request.url}`)
    return handler(request)
  }) as typeof globalThis.fetch
}

/** A runtime, tracker and host service on the simulated gateway, whose sleeps advance a clock instead of waiting. */
function setup(gateway: Gateway, options: { store?: TaskStore; pinned?: Partial<Record<ModelSlot, string>> } = {}) {
  const clock = { now: Date.parse('2026-10-11T09:00:00Z') }
  const now = () => clock.now
  const http = new GatewayHttp({ origin: ORIGIN, userAgent: 'vibedev-plugin/test', fetch: gateway.fetch, resolveCredential: async () => ({ token: 'app-token', kind: 'plugin' }), sleep: async () => {} })
  const store = options.store ?? new TaskStore(join(dir, 'state'), now)
  const tracker = new TaskTracker({ http, store, now, sleep: async (ms) => { clock.now += ms } })
  const runtime = new MediaRuntime({
    http, store, tracker, stateDir: join(dir, 'state'), now, library: new MediaLibrary(http, now),
    settings: { outputDir: () => 'media', confirmSpending: () => false, defaultModel: slot => options.pinned?.[slot] ?? '' },
  })
  const service = new MediaHostService(runtime, 'test')
  const target = { cwd: workspace, folder: join(workspace, 'media', 'audio'), stem: 'clip' }
  return { http, store, tracker, runtime, service, clock, target }
}

const signal = () => new AbortController().signal
const models = parseMediaCatalog(AUDIO_CATALOG)
const model = (id: string) => {
  const found = models.find(item => item.id === id)
  if (found === undefined) throw new Error(`missing ${id}`)
  return found
}
const errorCode = async (run: () => Promise<unknown> | unknown): Promise<string | undefined> => {
  try { await run() } catch (error) { return error instanceof MediaError ? error.code : String(error) }
  return undefined
}

/** A WAV file of `seconds` seconds (mono 16-bit 16 kHz), with a valid header. */
function wav(seconds: number): Uint8Array {
  const rate = 16_000
  const bytes = Math.round(seconds * rate * 2)
  const data = new Uint8Array(44 + bytes)
  const view = new DataView(data.buffer)
  data.set(WAV.subarray(0, 4), 0); view.setUint32(4, 36 + bytes, true); data.set([0x57, 0x41, 0x56, 0x45, 0x66, 0x6d, 0x74, 0x20], 8)
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, rate, true)
  view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true)
  data.set([0x64, 0x61, 0x74, 0x61], 36); view.setUint32(40, bytes, true)
  return data
}

/** The media library: every upload lands as an asset whose measured length the test names per file name. */
function library(gateway: Gateway, lengths: Record<string, number>): void {
  let next = 0
  const assets = new Map<string, { name: string; type: string }>()
  gateway.on('POST', `${ORIGIN}/v1/media-assets/uploads`, (request) => {
    const body = request.body as { filename: string; content_type: string; purpose: string }
    const id = `ma_${++next}`
    assets.set(id, { name: body.filename, type: body.content_type })
    gateway.on('PUT', `${MEDIA}/put/${id}`, () => new Response(null, { status: 200 }))
    gateway.on('POST', `${ORIGIN}/v1/media-assets/${id}/complete`, () => json(200, {
      asset_id: id, reference_url: `${MEDIA}/v1/media-assets/${id}/content?sig=ref`, content_type: body.content_type,
      expires_at: '2026-10-12T09:00:00Z',
      ...lengths[body.filename] === undefined ? {} : { duration_ms: lengths[body.filename]! * 1000 },
    }))
    return json(200, { asset_id: id, upload_required: true, upload_url: `${MEDIA}/put/${id}`, upload_headers: { 'x-oss-meta': 'owner' } })
  })
}

describe('audio catalog: what a model makes comes from its declaration', () => {
  it('reads music, podcast, speech and transcription from audio.generation_kind, never from the name', () => {
    expect(models.map(item => [item.id, item.kind, item.audioKind])).toEqual([
      ['podcast-style-music-vibedev', 'audio', 'music'],
      ['doubao-podcast-vibedev', 'audio', 'podcast'],
      ['seed-tts-2.0-vibedev', 'audio', 'speech'],
      ['brand-new-music-2027', 'audio', 'music'],
      ['mystery-audio', 'audio', undefined],
      ['doubao-asr-vibedev', 'transcription', undefined],
    ])
    expect(model('seed-tts-2.0-vibedev')).toMatchObject({
      aliases: ['seed-tts', 'seed-tts-latest'],
      audio: {
        generationKind: 'speech', promptField: 'text_prompt', billingUnit: 'original_second', maxPromptChars: 300,
        requestFields: ['model', 'text_prompt', 'references', 'audio_config', 'watermark'], defaultFormat: 'mp3',
        references: { min: 0, max: 2, maxBytes: 5 * 1024 * 1024, minSeconds: 3, maxSeconds: 30, maxTotalSeconds: 40, mimes: ['audio/wav', 'audio/mpeg'], exclusiveWith: ['voice_id'] },
        outputFormats: [{ format: 'wav', sampleRates: [16000, 24000, 48000], defaultSampleRate: 24000 }, { format: 'mp3', sampleRates: [24000, 32000], defaultSampleRate: 24000 }],
      },
      pricing: { default: { unit: 'original_second', amount: 0.015 } },
    })
    expect(model('doubao-asr-vibedev').audio).toMatchObject({ generationKind: 'transcription', billingUnit: 'minute', maxInputBytes: 20_000_000, maxInputSeconds: 600, languages: ['zh'] })
  })

  it('never treats an undeclared audio model as music, and tells why when it is named', async () => {
    const gateway = new Gateway()
    const { runtime } = setup(gateway)
    expect((await runtime.pickModel('audio', 'music', undefined, undefined, signal())).id).toBe('podcast-style-music-vibedev')
    expect(await errorCode(() => runtime.pickModel('audio', 'music', 'mystery-audio', undefined, signal()))).toBe('AUDIO_KIND_UNDECLARED')
    expect(await errorCode(() => prepareAudioTask(runtime, { signal: signal(), cwd: workspace }, { model: 'mystery-audio', prompt: 'x' }, { folder: workspace, stem: 's' }))).toBe('AUDIO_KIND_UNDECLARED')
    expect(audioFormOf(model('mystery-audio'))).toBeUndefined()
    // A catalog without any declared music model offers no music, rather than guessing one.
    gateway.catalog = { data: [AUDIO_CATALOG.data[5]] }
    runtime.accountChanged()
    expect(await errorCode(() => runtime.pickModel('audio', 'music', undefined, undefined, signal()))).toBe('NO_MODEL_AVAILABLE')
  })

  it('resolves aliases and models it has never seen, without a list of known ids', async () => {
    const { runtime } = setup(new Gateway(), { pinned: { speech: 'seed-tts' } })
    expect((await runtime.findModel('seed-tts', signal())).id).toBe('seed-tts-2.0-vibedev')
    expect((await runtime.pickModel('audio', 'speech', 'SEED-TTS-LATEST', undefined, signal())).id).toBe('seed-tts-2.0-vibedev')
    // A pinned alias is honoured too.
    expect((await runtime.pickModel('audio', 'speech', undefined, undefined, signal())).id).toBe('seed-tts-2.0-vibedev')
    expect((await runtime.pickModel('audio', 'music', 'brand-new-music-2027', undefined, signal())).id).toBe('brand-new-music-2027')
    // Transcription is its own kind: never offered for generation.
    expect(await errorCode(() => runtime.pickModel('audio', 'speech', 'doubao-asr-vibedev', undefined, signal()))).toBe('MODEL_KIND_MISMATCH')
  })

  it('reads the catalog again after a sign-in, sign-out or account switch, and drops a list fetched for the previous account', async () => {
    const gateway = new Gateway()
    const { runtime } = setup(gateway)
    expect((await runtime.models()).map(item => item.id)).toContain('seed-tts-2.0-vibedev')
    expect(gateway.count('GET', `${ORIGIN}/v1/models`)).toBe(1)
    await runtime.models()
    expect(gateway.count('GET', `${ORIGIN}/v1/models`)).toBe(1)
    // The other account has only the podcast model.
    gateway.catalog = { data: [AUDIO_CATALOG.data[2]] }
    runtime.accountChanged()
    expect((await runtime.models()).map(item => item.id)).toEqual(['doubao-podcast-vibedev'])
    expect(gateway.count('GET', `${ORIGIN}/v1/models`)).toBe(2)
    // A list still in flight when the account changes is not kept for the new account.
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    gateway.on('GET', `${ORIGIN}/v1/models`, async () => { await held; return json(200, AUDIO_CATALOG) })
    runtime.accountChanged()
    const stale = runtime.models()
    runtime.accountChanged()
    gateway.on('GET', `${ORIGIN}/v1/models`, () => json(200, { data: [AUDIO_CATALOG.data[1]] }))
    release()
    await stale
    expect((await runtime.models()).map(item => item.id)).toEqual(['podcast-style-music-vibedev'])
  })
})

describe('audio requests: each kind sends only its own fields', () => {
  it('music: model, prompt, lyrics, genre, mood, gender, within the declared choices', () => {
    const music = model('podcast-style-music-vibedev')
    expect(audioRequestBody(music, { kind: 'music', prompt: ' upbeat folk ', lyrics: 'la la', genre: 'folk', mood: 'happy', gender: 'female' }))
      .toEqual({ model: 'podcast-style-music-vibedev', prompt: 'upbeat folk', lyrics: 'la la', genre: 'folk', mood: 'happy', gender: 'female' })
    const code = (request: Parameters<typeof audioRequestBody>[1]) => { try { audioRequestBody(music, request); return undefined } catch (error) { return (error as MediaError).code } }
    expect(code({ prompt: 'x', gender: 'robot' })).toBe('AUDIO_OPTION_INVALID')
    expect(code({ prompt: 'x', sourceUrl: 'https://a.test' })).toBe('AUDIO_OPTION_INVALID')
    // Speech parameters never apply to music.
    expect(code({ prompt: 'x', references: ['a.wav'] })).toBe('AUDIO_OPTION_INVALID')
    expect(code({ prompt: 'x', format: 'wav' })).toBe('AUDIO_OPTION_INVALID')
    expect(code({ prompt: 'x', sampleRate: 24000 })).toBe('AUDIO_OPTION_INVALID')
    expect(code({ prompt: 'x', duration: 30 })).toBe('AUDIO_OPTION_INVALID')
    expect(code({ lyrics: 'only lyrics' })).toBe('AUDIO_PROMPT_REQUIRED')
    expect(audioFormOf(music)?.fields.map(field => [field.key, field.wire])).toEqual([
      ['prompt', 'prompt'], ['lyrics', 'lyrics'], ['genre', 'genre'], ['mood', 'mood'], ['gender', 'gender'],
    ])
    expect(audioFormOf(music)?.fields.find(field => field.key === 'gender')?.choices).toEqual(['male', 'female'])
  })

  it('podcast: model, prompt, source_url — and a prompt or a link is needed', () => {
    const podcast = model('doubao-podcast-vibedev')
    expect(audioRequestBody(podcast, { prompt: 'AI news', sourceUrl: 'https://news.test/a' })).toEqual({ model: 'doubao-podcast-vibedev', prompt: 'AI news', source_url: 'https://news.test/a' })
    expect(audioRequestBody(podcast, { sourceUrl: 'https://news.test/a' })).toEqual({ model: 'doubao-podcast-vibedev', source_url: 'https://news.test/a' })
    const code = (request: Parameters<typeof audioRequestBody>[1]) => { try { audioRequestBody(podcast, request); return undefined } catch (error) { return (error as MediaError).code } }
    expect(code({ prompt: 'x', lyrics: 'no' })).toBe('AUDIO_OPTION_INVALID')
    expect(code({ prompt: 'x', format: 'mp3' })).toBe('AUDIO_OPTION_INVALID')
    expect(code({ sourceUrl: 'ftp://x' })).toBe('AUDIO_OPTION_INVALID')
    expect(code({})).toBe('AUDIO_PROMPT_REQUIRED')
    expect(audioFormOf(podcast)?.fields.map(field => field.key)).toEqual(['prompt', 'sourceUrl'])
  })

  it('speech (Seed): text_prompt, audio_config from the declared formats and their own sample rates, watermark', () => {
    const seed = model('seed-tts-2.0-vibedev')
    // No format given: the declared default format at its default rate.
    expect(audioRequestBody(seed, { prompt: '你好', watermark: false })).toEqual({
      model: 'seed-tts-2.0-vibedev', text_prompt: '你好', watermark: false, audio_config: { format: 'mp3', sample_rate: 24000 },
    })
    expect(audioRequestBody(seed, { prompt: '你好', format: 'WAV', sampleRate: 48000 }).audio_config).toEqual({ format: 'wav', sample_rate: 48000 })
    const code = (request: Parameters<typeof audioRequestBody>[1]) => { try { audioRequestBody(seed, request); return undefined } catch (error) { return (error as MediaError).code } }
    // 48 kHz is a WAV rate, not an MP3 one; PCM and Ogg are not declared at all.
    expect(code({ prompt: '你好', format: 'mp3', sampleRate: 48000 })).toBe('AUDIO_OPTION_INVALID')
    expect(code({ prompt: '你好', format: 'pcm' })).toBe('AUDIO_OPTION_INVALID')
    expect(code({ prompt: '你好', format: 'ogg_opus' })).toBe('AUDIO_OPTION_INVALID')
    expect(code({ prompt: '你好', lyrics: 'no' })).toBe('AUDIO_OPTION_INVALID')
    expect(code({ prompt: '你好', duration: 5 })).toBe('AUDIO_OPTION_INVALID')
    expect(code({ prompt: '字'.repeat(301) })).toBe('AUDIO_OPTION_INVALID')
    expect(code({ watermark: true })).toBe('AUDIO_PROMPT_REQUIRED')
    const form = audioFormOf(seed)
    expect(form?.fields.map(field => [field.key, field.wire])).toEqual([
      ['prompt', 'text_prompt'], ['references', 'references'], ['format', 'audio_config.format'], ['sampleRate', 'audio_config.sample_rate'], ['watermark', 'watermark'],
    ])
    expect(form?.fields.find(field => field.key === 'sampleRate')?.sampleRates).toEqual({ wav: [16000, 24000, 48000], mp3: [24000, 32000] })
    expect(form?.defaultFormat).toBe('mp3')
  })

  it('speech references: uploaded to the media library and checked on count, size, type and measured length', async () => {
    const gateway = new Gateway()
    library(gateway, { 'voice.wav': 6, 'short.wav': 2, 'long.wav': 31, 'a.wav': 25, 'b.mp3': 20, 'unmeasured.wav': NaN })
    const { runtime } = setup(gateway)
    // Distinct contents: the library recognizes a file it already holds by its digest.
    for (const [name, data] of [['voice.wav', wav(0.11)], ['short.wav', wav(0.12)], ['long.wav', wav(0.13)], ['a.wav', wav(0.14)], ['b.mp3', MP3], ['c.wav', wav(0.15)], ['big.wav', wav(170)], ['voice.ogg', new Uint8Array([0x4f, 0x67, 0x67, 0x53, 0, 2, 0, 0])], ['unmeasured.wav', wav(0.16)]] as const) {
      await writeFile(join(workspace, name), data)
    }
    const call = { signal: signal(), cwd: workspace }
    const save = { folder: join(workspace, 'out'), stem: 's' }
    const prepared = await prepareAudioTask(runtime, call, { kind: 'speech', prompt: '你好', references: ['voice.wav'] }, save)
    expect(prepared.draft.body).toEqual({
      model: 'seed-tts-2.0-vibedev', text_prompt: '你好', audio_config: { format: 'mp3', sample_rate: 24000 },
      references: [`${MEDIA}/v1/media-assets/ma_1/content?sig=ref`],
    })
    const upload = gateway.seen.find(request => request.url.endsWith('/v1/media-assets/uploads'))
    expect(upload?.body).toMatchObject({ purpose: 'audio_reference', content_type: 'audio/wav', filename: 'voice.wav' })
    expect(upload?.headers.authorization).toBe('Bearer app-token')
    const code = (references: string[]) => errorCode(() => prepareAudioTask(runtime, call, { kind: 'speech', prompt: '你好', references }, save))
    const uploadsBefore = gateway.count('POST', `${ORIGIN}/v1/media-assets/uploads`)
    expect(await code(['a.wav', 'b.mp3', 'c.wav'])).toBe('AUDIO_OPTION_INVALID')
    expect(await code(['big.wav'])).toBe('MEDIA_TOO_LARGE')
    expect(await code(['voice.ogg'])).toBe('REFERENCE_MEDIA_TYPE_UNSUPPORTED')
    // Refused before anything was uploaded.
    expect(gateway.count('POST', `${ORIGIN}/v1/media-assets/uploads`)).toBe(uploadsBefore)
    expect(await code(['short.wav'])).toBe('REFERENCE_AUDIO_TOO_SHORT')
    expect(await code(['long.wav'])).toBe('REFERENCE_AUDIO_TOO_LONG')
    expect(await code(['a.wav', 'b.mp3'])).toBe('REFERENCE_TOTAL_TOO_LONG')
    expect(await code(['unmeasured.wav'])).toBe('REFERENCE_DURATION_UNKNOWN')
  })

  it('speech references: a declared exclusion is enforced, and a model without references refuses them', async () => {
    const exclusive = parseMediaCatalog({ data: [{ id: 'seed-x', media_type: 'audio', audio: { ...SEED_SPEECH_AUDIO, references: { ...SEED_SPEECH_AUDIO.references, mutually_exclusive_with: ['watermark'] } } }] })
    const gateway = new Gateway()
    gateway.catalog = { data: [{ id: 'seed-x', media_type: 'audio', audio: { ...SEED_SPEECH_AUDIO, references: { ...SEED_SPEECH_AUDIO.references, mutually_exclusive_with: ['watermark'] } } }] }
    library(gateway, { 'voice.wav': 6 })
    await writeFile(join(workspace, 'voice.wav'), wav(0.1))
    const { runtime } = setup(gateway)
    expect(exclusive[0]?.audio?.references?.exclusiveWith).toEqual(['watermark'])
    expect(await errorCode(() => prepareAudioTask(runtime, { signal: signal(), cwd: workspace }, { kind: 'speech', prompt: '你好', watermark: true, references: ['voice.wav'] }, { folder: workspace, stem: 's' })))
      .toBe('AUDIO_OPTION_INVALID')
    expect(gateway.count('POST', `${ORIGIN}/v1/media-assets/uploads`)).toBe(0)
    const plain = parseMediaCatalog({ data: [{ id: 'tts-plain', media_type: 'audio', audio: { generation_kind: 'speech', prompt_field: 'text', request_fields: ['model', 'text'] } }] })[0]!
    expect(() => audioRequestBody(plain, { prompt: 'hi', references: ['voice.wav'] })).toThrow(/does not take reference audio/)
    expect(audioRequestBody(plain, { prompt: 'hi' })).toEqual({ model: 'tts-plain', text: 'hi' })
  })
})

describe('audio prices: the gateway quote in yuan, in the right unit', () => {
  it('per generation, per original second, per minute, and 未定价 — never free', () => {
    expect(quoteAudio(model('podcast-style-music-vibedev'))).toMatchObject({ priced: true, unit: 'generation', amountCny: 0.5, label: { zh: '¥0.50/次', en: '¥0.50 per generation' } })
    expect(quoteAudio(model('doubao-podcast-vibedev'))).toMatchObject({ amountCny: 1, label: { zh: '¥1.00/次' } })
    const speech = quoteAudio(model('seed-tts-2.0-vibedev'))
    // Speech is billed on the original length the provider reports: no amount before it runs.
    expect(speech).toMatchObject({ priced: true, unit: 'original_second', unitPriceCny: 0.015, label: { zh: '¥0.015/原始秒' } })
    expect(speech.amountCny).toBeUndefined()
    expect(speech.basis.zh).toContain('原始时长')
    const minutes = quoteAudio(model('doubao-asr-vibedev'), 90)
    expect(minutes).toMatchObject({ unit: 'minute', label: { zh: '¥0.30/分钟' } })
    expect(minutes.amountCny).toBeCloseTo(0.45)
    const unpriced = quoteAudio(model('brand-new-music-2027'))
    expect(unpriced).toMatchObject({ priced: false, label: { zh: '未定价', en: 'not priced' } })
    expect(unpriced.amountCny).toBeUndefined()
    expect(JSON.stringify(unpriced)).not.toMatch(/免费|free|¥0\.00/)
    expect(describePrice(model('brand-new-music-2027'), 'zh')).toBe('未定价')
    expect(describePrice(model('seed-tts-2.0-vibedev'), 'zh')).toBe('¥0.015/原始秒')
  })
})

describe('audio tasks through the host service', () => {
  const POST = `${ORIGIN}/v1/audio/generations`
  const poll = (id: string) => `${ORIGIN}/v1/audio/generations/${id}`
  const done = (id: string, url: string, extra: Record<string, unknown> = {}) => json(200, {
    id, status: 'completed', outputs: [{ content_url: url, content_type: 'audio/mpeg', duration_seconds: 31.2, title: 'Song' }],
    effective: { estimated_cny: '0.50', charged_cny: '0.50' }, ...extra,
  })

  it('submits music once under the operation key, follows it by query and saves the file to play', async () => {
    const gateway = new Gateway()
      .on('POST', POST, () => json(200, { id: 'aud_1', status: 'queued', effective: { estimated_cny: '0.50' } }))
      .on('GET', poll('aud_1'), () => json(200, { id: 'aud_1', status: 'running', progress: 50 }), () => done('aud_1', `${MEDIA}/out/aud_1.mp3?sig=1`))
      .on('GET', `${MEDIA}/out/aud_1.mp3?sig=1`, () => new Response(MP3, { headers: { 'content-type': 'audio/mpeg' } }))
    const { service, tracker, target } = setup(gateway)
    const started = await service.startAudio({ kind: 'music', prompt: 'upbeat folk', gender: 'male', operationId: 'op-click-1' }, target, signal())
    expect(started).toMatchObject({ id: 'op-click-1', kind: 'audio', audioKind: 'music', model: 'podcast-style-music-vibedev', status: 'pending', estimatedCny: '0.50', billing: { unit: 'generation' } })
    const post = gateway.seen.find(request => request.method === 'POST' && request.url === POST)
    expect(post?.headers['idempotency-key']).toBe('op-click-1')
    expect(post?.headers.authorization).toBe('Bearer app-token')
    expect(post?.body).toEqual({ model: 'podcast-style-music-vibedev', prompt: 'upbeat folk', gender: 'male' })
    // The same click again: the same task, nothing submitted.
    expect((await service.startAudio({ kind: 'music', prompt: 'upbeat folk', gender: 'male', operationId: 'op-click-1' }, target, signal())).id).toBe('op-click-1')
    const final = await tracker.follow('op-click-1')
    expect(final).toMatchObject({ status: 'completed', chargedCny: '0.50', settlement: 'settled' })
    expect(gateway.count('POST', POST)).toBe(1)
    const outputs = await service.result('op-click-1')
    expect(outputs).toEqual([{ path: join(target.folder, 'clip.mp3'), url: `${MEDIA}/out/aud_1.mp3?sig=1`, contentType: 'audio/mpeg', title: 'Song', durationSeconds: 31.2 }])
    expect(new Uint8Array(await readFile(outputs![0]!.path!))).toEqual(MP3)
    // The signed link is fetched as-is, without the app token.
    expect(gateway.seen.find(request => request.url.startsWith(`${MEDIA}/out/`))?.headers.authorization).toBeUndefined()
  })

  it('an unconfirmed submission is settled under the SAME key and body, and creates one task', async () => {
    const gateway = new Gateway()
      .on('POST', POST,
        () => json(502, { error: { code: 'UPSTREAM_TIMEOUT', message: 'provider did not answer' } }),
        () => json(200, { id: 'aud_2', status: 'queued' }))
      .on('GET', poll('aud_2'), () => done('aud_2', `${MEDIA}/out/aud_2.mp3?sig=1`))
      .on('GET', `${MEDIA}/out/aud_2.mp3?sig=1`, () => new Response(MP3, { headers: { 'content-type': 'audio/mpeg' } }))
    const { service, tracker, target } = setup(gateway)
    const started = await service.startAudio({ kind: 'podcast', prompt: 'AI news', operationId: 'op-podcast' }, target, signal())
    expect(started.id).toBe('op-podcast')
    await tracker.follow('op-podcast')
    const posts = gateway.seen.filter(request => request.method === 'POST' && request.url === POST)
    expect(posts).toHaveLength(2)
    expect(posts.map(request => request.headers['idempotency-key'])).toEqual(['op-podcast', 'op-podcast'])
    expect(posts[1]?.body).toEqual(posts[0]?.body)
    expect((await service.task('op-podcast'))?.status).toBe('completed')
  })

  it('submission_unknown is only polled, never submitted again', async () => {
    const gateway = new Gateway()
      .on('POST', POST, () => json(200, { id: 'aud_3', status: 'submission_unknown' }))
      .on('GET', poll('aud_3'),
        () => json(200, { id: 'aud_3', status: 'submission_unknown' }),
        () => json(200, { id: 'aud_3', status: 'running' }),
        () => done('aud_3', `${MEDIA}/out/aud_3.mp3?sig=1`))
      .on('GET', `${MEDIA}/out/aud_3.mp3?sig=1`, () => new Response(MP3, { headers: { 'content-type': 'audio/mpeg' } }))
    const { service, tracker, target } = setup(gateway)
    const started = await service.startAudio({ kind: 'music', prompt: 'calm piano', operationId: 'op-unknown' }, target, signal())
    expect(started).toMatchObject({ status: 'pending', progress: 'submission unknown' })
    const final = await tracker.follow('op-unknown')
    expect(final.status).toBe('completed')
    expect(gateway.count('POST', POST)).toBe(1)
  })

  it('settlement_pending: the result is saved and never generated again; the charge is read again later, by query', async () => {
    const gateway = new Gateway()
      .on('POST', POST, () => json(200, { id: 'aud_4', status: 'queued' }))
      .on('GET', poll('aud_4'),
        // A charge reported while settlement is pending is not final, and not free.
        () => json(200, { id: 'aud_4', status: 'settlement_pending', outputs: [{ content_url: `${MEDIA}/out/aud_4.wav?sig=1`, content_type: 'audio/wav', duration_seconds: 9.5, original_duration_seconds: 11 }], billing: { original_seconds: 11 }, effective: { charged_cny: '0.00' } }),
        () => json(200, { id: 'aud_4', status: 'completed', settlement_state: 'settled', outputs: [{ content_url: `${MEDIA}/out/aud_4.wav?sig=2`, content_type: 'audio/wav', duration_seconds: 9.5, original_duration_seconds: 11 }], billing: { original_seconds: 11 }, effective: { charged_cny: '0.17' } }))
      .on('GET', `${MEDIA}/out/aud_4.wav?sig=1`, () => new Response(wav(0.1), { headers: { 'content-type': 'audio/wav' } }))
    const { service, tracker, target } = setup(gateway)
    await service.startAudio({ kind: 'speech', prompt: '你好，欢迎收听', format: 'wav', operationId: 'op-speech' }, target, signal())
    const final = await tracker.follow('op-speech')
    expect(final).toMatchObject({ status: 'completed', settlement: 'pending', billing: { unit: 'original_second', originalSeconds: 11 } })
    expect(final.chargedCny).toBeUndefined()
    expect(final.outputs?.[0]).toMatchObject({ path: join(target.folder, 'clip.wav'), durationSeconds: 9.5, originalSeconds: 11 })
    // Later: a query settles it and renews the link; nothing is generated again.
    const settled = await service.refreshTask('op-speech')
    expect(settled).toMatchObject({ status: 'completed', settlement: 'settled', chargedCny: '0.17' })
    expect(settled?.outputs?.[0]).toMatchObject({ path: join(target.folder, 'clip.wav'), url: `${MEDIA}/out/aud_4.wav?sig=2`, durationSeconds: 9.5, originalSeconds: 11 })
    expect(gateway.count('POST', POST)).toBe(1)
    expect(gateway.count('GET', `${MEDIA}/out/aud_4.wav?sig=2`)).toBe(0)
  })

  it('cancelled and failed tasks end without a charge and are never submitted again', async () => {
    const gateway = new Gateway()
      .on('POST', POST, () => json(200, { id: 'aud_5', status: 'queued' }), () => json(200, { id: 'aud_6', status: 'queued' }))
      .on('GET', poll('aud_5'), () => json(200, { id: 'aud_5', status: 'cancelled' }))
      .on('GET', poll('aud_6'), () => json(200, { id: 'aud_6', status: 'failed', error: { code: 'CONTENT_REJECTED', message: 'the provider refused the lyrics' } }))
    const { service, tracker, target } = setup(gateway)
    await service.startAudio({ kind: 'music', prompt: 'a', operationId: 'op-cancel' }, target, signal())
    await service.startAudio({ kind: 'music', prompt: 'b', operationId: 'op-fail' }, target, signal())
    expect(await tracker.follow('op-cancel')).toMatchObject({ status: 'failed', error: { code: 'CANCELLED' } })
    expect(await tracker.follow('op-fail')).toMatchObject({ status: 'failed', error: { code: 'CONTENT_REJECTED' } })
    expect((await service.task('op-cancel'))?.chargedCny).toBeUndefined()
    expect(gateway.count('POST', POST)).toBe(2)
    // Refreshing a failed task is a query, not a new generation.
    await service.refreshTask('op-fail')
    expect(gateway.count('POST', POST)).toBe(2)
  })

  it('an expired link is renewed by polling the task again, and the download is retried — not the generation', async () => {
    const gateway = new Gateway()
      .on('POST', POST, () => json(200, { id: 'aud_7', status: 'queued' }))
      .on('GET', poll('aud_7'), () => done('aud_7', `${MEDIA}/out/aud_7.mp3?sig=old`), () => done('aud_7', `${MEDIA}/out/aud_7.mp3?sig=new`))
      .on('GET', `${MEDIA}/out/aud_7.mp3?sig=old`, () => new Response('expired', { status: 403 }))
      .on('GET', `${MEDIA}/out/aud_7.mp3?sig=new`, () => new Response(MP3, { headers: { 'content-type': 'audio/mpeg' } }))
    const { service, tracker, target } = setup(gateway)
    await service.startAudio({ kind: 'music', prompt: 'x', operationId: 'op-link' }, target, signal())
    const final = await tracker.follow('op-link')
    expect(final.outputs?.[0]).toMatchObject({ path: join(target.folder, 'clip.mp3'), url: `${MEDIA}/out/aud_7.mp3?sig=new` })
    expect(final.error).toBeUndefined()
    expect(gateway.count('POST', POST)).toBe(1)
  })

  it('a missing file is downloaded again through a fresh link when the result is read', async () => {
    const gateway = new Gateway()
      .on('POST', POST, () => json(200, { id: 'aud_8', status: 'queued' }))
      .on('GET', poll('aud_8'), () => done('aud_8', `${MEDIA}/out/aud_8.mp3?sig=1`), () => done('aud_8', `${MEDIA}/out/aud_8.mp3?sig=2`))
      .on('GET', `${MEDIA}/out/aud_8.mp3?sig=1`, () => new Response(MP3, { headers: { 'content-type': 'audio/mpeg' } }))
      .on('GET', `${MEDIA}/out/aud_8.mp3?sig=2`, () => new Response(MP3, { headers: { 'content-type': 'audio/mpeg' } }))
    const { service, tracker, store, target } = setup(gateway)
    await service.startAudio({ kind: 'music', prompt: 'x', operationId: 'op-missing' }, target, signal())
    await tracker.follow('op-missing')
    // The person deleted the file; the result is read again.
    await store.update('op-missing', { outputs: [{ index: 0, url: `${MEDIA}/out/aud_8.mp3?sig=1`, contentType: 'audio/mpeg' }] })
    const outputs = await service.result('op-missing')
    expect(outputs?.[0]).toMatchObject({ url: `${MEDIA}/out/aud_8.mp3?sig=2` })
    expect(outputs?.[0]?.path).toBeDefined()
    expect(new Uint8Array(await readFile(outputs![0]!.path!))).toEqual(MP3)
    expect(gateway.count('POST', POST)).toBe(1)
  })

  it('a task still running when the host stopped is resumed by query after a restart', async () => {
    const gateway = new Gateway()
      .on('POST', POST, () => json(200, { id: 'aud_9', status: 'queued' }))
      .on('GET', poll('aud_9'), () => done('aud_9', `${MEDIA}/out/aud_9.mp3?sig=1`))
      .on('GET', `${MEDIA}/out/aud_9.mp3?sig=1`, () => new Response(MP3, { headers: { 'content-type': 'audio/mpeg' } }))
    const first = setup(gateway)
    await first.service.startAudio({ kind: 'music', prompt: 'x', operationId: 'op-restart' }, first.target, signal())
    first.tracker.dispose()
    expect((await first.store.get('op-restart'))?.status).toBe('pending')
    // A new process on the same state directory.
    const second = setup(gateway, { store: new TaskStore(join(dir, 'state')) })
    await second.tracker.resume()
    const final = await second.tracker.follow('op-restart')
    expect(final.status).toBe('completed')
    expect(gateway.count('POST', POST)).toBe(1)
  })

  it('offers forms and prices for every declared model, and nothing for an undeclared one', async () => {
    const { service } = setup(new Gateway())
    const forms = await service.audioForms()
    expect(forms.map(form => [form.model, form.kind, form.price.label.zh])).toEqual([
      ['podcast-style-music-vibedev', 'music', '¥0.50/次'],
      ['doubao-podcast-vibedev', 'podcast', '¥1.00/次'],
      ['seed-tts-2.0-vibedev', 'speech', '¥0.015/原始秒'],
      ['brand-new-music-2027', 'music', '未定价'],
    ])
    expect((await service.audioPrice('seed-tts')).unit).toBe('original_second')
    expect((await service.audioPrice('doubao-asr-vibedev')).label.zh).toBe('¥0.30/分钟')
  })
})
