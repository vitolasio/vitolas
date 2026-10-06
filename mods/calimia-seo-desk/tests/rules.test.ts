import { describe, expect, test } from 'claude-code/testing'

import {
  cleanTitle,
  duplicates,
  fileOf,
  fitDescription,
  isBadFile,
  issuesOf,
  proposeFilename,
  proposeTitle,
  scoreOf,
  type Item,
} from '../hooks/rules'

const item = (over: Partial<Item>): Item => ({
  kind: 'product',
  id: '1',
  title: 'Dark Mahogany Wall Mirror',
  handle: 'dark-mahogany-wall-mirror',
  vendor: 'Mirror Home',
  status: 'ACTIVE',
  createdAt: '2026-09-01T00:00:00Z',
  updatedAt: '2026-09-01T00:00:00Z',
  seoTitle: 'Dark Mahogany Wall Mirror | Mirror Home | Calimia Home',
  seoDesc: 'Designed by Bunny Williams for Mirror Home, this hand-carved dark mahogany mirror measures 36 x 49.5 inches with a satin black wood back.',
  imgs: [{ id: '10', alt: 'Hand carved dark mahogany wall mirror', file: 'dark-mahogany-wall-mirror-6023231.jpg' }],
  ...over,
})

const none = new Set<string>()

describe('file names', () => {
  test('hashes, screenshots and camera names are bad; TinySEO-style names are fine', () => {
    expect(isBadFile('663bce5cbcd0c4374533e114b129ecefdd983eecdf985e3112b0a5d5d7ae8dc2.png')).toBe(true)
    expect(isBadFile('ScreenShot2024-03-21at3.53.31PM.png')).toBe(true)
    expect(isBadFile('IMG_4021.JPG')).toBe(true)
    expect(isBadFile('dark-mahogany-wall-mirror-6023231.jpg')).toBe(false)
    expect(isBadFile('calimia-home-green-grey-porcelain-mug_ba7622d3-2b1e-46eb-9233-a1509a6f28bd.jpg')).toBe(false)
    expect(isBadFile('photo-frame-brass.jpg')).toBe(false)
  })

  test('the file name comes off a CDN URL without its query', () => {
    expect(fileOf('https://cdn.shopify.com/s/files/1/0815/7482/2169/files/treron-no292-2668334.jpg?v=1788418932')).toBe('treron-no292-2668334.jpg')
  })

  test('new names follow the handle and keep the extension', () => {
    const img = { id: '1', alt: '', file: '663bce5c.png' }
    expect(proposeFilename({ handle: 'astrid-toiletry-bag-sand' }, img, 0)).toBe('astrid-toiletry-bag-sand.png')
    expect(proposeFilename({ handle: 'astrid-toiletry-bag-sand' }, img, 2)).toBe('astrid-toiletry-bag-sand-3.png')
  })
})

describe('titles', () => {
  test('house format, dropping parts until it fits in 60', () => {
    expect(proposeTitle({ title: 'Primrose Sand Pillow', vendor: 'Maison Venu' }, 'product-vendor-brand')).toBe('Primrose Sand Pillow | Maison Venu | Calimia Home')
    const long = proposeTitle({ title: 'Jasmine Damask Rose Glass Hand Soap', vendor: 'Flamingo Estate' }, 'product-vendor-brand')
    expect(long).toBe('Jasmine Damask Rose Glass Hand Soap | Flamingo Estate')
    expect(proposeTitle({ title: 'Treron No.292', vendor: 'Farrow & Ball' }, 'product-brand')).toBe('Treron No.292 | Calimia Home')
  })

  test('stock notes leave the title', () => {
    expect(cleanTitle('Ebony Oak Cabinet — 1 Available')).toBe('Ebony Oak Cabinet')
    expect(proposeTitle({ title: 'Ebony Oak Cabinet — 1 Available', vendor: 'Four Hands' }, 'product-vendor-brand')).toBe(
      'Ebony Oak Cabinet | Four Hands | Calimia Home',
    )
  })

  test('the vendor is not repeated when the title already names it', () => {
    expect(proposeTitle({ title: 'Farrow & Ball Wall Primer', vendor: 'Farrow & Ball' }, 'product-vendor-brand')).toBe('Farrow & Ball Wall Primer | Calimia Home')
  })
})

describe('descriptions', () => {
  test('a long reply is cut at a sentence within 155', () => {
    const text =
      'Hand-poured Italian beeswax taper candles from il Buco Vita in two heights. A modern duplero with a soft honey scent for the table. Made in Umbria.'
    const fit = fitDescription(`${text} Extra words that run on and on past the limit for sure.`)
    expect(fit.length <= 155).toBe(true)
    expect(fit.endsWith('.')).toBe(true)
  })
})

describe('issues and score', () => {
  test('a clean listing has no issues and scores 100', () => {
    const clean = item({})
    expect(issuesOf(clean, none, none)).toEqual([])
    expect(scoreOf(clean, [])).toBe(100)
  })

  test('the Astrid bag: no SEO, no alt, hash files', () => {
    const astrid = item({
      title: 'Astrid Toiletry Bag, Sand: Small',
      seoTitle: null,
      seoDesc: null,
      imgs: [
        { id: '1', alt: '', file: '663bce5cbcd0c4374533e114b129ecefdd983eecdf985e3112b0a5d5d7ae8dc2.png' },
        { id: '2', alt: '', file: '24c998b11a3a269718cd69b3c600cbb7bb0101f4a4209e418e2e1510ac69a283.png' },
      ],
    })
    const issues = issuesOf(astrid, none, none)
    expect(issues.map(i => i.code)).toEqual(['title-missing', 'desc-missing', 'alt-missing', 'file-bad'])
    expect(scoreOf(astrid, issues)).toBe(35)
  })

  test('a meta description cut mid-sentence is flagged', () => {
    const sappho = item({
      seoDesc:
        'Elevate your home sanctuary with the Sappho Fig Candle, a sophisticated olfactory experience designed to transform any room into a lush, Mediterranean-inspired',
    })
    const codes = issuesOf(sappho, none, none).map(i => i.code)
    expect(codes).toContain('desc-cut')
    expect(codes).toContain('desc-long')
  })

  test('dashes as separators are flagged, a hyphen inside the name is not', () => {
    const codes = (seoTitle: string) => issuesOf(item({ seoTitle }), none, none).map(i => i.code)
    expect(codes('Faux Lilac Stem - Pistachio — Abigail Ahern | Calimia Home')).toContain('title-sep')
    expect(codes('Ice Bucket - Petite | Half Past Seven')).not.toContain('title-sep')
  })

  test('duplicates are found case-insensitively', () => {
    expect([...duplicates(['A | B', 'a | b', 'C', null])]).toEqual(['a | b'])
  })
})
