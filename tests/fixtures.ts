/**
 * A `/v1/models` body shaped like the live VibeDev catalog. The Seedance 2.0
 * entry follows the gateway's own catalog spec (Volcano Ark lane); the Doubao
 * web lane takes reference images only.
 */
export const SEEDANCE_VIDEO = {
  resolutions: ['720p'],
  durations_seconds: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  ratios: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9', 'adaptive'],
  text_to_video: true,
  image_to_video: true,
  edit: false,
  extend: false,
  first_frame: true,
  last_frame: true,
  native_sequence: false,
  native_audio_output: true,
  reference_image_input: true,
  reference_video_input: true,
  reference_audio_input: true,
  max_reference_images: 9,
  max_reference_videos: 3,
  max_reference_audios: 3,
  allowed_image_mimes: ['image/jpeg', 'image/png', 'image/webp'],
  allowed_video_mimes: ['video/mp4', 'video/quicktime'],
  allowed_audio_mimes: [],
  max_asset_bytes: 0,
  max_request_bytes: 0,
  gateway_relay_required: true,
  async_create_poll_content: true,
  modes_schema_version: 1,
  modes: {
    text_to_video: { inputs: {}, required_any_of: [] },
    first_frame: { inputs: { firstFrame: { min: 1, max: 1 } }, required_any_of: [['firstFrame']] },
    first_last_frame: {
      inputs: { firstFrame: { min: 1, max: 1 }, lastFrame: { min: 1, max: 1 } },
      required_any_of: [['firstFrame', 'lastFrame']],
    },
    omni_reference: {
      inputs: {
        referenceImages: { min: 0, max: 9 },
        referenceVideos: { min: 0, max: 3, source: 'gateway_media_asset' },
        referenceAudios: { min: 0, max: 3 },
      },
      required_any_of: [['referenceImages'], ['referenceVideos']],
    },
  },
  min_reference_video_duration_seconds: 2,
  max_reference_video_duration_seconds: 15,
  max_total_reference_video_duration_seconds: 15,
}

