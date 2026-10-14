/**
 * Reading the gateway's asynchronous task objects: `POST /v1/videos` and
 * `GET /v1/videos/{id}` (OpenAI video shape plus the gateway's `effective`
 * receipt and `asset`), and `POST /v1/audio/generations` and
 * `GET /v1/audio/generations/{id}` (`outputs[]`). Unknown statuses count as
 * still running; only an explicit terminal status ends a task.
 *
 * Both kinds carry the same settlement facts in `effective`: `billing_status`
 * (`pending`/`settled`), `billing_pending_reason`, `charged_cny` (kept as the
 * exact string given), `billed_tokens` and `estimated_cny`. A completed task
 * whose billing is pending has its result; only the charge is still to come.
 * @module dsh-vibedev/tasks/remote
 */

/** One produced file as the gateway describes it. */
export interface RemoteOutput {
  /** Position in `outputs[]`, for `/content?index=N`. */
  readonly index: number
  readonly url?: string
  readonly contentType?: string
  readonly title?: string
  /** Playback length. */
  readonly durationSeconds?: number
  /** The provider's original length this output is billed on, when it differs from playback (speech). */
  readonly originalSeconds?: number
}

/** A task's state. */
export interface RemoteTask {
  readonly id: string
  /**
   * `completed` also covers `settlement_pending`: the result exists and is
   * saved, only the charge is still being settled — it is never generated again.
   */
  readonly state: 'pending' | 'completed' | 'failed'
  /** The gateway's own status word. */
  readonly status: string
  /** Percent done, when the gateway reports it. */
  readonly progress?: number
  readonly error?: { readonly code: string; readonly message: string }
  /** Estimated price at submission (CNY, two decimals). */
  readonly estimatedCny?: string
  /**
   * Charge (CNY) exactly as the gateway wrote it (`3.98066354`); absent until the gateway
   * reports one, which is not the same as free. Final only while `settlement` is not `pending`.
   */
  readonly chargedCny?: string
  /**
   * Whether the charge of a finished task has settled: `effective.billing_status`,
   * `settlement_state`/`settlement_status` or the status `settlement_pending`. An explicit
   * pending wins over anything else in the same answer. Absent when no known word is given.
   */
  readonly settlement?: 'pending' | 'settled'
  /** The answer carried a billing or settlement status at all (older gateways send none). */
  readonly billingStatusReported: boolean
  /** Why the settlement is pending (`billing_pending_reason`). */
  readonly settlementPendingReason?: string
  /** The billable video Tokens the charge is based on (`billed_tokens`). */
  readonly billedTokens?: number
  /** The billed original length of the whole task, in seconds (speech). */
  readonly billedOriginalSeconds?: number
  /** The billed input length, in minutes (transcription). */
  readonly billedMinutes?: number
  readonly outputs: readonly RemoteOutput[]
}

type Json = Record<string, unknown>
const record = (value: unknown): Json | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Json : undefined
const text = (value: unknown): string | undefined => typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
const httpUrl = (value: unknown): string | undefined => {
  const url = text(value)
  return url !== undefined && /^https?:\/\//i.test(url) ? url : undefined
}
const amount = (value: unknown): string | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) return value.toFixed(2)
  const raw = text(value)
  return raw !== undefined && /^-?\d+(?:\.\d+)?$/.test(raw) ? raw : undefined
}

const COMPLETED = new Set(['completed', 'succeeded', 'success', 'done', 'finished', 'settlement_pending'])
const FAILED = new Set(['failed', 'failure', 'error', 'cancelled', 'canceled', 'expired', 'rejected'])
const CANCELLED = new Set(['cancelled', 'canceled'])
/** The result exists; only the charge is still being settled. */
const SETTLEMENT_PENDING = 'settlement_pending'
// Any other word, `submission_unknown` included (the gateway is still settling whether the provider took the
// request, under the same key), counts as still open: the task is only polled, never submitted again.

function stateOf(status: string): RemoteTask['state'] {
  const word = status.toLowerCase()
  if (COMPLETED.has(word)) return 'completed'
  if (FAILED.has(word)) return 'failed'
  return 'pending'
}

