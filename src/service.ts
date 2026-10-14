/**
 * The media service other plugins call, registered as `vibedevMedia`: the
 * film workbench's storyboard generates through it when someone presses a
 * generate button. It takes the same paths as the agent tools — model
 * choice, reference checks and uploads, idempotent submission, a background
 * follower that saves the result — with the caller naming the workspace and
 * where results go. The caller has already shown the price and the user chose
 * to go ahead, so the spending confirmation setting does not ask again.
 *
 * Every task, video or audio, is read the same way: {@link MediaHostService.task}
 * (what is recorded), {@link MediaHostService.refreshTask} (ask the gateway again:
 * fresh links, settlement — a query only, it never submits),
 * {@link MediaHostService.onTask} (each change) and
 * {@link MediaHostService.result} (the files to play or download).
 * @module dsh-vibedev/service
 */

import { audioFormOf, prepareAudioTask } from './audio/request.js'
import type { AudioForm, AudioRequest } from './audio/request.js'
import type { MediaModel } from './gateway/catalog.js'
import { MediaError } from './gateway/errors.js'
import { quoteAudio, quoteVideo } from './pricing.js'
import type { AudioQuote, VideoQuote, VideoQuoteRequest } from './pricing.js'
import type { MediaCall, MediaRuntime } from './runtime.js'
import type { TaskRecord, TaskStatus } from './tasks/store.js'
import { generateImages } from './tools/image.js'
import type { ImageRequest } from './tools/image.js'
import { prepareVideoTask } from './tools/video.js'
import type { VideoRequest } from './tools/video.js'

/** Where a host request runs and where its results go. */
export interface HostTarget {
  /** The workspace; relative input paths resolve against it. */
  readonly cwd: string
  /** Absolute folder the results are saved in. */
  readonly folder: string
  /** File-name stem of the results. */
  readonly stem: string
}

/** One produced file, as host callers see it. */
export interface MediaOutputView {
  /** Where it was saved; absent while it could not be downloaded. */
  readonly path?: string
  /** The gateway's link (signed; it expires — {@link MediaHostService.result} renews it). */
  readonly url?: string
  readonly contentType?: string
  readonly title?: string
  /** Playback length. */
  readonly durationSeconds?: number
  /** The original length it is billed on (speech), when it differs from playback. */
  readonly originalSeconds?: number
}

/** A video or audio task, as host callers see it. */
export interface MediaTaskView {
  readonly id: string
  readonly kind: TaskRecord['kind']
  /** For audio: music, podcast or speech. */
  readonly audioKind?: string
  readonly model: string
  readonly status: TaskStatus
  readonly progress?: string
  readonly outputs?: readonly MediaOutputView[]
  readonly error?: { readonly code: string; readonly message: string }
  /** The gateway's estimate, as given (`3.98`). */
  readonly estimatedCny?: string
  /** Only when `settlement` is `settled`: the final charge, exactly as given (`3.98066354`). */
  readonly chargedCny?: string
  /**
   * `pending`: the result is there, the charge is still being settled (it is
   * never generated again, and it is neither a failure nor free); `settled`: `chargedCny` is final.
   */
  readonly settlement?: 'pending' | 'settled'
  /** Why the settlement is pending (`billing_pending_reason`), while it is. */
  readonly settlementPendingReason?: string
  /** How it is billed: the unit, the unit price, and the billed length or video Tokens once known. */
  readonly billing?: TaskRecord['billing']
  readonly createdAt: number
  readonly updatedAt: number
}

const view = (record: TaskRecord): MediaTaskView => ({
  id: record.id,
  kind: record.kind,
  ...record.audioKind === undefined ? {} : { audioKind: record.audioKind },
  model: record.model,
  status: record.status,
  ...record.progress === undefined ? {} : { progress: record.progress },
  ...record.outputs === undefined ? {} : {
    outputs: record.outputs.map(({ index: _index, bytes: _bytes, ...output }) => ({ ...output })),
  },
  ...record.error === undefined ? {} : { error: { ...record.error } },
  ...record.estimatedCny === undefined ? {} : { estimatedCny: record.estimatedCny },
  // A charge is never shown as final while its settlement is pending.
  ...record.chargedCny === undefined || record.settlement === 'pending' ? {} : { chargedCny: record.chargedCny },
  ...record.settlement === undefined ? {} : { settlement: record.settlement },
  ...record.settlement !== 'pending' || record.settlementPendingReason === undefined ? {} : { settlementPendingReason: record.settlementPendingReason },
  ...record.billing === undefined ? {} : { billing: { ...record.billing } },
  createdAt: record.createdAt,
  updatedAt: record.updatedAt,
})