export const CATALOG = {
  object: 'list',
  data: [
    {
      id: 'deepseek-v4-flash', display_name: 'DeepSeek V4 Flash', protocol: 'openai',
      capabilities: { context_window: 1_000_000, input_modalities: ['text', 'image'], allowed_endpoints: ['/v1/chat/completions'] },
    },
    {
      id: 'glm-4v-flash', internal_role: 'vision_fast', protocol: 'anthropic',
      capabilities: { output_modalities: ['text'], allowed_endpoints: ['/v1/chat/completions'] },
    },
    {
      id: 'gpt-image-2.5-flare', display_name: 'GPT Image 2.5 Flare', description: 'Fast photoreal images.', protocol: 'openai',
      capabilities: { chat: false, output_modalities: ['image'], input_modalities: ['text', 'image'], allowed_endpoints: ['/v1/images/generations'] },
      media_pricing: { currency: 'CNY', tiers: [{ tier: '1K', unit: 'generation', amount: 0.1 }], default: { unit: 'generation', amount: 0.1 } },
    },
    {
      id: 'seedance-2.0', display_name: 'Seedance 2.0 720P', media_type: 'video', protocol: 'openai',
      capabilities: { chat: false, output_modalities: ['video'], input_modalities: ['text', 'image', 'audio', 'video'], allowed_endpoints: ['/v1/videos'] },
      video: SEEDANCE_VIDEO,
      media_pricing: { currency: 'CNY', tiers: [{ tier: '720p', unit: 'second', amount: 0.99 }] },
    },
    {
      id: 'seedance-2.5-vibedev', display_name: 'Seedance 2.5 (web)', media_type: 'video', protocol: 'openai',
      capabilities: { chat: false, output_modalities: ['video'], allowed_endpoints: ['/v1/videos'] },
      video: {
        durations_seconds: [4, 5, 10, 15, 20, 25, 30],
        ratios: ['adaptive', '16:9', '9:16', '1:1', '4:3', '3:4', '21:9'],
        text_to_video: true, image_to_video: false, first_frame: false, last_frame: false,
        reference_image_input: true, max_reference_images: 10, reference_video_input: false, reference_audio_input: false,
        max_reference_image_bytes: 10 * 1024 * 1024,
        modes_schema_version: 1,
        modes: {
          text_to_video: { inputs: {}, required_any_of: [] },
          omni_reference: { inputs: { referenceImages: { min: 1, max: 10 } }, required_any_of: [['referenceImages']] },
        },
      },
    },
    {
      id: 'legacy-video', media_type: 'video',
      capabilities: { chat: false, output_modalities: ['video'], allowed_endpoints: ['/v1/videos'] },
      video: {
        text_to_video: true, image_to_video: true, first_frame: true, last_frame: false,
        reference_image_input: true, max_reference_images: 4, reference_audio_input: true, max_reference_audios: 1,
        durations_seconds: [6, 10], resolutions: ['720p', '1080p'],
        combinations: [{ duration_seconds: 6, resolution: '1080p' }, { duration_seconds: 10, resolution: '720p' }, { duration_seconds: 6, resolution: '720p' }],
      },
    },
    {
      id: 'lec-ty-wan-3-0-1050-480p', media_type: 'video',
      capabilities: { chat: false, output_modalities: ['video'], allowed_endpoints: ['/v1/videos'] },
      video: {
        text_to_video: true, image_to_video: true, reference_image_input: true, max_reference_images: 4,
        reference_video_input: true, max_reference_videos: 1, reference_audio_input: true, max_reference_audios: 1,
        durations_seconds: [5, 10], resolutions: ['480p'],
        // This lane states its own reference ranges; the plugin must read them rather than assume another model's.
        min_reference_video_duration_seconds: 1, max_reference_video_duration_seconds: 15,
        min_reference_audio_duration_seconds: 1, max_reference_audio_duration_seconds: 15,
      },
    },
    {
      id: 'future-video', media_type: 'video', capabilities: { output_modalities: ['video'] },
      video: { modes_schema_version: 2, modes: { text_to_video: { inputs: {} } } },
    },
    {
      id: 'doubao-music-vibedev', display_name: '豆包音乐', media_type: 'audio',
      capabilities: { chat: false, output_modalities: ['audio'], allowed_endpoints: ['/v1/audio/generations'] },
      audio: { generation_kind: 'music', prompt_field: 'prompt', request_fields: ['model', 'prompt', 'lyrics', 'genre', 'mood', 'gender'], billing_unit: 'generation' },
      media_pricing: { currency: 'CNY', tiers: [], default: { unit: 'generation', amount: 0.5 } },
    },
    {
      id: 'doubao-podcast-vibedev', display_name: '豆包播客', media_type: 'audio',
      capabilities: { chat: false, output_modalities: ['audio'], allowed_endpoints: ['/v1/audio/generations'] },
      audio: { generation_kind: 'podcast', prompt_field: 'prompt', request_fields: ['model', 'prompt', 'source_url'], billing_unit: 'generation' },
    },
    {
      id: 'doubao-asr-vibedev', display_name: '豆包语音转写', media_type: 'transcription',
      capabilities: { chat: false, allowed_endpoints: ['/v1/audio/transcriptions'] },
    },
  ],
}

const NOISE = { thinking: false, adaptive_thinking: false, interleaved_thinking: false, fast: false }

/**
 * Entries shaped like the live `/v1/models` answer of 2026-10-03: no `video`
 * block and no modes; video capabilities flattened into `capabilities` under
 * `supported_*` names; image entries without `media_type`.
 */