const seconds = (value: unknown): number | undefined => {
  const number = typeof value === 'string' ? Number(value) : value
  return typeof number === 'number' && Number.isFinite(number) && number > 0 ? number : undefined
}

/** The blocks billing facts are read from, in order: `billing`, `usage`, `effective`, then the answer itself. */
function billingBlocks(raw: Json): Json[] {
  return [record(raw.billing), record(raw.usage), record(raw.effective), raw].filter((block): block is Json => block !== undefined)
}

function pickFrom(blocks: readonly Json[], ...names: string[]): unknown {
  for (const block of blocks) for (const name of names) if (block[name] !== undefined && block[name] !== null) return block[name]
  return undefined
}

const SETTLEMENT_FIELDS = ['billing_status', 'settlement_state', 'settlement_status'] as const

const tokens = (value: unknown): number | undefined => {
  const number = typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value) : value
  return typeof number === 'number' && Number.isSafeInteger(number) && number >= 0 ? number : undefined
}

/**
 * Whether a task's charge settled, for video and audio alike. An explicit
 * pending (anywhere in the answer) wins; settled needs an explicit word. Whether
 * any status was given at all is reported apart, so the tracker can tell an older
 * gateway (no status: a charge then implies settled) from a word it does not know.
 */
function settlementOf(raw: Json, status: string): Pick<RemoteTask, 'settlement' | 'billingStatusReported' | 'settlementPendingReason' | 'billedTokens'> {
  const blocks = billingBlocks(raw)
  const words: string[] = []
  let reported = status.toLowerCase() === SETTLEMENT_PENDING
  for (const block of blocks) {
    for (const name of SETTLEMENT_FIELDS) {
      if (block[name] === undefined || block[name] === null) continue
      reported = true
      const word = text(block[name])?.toLowerCase()
      if (word !== undefined) words.push(word)
    }
  }
  const settlement = status.toLowerCase() === SETTLEMENT_PENDING || words.includes('pending') ? 'pending'
    : words.includes('settled') || words.includes('completed') ? 'settled' : undefined
  const reason = settlement === 'pending' ? text(pickFrom(blocks, 'billing_pending_reason', 'settlement_pending_reason')) : undefined
  const billedTokens = tokens(pickFrom(blocks, 'billed_tokens'))
  return {
    billingStatusReported: reported,
    ...settlement === undefined ? {} : { settlement },
    ...reason === undefined ? {} : { settlementPendingReason: reason },
    ...billedTokens === undefined ? {} : { billedTokens },
  }
}

/** The billed lengths of an audio task: original seconds (speech) and minutes (transcription). */
function billedLengths(raw: Json): Pick<RemoteTask, 'billedOriginalSeconds' | 'billedMinutes'> {
  const blocks = billingBlocks(raw)
  const originalSeconds = seconds(pickFrom(blocks, 'original_seconds', 'billed_original_seconds', 'original_duration_seconds'))
  const minutes = seconds(pickFrom(blocks, 'billed_minutes', 'minutes'))
  return {
    ...originalSeconds === undefined ? {} : { billedOriginalSeconds: originalSeconds },
    ...minutes === undefined ? {} : { billedMinutes: minutes },
  }
}

function errorOf(raw: Json): RemoteTask['error'] {
  const nested = record(raw.error)
  const message = text(nested?.message) ?? text(raw.error) ?? text(raw.failure_reason) ?? text(raw.error_message) ?? text(raw.fail_reason)
  const code = text(nested?.code) ?? text(nested?.type) ?? text(raw.error_code)
  if (message === undefined && code === undefined) return undefined
  return { code: code ?? 'GENERATION_FAILED', message: message ?? code ?? 'generation failed' }
}

function progressOf(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined
  // Some lanes report a fraction, others a percentage.
  return Math.min(100, Math.round(value <= 1 && value !== 0 ? value * 100 : value))
}

