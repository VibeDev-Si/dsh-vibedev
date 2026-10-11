/**
 * `media_models`: the media models this VibeDev account can use, with prices
 * and, for video, what each generation mode accepts.
 * @module dsh-vibedev/tools/models
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { MediaModel } from '../gateway/catalog.js'
import { promptFieldOf, requestFieldsOf } from '../audio/request.js'
import { describePrice, quoteAudio } from '../pricing.js'
import type { MediaRuntime, ModelSlot } from '../runtime.js'
import { describeVideoModel } from '../video/plan.js'

const KIND_LABEL: Readonly<Record<MediaModel['kind'], string>> = {
  image: 'Image models (image_generate)',
  video: 'Video models (video_generate)',
  audio: 'Music, podcast and speech models (audio_generate)',
  transcription: 'Transcription models (audio_transcribe)',
}

function slotOf(model: MediaModel): ModelSlot | undefined {
  if (model.kind === 'audio') return model.audioKind
  return model.kind
}

/**
 * What an audio model takes, from its declaration: the fields, speech references, output formats and sample rates.
 * @param model - an audio or transcription model.
 * @returns one line, or undefined when nothing is declared.
 */
export function describeAudioModel(model: MediaModel): string | undefined {
  const audio = model.audio
  if (model.kind === 'transcription') {
    const facts = [
      audio?.maxInputBytes === undefined ? undefined : `at most ${(audio.maxInputBytes / 1_000_000).toFixed(0)} MB`,
      audio?.maxInputSeconds === undefined ? undefined : `at most ${Math.round(audio.maxInputSeconds / 60)} min`,
      audio?.languages === undefined ? undefined : `languages ${audio.languages.join(', ')}`,
    ].filter(Boolean)
    return facts.length === 0 ? undefined : facts.join('; ')
  }
  if (model.audioKind === undefined) return 'does not declare what kind of audio it makes; it cannot be used for generation'
  const fields = requestFieldsOf(model).filter(name => name !== 'model')
  const parts = [`fields: ${fields.join(', ') || 'none declared'}`]
  const prompt = promptFieldOf(model)
  if (prompt !== undefined && prompt !== 'prompt') parts.push(`the text goes in ${prompt}`)
  const references = audio?.references
  if (references !== undefined && fields.includes('references')) {
    const count = references.min === references.max ? `${references.max}` : `${references.min}-${references.max}`
    parts.push([`${count} reference audio`,
      references.maxBytes === undefined ? undefined : `each at most ${(references.maxBytes / 1048576).toFixed(0)} MiB`,
      references.minSeconds === undefined && references.maxSeconds === undefined ? undefined : `each ${references.minSeconds ?? 0}-${references.maxSeconds ?? '∞'} s`,
      references.exclusiveWith === undefined ? undefined : `not with ${references.exclusiveWith.join(', ')}`].filter(Boolean).join(', '))
  }
  for (const format of audio?.outputFormats ?? []) {
    parts.push(`format ${format.format}${format.sampleRates.length === 0 ? '' : ` at ${format.sampleRates.join('/')} Hz`}`)
  }
  return parts.join('; ')
}

/**
 * Build the tool.
 * @param runtime - the media runtime.
 * @returns the tool definition.
 */
export function mediaModelsTool(runtime: MediaRuntime): ToolDefinition {
  return defineTool({
    name: 'media_models',
    description: 'List the image, video, music/podcast/speech and transcription models this VibeDev account can use, with prices '
      + '("not priced" when the catalog states none). For video models it lists each generation mode and the inputs it accepts (reference images, '
      + 'videos and audio, first and last frames), durations, aspect ratios and resolutions; for audio models the fields each takes, speech '
      + 'references, output formats and sample rates. Use it to choose a model when a request needs particular inputs or options; '
      + 'the generation tools pick a suitable model themselves when none is named.',
    parameters: {
      kind: { type: 'string', enum: ['image', 'video', 'audio', 'transcription'], description: 'Only list models of this kind.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          models: {
            type: 'array',
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                name: { type: 'string', required: true },
                kind: { type: 'string', required: true },
                produces: { type: 'string' },
                description: { type: 'string' },
                price: { type: 'string' },
                capabilities: { type: 'string' },
                pinned: { type: 'boolean' },
              },
            },
          },
        },
      },
      render: (args, value) => {
        const models = value.models ?? []
        if (models.length === 0) return [{ type: 'text', text: `No ${args.kind ?? 'media'} models are available on this VibeDev account.` }]
        const lines: string[] = []
        for (const kind of ['image', 'video', 'audio', 'transcription'] as const) {
          const group = models.filter(model => model.kind === kind)
          if (group.length === 0) continue
          lines.push(`${KIND_LABEL[kind]}:`)
          for (const model of group) {
            const facts = [
              model.name === model.id ? undefined : model.name,
              model.produces,
              model.description,
              model.price,
              model.pinned === true ? 'default in settings' : undefined,
            ].filter(part => part !== undefined && part !== '')
            lines.push(`- ${model.id}${facts.length === 0 ? '' : ` — ${facts.join('; ')}`}`)
            if (model.capabilities !== undefined) lines.push(`  ${model.capabilities}`)
          }
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const models = (await runtime.models(exec.signal)).filter(model => args.kind === undefined || model.kind === args.kind)
      return {
        models: models.map((model) => {
          const audioLike = model.kind === 'audio' || model.kind === 'transcription'
          const price = audioLike ? quoteAudio(model).label.en : describePrice(model)
          const slot = slotOf(model)
          const pinned = slot !== undefined && runtime.settings.defaultModel(slot).trim() === model.id
          const audioFacts = audioLike ? describeAudioModel(model) : undefined
          return {
            id: model.id, name: model.name, kind: model.kind,
            ...model.kind !== 'audio' ? {} : { produces: model.audioKind ?? 'undeclared' },
            ...model.description === undefined ? {} : { description: model.description },
            price,
            ...model.kind === 'video' ? { capabilities: describeVideoModel(model) } : {},
            ...audioFacts === undefined ? {} : { capabilities: audioFacts },
            ...pinned ? { pinned } : {},
          }
        }),
      }
    },
  })
}
