/** The audio tools of the loaded plugin against a simulated gateway that ships structured audio models. */

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import * as Media from '../src/index.js'
import type { MediaHostService } from '../src/index.js'
import { AUDIO_CATALOG, MP3, WAV } from './fixtures.js'
import { json } from './helpers.js'

const GATEWAY = 'https://gw.test'

interface Seen { method: string; url: string; headers: Record<string, string>; body: unknown }

let dir: string
let seen: Seen[]
let routes: Record<string, (request: Seen) => Response>

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-audio-plugin-'))
  seen = []
  routes = {
    [`GET ${GATEWAY}/v1/models`]: () => json(200, AUDIO_CATALOG),
    [`POST ${GATEWAY}/v1/audio/generations`]: () => json(200, { id: 'aud_1', status: 'queued' }),
    [`GET ${GATEWAY}/v1/audio/generations/aud_1`]: () => json(200, {
      id: 'aud_1', status: 'completed', outputs: [{ content_url: 'https://media.test/aud_1.mp3?sig=1', content_type: 'audio/mpeg', duration_seconds: 4.2, original_duration_seconds: 5 }],
      billing: { original_seconds: 5 }, effective: { charged_cny: '0.08' },
    }),
    'GET https://media.test/aud_1.mp3?sig=1': () => new Response(MP3, { headers: { 'content-type': 'audio/mpeg' } }),
  }
  vi.stubEnv('DSH_MEDIA_TEST_KEY', 'dev-key')
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
    const request: Seen = { method: init?.method ?? 'GET', url: String(input), headers: { ...init?.headers as Record<string, string> }, body: init?.body }
    seen.push(request)
    const route = routes[`${request.method} ${request.url}`]
    if (route === undefined) throw new Error(`no route for ${request.method} ${request.url}`)
    return route(request)
  }))
})

afterEach(async () => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  await rm(dir, { recursive: true, force: true })
})

async function load() {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(Media, { gatewayOrigin: `${GATEWAY}/`, apiKeyEnv: 'DSH_MEDIA_TEST_KEY', stateDir: dir })
  let calls = 0
  const run = (name: string, args: Record<string, unknown>): Promise<ToolExecutionResult> =>
    ctx.tools.execute({ callId: ToolCallId(`call-${++calls}`), name, arguments: args, signal: new AbortController().signal })
  return { ctx, run }
}

const textOf = (result: ToolExecutionResult) => result.content.map(block => block.type === 'text' ? block.text : `[${block.type}]`).join('\n')