/** The parts of a request that decide what is generated, to tell a repeated operation from a different one. */
function sameRequest(record: TaskRecord, draft: TaskRecord): boolean {
  const { references: _a, ...left } = record.body as Record<string, unknown>
  const { references: _b, ...right } = draft.body as Record<string, unknown>
  return record.kind === draft.kind && record.model === draft.model && JSON.stringify(left) === JSON.stringify(right)
}

export class MediaHostService {
  constructor(private readonly runtime: MediaRuntime, readonly version: string) {}

  private call(target: HostTarget, signal: AbortSignal): MediaCall {
    return { signal, cwd: target.cwd, confirmed: true }
  }

  /**
   * The media models this account can use (cached briefly; renewed after a sign-in, sign-out or account switch).
   * @param signal - cancels the request.
   * @returns the models in catalog order.
   */
  models(signal?: AbortSignal): Promise<readonly MediaModel[]> {
    return this.runtime.models(signal)
  }

  /**
   * The forms to show for the audio models this account can use: one per
   * model that declares what it makes, with only the fields it takes, their
   * declared choices and limits, and its price.
   * @param signal - cancels the catalog request.
   * @returns the forms, in catalog order.
   */
  async audioForms(signal?: AbortSignal): Promise<readonly AudioForm[]> {
    return (await this.runtime.models(signal)).flatMap((model) => {
      const form = audioFormOf(model)
      return form === undefined ? [] : [form]
    })
  }

  /**
   * The price of one audio or transcription model: `¥0.50/次`, `¥0.02/原始秒`, `¥0.30/分钟`, or 未定价.
   * @param model - the model id or alias.
   * @param signal - cancels the catalog request.
   * @returns the quote.
   */
  async audioPrice(model: string, signal?: AbortSignal): Promise<AudioQuote> {
    return quoteAudio(await this.runtime.findModel(model, signal))
  }

  /**
   * What a video request is expected to cost, from the (cached) catalog alone:
   * nothing is uploaded, submitted or recorded. Video Token pricing gives the
   * matching rule's estimate (`预计 ¥8.34 · 最终按实际视频 Token 结算`) or says why there
   * is none; legacy prices are quoted as before. A model the account does not
   * have is an `invalid-request`; a catalog failure (no sign-in, no network) is thrown.
   * @param request - the model (id or alias), resolution, duration and references.
   * @param signal - cancels the catalog request.
   * @returns the quote, under the model's canonical id.
   */
  async videoQuote(request: VideoQuoteRequest, signal?: AbortSignal): Promise<VideoQuote> {
    const wanted = typeof request?.model === 'string' ? request.model.trim() : ''
    let model: MediaModel
    try {
      if (wanted === '') throw new MediaError('A video quote needs a model.', 'MODEL_NOT_FOUND', { field: 'model' })
      model = await this.runtime.findModel(wanted, signal)
    } catch (error) {
      if (!(error instanceof MediaError) || error.code !== 'MODEL_NOT_FOUND') throw error
      return {
        status: 'unavailable', mode: 'none', model: wanted, reason: 'invalid-request',
        label: { en: 'estimate unavailable', zh: '无法预估' },
        basis: { en: `There is no model "${wanted}" on this VibeDev account.`, zh: `当前 VibeDev 账号没有模型“${wanted}”。` },
      }
    }
    return quoteVideo(model, request)
  }

  /**
   * Generate images now and save them.
   * @param request - what to generate.
   * @param target - the workspace and where the files go.
   * @param signal - cancels the request.
   * @returns the model, the saved files, the estimate and a revised prompt.
   */
  async generateImages(request: ImageRequest, target: HostTarget, signal: AbortSignal) {
    const result = await generateImages(this.runtime, this.call(target, signal), request, { folder: target.folder, stem: target.stem })
    return { ...result, images: result.images.map(({ data: _data, ...image }) => image) }
  }

  /**
   * Submit a video. The plugin follows the task in the background and saves
   * the video when it finishes; watch it with {@link task} and {@link onTask}.
   * A submission the gateway did not confirm is resent in the background
   * under the same key, so it is reported as a task still being submitted
   * rather than as a failure.
   * @param request - what to generate.
   * @param target - the workspace and where the video goes.
   * @param signal - cancels the preparation and the submission.
   * @returns the task.
   */
  async startVideo(request: VideoRequest, target: HostTarget, signal: AbortSignal): Promise<MediaTaskView> {
    const prepared = await prepareVideoTask(this.runtime, this.call(target, signal), request, { folder: target.folder, stem: target.stem })
    return this.submit(prepared.draft, signal)
  }

