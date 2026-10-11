/**
 * The VibeDev account as the plugin's pages see it, and the Host routes they
 * call (`/api/dsh-vibedev/account…`, on the client connection like every
 * plugin route):
 *
 * - `GET  /api/dsh-vibedev/account` — where the credential comes from (the
 *   app's account, the plugin's own sign-in, a development key, or none), who
 *   is signed in, the balance, a sign-in waiting for the browser, and how many
 *   VibeDev models the pickers list; `?fresh=1` reads the balance again;
 *   `?since=<revision>` holds the request until the person or the balance
 *   changes (a charge is read again right after it ends), so the pages show a
 *   new balance within seconds instead of on their next minute poll;
 * - `POST /api/dsh-vibedev/account/sign-in` — `{ open?: boolean }`: start the
 *   plugin's own sign-in; answers the authorization link (`open: false` leaves
 *   opening it to the page);
 * - `POST /api/dsh-vibedev/account/cancel` — stop a waiting sign-in;
 * - `POST /api/dsh-vibedev/account/sign-out` — end the plugin's own sign-in
 *   (an app account is signed out in the app, so that answers 409).
 *
 * The DeepSeek account is never touched: it stays the Harness's own.
 * @module dsh-vibedev/account
 */

import type { ConnectionFetchRoute } from '@deepseek-ai/dsh-client-connection'
import type { CredentialChain } from '../auth/credentials.js'
import type { PluginGrant, PluginLogin, SignInAttempt } from '../auth/login.js'

/** Path prefix of the plugin's Host routes. */
export const ACCOUNT_ROUTE_PREFIX = '/api/dsh-vibedev/account'

/**
 * How long a balance read is reused as it is. After that the cached value is
 * still answered at once while a new read runs in the background (the page
 * hears the result through the long poll), so a page never waits on the gateway
 * when it already has a balance.
 */
const BALANCE_TTL_MS = 30_000

/** How long `?since=` holds a request open when nothing changes. */
const WAIT_MS = 25_000

/**
 * When the balance is read again after a charge: the gateway settles a charge
 * shortly after the request ends, so it is read a moment later, and once more
 * if the first read still shows the old amount.
 */
const SETTLE_READS_MS = [1_500, 8_000] as const

/** Reads after charges are at least this far apart. */
const MIN_READ_SPACING_MS = 5_000

/** Where the active credential comes from. */
export type AccountSource = 'host' | 'plugin' | 'key' | 'none'

/** What the account pages render. */
export interface AccountView {
  readonly source: AccountSource
  /** The signed-in person, when known. */
  readonly user?: { readonly id?: string; readonly email?: string; readonly nickname?: string }
  /** The balance, when it could be read. */
  readonly balance?: { readonly amount: string; readonly currency: string }
  /** A sign-in waiting for the browser. */
  readonly pending?: { readonly url: string; readonly expiresAt: number }
  /** Safe sign-in progress or the most recent terminal diagnostic. */
  readonly attempt?: SignInAttempt
  /** VibeDev chat models the pickers list now, and why there are none. */
  readonly models: { readonly count: number; readonly hidden?: 'signed-out' | 'host-account' }
  /** Pages on the gateway's site. */
  readonly links: { readonly topUp: string; readonly register: string; readonly usage: string }
  /** The VibeDev account is the app's main account (the VibeDev app): its row leads the sidebar foot and Settings. */
  readonly primary: boolean
  /**
   * Grows whenever the person or the balance changes; `GET …/account?since=<revision>`
   * answers as soon as it grows (or after a while with the same view).
   */
  readonly revision: number
}

/** What the account routes need from the plugin. */
export interface AccountServiceOptions {
  readonly origin: string
  readonly userAgent: string
  readonly chain: CredentialChain
  readonly login: PluginLogin
  /** The VibeDev route's model count and why it is empty. */
  readonly models: () => { count: number; hidden?: 'signed-out' | 'host-account' }
  /** Present the VibeDev account as the app's main account. */
  readonly primary?: boolean
  readonly fetch?: typeof globalThis.fetch
  readonly now?: () => number
  /** Timer seams for the reads after a charge and the long poll. */
  readonly setTimeout?: (callback: () => void, ms: number) => unknown
  readonly clearTimeout?: (handle: unknown) => void
}

