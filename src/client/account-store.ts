/**
 * The VibeDev account as the browser half sees it: one store the Settings
 * section and the sidebar status share. It reads the Host route
 * (`GET /api/dsh-vibedev/account`) on start, every 2 s while a sign-in waits
 * for the browser, and whenever the window regains focus. Otherwise it keeps a
 * long poll open (`?since=<revision>`), which the Host answers as soon as the
 * balance or the person changes — a charge shows within seconds; a Host
 * without long polls is read every minute. The actions call the sign-in,
 * cancel and sign-out routes.
 *
 * Kept free of React and of the DOM beyond `fetch` and timers (both
 * injectable) so it can be tested in node.
 */

/** Mirrors the Host's `AccountView` (src/account/index.ts). */
export interface SignInAttempt {
  readonly id: string
  readonly phase: 'preparing' | 'waiting-browser' | 'exchanging' | 'committing' | 'succeeded' | 'failed' | 'cancelled' | 'expired'
  readonly expiresAt: number
  readonly gatewayOrigin: string
  readonly stage?: 'listen' | 'device' | 'redeem' | 'persist'
  readonly errorCode?: 'network' | 'timeout' | 'gateway-refused' | 'gateway-unavailable' | 'protocol' | 'storage' | 'callback'
  readonly httpStatus?: number
  readonly networkCode?: string
}

export interface AccountView {
  readonly source: 'host' | 'plugin' | 'key' | 'none'
  readonly user?: { readonly id?: string; readonly email?: string; readonly nickname?: string }
  readonly balance?: { readonly amount: string; readonly currency: string }
  readonly pending?: { readonly url: string; readonly expiresAt: number }
  readonly attempt?: SignInAttempt
  readonly models: { readonly count: number; readonly hidden?: 'signed-out' | 'host-account' }
  readonly links: { readonly topUp: string; readonly register: string; readonly usage: string }
  /** The VibeDev account is the app's main account (absent from older Hosts: not). */
  readonly primary?: boolean
  /** Grows with every change of the person or the balance; a Host that sends it answers `?since=` long polls. */
  readonly revision?: number
}

/** What the pages render. */
export interface AccountState {
  /** Undefined until the first read answers. */
  readonly view: AccountView | undefined
  /** The last read failed (the view, if any, is the previous one). */
  readonly loadFailed: boolean
  /** An action is running. */
  readonly busy: 'sign-in' | 'sign-out' | undefined
  /** The last action's failure, for a line under the buttons. */
  readonly actionError: { readonly kind: 'sign-in' | 'sign-out'; readonly message: string } | undefined
}

export const ACCOUNT_ROUTE = '/api/dsh-vibedev/account'

const PENDING_POLL_MS = 2_000
const IDLE_POLL_MS = 60_000
/** After a failed long poll, the next one waits this long (the Host may be restarting). */
const WATCH_RETRY_MS = 5_000

/** Injectable environment. */
export interface AccountStoreOptions {
  readonly fetch?: typeof globalThis.fetch
  readonly setTimeout?: (callback: () => void, ms: number) => unknown
  readonly clearTimeout?: (handle: unknown) => void
  /** Open a URL in a new browser tab or window (the page's own way to open the sign-in link). */
  readonly openWindow?: (url: string) => void
  /** Subscribe to the window regaining focus; returns unsubscribe. */
  readonly onFocus?: (listener: () => void) => () => void
}

/** Who to show: the nickname, else the email. */
export function displayName(view: AccountView | undefined): string | undefined {
  return view?.user?.nickname ?? view?.user?.email
}

/** The balance as text, e.g. `¥12.50`. */
export function balanceText(view: AccountView | undefined): string | undefined {
  const balance = view?.balance
  if (balance === undefined) return undefined
  const symbol = balance.currency === 'CNY' ? '¥' : balance.currency === 'USD' ? '$' : `${balance.currency} `
  return `${symbol}${balance.amount}`
}

/** The account store. */
export class AccountStore {
  private state: AccountState = { view: undefined, loadFailed: false, busy: undefined, actionError: undefined }
  private readonly listeners = new Set<() => void>()
  private timer: unknown
  private reading: Promise<void> | undefined
  private stopped = true
  private unsubscribeFocus: (() => void) | undefined
  /** The open long poll, when one is. */
  private watching: AbortController | undefined

  /**
   * @param options - fetch, timers, window opening and focus (test seams).
   */
  constructor(private readonly options: AccountStoreOptions = {}) {}

  /** Subscribe for useSyncExternalStore. */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** The current state, for useSyncExternalStore. */
  readonly getSnapshot = (): AccountState => this.state

  private set(next: Partial<AccountState>): void {
    this.state = { ...this.state, ...next }
    for (const listener of this.listeners) {
      try { listener() } catch { /* a listener cannot stop the others */ }
    }
  }

  // The Host answers these routes with `cache-control: no-store`.
  private fetch(path: string, init?: RequestInit): Promise<Response> {
    return (this.options.fetch ?? globalThis.fetch)(path, init)
  }

