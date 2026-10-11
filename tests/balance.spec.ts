/**
 * The balance shows a charge within seconds: the Host reads it again right
 * after a paid request ends, answers the pages' long poll as soon as it
 * changes, and never makes a page wait on the gateway when it has a balance.
 */

import { describe, expect, it, vi } from 'vitest'
import { ACCOUNT_ROUTE_PREFIX, AccountService, accountRoutes } from '../src/account/index.js'
import type { CredentialChain } from '../src/auth/credentials.js'
import type { PluginLogin } from '../src/auth/login.js'
import { ACCOUNT_ROUTE, AccountStore } from '../src/client/account-store.js'
import type { AccountView } from '../src/client/account-store.js'
import { GatewayHttp } from '../src/gateway/http.js'
import type { GatewayCredential } from '../src/gateway/http.js'
import { TaskStore } from '../src/tasks/store.js'
import { TaskTracker } from '../src/tasks/tracker.js'
import { json } from './helpers.js'

const ORIGIN = 'https://gw.test'

/** Timers driven by hand: `run(ms)` advances the clock and fires what came due. */
function clock() {
  let now = 0
  let next = 1
  const pending = new Map<number, { at: number; callback: () => void }>()
  return {
    now: () => now,
    setTimeout: (callback: () => void, ms: number) => { const id = next++; pending.set(id, { at: now + ms, callback }); return id },
    clearTimeout: (id: unknown) => { pending.delete(id as number) },
    pending: () => [...pending.values()].map(item => item.at - now).sort((a, b) => a - b),
    async run(ms: number) {
      const until = now + ms
      for (;;) {
        const due = [...pending.entries()].filter(([, item]) => item.at <= until).sort((a, b) => a[1].at - b[1].at)[0]
        if (due === undefined) break
        pending.delete(due[0])
        now = due[1].at
        due[1].callback()
        await new Promise(resolve => setTimeout(resolve, 0))
      }
      now = until
      await new Promise(resolve => setTimeout(resolve, 0))
    },
  }
}

/** An account on a gateway whose balance the test sets. */
function bench(credential: GatewayCredential = { token: 'vdat_1', kind: 'plugin' }) {
  const time = clock()
  let balance = '12.50'
  let current: GatewayCredential | undefined = credential
  let hold: Promise<void> | undefined
  const fetch = vi.fn(async () => {
    const seen = balance
    await hold
    return Response.json({ data: { id: 7, email: 'a@b.c', balance: seen, currency: 'CNY' } })
  })
  const login = {
    signInAttempt: () => undefined, pendingSignIn: () => undefined, user: () => Promise.resolve(undefined),
    signOut: () => { current = undefined; return Promise.resolve() }, dispose: () => {},
  }
  const account = new AccountService({
    origin: ORIGIN, userAgent: 'test',
    chain: { resolve: () => Promise.resolve(current), reject: () => Promise.resolve() } as unknown as CredentialChain,
    login: login as unknown as PluginLogin,
    models: () => ({ count: 3 }),
    fetch: fetch as unknown as typeof globalThis.fetch,
    now: time.now, setTimeout: time.setTimeout, clearTimeout: time.clearTimeout,
  })
  return {
    account, fetch, time,
    setBalance: (value: string) => { balance = value },
    switchTo: (next: GatewayCredential | undefined) => { current = next },
    holdReads: () => { let release!: () => void; hold = new Promise((resolve) => { release = resolve }); return () => { hold = undefined; release() } },
  }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0))

