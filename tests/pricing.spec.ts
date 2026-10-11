import { describe, expect, it } from 'vitest'
import { parseMediaCatalog } from '../src/gateway/catalog.js'
import { describePrice, estimateImages, estimateVideo, quoteAudio } from '../src/pricing.js'
import { CATALOG } from './fixtures.js'

const models = parseMediaCatalog(CATALOG)
const model = (id: string) => {
  const found = models.find(item => item.id === id)
  if (found === undefined) throw new Error(`missing ${id}`)
  return found
}

describe('pricing', () => {
  it('describes catalog prices', () => {
    expect(describePrice(model('gpt-image-2.5-flare'))).toBe('¥0.10 per image (1K)')
    expect(describePrice(model('seedance-2.0'))).toBe('¥0.99/s (720p)')
    expect(describePrice(model('doubao-music-vibedev'))).toBe('¥0.50 per generation')
    // No price is not a free model.
    expect(describePrice(model('doubao-podcast-vibedev'))).toBe('not priced')
    expect(describePrice(model('doubao-podcast-vibedev'), 'zh')).toBe('未定价')
  })

  it('estimates images per image', () => {
    expect(estimateImages(model('gpt-image-2.5-flare'), 3)).toEqual({ amountCny: 0.30000000000000004, basis: '¥0.10 × 3 images' })
  })

  it('estimates video seconds like the gateway: output plus reference video, rounded up once', () => {
    expect(estimateVideo(model('seedance-2.0'), 5, undefined)).toMatchObject({ basis: '¥0.99/s × 5 s' })
    expect(estimateVideo(model('seedance-2.0'), 5, '720p')?.amountCny).toBeCloseTo(4.95)
    expect(estimateVideo(model('seedance-2.0'), 5, '720p', 8_080)).toMatchObject({ basis: '¥0.99/s × (5 s output + 9 s of reference video)' })
    expect(estimateVideo(model('seedance-2.0'), undefined, undefined)?.amountCny).toBeCloseTo(7.92)
    expect(estimateVideo(model('legacy-video'), 6, '1080p')).toBeUndefined()
  })

  it('estimates music per request and gives up without a price', () => {
    expect(quoteAudio(model('doubao-music-vibedev'))).toMatchObject({ priced: true, unit: 'generation', amountCny: 0.5, label: { zh: '¥0.50/次' } })
    expect(quoteAudio(model('doubao-podcast-vibedev'))).toMatchObject({ priced: false, label: { zh: '未定价', en: 'not priced' } })
    expect(quoteAudio(model('doubao-podcast-vibedev')).amountCny).toBeUndefined()
  })
})