export const LIVE_CATALOG = {
  object: 'list',
  data: [
    {
      id: 'seedance-2.0', display_name: 'Seedance 2.0 720P', media_type: 'video', protocol: 'openai',
      capabilities: {
        ...NOISE, input_modalities: ['text', 'image', 'audio', 'video'], video_generation: true, output_modalities: ['video'],
        allowed_endpoints: ['/v1/videos'], reference_image_input: true, max_reference_images: 9, reference_video_input: true,
        max_reference_videos: 3, reference_audio_input: true, max_reference_audios: 3, chat: false, text_to_video: true,
        image_to_video: true, native_audio_output: true, supported_durations_seconds: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
        supported_aspects: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9', 'adaptive'], supported_resolutions: ['720p'],
        max_reference_video_duration_seconds: 15, allowed_image_mimes: ['image/jpeg', 'image/png', 'image/webp'],
        allowed_video_mimes: ['video/mp4', 'video/quicktime'], first_frame: true, last_frame: true,
        async_create_poll_content: true, gateway_relay_required: true,
      },
      currency: 'CNY', input_price_per_mtok: 0, output_price_per_mtok: 0,
      media_pricing: { currency: 'CNY', default: { unit: 'second', amount: 1.48 } },
    },
    {
      id: 'seedance-2.0-multi', display_name: 'Seedance 2.0 (480p-1080p)', media_type: 'video', protocol: 'openai',
      capabilities: {
        ...NOISE, output_modalities: ['video'], allowed_endpoints: ['/v1/videos'], reference_image_input: true, max_reference_images: 9,
        reference_video_input: true, max_reference_videos: 3, reference_audio_input: true, max_reference_audios: 3, text_to_video: true,
        image_to_video: true, native_audio_output: true, supported_durations_seconds: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
        supported_aspects: ['16:9', '9:16', '1:1'], supported_resolutions: ['480p', '720p', '1080p'],
        max_reference_video_duration_seconds: 13, max_reference_image_bytes: 5_242_880, max_reference_video_bytes: 52_428_800,
        max_reference_audio_bytes: 52_428_800, allowed_image_mimes: ['image/jpeg', 'image/png', 'image/webp'],
        allowed_video_mimes: ['video/mp4', 'video/quicktime'], first_frame: true, last_frame: true, gateway_relay_required: true,
      },
      media_pricing: {
        currency: 'CNY',
        tiers: [{ tier: '480p', unit: 'second', amount: 0.69 }, { tier: '720p', unit: 'second', amount: 1.48 }, { tier: '1080p', unit: 'second', amount: 3.7 }],
        default: { unit: 'second', amount: 3.7 },
      },
    },
    {
      id: 'seedance-2.5-vibedev', display_name: 'Seedance 2.5（VibeDev，4–30 秒）', media_type: 'video', protocol: 'openai',
      capabilities: {
        ...NOISE, input_modalities: ['text', 'image'], video_generation: true, output_modalities: ['video'], allowed_endpoints: ['/v1/videos'],
        reference_image_input: true, max_reference_images: 10, chat: false, text_to_video: true, image_to_video: true, native_audio_output: true,
        supported_durations_seconds: Array.from({ length: 27 }, (_, i) => i + 4),
        supported_aspects: ['adaptive', '16:9', '9:16', '1:1', '4:3', '3:4', '21:9'], supported_resolutions: ['720p'],
        allowed_image_mimes: ['image/jpeg', 'image/png', 'image/webp'], async_create_poll_content: true, gateway_relay_required: true,
      },
      media_pricing: { currency: 'CNY', default: { unit: 'second', amount: 0.3 } },
    },
    {
      id: 'seedance-2.5-30s-vibedev', display_name: 'Seedance 2.5 30s（VibeDev）', media_type: 'video', protocol: 'openai',
      capabilities: {
        ...NOISE, output_modalities: ['video'], allowed_endpoints: ['/v1/videos'], reference_image_input: true, max_reference_images: 10,
        text_to_video: true, image_to_video: true, native_audio_output: true, supported_durations_seconds: [30],
        supported_aspects: ['adaptive', '16:9', '9:16'], supported_resolutions: ['720p'], gateway_relay_required: true,
      },
      media_pricing: { currency: 'CNY', default: { unit: 'generation', amount: 4 } },
    },
    {
      id: 'gpt-image-2.5-flare', display_name: 'gpt-image-2.5-flare', protocol: 'openai',
      capabilities: { ...NOISE, input_modalities: ['text', 'image', 'file'], output_modalities: ['image'], allowed_endpoints: ['/v1/images/generations'] },
      media_pricing: { currency: 'CNY', default: { unit: 'generation', amount: 0.1 } },
    },
    {
      id: 'doubao-music-vibedev', display_name: '豆包音乐（VibeDev）', media_type: 'audio', protocol: 'openai',
      capabilities: {
        ...NOISE, input_modalities: ['text'], output_modalities: ['audio'], allowed_endpoints: ['/v1/audio/generations'],
        chat: false, async_create_poll_content: true, audio_generation: true,
      },
      media_pricing: { currency: 'CNY', default: { unit: 'generation', amount: 0.5 } },
    },
  ],
}