describe('balance after a charge', () => {
  it('reads the balance again shortly after a paid request and answers the waiting page at once', async () => {
    const { account, fetch, time, setBalance } = bench()
    const first = await account.view()
    expect(first.balance?.amount).toBe('12.50')
    let answered: AccountView | undefined
    const route = accountRoutes(account).find(item => item.path === ACCOUNT_ROUTE_PREFIX)!
    void route.fetch(new Request(`http://host${ACCOUNT_ROUTE_PREFIX}?since=${first.revision}`) as never)
      .then(async (response) => { answered = await response.json() as AccountView })
    await settle()
    expect(answered).toBeUndefined()
    setBalance('11.80')
    account.spent()
    await time.run(1_499)
    expect(fetch).toHaveBeenCalledTimes(1)
    await time.run(1)
    await settle()
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(answered).toMatchObject({ balance: { amount: '11.80' }, revision: first.revision + 1 })
    // The charge showed on the first read: no second read.
    await time.run(10_000)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('reads once more later when the charge had not settled yet, and shares the reads of a burst', async () => {
    const { account, fetch, time, setBalance } = bench()
    await account.view()
    account.spent()
    account.spent()
    account.spent()
    await time.run(1_500)
    expect(fetch).toHaveBeenCalledTimes(2)
    setBalance('9.00')
    await time.run(6_500)
    expect(fetch).toHaveBeenCalledTimes(3)
    expect((await account.view()).balance?.amount).toBe('9.00')
  })

  it('keeps reads after charges at least five seconds apart however busy the agent is', async () => {
    const { account, fetch, time } = bench()
    await account.view(true)
    for (let i = 0; i < 10; i++) {
      account.spent()
      await time.run(500)
    }
    // The reads land on the spacing, not on every request.
    expect(fetch.mock.calls.length).toBeLessThanOrEqual(3)
  })

  it('answers a page from the cache at once when the read is old, and tells it when the new read differs', async () => {
    const { account, fetch, time, setBalance, holdReads } = bench()
    const first = await account.view()
    await time.run(31_000)
    setBalance('5.00')
    const release = holdReads()
    // The gateway is slow: the page is answered from the cache without waiting for it.
    const stale = await account.view()
    expect(stale.balance?.amount).toBe('12.50')
    expect(fetch).toHaveBeenCalledTimes(2)
    let woke = false
    void account.wait(stale.revision).then(() => { woke = true })
    release()
    await settle()
    await settle()
    expect(woke).toBe(true)
    expect((await account.view()).revision).toBe(first.revision + 1)
    expect((await account.view()).balance?.amount).toBe('5.00')
  })

  it('a long poll with nothing new ends after a while, and ends at once when the page goes away', async () => {
    const { account, time } = bench()
    const { revision } = await account.view()
    let ended = false
    void account.wait(revision).then(() => { ended = true })
    await time.run(24_000)
    expect(ended).toBe(false)
    await time.run(1_000)
    expect(ended).toBe(true)
    const gone = new AbortController()
    let left = false
    void account.wait(revision, gone.signal).then(() => { left = true })
    gone.abort()
    await settle()
    expect(left).toBe(true)
    // An out-of-date revision answers at once.
    await expect(account.wait(revision - 1)).resolves.toBeUndefined()
  })

  it('drops a read started for the previous account and tells the pages about the switch', async () => {
    const { account, time, setBalance, switchTo, holdReads } = bench()
    const before = await account.view()
    const release = holdReads()
    account.spent()
    await time.run(1_500)
    switchTo({ token: 'vdat_2', kind: 'plugin' })
    account.credentialChanged()
    setBalance('99.00')
    release()
    await settle()
    const after = await account.view()
    expect(after.revision).toBeGreaterThan(before.revision)
    expect(after.balance?.amount).toBe('99.00')
  })
})

describe('what counts as a charge', () => {
  it('the gateway client reports accepted requests, which the plugin narrows to generations', async () => {
    const accepted: string[] = []
    const http = new GatewayHttp({
      origin: ORIGIN, userAgent: 'test', resolveCredential: async () => ({ token: 't', kind: 'plugin' }),
      fetch: (async () => json(200, { ok: true })) as unknown as typeof globalThis.fetch,
      onAccepted: ({ method, path }) => { accepted.push(`${method} ${path}`) },
    })
    await http.json('/v1/videos', { method: 'POST', json: {} })
    await http.json('/v1/models')
    // A pre-signed upload outside the gateway is not reported.
    await http.send('https://oss.test/put', { method: 'PUT', anonymous: true })
    expect(accepted).toEqual(['POST /v1/videos', 'GET /v1/models'])
    const paid = /^\/v1\/(?:images|videos|audio)(?:\/|$)/
    expect(['/v1/videos', '/v1/images/generations', '/v1/audio/generations', '/v1/audio/transcriptions'].every(path => paid.test(path))).toBe(true)
    expect(['/v1/media-assets/uploads', '/v1/models', '/v1/videosx'].some(path => paid.test(path))).toBe(false)
  })

  it('a task that ends is reported, so its charge shows', async () => {
    const { mkdtemp, rm } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = await mkdtemp(join(tmpdir(), 'dsh-balance-'))
    try {
      const http = new GatewayHttp({
        origin: ORIGIN, userAgent: 'test', resolveCredential: async () => ({ token: 't', kind: 'plugin' }), sleep: async () => {},
        fetch: (async (input: string) => String(input).endsWith('/v1/audio/generations')
          ? json(200, { id: 'a1', status: 'queued' })
          : json(200, { id: 'a1', status: 'failed', error: { code: 'X', message: 'no' } })) as unknown as typeof globalThis.fetch,
      })
      const finished: string[] = []
      const tracker = new TaskTracker({ http, store: new TaskStore(join(dir, 'state')), sleep: async () => {}, onFinished: record => { finished.push(`${record.id}:${record.status}`) } })
      const now = Date.now()
      await tracker.submit({ id: 'op-1', kind: 'audio', model: 'm', label: 'x', createdAt: now, updatedAt: now, outputDir: dir, stem: 's', endpoint: '/v1/audio/generations', body: { model: 'm' }, status: 'submitting' })
      await tracker.follow('op-1')
      expect(finished).toEqual(['op-1:failed'])
      tracker.dispose()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('the pages keep a long poll open', () => {
  function harness(answers: Array<(path: string, init?: RequestInit) => Promise<Response> | Response>) {
    const calls: string[] = []
    const timers: number[] = []
    const store = new AccountStore({
      fetch: vi.fn(async (path: string, init?: RequestInit) => {
        calls.push(path)
        const answer = answers.shift()
        if (answer === undefined) return new Promise<Response>((_resolve, reject) => { init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))) })
        return answer(path, init)
      }) as unknown as typeof globalThis.fetch,
      setTimeout: (_callback, ms) => { timers.push(ms); return timers.length },
      clearTimeout: () => {},
    })
    return { store, calls, timers }
  }
  const view = (amount: string, revision: number): AccountView => ({
    source: 'plugin', balance: { amount, currency: 'CNY' }, models: { count: 3 }, revision,
    links: { topUp: 'https://gw.test/purchase', register: 'https://gw.test', usage: 'https://gw.test/usage' },
  })

  it('waits on the Host for changes instead of polling every minute, and shows the new balance as soon as it answers', async () => {
    const { store, calls, timers } = harness([() => Response.json(view('12.50', 4)), () => Response.json(view('11.80', 5))])
    const stop = store.start()
    await vi.waitFor(() => { expect(store.getSnapshot().view?.balance?.amount).toBe('11.80') })
    expect(calls.slice(0, 3)).toEqual([ACCOUNT_ROUTE, `${ACCOUNT_ROUTE}?since=4`, `${ACCOUNT_ROUTE}?since=5`])
    expect(timers).not.toContain(60_000)
    stop()
  })

  it('tries again a little later when the long poll fails, and keeps the minute poll for an older Host', async () => {
    const failing = harness([() => Response.json(view('12.50', 1)), () => new Response('down', { status: 502 })])
    const stop = failing.store.start()
    await vi.waitFor(() => { expect(failing.timers).toContain(5_000) })
    expect(failing.store.getSnapshot().view?.balance?.amount).toBe('12.50')
    stop()
    const { revision: _revision, ...old } = view('12.50', 0)
    const older = harness([() => Response.json(old)])
    const stopOlder = older.store.start()
    await vi.waitFor(() => { expect(older.timers).toContain(60_000) })
    expect(older.calls).toEqual([ACCOUNT_ROUTE])
    stopOlder()
  })
})
