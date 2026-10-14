/** The `vibedevMedia` host service, as the film workbench calls it, against a fake gateway. */

import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as Media from '../src/index.js'
import type { MediaHostService, MediaTaskView, VideoQuote, VideoQuoteRequest } from '../src/index.js'
import { CATALOG, MP4, PNG, TOKEN_CATALOG } from './fixtures.js'
import { json } from './helpers.js'

const GATEWAY = 'https://gw.test'

let state: string
let workspace: string
let seen: { method: string; url: string; body: unknown }[]
let routes: Record<string, () => Response>

beforeEach(async () => {
  state = await mkdtemp(join(tmpdir(), 'dsh-media-service-state-'))
  workspace = await mkdtemp(join(tmpdir(), 'dsh-media-service-ws-'))
  seen = []
  routes = {
    [`GET ${GATEWAY}/v1/models`]: () => json(200, CATALOG),
    [`POST ${GATEWAY}/v1/images/generations`]: () => json(200, { created: 1, data: [{ b64_json: Buffer.from(PNG).toString('base64') }] }),
    [`POST ${GATEWAY}/v1/media-assets/uploads`]: () => json(200, { asset_id: 'ma_1', upload_required: true, upload_url: 'https://oss.test/put/ma_1', upload_headers: {} }),
    'PUT https://oss.test/put/ma_1': () => new Response(null, { status: 200 }),
    [`POST ${GATEWAY}/v1/media-assets/ma_1/complete`]: () => json(200, { asset_id: 'ma_1', reference_url: `${GATEWAY}/v1/media-assets/ma_1/content?sig=r`, content_type: 'image/png' }),
    [`POST ${GATEWAY}/v1/videos`]: () => json(200, { id: 'vid_1', status: 'queued', effective: { estimated_cny: '4.95' } }),
    [`GET ${GATEWAY}/v1/videos/vid_1`]: () => json(200, { id: 'vid_1', status: 'completed', video: { url: 'https://cdn.test/vid_1.mp4' }, effective: { estimated_cny: '4.95', charged_cny: '4.95' } }),
    ['GET https://cdn.test/vid_1.mp4']: () => new Response(MP4, { headers: { 'content-type': 'video/mp4' } }),
  }
  vi.stubEnv('DSH_MEDIA_TEST_KEY', 'dev-key')
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
    const request = { method: init?.method ?? 'GET', url: String(input), body: init?.body }
    seen.push(request)
    const route = routes[`${request.method} ${request.url}`]
    if (route === undefined) throw new Error(`no route for ${request.method} ${request.url}`)
    return route()
  }))
})

afterEach(async () => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  await rm(state, { recursive: true, force: true })
  await rm(workspace, { recursive: true, force: true })
})

async function load() {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  // Asking before spending is on: the service's callers confirm in their own interface.
  await ctx.plugin(Media, { gatewayOrigin: `${GATEWAY}/`, apiKeyEnv: 'DSH_MEDIA_TEST_KEY', stateDir: state, confirmSpending: true })
  const service = ctx.get('vibedevMedia') as MediaHostService | undefined
  if (service === undefined) throw new Error('vibedevMedia is not provided')
  return { ctx, service }
}

