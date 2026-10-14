/**
 * The spending confirmation of a video request, priced by the unified video
 * quote: video Token pricing from the measured reference lengths, legacy prices
 * as before, and an estimate that cannot be made said out loud — never left out.
 * Nothing here is submitted.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ApprovalService } from '@deepseek-ai/dsh-user-approval'
import { MediaLibrary } from '../src/gateway/assets.js'
import { GatewayHttp } from '../src/gateway/http.js'
import { MediaRuntime } from '../src/runtime.js'
import type { MediaCall } from '../src/runtime.js'
import { TaskStore } from '../src/tasks/store.js'
import { TaskTracker } from '../src/tasks/tracker.js'
import { prepareVideoTask, videoGenerateTool } from '../src/tools/video.js'
import type { VideoRequest } from '../src/tools/video.js'
import { CATALOG, JPEG, MP4, PNG, SD25_TC_PRICING, TOKEN_CATALOG, tokenVideoBlock } from './fixtures.js'
import { json } from './helpers.js'

const ORIGIN = 'https://api.vibedev.test'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'dsh-video-spending-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

/** Image references only change the rule here: no image 0.1/s, any image 0.2/s (fixture values). */
const FRAMES_MODEL = {
  id: 'video-frames-token', media_type: 'video', capabilities: { output_modalities: ['video'], allowed_endpoints: ['/v1/videos'] },
  video: tokenVideoBlock(['480p'], [5]),
  video_pricing: {
    ...SD25_TC_PRICING,
    rules: [
      { resolution: '480p', reference_image: false, price_per_million_tokens: 1, estimated_price_per_second: 0.1 },
      { resolution: '480p', reference_image: true, price_per_million_tokens: 2, estimated_price_per_second: 0.2 },
    ],
  },
}

const dataUrl = (mime: string, bytes: Uint8Array) => `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`

/**
 * A runtime on a simulated gateway whose media library measures reference videos at `videoMs`
 * (undefined: not measured), with spending confirmation on and an approver that records what it was asked.
 */
function setup(videoMs: number | undefined) {
  const seen: string[] = []
  const fetch = (async (input: string | URL, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    const url = String(input)
    seen.push(`${method} ${url}`)
    if (method === 'GET' && url === `${ORIGIN}/v1/models`) return json(200, { object: 'list', data: [...CATALOG.data, ...TOKEN_CATALOG.data, FRAMES_MODEL] })
    if (method === 'POST' && url === `${ORIGIN}/v1/media-assets/uploads`) {
      const body = JSON.parse(String(init?.body)) as { sha256: string }
      const id = `ma_${body.sha256.slice(0, 8)}`
      return json(200, { asset_id: id, upload_required: true, upload_url: `https://oss.test/put/${id}`, upload_headers: {} })
    }
    if (method === 'PUT' && url.startsWith('https://oss.test/put/')) return new Response(null, { status: 200 })
    const complete = /\/v1\/media-assets\/(ma_\w+)\/complete$/.exec(url)
    if (method === 'POST' && complete !== null) {
      return json(200, {
        asset_id: complete[1], reference_url: `${ORIGIN}/v1/media-assets/${complete[1]}/content?sig=r`,
        ...videoMs === undefined ? {} : { duration_ms: videoMs },
      })
    }
    throw new Error(`no route for ${method} ${url}`)
  }) as typeof globalThis.fetch
  const http = new GatewayHttp({ origin: ORIGIN, userAgent: 'vibedev-plugin/test', fetch, resolveCredential: async () => ({ token: 'tok', kind: 'plugin' }), sleep: async () => {} })
  const store = new TaskStore(join(dir, 'state'))
  const tracker = new TaskTracker({ http, store })
  const asked: Array<{ reason: string; displayReason: { en: string; zh: string } }> = []
  const approval = {
    request: async (request: { reason: string; displayReason: { en: string; zh: string } }) => { asked.push(request); return 'allowed-once' },
  } as unknown as ApprovalService
  const runtime = new MediaRuntime({
    http, store, tracker, stateDir: join(dir, 'state'), library: new MediaLibrary(http),
    settings: { outputDir: () => 'media', confirmSpending: () => true, defaultModel: () => '' },
    approval: () => approval,
  })
  const call: MediaCall = { signal: new AbortController().signal, cwd: dir, callId: ToolCallId('call-1'), agent: { id: 'agent-1' } as unknown as MediaCall['agent'] }
  const prepare = (request: VideoRequest) => prepareVideoTask(runtime, call, request, { folder: join(dir, 'out'), stem: 'clip' })
  return { runtime, seen, asked, prepare, store }
}