/** The Seed speech `audio` block: text in `text_prompt`, voice references, WAV/MP3 at their own sample rates. */
export const SEED_SPEECH_AUDIO = {
  generation_kind: 'speech',
  prompt_field: 'text_prompt',
  request_fields: ['model', 'text_prompt', 'references', 'audio_config', 'watermark'],
  billing_unit: 'original_second',
  max_prompt_chars: 300,
  references: {
    min_count: 0, max_count: 2, max_bytes: 5 * 1024 * 1024,
    min_duration_seconds: 3, max_duration_seconds: 30, max_total_duration_seconds: 40,
    allowed_mimes: ['audio/wav', 'audio/mpeg'], mutually_exclusive_with: ['voice_id'],
  },
  output_formats: [
    { format: 'wav', sample_rates: [16000, 24000, 48000], default_sample_rate: 24000 },
    { format: 'mp3', sample_rates: [24000, 32000], default_sample_rate: 24000 },
  ],
  default_format: 'mp3',
}

/**
 * A catalog as the gateway will ship audio: structured `audio` blocks on every
 * audio model, an alias, a model this plugin has never seen, one that declares
 * no kind, and transcription billed per minute.
 */
export const AUDIO_CATALOG = {
  object: 'list',
  data: [
    {
      id: 'deepseek-v4-flash', display_name: 'DeepSeek V4 Flash', protocol: 'openai',
      capabilities: { context_window: 1_000_000, allowed_endpoints: ['/v1/chat/completions'] },
    },
    {
      // Named like a podcast model, declared as music: the declaration decides.
      id: 'podcast-style-music-vibedev', display_name: '播客风格音乐', media_type: 'audio',
      capabilities: { output_modalities: ['audio'], allowed_endpoints: ['/v1/audio/generations'] },
      audio: {
        generation_kind: 'music', prompt_field: 'prompt', request_fields: ['model', 'prompt', 'lyrics', 'genre', 'mood', 'gender'],
        billing_unit: 'generation', choices: { gender: ['male', 'female'] },
      },
      media_pricing: { currency: 'CNY', default: { unit: 'generation', amount: 0.5 } },
    },
    {
      id: 'doubao-podcast-vibedev', display_name: '豆包播客', media_type: 'audio',
      capabilities: { output_modalities: ['audio'], allowed_endpoints: ['/v1/audio/generations'] },
      audio: { generation_kind: 'podcast', prompt_field: 'prompt', request_fields: ['model', 'prompt', 'source_url'], billing_unit: 'generation' },
      media_pricing: { currency: 'CNY', default: { unit: 'generation', amount: 1 } },
    },
    {
      id: 'seed-tts-2.0-vibedev', display_name: 'Seed 语音合成 2.0', media_type: 'audio', aliases: ['seed-tts', 'seed-tts-latest'],
      capabilities: { output_modalities: ['audio'], allowed_endpoints: ['/v1/audio/generations'] },
      audio: SEED_SPEECH_AUDIO,
      // The price names no unit: it is read in the declared billing unit.
      media_pricing: { currency: 'CNY', default: { amount: 0.015 } },
    },
    {
      // A model added after this plugin was written: recognized from its declaration alone.
      id: 'brand-new-music-2027', display_name: 'Brand new music', media_type: 'audio',
      capabilities: { output_modalities: ['audio'] },
      audio: { generationKind: 'music', promptField: 'prompt', requestFields: ['model', 'prompt'], billingUnit: 'generation' },
    },
    {
      // Undeclared: listed, never treated as music.
      id: 'mystery-audio', media_type: 'audio',
      capabilities: { output_modalities: ['audio'], allowed_endpoints: ['/v1/audio/generations'] },
      media_pricing: { currency: 'CNY', default: { unit: 'generation', amount: 0.2 } },
    },
    {
      id: 'doubao-asr-vibedev', display_name: '豆包语音转写', media_type: 'audio',
      capabilities: { allowed_endpoints: ['/v1/audio/transcriptions'] },
      audio: { generation_kind: 'transcription', billing_unit: 'minute', max_input_bytes: 20_000_000, max_input_seconds: 600, languages: ['zh'] },
      media_pricing: { currency: 'CNY', default: { unit: 'minute', amount: 0.3 } },
    },
  ],
}