function receipt(raw: Json): Pick<RemoteTask, 'estimatedCny' | 'chargedCny'> {
  const effective = record(raw.effective) ?? {}
  const estimatedCny = amount(effective.estimated_cny)
  const chargedCny = amount(effective.charged_cny) ?? amount(raw.charged_cny)
  return {
    ...estimatedCny === undefined ? {} : { estimatedCny },
    ...chargedCny === undefined ? {} : { chargedCny },
  }
}

/**
 * Read a video task.
 * @param body - the parsed answer.
 * @returns the task, or undefined when the answer names no task id.
 */
export function parseVideoTask(body: unknown): RemoteTask | undefined {
  const raw = record(body)
  const id = text(raw?.id) ?? text(raw?.task_id)
  if (raw === undefined || id === undefined) return undefined
  const status = text(raw.status) ?? 'queued'
  const video = record(raw.video) ?? {}
  const asset = record(raw.asset) ?? record(video.asset) ?? {}
  const url = httpUrl(video.url) ?? httpUrl(asset.content_url) ?? httpUrl(raw.url) ?? httpUrl(asset.reference_url)
  const durationMs = typeof asset.duration_ms === 'number' && asset.duration_ms > 0 ? asset.duration_ms : undefined
  const seconds = typeof raw.seconds === 'number' ? raw.seconds : typeof raw.seconds === 'string' ? Number(raw.seconds) : undefined
  const contentType = text(asset.content_type) ?? text(video.content_type)
  const durationSeconds = durationMs !== undefined ? durationMs / 1000 : seconds !== undefined && Number.isFinite(seconds) && seconds > 0 ? seconds : undefined
  const state = stateOf(status)
  const error = state === 'failed' ? errorOf(raw) ?? { code: 'GENERATION_FAILED', message: `the task ended with status "${status}"` } : undefined
  const progress = progressOf(raw.progress)
  return {
    id, state, status,
    ...progress === undefined ? {} : { progress },
    ...error === undefined ? {} : { error },
    ...receipt(raw),
    ...settlementOf(raw, status),
    outputs: state === 'completed'
      ? [{
          index: 0,
          ...url === undefined ? {} : { url },
          ...contentType === undefined ? {} : { contentType },
          ...durationSeconds === undefined ? {} : { durationSeconds },
        }]
      : [],
  }
}

/**
 * Read a music or podcast task.
 * @param body - the parsed answer.
 * @returns the task, or undefined when the answer names no task id.
 */
export function parseAudioTask(body: unknown): RemoteTask | undefined {
  const raw = record(body)
  const id = text(raw?.id) ?? text(raw?.task_id)
  if (raw === undefined || id === undefined) return undefined
  const status = text(raw.status) ?? 'queued'
  const state = stateOf(status)
  const outputs: RemoteOutput[] = []
  if (Array.isArray(raw.outputs)) {
    for (const [index, item] of raw.outputs.entries()) {
      const output = record(item)
      if (output === undefined) continue
      const url = httpUrl(output.content_url) ?? httpUrl(output.url)
      const contentType = text(output.content_type)
      const title = text(output.title)
      const duration = seconds(output.duration_seconds)
      const original = seconds(output.original_duration_seconds) ?? seconds(output.original_seconds)
      outputs.push({
        index,
        ...url === undefined ? {} : { url },
        ...contentType === undefined ? {} : { contentType },
        ...title === undefined ? {} : { title },
        ...duration === undefined ? {} : { durationSeconds: duration },
        ...original === undefined ? {} : { originalSeconds: original },
      })
    }
  }
  const cancelled = CANCELLED.has(status.toLowerCase())
  const error = state === 'failed'
    ? errorOf(raw) ?? (cancelled ? { code: 'CANCELLED', message: 'The task was cancelled; cancelled tasks are not charged.' }
      : { code: 'GENERATION_FAILED', message: `the task ended with status "${status}"` })
    : undefined
  const progress = progressOf(raw.progress)
  return {
    id, state, status,
    ...progress === undefined ? {} : { progress },
    ...error === undefined ? {} : { error },
    ...receipt(raw),
    ...settlementOf(raw, status),
    ...billedLengths(raw),
    outputs: state === 'completed' ? outputs : [],
  }
}