describe('vibedevMedia host service', () => {
  it('lists the models and generates an image into the folder the caller names', async () => {
    const { ctx, service } = await load()
    expect((await service.models()).map(model => model.id)).toContain('gpt-image-2.5-flare')
    const folder = join(workspace, 'film', 'canvas', 'media')
    const result = await service.generateImages({ prompt: 'a red apple' }, { cwd: workspace, folder, stem: 'image-abc' }, new AbortController().signal)
    expect(result).toMatchObject({ model: 'gpt-image-2.5-flare', images: [{ absolutePath: join(folder, 'image-abc.png'), mediaType: 'image/png', bytes: PNG.byteLength }] })
    expect(new Uint8Array(await readFile(join(folder, 'image-abc.png')))).toEqual(PNG)
    await ctx.fiber.dispose()
  })

  it('reads workspace-relative references against the caller\'s workspace', async () => {
    const { ctx, service } = await load()
    await writeFile(join(workspace, 'ref.png'), PNG)
    routes[`POST ${GATEWAY}/v1/images/edits`] = () => json(200, { created: 1, data: [{ b64_json: Buffer.from(PNG).toString('base64') }] })
    const result = await service.generateImages({ prompt: 'same apple, blue', references: ['ref.png'] }, { cwd: workspace, folder: join(workspace, 'out'), stem: 'edit' }, new AbortController().signal)
    expect(result.images).toHaveLength(1)
    expect(seen.some(item => item.url.endsWith('/v1/images/edits'))).toBe(true)
    await ctx.fiber.dispose()
  })

  it('starts a video, follows it in the background and saves it where asked', async () => {
    const { ctx, service } = await load()
    const folder = join(workspace, 'film', 'canvas', 'media')
    const updates: MediaTaskView[] = []
    const started = await service.startVideo(
      { prompt: 'the apple rolls', referenceImages: [`data:image/png;base64,${Buffer.from(PNG).toString('base64')}`] },
      { cwd: workspace, folder, stem: 'video-xyz' },
      new AbortController().signal,
    )
    expect(started).toMatchObject({ kind: 'video', model: 'seedance-2.0' })
    const stop = service.onTask(started.id, (task) => { updates.push(task) })
    let finished = await service.task(started.id)
    for (let tries = 0; tries < 100 && finished?.status !== 'completed'; tries++) {
      await new Promise(resolve => setTimeout(resolve, 20))
      finished = await service.task(started.id)
    }
    stop()
    expect(finished).toMatchObject({ status: 'completed', chargedCny: '4.95' })
    expect(finished?.outputs?.[0]?.path).toBe(join(folder, 'video-xyz.mp4'))
    expect(new Uint8Array(await readFile(join(folder, 'video-xyz.mp4')))).toEqual(MP4)
    await ctx.fiber.dispose()
  })

  it('shows a pending Token settlement with its reason, then the settled charge and the billed Tokens after a refresh', async () => {
    const effective = (extra: Record<string, unknown>) => () => json(200, { id: 'vid_1', status: 'completed', video: { url: 'https://cdn.test/vid_1.mp4' }, effective: { estimated_cny: '3.98', ...extra } })
    routes[`GET ${GATEWAY}/v1/videos/vid_1`] = effective({ billing_status: 'pending', billing_pending_reason: 'usage_counters_inconsistent', charged_cny: '3.98' })
    const { ctx, service } = await load()
    const started = await service.startVideo({ prompt: 'the apple rolls' }, { cwd: workspace, folder: join(workspace, 'out'), stem: 'v' }, new AbortController().signal)
    let task = await service.task(started.id)
    for (let tries = 0; tries < 100 && task?.status !== 'completed'; tries++) {
      await new Promise(resolve => setTimeout(resolve, 20))
      task = await service.task(started.id)
    }
    expect(task).toMatchObject({ status: 'completed', settlement: 'pending', settlementPendingReason: 'usage_counters_inconsistent', estimatedCny: '3.98' })
    expect(task?.chargedCny).toBeUndefined()
    routes[`GET ${GATEWAY}/v1/videos/vid_1`] = effective({ billing_status: 'settled', charged_cny: '3.98066354', billed_tokens: 100858 })
    const settled = await service.refreshTask(started.id)
    expect(settled).toMatchObject({ status: 'completed', settlement: 'settled', chargedCny: '3.98066354', estimatedCny: '3.98', billing: { tokens: 100858 } })
    expect(settled?.settlementPendingReason).toBeUndefined()
    expect(seen.filter(item => item.method === 'POST' && item.url === `${GATEWAY}/v1/videos`)).toHaveLength(1)
    await ctx.fiber.dispose()
  })

  it('reports an unknown task as undefined', async () => {
    const { ctx, service } = await load()
    expect(await service.task('missing')).toBeUndefined()
    await ctx.fiber.dispose()
  })
})

describe('vibedevMedia videoQuote', () => {
  beforeEach(() => {
    routes[`GET ${GATEWAY}/v1/models`] = () => json(200, { object: 'list', data: [...CATALOG.data, ...TOKEN_CATALOG.data] })
  })

  it('quotes from the catalog alone, under the canonical id of an alias: no upload, no submission, no task', async () => {
    const { ctx, service } = await load()
    const startVideo = vi.spyOn(service, 'startVideo')
    const request: VideoQuoteRequest = { model: 'SD-2.5-TC', resolution: '480p', durationSeconds: 7, references: { videos: [{ durationSeconds: 5 }], images: 1, audios: 0 } }
    const quote: VideoQuote = await service.videoQuote(request)
    expect(quote).toMatchObject({ status: 'estimate', mode: 'video_token', model: 'video-sd-2.5(TC)', amountCny: '8.3424', label: { zh: '预计 ¥8.34 · 最终按实际视频 Token 结算' } })
    expect(await service.videoQuote({ model: 'video-sd-2.5(TC)', resolution: '480p', durationSeconds: 5 })).toMatchObject({ model: 'video-sd-2.5(TC)', amountCny: '2.9095' })
    expect(await service.videoQuote({ model: 'seedance-2.0', durationSeconds: 5 })).toMatchObject({ status: 'estimate', mode: 'legacy', amountCny: '4.95' })
    expect(await service.videoQuote({ model: 'video-token-future', resolution: '480p', durationSeconds: 5 })).toMatchObject({ status: 'unavailable', reason: 'unknown-schema' })
    // One catalog read (cached), nothing else on the network, nothing recorded.
    expect(seen.map(item => `${item.method} ${item.url}`)).toEqual([`GET ${GATEWAY}/v1/models`])
    expect(startVideo).not.toHaveBeenCalled()
    expect((await readdir(state, { recursive: true })).filter(path => /tasks/.test(path))).toEqual([])
    await ctx.fiber.dispose()
  })

  it('answers an unknown model as an invalid request rather than throwing', async () => {
    const { ctx, service } = await load()
    expect(await service.videoQuote({ model: 'no-such-video', durationSeconds: 5 })).toMatchObject({ status: 'unavailable', mode: 'none', model: 'no-such-video', reason: 'invalid-request' })
    await ctx.fiber.dispose()
  })

  it('does not hide a missing sign-in as an invalid request', async () => {
    vi.stubEnv('DSH_MEDIA_TEST_KEY', '')
    const { ctx, service } = await load()
    await expect(service.videoQuote({ model: 'video-sd-2.5(TC)', durationSeconds: 5 })).rejects.toMatchObject({ code: 'NOT_SIGNED_IN' })
    expect(seen).toEqual([])
    await ctx.fiber.dispose()
  })
})