/**
 * The `video_pricing` of `video-sd-2.5(TC)` as the gateway contract publishes it
 * (480p rules from the contract; the 720p rules are fixture values).
 */
export const SD25_TC_PRICING = {
  schema_version: 1,
  currency: 'CNY',
  final_basis: 'provider_tokens',
  estimate_basis: 'output_plus_reference_video_seconds',
  estimate_only: true,
  rules: [
    { resolution: '480p', reference_video: false, price_per_million_tokens: 60.06, estimated_price_per_second: 0.5819 },
    { resolution: '480p', reference_video: true, price_per_million_tokens: 36.036, estimated_price_per_second: 0.6952 },
    { resolution: '720p', reference_video: false, reference_audio: null, price_per_million_tokens: 70, estimated_price_per_second: 1.25 },
    { resolution: '720p', reference_video: true, reference_audio: null, price_per_million_tokens: 42, estimated_price_per_second: 1.5 },
  ],
}

/** A v1 video block of a Token-priced lane: the capabilities come from here, never from the price rules. */
export function tokenVideoBlock(resolutions: string[], durations: number[]) {
  return {
    resolutions, durations_seconds: durations, ratios: ['16:9', '9:16', '1:1'],
    native_audio_output: true, gateway_relay_required: true,
    modes_schema_version: 1,
    modes: {
      text_to_video: { inputs: {}, required_any_of: [] },
      first_frame: { inputs: { firstFrame: { min: 1, max: 1 } }, required_any_of: [['firstFrame']] },
      first_last_frame: {
        inputs: { firstFrame: { min: 1, max: 1 }, lastFrame: { min: 1, max: 1 } },
        required_any_of: [['firstFrame', 'lastFrame']],
      },
      omni_reference: {
        inputs: {
          referenceImages: { min: 0, max: 1 },
          referenceVideos: { min: 0, max: 1, source: 'gateway_media_asset' },
          referenceAudios: { min: 0, max: 1 },
        },
        required_any_of: [['referenceImages'], ['referenceVideos']],
      },
    },
  }
}

/**
 * Video models priced per video Token (`video_pricing`, schema 1), shaped like
 * the gateway's `/v1/models` (sanitised): no unconditional `media_pricing`, and the
 * zero text-Token fields an old client must not read as a free video.
 */