type BalanceRead = Pick<AccountView, 'balance' | 'user'>

type Json = Record<string, unknown>
const record = (value: unknown): Json | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Json : undefined
const text = (value: unknown): string | undefined => typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined

/** The account state behind the pages. */
export class AccountService {
  private balanceCache: { token: string; at: number; value: Promise<BalanceRead> } | undefined
  /** A background read of a stale balance, so only one runs at a time. */
  private revalidating: Promise<BalanceRead> | undefined
  private readonly now: () => number
  private revision = 0
  /** What the last read showed, to tell whether the next one changed anything. */
  private lastSeen: string | undefined
  private readonly waiters = new Set<() => void>()
  private settleTimers: unknown[] = []
  /** Grows with every credential change; a read started before one is dropped. */
  private epoch = 0
  /** When the last read after a charge started, to space them out. */
  private lastSpendReadAt = Number.NEGATIVE_INFINITY

  /**
   * @param options - origin, credential chain, the plugin's sign-in and the route's model state.
   */
  constructor(private readonly options: AccountServiceOptions) {
    this.now = options.now ?? Date.now
  }

  private timeout(callback: () => void, ms: number): unknown {
    return (this.options.setTimeout ?? ((run: () => void, delay: number) => {
      const handle = globalThis.setTimeout(run, delay)
      ;(handle as { unref?: () => void }).unref?.()
      return handle
    }))(callback, ms)
  }

  private cancelTimeout(handle: unknown): void {
    (this.options.clearTimeout ?? ((value: unknown) => { globalThis.clearTimeout(value as ReturnType<typeof setTimeout>) }))(handle)
  }

  /** Something the pages show changed: answer every waiting `?since=` request. */
  changed(): void {
    this.revision++
    const waiting = [...this.waiters]
    this.waiters.clear()
    for (const wake of waiting) wake()
  }

  /** The account changed hands (sign-in, sign-out, switch): forget the balance and tell the pages. */
  credentialChanged(): void {
    this.epoch++
    this.balanceCache = undefined
    this.revalidating = undefined
    this.lastSeen = undefined
    this.changed()
  }

  /**
   * A request that may have cost money ended (a chat reply, a generation, a
   * transcription): read the balance again shortly, and once more later if the
   * charge had not settled yet. Repeated calls in a burst share the reads.
   */
  spent(): void {
    for (const handle of this.settleTimers) this.cancelTimeout(handle)
    const before = this.lastSeen
    // At most one read every few seconds, however busy an agent loop is.
    const spacing = Math.max(0, this.lastSpendReadAt + MIN_READ_SPACING_MS - this.now())
    this.settleTimers = SETTLE_READS_MS.map((delay, index) => this.timeout(() => {
      // The second read only when the first one still showed the amount from before the charge.
      if (index > 0 && this.lastSeen !== before) return
      void this.readNow()
    }, Math.max(delay, spacing + (index === 0 ? 0 : delay - SETTLE_READS_MS[0]))))
  }

  /** Read the balance of the current credential now (the pages hear about a change through the long poll). */
  private async readNow(): Promise<void> {
    this.lastSpendReadAt = this.now()
    const credential = await this.options.chain.resolve().catch(() => undefined)
    if (credential !== undefined) await this.me(credential.token, true)
  }

  /**
   * Wait until the view changes past `since`, or a while.
   * @param since - the revision the page shows.
   * @param signal - the page went away.
   * @returns once there is something new, or the wait ran out.
   */
  async wait(since: number, signal?: AbortSignal): Promise<void> {
    if (since !== this.revision || signal?.aborted === true) return
    await new Promise<void>((resolve) => {
      const done = (): void => {
        this.waiters.delete(done)
        this.cancelTimeout(timer)
        signal?.removeEventListener('abort', done)
        resolve()
      }
      const timer = this.timeout(done, WAIT_MS)
      this.waiters.add(done)
      signal?.addEventListener('abort', done, { once: true })
    })
  }