describe('video spending confirmation', () => {
  it('confirms a Token-priced model at its Token estimate from the measured reference video: 0.6952 × (7 + 5)', async () => {
    const { prepare, asked, seen, store } = setup(5_000)
    const prepared = await prepare({ model: 'video-sd-2.5(TC)', prompt: 'the dancer from video 1', duration: 7, resolution: '480p', referenceVideos: [dataUrl('video/mp4', MP4)] })
    expect(asked).toHaveLength(1)
    expect(asked[0]?.displayReason.en).toContain('about ¥8.34 · billed by actual video Tokens (¥0.6952/s × (7 s output + 5 s of reference video), ¥36.036 per million Tokens)')
    expect(asked[0]?.displayReason.zh).toContain('预计 ¥8.34 · 最终按实际视频 Token 结算')
    expect(prepared.draft.estimatedCny).toBe('8.34')
    expect(prepared.quote).toMatchObject({ status: 'estimate', mode: 'video_token', amountCny: '8.3424' })
    // Prepared, not submitted.
    expect(seen.filter(request => request.endsWith('/v1/videos'))).toEqual([])
    expect(await store.list()).toEqual([])
  })

  it('counts first and last frames as image references', async () => {
    const { prepare, asked } = setup(undefined)
    const prepared = await prepare({ model: 'video-frames-token', prompt: 'from dawn to dusk', duration: 5, resolution: '480p', firstFrame: dataUrl('image/png', PNG), lastFrame: dataUrl('image/jpeg', JPEG) })
    expect(prepared.plan.mode).toBe('first_last_frame')
    expect(prepared.quote).toMatchObject({ status: 'estimate', amountCny: '1', rule: { resolution: '480p', referenceImage: true } })
    expect(prepared.draft.estimatedCny).toBe('1.00')
    expect(asked[0]?.displayReason.en).toContain('about ¥1.00 · billed by actual video Tokens')
  })

  it('says an estimate it cannot make, instead of leaving it out', async () => {
    const { prepare, asked } = setup(undefined)
    const prepared = await prepare({ model: 'video-token-no-estimate', prompt: 'rain on a window', duration: 5 })
    expect(prepared.draft.estimatedCny).toBeUndefined()
    expect(asked[0]?.displayReason.en).toContain('estimate unavailable; billed by actual video Token usage')
    expect(asked[0]?.displayReason.zh).toContain('无法预估；按实际视频 Token 用量结算')
    expect(asked[0]?.displayReason.en).not.toMatch(/not priced|free/i)
  })

  it('a reference video the gateway could not measure leaves the Token estimate unknown, not zero', async () => {
    const { prepare, asked } = setup(undefined)
    const prepared = await prepare({ model: 'video-sd-2.5(TC)', prompt: 'the dancer from video 1', duration: 7, resolution: '480p', referenceVideos: [dataUrl('video/mp4', MP4)] })
    expect(prepared.quote).toMatchObject({ status: 'unavailable', reason: 'unknown-reference-duration', pricePerMillionTokensCny: 36.036 })
    expect(prepared.draft.estimatedCny).toBeUndefined()
    expect(asked[0]?.displayReason.en).toContain('estimate unavailable; billed by actual video Token usage')
  })

  it('keeps the per-second estimate of legacy models', async () => {
    const { prepare, asked } = setup(8_080)
    const plain = await prepare({ model: 'seedance-2.0', prompt: 'a cat', duration: 5 })
    expect(asked[0]?.displayReason.en).toContain('about ¥4.95 (¥0.99/s × 5 s). Charged only if it succeeds.')
    expect(asked[0]?.displayReason.zh).toContain('，约 ¥4.95，成功才扣费。')
    expect(plain.draft.estimatedCny).toBe('4.95')
    const referenced = await prepare({ model: 'seedance-2.0', prompt: 'a cat dancing like video 1', duration: 5, referenceVideos: [dataUrl('video/mp4', MP4)] })
    expect(asked[1]?.displayReason.en).toContain('about ¥13.86 (¥0.99/s × (5 s output + 9 s of reference video))')
    expect(referenced.draft.estimatedCny).toBe('13.86')
  })

  it('the tool does not describe every video as charged per second', () => {
    const { runtime } = setup(undefined)
    const description = videoGenerateTool(runtime).description
    expect(description).not.toContain('Charged per second of video')
    expect(description).toContain('video Tokens')
  })
})
