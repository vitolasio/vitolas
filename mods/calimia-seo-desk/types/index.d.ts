export type SeoGroup = 'meta' | 'alt' | 'files'

export type SeoFilter = 'all' | SeoGroup | 'new'

export type SeoRow = {
  /** Numeric part of the Shopify gid. */
  id: string
  kind: 'product' | 'collection'
  title: string
  handle: string
  status: string
  score: number
  groups: SeoGroup[]
  summary: string
  isNew: boolean
}

export type SeoTotals = {
  products: number
  collections: number
  score: number
  imgs: number
  altMissing: number
  metaIssues: number
  badFiles: number
  withIssues: number
  newWithIssues: number
}

export type SeoView = {
  scannedAt: number | null
  busy: string | null
  error: string | null
  totals: SeoTotals
  rows: SeoRow[]
}

export type SeoFix = {
  key: string
  kind: 'product' | 'collection' | 'file'
  /** Numeric id of the product, collection or MediaImage. */
  targetId: string
  /** Numeric id of the product or collection the fix belongs to. */
  ownerId: string
  handle: string
  field: 'title' | 'description' | 'alt' | 'filename'
  before: string
  after: string
}

export type SeoUi = { filter: SeoFilter; page: number }

export type SeoAlert = { count: number; titles: string[] }

declare module 'claude-code' {
  interface PluginState {
    'calimia-seo-desk': {
      view: SeoView
      pending: SeoFix[]
      ui: SeoUi
      alert: SeoAlert | null
    }
  }
}