  /** Links to the gateway's pages. */
  links(): AccountView['links'] {
    const origin = this.options.origin
    return { topUp: `${origin}/purchase`, register: origin, usage: `${origin}/usage` }
  }

  /**
   * The account as it stands.
   * @param fresh - read the balance again instead of reusing a recent read.
   * @returns the view.
   */
  async view(fresh = false): Promise<AccountView> {
    const credential = await this.options.chain.resolve().catch(() => undefined)
    const source: AccountSource = credential === undefined ? 'none' : credential.kind === 'account' ? 'host' : credential.kind
    const pending = this.options.login.pendingSignIn()
    const attempt = this.options.login.signInAttempt()
    const base = {
      source, models: this.options.models(), links: this.links(), primary: this.options.primary === true,
      ...pending === undefined ? {} : { pending },
      ...attempt === undefined ? {} : { attempt },
    }
    if (credential === undefined) return { ...base, revision: this.revision }
    // The sign-in's own user and the gateway read run side by side.
    const [grantUser, me] = await Promise.all([
      credential.kind === 'plugin' ? this.options.login.user().catch(() => undefined) : Promise.resolve(undefined),
      this.me(credential.token, fresh),
    ])
    const user = me.user ?? userOf(grantUser)
    // The revision is read last, so a change that landed during this read is already counted in it.
    return { ...base, ...user === undefined ? {} : { user }, ...me.balance === undefined ? {} : { balance: me.balance }, revision: this.revision }
  }

  /**
   * `GET /v1/account/auth/me` for one token. A read younger than the TTL is
   * reused; an older one is answered at once while a new read runs behind it.
   */
  private me(token: string, fresh: boolean): Promise<BalanceRead> {
    const cached = this.balanceCache
    if (!fresh && cached !== undefined && cached.token === token) {
      if (this.now() - cached.at >= BALANCE_TTL_MS && this.revalidating === undefined) {
        const next = this.read(token)
        this.revalidating = next
        void next.finally(() => { if (this.revalidating === next) this.revalidating = undefined })
      }
      return cached.value
    }
    return this.read(token)
  }

  private read(token: string): Promise<BalanceRead> {
    const epoch = this.epoch
    const value = (async (): Promise<BalanceRead> => {
      try {
        const response = await (this.options.fetch ?? globalThis.fetch)(`${this.options.origin}/v1/account/auth/me`, {
          headers: { accept: 'application/json', authorization: `Bearer ${token}`, 'user-agent': this.options.userAgent },
          signal: AbortSignal.timeout(15_000),
          redirect: 'error',
        })
        if (!response.ok) return {}
        const body = record(await response.json().catch(() => undefined))
        const data = record(body?.data) ?? body
        const balance = typeof data?.balance === 'number' && Number.isFinite(data.balance) ? String(data.balance) : text(data?.balance)
        const currency = text(data?.currency) ?? 'CNY'
        const id = typeof data?.id === 'number' ? String(data.id) : text(data?.id)
        const nickname = text(data?.nickname) ?? text(data?.username)
        const email = text(data?.email)
        const user = id === undefined && nickname === undefined && email === undefined
          ? undefined
          : { ...id === undefined ? {} : { id }, ...email === undefined ? {} : { email }, ...nickname === undefined ? {} : { nickname } }
        return {
          ...balance === undefined || !/^-?\d+(\.\d+)?$/.test(balance) ? {} : { balance: { amount: balance, currency } },
          ...user === undefined ? {} : { user },
        }
      } catch {
        // The page shows the account without a balance; the next read tries again.
        return {}
      }
    })()
    const previous = this.balanceCache
    // A stale value keeps being answered until the new read lands; a first read is waited for.
    if (previous === undefined || previous.token !== token) this.balanceCache = { token, at: this.now(), value }
    void value.then((read) => {
      // A read started for an account that has since changed hands is dropped.
      if (epoch !== this.epoch) return
      // A failed read is not kept (the next view asks again), and does not replace a good one.
      if (read.balance === undefined) {
        if (this.balanceCache?.value === value) this.balanceCache = undefined
        return
      }
      this.balanceCache = { token, at: this.now(), value }
      const seen = JSON.stringify(read)
      if (this.lastSeen !== undefined && this.lastSeen !== seen) {
        this.lastSeen = seen
        this.changed()
      } else this.lastSeen = seen
    })
    return value
  }