describe('audio tools', () => {
  it('media_models lists each audio model by its declared kind, with the unit of its price', async () => {
    const { ctx, run } = await load()
    const text = textOf(await run('media_models', { kind: 'audio' }))
    expect(text).toContain('- podcast-style-music-vibedev — 播客风格音乐; music; ¥0.50 per generation')
    expect(text).toContain('- seed-tts-2.0-vibedev — Seed 语音合成 2.0; speech; ¥0.015/s of original audio')
    expect(text).toContain('fields: text_prompt, references, audio_config, watermark; the text goes in text_prompt; 0-2 reference audio')
    expect(text).toContain('format wav at 16000/24000/48000 Hz; format mp3 at 24000/32000 Hz')
    expect(text).toContain('- brand-new-music-2027 — Brand new music; music; not priced')
    expect(text).toContain('- mystery-audio — undeclared; ¥0.20 per generation')
    expect(text).toContain('does not declare what kind of audio it makes')
    const transcription = textOf(await run('media_models', { kind: 'transcription' }))
    expect(transcription).toContain('- doubao-asr-vibedev — 豆包语音转写; ¥0.30/min')
    await ctx.fiber.dispose()
  })

  it('audio_generate makes speech with the declared fields and reports playback and billed lengths apart', async () => {
    const { ctx, run } = await load()
    const result = await run('audio_generate', { type: 'speech', prompt: '欢迎收听', format: 'wav', sample_rate: 16000, watermark: true, filename: 'welcome' })
    expect(result.isError).toBe(false)
    const submit = seen.find(item => item.method === 'POST' && item.url === `${GATEWAY}/v1/audio/generations`)
    expect(JSON.parse(submit?.body as string)).toEqual({
      model: 'seed-tts-2.0-vibedev', text_prompt: '欢迎收听', watermark: true, audio_config: { format: 'wav', sample_rate: 16000 },
    })
    expect(submit?.headers['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/)
    expect(result.value).toMatchObject({ status: 'completed', model: 'seed-tts-2.0-vibedev', price: '¥0.015/s of original audio' })
    expect((result.value as { outputs: unknown[] }).outputs[0]).toMatchObject({ durationSeconds: 4.2, originalSeconds: 5 })
    expect(new Uint8Array(await readFile(join(dir, 'outputs', 'media', 'audio', 'welcome.mp3')))).toEqual(MP3)
    await ctx.fiber.dispose()
  })

  it('audio_generate refuses speech-only parameters for music before anything is submitted', async () => {
    const { ctx, run } = await load()
    const result = await run('audio_generate', { type: 'music', prompt: 'calm piano', sample_rate: 48000 })
    expect(result.isError).toBe(true)
    expect(result.error?.info?.code).toBe('AUDIO_OPTION_INVALID')
    expect(seen.filter(item => item.method === 'POST')).toHaveLength(0)
    await ctx.fiber.dispose()
  })

  it('audio_transcribe uploads the file as multipart to its own endpoint and holds to the declared languages', async () => {
    routes[`POST ${GATEWAY}/v1/audio/transcriptions`] = () => json(200, { text: '你好，世界', duration: 1.5 })
    const { ctx, run } = await load()
    const file = `data:audio/wav;base64,${Buffer.from(WAV).toString('base64')}`
    const result = await run('audio_transcribe', { file })
    expect(result.value).toMatchObject({ model: 'doubao-asr-vibedev', text: '你好，世界' })
    const request = seen.find(item => item.url === `${GATEWAY}/v1/audio/transcriptions`)
    expect(request?.body).toBeInstanceOf(FormData)
    const form = request?.body as FormData
    expect(form.get('model')).toBe('doubao-asr-vibedev')
    expect(form.get('language')).toBe('zh')
    expect(form.get('file')).toBeInstanceOf(Blob)
    expect(seen.some(item => item.url.endsWith('/v1/audio/generations'))).toBe(false)
    const english = await run('audio_transcribe', { file, language: 'en' })
    expect(english.error?.info?.code).toBe('AUDIO_OPTION_INVALID')
    await ctx.fiber.dispose()
  })

  it('the host service is the same path: startAudio, task, onTask and result', async () => {
    const { ctx } = await load()
    const service = ctx.get('vibedevMedia') as MediaHostService
    const folder = join(dir, 'film', 'audio')
    const updates: string[] = []
    const started = await service.startAudio({ kind: 'speech', prompt: '第一幕', operationId: 'film-op-1' }, { cwd: dir, folder, stem: 'line-1' }, new AbortController().signal)
    service.onTask(started.id, task => { updates.push(task.status) })
    expect(started).toMatchObject({ id: 'film-op-1', audioKind: 'speech', billing: { unit: 'original_second', unitPriceCny: '0.015' } })
    // The plugin follows it in the background; wait for the saved result.
    for (let i = 0; i < 100 && (await service.task('film-op-1'))?.status !== 'completed'; i++) await new Promise(resolve => setTimeout(resolve, 20))
    const outputs = await service.result('film-op-1')
    expect(outputs?.[0]).toMatchObject({ path: join(folder, 'line-1.mp3'), contentType: 'audio/mpeg', durationSeconds: 4.2, originalSeconds: 5 })
    expect(await service.task('film-op-1')).toMatchObject({ chargedCny: '0.08', settlement: 'settled', billing: { originalSeconds: 5 } })
    await ctx.fiber.dispose()
  })
})