export const TOKEN_CATALOG = {
  object: 'list',
  data: [
    {
      id: 'video-sd-2.5(TC)', display_name: 'Seedance 2.5（TC）', media_type: 'video', protocol: 'openai', aliases: ['sd-2.5-tc'],
      capabilities: { chat: false, output_modalities: ['video'], allowed_endpoints: ['/v1/videos'] },
      currency: 'CNY', input_price_per_mtok: 0, output_price_per_mtok: 0,
      video: tokenVideoBlock(['480p', '720p'], Array.from({ length: 27 }, (_, i) => i + 4)),
      video_pricing: SD25_TC_PRICING,
    },
    {
      id: 'video-sd-2.0(TC)', display_name: 'Seedance 2.0（TC）', media_type: 'video', protocol: 'openai',
      capabilities: { chat: false, output_modalities: ['video'], allowed_endpoints: ['/v1/videos'] },
      currency: 'CNY', input_price_per_mtok: 0, output_price_per_mtok: 0,
      video: tokenVideoBlock(['480p'], [5, 10]),
      video_pricing: {
        schema_version: 1, currency: 'CNY', final_basis: 'provider_tokens', estimate_basis: 'output_plus_reference_video_seconds', estimate_only: true,
        rules: [
          { resolution: '480p', reference_video: false, reference_audio: null, reference_image: null, price_per_million_tokens: 40.04, estimated_price_per_second: 0.3971 },
          { resolution: '480p', reference_video: true, price_per_million_tokens: 24.024, estimated_price_per_second: 0.4633 },
        ],
      },
    },
    {
      // Only a Token price, no per-second estimate: the estimate is unknown, not zero.
      id: 'video-token-no-estimate', media_type: 'video',
      capabilities: { output_modalities: ['video'], allowed_endpoints: ['/v1/videos'] },
      video: tokenVideoBlock(['480p'], [5]),
      video_pricing: {
        schema_version: 1, currency: 'CNY', final_basis: 'provider_tokens', estimate_basis: 'output_plus_reference_video_seconds', estimate_only: true,
        rules: [{ resolution: '480p', price_per_million_tokens: 50 }],
      },
    },
    {
      // A pricing schema this plugin does not know, next to a legacy price it must not fall back to.
      id: 'video-token-future', media_type: 'video',
      capabilities: { output_modalities: ['video'], allowed_endpoints: ['/v1/videos'] },
      video: tokenVideoBlock(['480p'], [5]),
      media_pricing: { currency: 'CNY', default: { unit: 'second', amount: 0.5 } },
      video_pricing: { schema_version: 2, currency: 'CNY', tiers: [{ resolution: '480p', price: 1 }] },
    },
    {
      // One unreadable rule spoils the whole object.
      id: 'video-token-broken', media_type: 'video',
      capabilities: { output_modalities: ['video'], allowed_endpoints: ['/v1/videos'] },
      video: tokenVideoBlock(['480p'], [5]),
      video_pricing: {
        ...SD25_TC_PRICING,
        rules: [SD25_TC_PRICING.rules[0], { ...SD25_TC_PRICING.rules[1], reference_video: 'yes' }],
      },
    },
  ],
}

/** A minimal valid PNG header (enough for sniffing). */
export const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d])
export const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10])
export const GIF = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])
export const MP4 = new Uint8Array([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 2, 0])
export const MOV = new Uint8Array([0, 0, 0, 0x14, 0x66, 0x74, 0x79, 0x70, 0x71, 0x74, 0x20, 0x20, 0, 0, 0, 0])
export const M4A = new Uint8Array([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41, 0x20, 0, 0, 0, 0])
export const WAV = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x24, 0, 0, 0, 0x57, 0x41, 0x56, 0x45, 0x66, 0x6d, 0x74, 0x20])
export const MP3 = new Uint8Array([0x49, 0x44, 0x33, 0x04, 0, 0, 0, 0, 0, 0])
export const WEBM = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81])