  /**
   * Submit music, a podcast episode or speech. Fields are checked against
   * what the model declares before anything is uploaded or charged; speech
   * references are uploaded to the gateway media library first.
   *
   * One user operation, one task: pass the same `operationId` when the same
   * click is retried and the task already recorded under it is returned —
   * nothing is submitted twice. Without one, every call is a new operation.
   * @param request - what to generate.
   * @param target - the workspace and where the audio goes.
   * @param signal - cancels the preparation and the submission.
   * @returns the task.
   */
  async startAudio(request: AudioRequest, target: HostTarget, signal: AbortSignal): Promise<MediaTaskView> {
    if (request.operationId !== undefined) {
      const earlier = await this.runtime.store.get(request.operationId).catch(() => undefined)
      if (earlier !== undefined) {
        // The same operation again: its task, never a second submission. A finished one is not restarted either.
        if (earlier.kind !== 'audio') throw new MediaError(`Operation ${request.operationId} already belongs to a ${earlier.kind} task.`, 'OPERATION_CONFLICT', { field: 'operationId' })
        return view(earlier)
      }
    }
    const prepared = await prepareAudioTask(this.runtime, this.call(target, signal), request, { folder: target.folder, stem: target.stem })
    const raced = await this.runtime.store.get(prepared.draft.id).catch(() => undefined)
    if (raced !== undefined) {
      if (!sameRequest(raced, prepared.draft)) throw new MediaError(`Operation ${prepared.draft.id} already belongs to a different request.`, 'OPERATION_CONFLICT', { field: 'operationId' })
      return view(raced)
    }
    return this.submit(prepared.draft, signal)
  }

  private async submit(draft: TaskRecord, signal: AbortSignal): Promise<MediaTaskView> {
    try {
      return view(await this.runtime.tracker.submit(draft, signal))
    } catch (error) {
      if (error instanceof MediaError && error.code === 'SUBMISSION_UNCONFIRMED') {
        const recorded = await this.runtime.store.get(draft.id)
        if (recorded !== undefined) return view(recorded)
      }
      throw error
    }
  }

  /**
   * A task's current state, as recorded (no request to the gateway).
   * @param id - the task id.
   * @returns the task, or `undefined` when there is none.
   */
  async task(id: string): Promise<MediaTaskView | undefined> {
    const record = await this.runtime.store.get(id)
    return record === undefined ? undefined : view(record)
  }

  /**
   * Ask the gateway about a task again — a query, never a submission: a
   * finished task gets fresh links and its missing files are downloaded
   * again, and a pending settlement is read again. A running task is followed.
   * @param id - the task id.
   * @param signal - cancels the query.
   * @returns the task after the query, or `undefined` when there is none.
   */
  async refreshTask(id: string, signal?: AbortSignal): Promise<MediaTaskView | undefined> {
    if (await this.runtime.store.get(id) === undefined) return undefined
    return view(await this.runtime.tracker.refresh(id, signal))
  }

  /**
   * The files of a finished task, ready to play or download: saved files by
   * path, and links renewed by a query when one is needed (a missing file, an
   * expired link). Never generates again.
   * @param id - the task id.
   * @param signal - cancels the query.
   * @returns the outputs, or `undefined` while the task has none.
   */
  async result(id: string, signal?: AbortSignal): Promise<readonly MediaOutputView[] | undefined> {
    const record = await this.runtime.store.get(id)
    if (record === undefined || record.status !== 'completed') return undefined
    const complete = (record.outputs ?? []).length > 0 && (record.outputs ?? []).every(output => output.path !== undefined)
    const current = complete ? record : await this.runtime.tracker.refresh(id, signal).catch(() => record)
    return (current.outputs ?? []).map(({ index: _index, bytes: _bytes, ...output }) => ({ ...output }))
  }

  /**
   * Hear about every change to one task.
   * @param id - the task id.
   * @param listener - called with the task after each change.
   * @returns stops listening.
   */
  onTask(id: string, listener: (task: MediaTaskView) => void): () => void {
    return this.runtime.tracker.onUpdate(id, (record) => { listener(view(record)) })
  }
}