  /** Start reading; returns stop. */
  start(): () => void {
    if (!this.stopped) return () => { this.stop() }
    this.stopped = false
    this.unsubscribeFocus = this.options.onFocus?.(() => { void this.refresh() })
    void this.refresh()
    return () => { this.stop() }
  }

  private stop(): void {
    this.stopped = true
    this.unsubscribeFocus?.()
    this.unsubscribeFocus = undefined
    if (this.timer !== undefined) (this.options.clearTimeout ?? ((handle: unknown) => { globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>) }))(this.timer)
    this.timer = undefined
    this.watching?.abort()
    this.watching = undefined
  }

  private later(callback: () => void, ms: number): void {
    if (this.timer !== undefined) (this.options.clearTimeout ?? ((handle: unknown) => { globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>) }))(this.timer)
    this.timer = (this.options.setTimeout ?? ((run: () => void, delay: number) => globalThis.setTimeout(run, delay)))(() => {
      this.timer = undefined
      callback()
    }, ms)
  }

  private schedule(): void {
    if (this.stopped) return
    const view = this.state.view
    // A Host that counts revisions tells us about changes as they happen; a waiting sign-in keeps its quick pace.
    if (view?.pending === undefined && typeof view?.revision === 'number') {
      if (this.timer !== undefined) (this.options.clearTimeout ?? ((handle: unknown) => { globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>) }))(this.timer)
      this.timer = undefined
      this.watch(view.revision)
      return
    }
    this.watching?.abort()
    this.watching = undefined
    this.later(() => { void this.refresh() }, view?.pending !== undefined ? PENDING_POLL_MS : IDLE_POLL_MS)
  }

  /** Keep one long poll open for changes past `revision`. */
  private watch(revision: number): void {
    if (this.watching !== undefined) return
    const controller = new AbortController()
    this.watching = controller
    void (async () => {
      let failed = false
      try {
        const response = await this.fetch(`${ACCOUNT_ROUTE}?since=${revision}`, { signal: controller.signal })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const view = await response.json() as AccountView
        // A direct read may already have shown something newer.
        if (!controller.signal.aborted && (view.revision ?? 0) >= (this.state.view?.revision ?? 0)) this.set({ view, loadFailed: false })
      } catch {
        failed = !controller.signal.aborted
      } finally {
        if (this.watching === controller) this.watching = undefined
      }
      if (this.stopped || controller.signal.aborted) return
      if (failed) this.later(() => { void this.refresh() }, WATCH_RETRY_MS)
      else this.schedule()
    })()
  }

  /**
   * Read the account now.
   * @param fresh - ask the Host to read the balance again.
   */
  refresh(fresh = false): Promise<void> {
    this.reading ??= (async () => {
      try {
        const response = await this.fetch(fresh ? `${ACCOUNT_ROUTE}?fresh=1` : ACCOUNT_ROUTE)
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        this.set({ view: await response.json() as AccountView, loadFailed: false })
      } catch {
        this.set({ loadFailed: true })
      } finally {
        this.reading = undefined
        this.schedule()
      }
    })()
    return this.reading
  }

  /** Start a sign-in: the Host opens the system browser; when it could not, the page opens the link. */
  async signIn(): Promise<void> {
    this.set({ busy: 'sign-in', actionError: undefined })
    try {
      const response = await this.fetch(`${ACCOUNT_ROUTE}/sign-in`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ open: true }) })
      const body = await response.json().catch(() => undefined) as { url?: unknown; opened?: unknown; error?: { message?: unknown } } | undefined
      if (!response.ok || typeof body?.url !== 'string') {
        throw new Error(typeof body?.error?.message === 'string' ? body.error.message : `HTTP ${response.status}`)
      }
      if (body.opened !== true) this.options.openWindow?.(body.url)
    } catch {
      this.set({ actionError: { kind: 'sign-in', message: 'Sign-in request failed.' } })
    } finally {
      this.set({ busy: undefined })
      await this.refresh()
    }
  }

  /** Open the waiting sign-in's link again (the browser did not show it). */
  openPending(): void {
    const url = this.state.view?.pending?.url
    if (url !== undefined) this.options.openWindow?.(url)
  }

  /**
   * Open one of the gateway's pages (top-up, usage) the page's own way.
   * @param url - the page.
   */
  openLink(url: string): void {
    this.options.openWindow?.(url)
  }

  /** Stop a waiting sign-in. */
  async cancel(): Promise<void> {
    await this.fetch(`${ACCOUNT_ROUTE}/cancel`, { method: 'POST' }).catch(() => undefined)
    await this.refresh()
  }

  /** Sign out of the plugin's own sign-in. */
  async signOut(): Promise<void> {
    this.set({ busy: 'sign-out', actionError: undefined })
    try {
      const response = await this.fetch(`${ACCOUNT_ROUTE}/sign-out`, { method: 'POST' })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
    } catch (error) {
      this.set({ actionError: { kind: 'sign-out', message: error instanceof Error ? error.message : String(error) } })
    } finally {
      this.set({ busy: undefined })
      await this.refresh()
    }
  }
}