  /**
   * Start the plugin's own sign-in.
   * @param open - open the system browser (false: the page opens the link itself).
   * @returns the authorization link and whether a browser was opened.
   */
  async signIn(open: boolean): Promise<{ url: string; expiresAt: number; opened: boolean }> {
    const started = await this.options.login.startSignIn({ open })
    return { url: started.url, expiresAt: started.expiresAt, opened: started.opened }
  }

  /** Stop a waiting sign-in. */
  cancel(): void {
    this.options.login.dispose()
  }

  /**
   * End the plugin's own sign-in.
   * @returns false when the credential is the app's account, which is signed out in the app.
   */
  async signOut(): Promise<boolean> {
    const credential = await this.options.chain.resolve().catch(() => undefined)
    if (credential?.kind === 'account') return false
    await this.options.login.signOut()
    this.credentialChanged()
    return true
  }

  /** Stop the pending reads after a charge (the plugin is going away). */
  dispose(): void {
    for (const handle of this.settleTimers) this.cancelTimeout(handle)
    this.settleTimers = []
    const waiting = [...this.waiters]
    this.waiters.clear()
    for (const wake of waiting) wake()
  }
}

function userOf(user: PluginGrant['user'] | undefined): AccountView['user'] | undefined {
  if (user === undefined) return undefined
  const { id, email, nickname } = user
  if (id === undefined && email === undefined && nickname === undefined) return undefined
  return { ...id === undefined ? {} : { id }, ...email === undefined ? {} : { email }, ...nickname === undefined ? {} : { nickname } }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
}

function failure(error: unknown): Response {
  const candidate = record(error)?.code
  // Even an unexpected storage/listener error may contain tokens, URLs or paths.
  // Keep legacy route codes, but never copy arbitrary codes, messages or causes.
  const code = candidate === 'SIGN_IN_REFUSED' || candidate === 'SIGN_IN_TIMEOUT' || candidate === 'SIGN_IN_CANCELLED' ? candidate : 'INTERNAL'
  const message = code === 'SIGN_IN_CANCELLED' ? 'Sign-in was cancelled. 登录已取消。'
    : code === 'SIGN_IN_TIMEOUT' ? 'Sign-in expired. 登录已超时，请重新登录。'
      : 'The account request could not be completed. 账号请求未完成，请查看登录诊断后重试。'
  return json(500, { error: { code, message } })
}

/**
 * The account routes.
 * @param account - the account service.
 * @returns routes for the client connection.
 */
export function accountRoutes(account: AccountService): ConnectionFetchRoute[] {
  return [
    {
      path: ACCOUNT_ROUTE_PREFIX,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async (request) => {
        try {
          const query = new URL(request.url, 'http://host').searchParams
          // `?since=<revision>`: a long poll that answers as soon as the person or the balance changes.
          const since = query.get('since')
          if (since !== null && /^\d{1,15}$/.test(since)) await account.wait(Number(since), request.signal)
          return json(200, await account.view(query.get('fresh') === '1'))
        } catch (error) {
          return failure(error)
        }
      },
    },
    {
      path: `${ACCOUNT_ROUTE_PREFIX}/sign-in`,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        try {
          const body = record(await request.json().catch(() => undefined))
          return json(200, await account.signIn(body?.open !== false))
        } catch (error) {
          return failure(error)
        }
      },
    },
    {
      path: `${ACCOUNT_ROUTE_PREFIX}/cancel`,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: () => {
        account.cancel()
        return Promise.resolve(json(200, { ok: true }))
      },
    },
    {
      path: `${ACCOUNT_ROUTE_PREFIX}/sign-out`,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async () => {
        try {
          return await account.signOut()
            ? json(200, { ok: true })
            : json(409, { error: { code: 'SIGNED_IN_BY_APP', message: 'The VibeDev account is the app\'s sign-in; sign out in the app.' } })
        } catch (error) {
          return failure(error)
        }
      },
    },
  ]
}
