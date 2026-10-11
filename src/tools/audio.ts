/**
 * `audio_generate`: music, a podcast episode or speech, as a background task
 * whose results are saved in the workspace. Every field is checked against
 * what the chosen model declares (see `audio/request`).
 * @module dsh-vibedev/tools/audio
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { AUDIO_MAKE_KINDS, prepareAudioTask } from '../audio/request.js'
import type { AudioMakeKind } from '../audio/request.js'
import type { MediaRuntime } from '../runtime.js'
import { yuan } from '../pricing.js'
import { SOURCE_HELP, UNCONFIRMED_NOTE, describeTask, submitTask, waitForTask } from './common.js'

/**
 * Build the tool.
 * @param runtime - the media runtime.
 * @returns the tool definition.
 */
export function audioGenerateTool(runtime: MediaRuntime): ToolDefinition {
  return defineTool({
    name: 'audio_generate',
    description: 'Generate music (a song with vocals or an instrumental), a podcast episode (a spoken conversation about a topic or a web page) '
      + 'or speech (text read aloud, optionally in the voice of reference audio) with a VibeDev audio model. It runs as a background job: '
      + 'this call returns once the gateway accepts the task, you are notified when it finishes, and the files are saved in the workspace '
      + '(media/audio/). Each model takes only the fields it declares; media_models lists them with prices (music and podcasts per request, '
      + 'speech per second of original audio). Charged only when it succeeds.',
    parameters: {
      type: { type: 'string', enum: [...AUDIO_MAKE_KINDS], required: true, description: 'What to make.' },
      prompt: {
        type: 'string',
        description: 'Music: style, mood, instruments, tempo, theme (required). Podcast: the topic and angle; give a prompt, a source_url, or both. '
          + 'Speech: the exact text to speak (required).',
      },
      lyrics: { type: 'string', description: 'Music only: the complete lyrics. Omit to let the model write them.' },
      genre: { type: 'string', description: 'Music only: genre, such as pop, folk, electronic.' },
      mood: { type: 'string', description: 'Music only: mood, such as happy, calm, epic.' },
      gender: { type: 'string', description: 'Music only: the singer\'s voice, such as male or female.' },
      source_url: { type: 'string', description: 'Podcast only: an http(s) page for the hosts to discuss.' },
      references: { type: 'array', items: { type: 'string' }, description: `Speech only: reference audio whose voice to imitate, each ${SOURCE_HELP}. The model states how many, how large and how long.` },
      format: { type: 'string', description: 'Speech only: an output format the model offers (media_models lists them, such as wav or mp3).' },
      sample_rate: { type: 'integer', description: 'Speech only: a sample rate the model offers for that format (Hz).' },
      watermark: { type: 'boolean', description: 'Speech only, when the model takes it: add the provider\'s audio watermark.' },
      model: { type: 'string', description: 'Audio model id (or alias) from media_models. Omit to use the default for the type.' },
      filename: { type: 'string', description: 'File name for the result, without extension. Default: a timestamp plus the start of the prompt.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          taskId: { type: 'string', required: true },
          status: { type: 'string', required: true },
          model: { type: 'string', required: true },
          jobId: { type: 'string' },
          estimatedCny: { type: 'string' },
          price: { type: 'string' },
          outputs: {
            type: 'array',
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                path: { type: 'string' }, url: { type: 'string' }, title: { type: 'string' },
                durationSeconds: { type: 'number' }, originalSeconds: { type: 'number' },
              },
            },
          },
          message: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.message }],
    },
    async execute(args, exec) {
      const kind = args.type as AudioMakeKind
      const prompt = args.prompt?.trim()
      const prepared = await prepareAudioTask(runtime, exec, {
        kind,
        ...args.model === undefined ? {} : { model: args.model },
        ...prompt === undefined || prompt === '' ? {} : { prompt },
        ...args.lyrics === undefined ? {} : { lyrics: args.lyrics },
        ...args.genre === undefined ? {} : { genre: args.genre },
        ...args.mood === undefined ? {} : { mood: args.mood },
        ...args.gender === undefined ? {} : { gender: args.gender },
        ...args.source_url === undefined ? {} : { sourceUrl: args.source_url },
        ...args.references === undefined ? {} : { references: args.references as string[] },
        ...args.format === undefined ? {} : { format: args.format },
        ...args.sample_rate === undefined ? {} : { sampleRate: args.sample_rate },
        ...args.watermark === undefined ? {} : { watermark: args.watermark },
      }, { folder: runtime.outputFolder(exec, 'audio'), stem: runtime.stem(args.filename, prompt ?? args.source_url ?? kind) })
      const { model, quote } = prepared
      const { record: accepted, jobId, unconfirmed } = await submitTask(runtime, exec, prepared.draft)
      const base = {
        taskId: accepted.id, model: model.id, price: quote.label.en,
        ...accepted.estimatedCny === undefined ? {} : { estimatedCny: accepted.estimatedCny },
      }
      const name = { music: 'Music', podcast: 'Podcast', speech: 'Speech' }[kind]
      if (jobId !== undefined) {
        return {
          ...base, status: accepted.status, jobId,
          message: `${unconfirmed ? `${name} task ${accepted.id} (${model.id}): ${UNCONFIRMED_NOTE}` : `${name} task submitted to ${model.id}.`} `
            + `Background job ${jobId} reports when it finishes; `
            + `files are saved under ${runtime.display(exec, accepted.outputDir)}. `
            + `${accepted.estimatedCny === undefined ? `Price: ${quote.basis.en}. ` : `Estimated ${yuan(Number(accepted.estimatedCny))}, charged only if it succeeds. `}`
            + 'Carry on with other work meanwhile; there is no need to poll.',
        }
      }
      const final = await waitForTask(runtime, exec, accepted)
      return {
        ...base, status: final.status,
        ...final.outputs === undefined ? {} : {
          outputs: final.outputs.map(output => ({
            ...output.path === undefined ? {} : { path: runtime.display(exec, output.path) },
            ...output.url === undefined ? {} : { url: output.url },
            ...output.title === undefined ? {} : { title: output.title },
            ...output.durationSeconds === undefined ? {} : { durationSeconds: output.durationSeconds },
            ...output.originalSeconds === undefined ? {} : { originalSeconds: output.originalSeconds },
          })),
        },
        message: describeTask(runtime, exec, final),
      }
    },
  })
}
