import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { SeoAlert, SeoFilter, SeoFix, SeoGroup, SeoRow, SeoTotals, SeoUi, SeoView } from '../types'
import {
  describeIssues,
  duplicates,
  GROUP_OF,
  HOUSE_RULES,
  isBadFile,
  issuesOf,
  proposeFilename,
  proposeTitle,
  scoreOf,
  type Issue,
  type Item,
  type TitleFormat,
} from './rules'
import {
  altPrompt,
  COLLECTION_DETAIL,
  COLLECTION_SEO,
  collectionDetail,
  collectionItem,
  COLLECTIONS,
  dataOf,
  descriptionFrom,
  descriptionRequest,
  FILES,
  gidOf,
  PRODUCT_DETAIL,
  PRODUCT_SEO,
  productDetail,
  productFilter,
  productItem,
  PRODUCTS,
  userErrors,
  type Detail,
} from './shopify'

type Engine = EngineInterface

const PANE = 'seo-desk'
const MAX_ROWS = 2500
const FULL_SCAN_EVERY_MS = 7 * 24 * 3600 * 1000

const NO_TOTALS: SeoTotals = {
  products: 0,
  collections: 0,
  score: 0,
  imgs: 0,
  altMissing: 0,
  metaIssues: 0,
  badFiles: 0,
  withIssues: 0,
  newWithIssues: 0,
}
const NO_VIEW: SeoView = { scannedAt: null, busy: null, error: null, totals: NO_TOTALS, rows: [] }

const view = atom({ plugin: 'calimia-seo-desk', key: 'view' } as const, NO_VIEW)
const pending = atom({ plugin: 'calimia-seo-desk', key: 'pending' } as const, [] as SeoFix[])
const ui = atom({ plugin: 'calimia-seo-desk', key: 'ui' } as const, { filter: 'all', page: 0 } as SeoUi)
const alert = atom({ plugin: 'calimia-seo-desk', key: 'alert' } as const, null as SeoAlert | null)

const FILTERS: { id: SeoFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'new', label: 'New' },
  { id: 'meta', label: 'Meta' },
  { id: 'alt', label: 'Alt' },
  { id: 'files', label: 'Files' },
]

// Product and collection writes Claude makes through the Shopify connector.
const SHOPIFY_WRITE = /^mcp__.*shopify.*__(create-product|update-product|bulk-update-product-status|create-collection|update-collection|graphql_mutation)$/i

type Config = {
  server: string
  adminStore: string
  titleFormat: TitleFormat
  metaModel: string
  rescanMinutes: number
  newDays: number
  renameFiles: boolean
  houseRulesInPrompt: boolean
}

// Set by register from the plugin's options; the module's values start over on a reload,
// and session.start loads the scan back from $.store.
const cfg: Config = {
  server: 'claude.ai Shopify',
  adminStore: '1ba31e-2',
  titleFormat: 'product-vendor-brand',
  metaModel: 'haiku',
  rescanMinutes: 60,
  newDays: 14,
  renameFiles: true,
  houseRulesInPrompt: true,
}

const scan = {
  items: [] as Item[],
  scannedAt: null as number | null,
  fullScanAt: null as number | null,
  ackedAt: 0,
  isLoaded: false,
  running: null as Promise<unknown> | null,
  // The page size the pane last drew, so the page buttons act on what is on screen.
  pageSize: 8,
}

function fmt(n: number): string {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

function ago(ms: number): string {
  const min = Math.round(ms / 60000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min} min ago`
  const h = Math.round(min / 60)
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`
}

function keyOf(item: Pick<Item, 'kind' | 'id'>): string {
  return `${item.kind}:${item.id}`
}

function adminUrl(kind: Item['kind'], id: string): string {
  return `https://admin.shopify.com/store/${cfg.adminStore}/${kind === 'product' ? 'products' : 'collections'}/${id}`
}

function itemOf(kind: Item['kind'], id: string): Item | undefined {
  return scan.items.find(i => i.kind === kind && i.id === id)
}

function issueMap(): Map<string, Issue[]> {
  const products = scan.items.filter(i => i.kind === 'product')
  const dupT = duplicates(products.map(i => i.seoTitle))
  const dupD = duplicates(products.map(i => i.seoDesc))
  const none = new Set<string>()
  return new Map(scan.items.map(i => [keyOf(i), issuesOf(i, i.kind === 'product' ? dupT : none, i.kind === 'product' ? dupD : none)]))
}

function rowsFor(v: SeoView, filter: SeoFilter): SeoRow[] {
  if (filter === 'all') return v.rows
  if (filter === 'new') return v.rows.filter(r => r.isNew)
  return v.rows.filter(r => r.groups.includes(filter))
}

function scoreColor(score: number): string {
  return score >= 85 ? 'green' : score >= 60 ? 'yellow' : 'red'
}

function report(v: SeoView): string {
  const t = v.totals
  const head = [
    `Calimia SEO Desk, scanned ${v.scannedAt === null ? 'never' : new Date(v.scannedAt).toISOString()}`,
    `Average score ${t.score}/100 across ${fmt(t.products)} products and ${fmt(t.collections)} collections.`,
    `${fmt(t.withIssues)} with issues (${fmt(t.newWithIssues)} new) · ${fmt(t.altMissing)} of ${fmt(t.imgs)} images missing alt · ${fmt(t.metaIssues)} with meta issues · ${fmt(t.badFiles)} badly named files.`,
    '',
    'Worst first:',
  ]
  const rows = v.rows
    .slice(0, 25)
    .map(r => `${String(r.score).padStart(3)}  ${r.title} (${r.handle}${r.status === 'DRAFT' ? ', draft' : ''}${r.isNew ? ', new' : ''}): ${r.summary}`)
  return [...head, ...rows].join('\n')
}

type Json = Record<string, any>

// Products per page: about 1,500 characters each with their images, so 15 stays well
// under the size Claude Code allows one tool result; halved on the rare page that is not.
const PAGE_START = 15
const PAGE_MIN = 2

function isTooLarge(err: unknown): boolean {
  return err instanceof Error && /exceeds maximum allowed tokens|too large|output has been saved/i.test(err.message)
}

async function gql($: Engine, tool: 'graphql_query' | 'graphql_mutation', query: string, variables: Json): Promise<Json> {
  const args: Json = { query, variables }
  if (tool === 'graphql_query' && typeof variables.first === 'number') {
    args.first = variables.first
    if (typeof variables.after === 'string') args.after = variables.after
  }
  const res = await $.mcp.call(cfg.server, tool, args)
  return dataOf(tool, res.content, res.isError)
}

/** Pages through active and draft products, newest change first; with `since`, only those changed after it. */
async function scanProducts($: Engine, since: string | null): Promise<Item[]> {
  const out: Item[] = []
  let after: string | null = null
  let size = PAGE_START
  for (let page = 0; page < 1000; page += 1) {
    const vars: Json = { first: size, query: productFilter(since) }
    if (after !== null) vars.after = after
    let conn: Json
    try {
      conn = (await gql($, 'graphql_query', PRODUCTS, vars)).products
    } catch (err) {
      // Claude Code caps one tool result; a page of image-heavy products can pass it.
      if (!isTooLarge(err) || size <= PAGE_MIN) throw err
      size = Math.max(PAGE_MIN, Math.floor(size / 2))
      continue
    }
    for (const node of conn?.nodes ?? []) out.push(productItem(node))
    if (since === null) await setBusy($, `Scanning products… ${fmt(out.length)}`)
    if (!conn?.pageInfo?.hasNextPage) break
    after = conn.pageInfo.endCursor
  }
  return out
}

async function scanCollections($: Engine): Promise<Item[]> {
  const out: Item[] = []
  let after: string | null = null
  let size = 25
  for (let page = 0; page < 200; page += 1) {
    const vars: Json = { first: size }
    if (after !== null) vars.after = after
    let conn: Json
    try {
      conn = (await gql($, 'graphql_query', COLLECTIONS, vars)).collections
    } catch (err) {
      if (!isTooLarge(err) || size <= PAGE_MIN) throw err
      size = Math.max(PAGE_MIN, Math.floor(size / 2))
      continue
    }
    for (const node of conn?.nodes ?? []) out.push(collectionItem(node))
    if (!conn?.pageInfo?.hasNextPage) break
    after = conn.pageInfo.endCursor
  }
  return out
}

async function detailOf($: Engine, item: Item): Promise<Detail> {
  if (item.kind === 'collection') {
    return collectionDetail(await gql($, 'graphql_query', COLLECTION_DETAIL, { id: gidOf('collection', item.id) }), item.id)
  }
  return productDetail(await gql($, 'graphql_query', PRODUCT_DETAIL, { id: gidOf('product', item.id) }))
}

/** Sets SEO title and/or description; resolves Shopify's user errors. */
async function writeSeo($: Engine, kind: Item['kind'], id: string, seo: { title?: string; description?: string }): Promise<string[]> {
  if (kind === 'product') {
    return userErrors(await gql($, 'graphql_mutation', PRODUCT_SEO, { product: { id: gidOf('product', id), seo } }), 'productUpdate')
  }
  return userErrors(await gql($, 'graphql_mutation', COLLECTION_SEO, { input: { id: gidOf('collection', id), seo } }), 'collectionUpdate')
}

/** Renames and/or re-alts product images, 25 per call; resolves Shopify's user errors. */
async function writeFiles($: Engine, files: { id: string; alt?: string; filename?: string }[]): Promise<string[]> {
  const errors: string[] = []
  for (let i = 0; i < files.length; i += 25) {
    const chunk = files.slice(i, i + 25).map(f => ({ ...f, id: gidOf('image', f.id) }))
    errors.push(...userErrors(await gql($, 'graphql_mutation', FILES, { files: chunk }), 'fileUpdate'))
  }
  return errors
}

async function writeDescription($: Engine, item: Item, detail: Detail): Promise<string | null> {
  const res = await $.model.complete(descriptionRequest(item, detail, cfg.metaModel))
  return res.isAnswered ? descriptionFrom(res.text) : null
}

async function load($: Engine): Promise<void> {
  if (scan.isLoaded) return
  const stored = await $.store.get('items')
  scan.items = Array.isArray(stored) ? (stored as Item[]) : []
  scan.scannedAt = Number((await $.store.get('scannedAt')) ?? 0) || null
  scan.fullScanAt = Number((await $.store.get('fullScanAt')) ?? 0) || null
  scan.ackedAt = Number((await $.store.get('ackedAt')) ?? 0)
  scan.isLoaded = true
}

async function save($: Engine): Promise<void> {
  await $.store.set('items', scan.items)
  await $.store.set('scannedAt', scan.scannedAt ?? 0)
  await $.store.set('fullScanAt', scan.fullScanAt ?? 0)
}

async function publish($: Engine): Promise<void> {
  const now = await $.clock.now()
  const issues = issueMap()
  const rows: SeoRow[] = []
  const totals: SeoTotals = { ...NO_TOTALS }
  const newSince = now - cfg.newDays * 24 * 3600 * 1000
  const fresh: Item[] = []
  let scoreSum = 0
  let scored = 0

  for (const item of scan.items) {
    const list = issues.get(keyOf(item)) ?? []
    const score = scoreOf(item, list)
    if (item.kind === 'product') totals.products += 1
    else totals.collections += 1
    if (item.status === 'ACTIVE') {
      scoreSum += score
      scored += 1
    }
    totals.imgs += item.imgs.length
    totals.altMissing += item.imgs.filter(img => img.alt.trim() === '').length
    totals.badFiles += item.imgs.filter(img => isBadFile(img.file)).length
    const groups = [...new Set(list.map(i => GROUP_OF[i.code]))] as SeoGroup[]
    if (groups.includes('meta')) totals.metaIssues += 1
    if (list.length === 0) continue
    const created = Date.parse(item.createdAt)
    const isNew = item.kind === 'product' && created > newSince
    totals.withIssues += 1
    if (isNew) {
      totals.newWithIssues += 1
      if (created > scan.ackedAt) fresh.push(item)
    }
    rows.push({ id: item.id, kind: item.kind, title: item.title, handle: item.handle, status: item.status, score, groups, summary: describeIssues(list), isNew })
  }
  totals.score = scored > 0 ? Math.round(scoreSum / scored) : 0
  rows.sort((a, b) => Number(b.isNew) - Number(a.isNew) || a.score - b.score)

  await update($, view, v => ({ ...v, scannedAt: scan.scannedAt, totals, rows: rows.slice(0, MAX_ROWS) }))
  await update($, alert, () => (fresh.length > 0 ? { count: fresh.length, titles: fresh.slice(0, 3).map(i => i.title) } : null))
  $.ui.status(
    scan.scannedAt === null
      ? 'SEO Desk: not scanned yet (/seo scan)'
      : `SEO ${totals.score} · ${fmt(totals.altMissing)} no alt · ${fmt(totals.metaIssues)} meta · ${fmt(totals.badFiles)} files`,
  )
}

async function setBusy($: Engine, busy: string | null): Promise<void> {
  await update($, view, v => ({ ...v, busy }))
}

async function setError($: Engine, error: string | null): Promise<void> {
  await update($, view, v => ({ ...v, error }))
}

/** One scan or write at a time; a second ask while one runs is told so. */
async function exclusive($: Engine, label: string, work: () => Promise<void>, isQuiet = false): Promise<boolean> {
  if (scan.running !== null) {
    if (!isQuiet) $.ui.toast('SEO Desk is busy; try again in a moment.')
    return false
  }
  const job = guarded($, label, work)
  scan.running = job
  try {
    await job
  } finally {
    scan.running = null
  }
  return true
}

async function guarded($: Engine, label: string, work: () => Promise<void>): Promise<void> {
  await setBusy($, label)
  await setError($, null)
  try {
    await work()
  } catch (err) {
    await setError($, err instanceof Error ? err.message : String(err))
  } finally {
    await setBusy($, null)
  }
}

async function fullScan($: Engine, isQuiet = false): Promise<void> {
  await exclusive($, 'Scanning products…', async () => {
    await load($)
    const startedAt = await $.clock.now()
    const products = await scanProducts($, null)
    await setBusy($, 'Scanning collections…')
    const collections = await scanCollections($)
    scan.items = [...products, ...collections]
    scan.scannedAt = startedAt
    scan.fullScanAt = startedAt
    await save($)
    await publish($)
  }, isQuiet)
}

/** Products changed since the last scan (a full scan when none or a week old); resolves the changed ones. */
async function refresh($: Engine): Promise<Item[]> {
  await load($)
  const now = await $.clock.now()
  if (scan.scannedAt === null || scan.fullScanAt === null || now - scan.fullScanAt > FULL_SCAN_EVERY_MS) {
    await fullScan($, true)
    return []
  }
  let changed: Item[] = []
  await exclusive($, 'Checking for changes…', async () => {
    const startedAt = await $.clock.now()
    const since = new Date((scan.scannedAt ?? startedAt) - 2 * 60 * 1000).toISOString()
    changed = await scanProducts($, since)
    const byKey = new Map(scan.items.map(i => [keyOf(i), i]))
    for (const item of changed) byKey.set(keyOf(item), item)
    scan.items = [...byKey.values()]
    scan.scannedAt = startedAt
    await save($)
    await publish($)
  }, true)
  return changed
}

/** After Claude writes to Shopify: rescan what changed and say what still needs SEO. */
async function checkAfterWrite($: Engine): Promise<void> {
  const changed = await refresh($)
  const issues = issueMap()
  const flagged = changed.filter(i => (issues.get(keyOf(i)) ?? []).length > 0)
  const first = flagged[0]
  if (first === undefined) return
  const more = flagged.length > 1 ? ` (+${flagged.length - 1} more)` : ''
  $.ui.toast(`SEO Desk · ${first.title}: ${describeIssues(issues.get(keyOf(first)) ?? [])}${more}`)
}

async function addFixes($: Engine, fixes: SeoFix[]): Promise<void> {
  await update($, pending, list => {
    const keys = new Set(fixes.map(f => f.key))
    return [...list.filter(f => !keys.has(f.key)), ...fixes]
  })
}

async function prepareMeta($: Engine, targets: Item[]): Promise<number> {
  const issues = issueMap()
  const fixes: SeoFix[] = []
  let done = 0
  await exclusive($, 'Writing meta…', async () => {
    for (const item of targets) {
      done += 1
      await setBusy($, `Writing meta ${done}/${targets.length}: ${item.title}`)
      const list = issues.get(keyOf(item)) ?? []
      const base = { kind: item.kind, targetId: item.id, ownerId: item.id, handle: item.handle }
      if (list.some(i => i.code.startsWith('title-'))) {
        const after = proposeTitle(item, cfg.titleFormat)
        if (after !== (item.seoTitle ?? '')) fixes.push({ ...base, key: `${keyOf(item)}:title`, field: 'title', before: item.seoTitle ?? '', after })
      }
      if (list.some(i => i.code.startsWith('desc-'))) {
        const detail = await detailOf($, item)
        const after = await writeDescription($, item, detail)
        if (after !== null && after !== (item.seoDesc ?? '')) {
          fixes.push({ ...base, key: `${keyOf(item)}:description`, field: 'description', before: item.seoDesc ?? '', after })
        }
      }
    }
    await addFixes($, fixes)
  })
  return fixes.length
}

async function prepareFiles($: Engine, targets: Item[]): Promise<number> {
  if (!cfg.renameFiles) {
    $.ui.toast('File renaming is off in the SEO Desk settings.')
    return 0
  }
  const fixes: SeoFix[] = []
  for (const item of targets) {
    if (item.kind !== 'product') continue
    item.imgs.forEach((img, index) => {
      if (!isBadFile(img.file)) return
      fixes.push({
        key: `file:${img.id}:filename`,
        kind: 'file',
        targetId: img.id,
        ownerId: item.id,
        handle: item.handle,
        field: 'filename',
        before: img.file,
        after: proposeFilename(item, img, index),
      })
    })
  }
  await addFixes($, fixes)
  return fixes.length
}

async function prepareAll($: Engine, targets: Item[]): Promise<void> {
  const n = (await prepareMeta($, targets)) + (await prepareFiles($, targets))
  $.ui.toast(`SEO Desk: ${n} change${n === 1 ? '' : 's'} ready for review.`)
}

/** Alt text needs eyes: hand the images to the main Claude loop, which can view them. */
async function sendAlt($: Engine, targets: Item[]): Promise<void> {
  const picked = targets.slice(0, 5)
  if (picked.length === 0) return
  const entries: { item: Item; detail: Detail }[] = []
  await exclusive($, 'Gathering images…', async () => {
    for (const item of picked) entries.push({ item, detail: await detailOf($, item) })
  })
  if (entries.length === 0) return
  await $.prompt.submit({ text: altPrompt(cfg.server, entries) })
  $.ui.toast(`Sent ${entries.length} product${entries.length === 1 ? '' : 's'} to Claude for alt text.`)
}

async function applyPending($: Engine): Promise<void> {
  const fixes = await read($, pending)
  if (fixes.length === 0) return
  const failed: SeoFix[] = []
  const errors: string[] = []
  await exclusive($, `Applying ${fixes.length} changes…`, async () => {
    const seoGroups = new Map<string, SeoFix[]>()
    const fileGroups = new Map<string, SeoFix[]>()
    for (const fix of fixes) {
      const groups = fix.kind === 'file' ? fileGroups : seoGroups
      const key = fix.kind === 'file' ? fix.targetId : `${fix.kind}:${fix.targetId}`
      groups.set(key, [...(groups.get(key) ?? []), fix])
    }

    for (const group of seoGroups.values()) {
      const first = group[0]
      if (first === undefined || first.kind === 'file') continue
      const seo: { title?: string; description?: string } = {}
      for (const fix of group) {
        if (fix.field === 'title') seo.title = fix.after
        if (fix.field === 'description') seo.description = fix.after
      }
      const errs = await writeSeo($, first.kind, first.targetId, seo)
      if (errs.length > 0) {
        failed.push(...group)
        errors.push(`${first.handle}: ${errs.join('; ')}`)
        continue
      }
      const item = itemOf(first.kind, first.targetId)
      if (item === undefined) continue
      if (seo.title !== undefined) item.seoTitle = seo.title
      if (seo.description !== undefined) item.seoDesc = seo.description
    }

    const files = [...fileGroups.values()].map(group => {
      const out: { id: string; alt?: string; filename?: string } = { id: group[0]?.targetId ?? '' }
      for (const fix of group) {
        if (fix.field === 'alt') out.alt = fix.after
        if (fix.field === 'filename') out.filename = fix.after
      }
      return out
    })
    if (files.length > 0) {
      const errs = await writeFiles($, files)
      if (errs.length > 0) {
        failed.push(...fixes.filter(f => f.kind === 'file'))
        errors.push(...errs)
      } else {
        for (const fix of fixes) {
          if (fix.kind !== 'file') continue
          const img = itemOf('product', fix.ownerId)?.imgs.find(i => i.id === fix.targetId)
          if (img === undefined) continue
          if (fix.field === 'filename') img.file = fix.after
          if (fix.field === 'alt') img.alt = fix.after
        }
      }
    }
    await save($)
    await publish($)
  })
  const keys = new Set(failed.map(f => f.key))
  await update($, pending, list => list.filter(f => keys.has(f.key)))
  if (errors.length > 0) await setError($, `Shopify refused some changes (kept in the list): ${errors.slice(0, 3).join(' | ')}`)
  $.ui.toast(`SEO Desk: applied ${fixes.length - failed.length} of ${fixes.length} changes.`)
}

async function acknowledge($: Engine): Promise<void> {
  scan.ackedAt = await $.clock.now()
  await $.store.set('ackedAt', scan.ackedAt)
  await update($, alert, () => null)
}

async function openPane($: Engine): Promise<boolean> {
  const opened = await $.ui.open({ id: PANE, title: 'SEO Desk' })
  return opened.isPlaced
}

async function pageItems($: Engine): Promise<Item[]> {
  const v = await read($, view)
  const u = await read($, ui)
  const size = scan.pageSize
  return rowsFor(v, u.filter)
    .slice(u.page * size, u.page * size + size)
    .map(r => itemOf(r.kind, r.id))
    .filter((i): i is Item => i !== undefined)
}

async function pageMeta($: Engine): Promise<void> {
  await prepareMeta($, await pageItems($))
}

async function pageFiles($: Engine): Promise<void> {
  await prepareFiles($, await pageItems($))
}

async function pageAlt($: Engine): Promise<void> {
  await sendAlt($, await pageItems($))
}

async function rowMeta($: Engine, r: SeoRow): Promise<void> {
  const item = itemOf(r.kind, r.id)
  if (item !== undefined) await prepareMeta($, [item])
}

async function rowFiles($: Engine, r: SeoRow): Promise<void> {
  const item = itemOf(r.kind, r.id)
  if (item !== undefined) await prepareFiles($, [item])
}

async function rowAlt($: Engine, r: SeoRow): Promise<void> {
  const item = itemOf(r.kind, r.id)
  if (item !== undefined) await sendAlt($, [item])
}

/** Opens the listing in Shopify admin in the browser; copies the link where that fails. */
async function openAdmin($: Engine, r: SeoRow): Promise<void> {
  const url = adminUrl(r.kind, r.id)
  for (const opener of ['open', 'xdg-open']) {
    try {
      if ((await $.process.run([opener, url])).exitCode === 0) return
    } catch {
      // not this platform's opener; try the next
    }
  }
  await $.ui.copy({ text: url })
  $.ui.toast('Shopify link copied to the clipboard.')
}

async function setFilter($: Engine, filter: SeoFilter): Promise<void> {
  await update($, ui, () => ({ filter, page: 0 }))
}

async function setPage($: Engine, page: number): Promise<void> {
  await update($, ui, u => ({ ...u, page }))
}

async function discard($: Engine): Promise<void> {
  await update($, pending, () => [])
}

async function reviewAll($: Engine): Promise<void> {
  await $.command.run({ command: 'seo', args: 'pending' })
}

export const register: Register = (on, options) => {
  cfg.server = String(options.shopifyServer ?? cfg.server)
  cfg.adminStore = String(options.adminStore ?? cfg.adminStore)
  cfg.titleFormat = options.titleFormat === 'product-brand' ? 'product-brand' : 'product-vendor-brand'
  cfg.metaModel = String(options.metaModel ?? cfg.metaModel)
  cfg.rescanMinutes = Math.max(10, Number(options.rescanMinutes ?? cfg.rescanMinutes))
  cfg.newDays = Math.max(1, Number(options.newDays ?? cfg.newDays))
  cfg.renameFiles = options.renameFiles !== false
  cfg.houseRulesInPrompt = options.houseRulesInPrompt !== false

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'seo',
      description: 'Calimia SEO Desk: open | scan | report | pending | fix <handle> | alt <handle>',
    })
    await load($)
    await publish($)
    $.clock.after(scan.scannedAt === null ? 4000 : 15000, () => void refresh($))
    $.clock.every(cfg.rescanMinutes * 60 * 1000, () => void refresh($))
    return next(e)
  })

  on('command.run', { command: 'seo' }, async ($, e) => {
    await load($)
    const [verb = '', ...rest] = e.args.trim().split(/\s+/)
    const handle = rest.join(' ')

    if (verb === '' || verb === 'open') {
      const isPlaced = await openPane($)
      return { text: isPlaced ? 'SEO Desk opened.' : 'SEO Desk is open; widen the terminal to see it beside the transcript.' }
    }
    if (verb === 'scan') {
      void fullScan($)
      return { text: 'SEO Desk: full scan started. The status line shows progress.' }
    }
    if (verb === 'report') return { text: report(await read($, view)) }
    if (verb === 'pending') {
      const fixes = await read($, pending)
      if (fixes.length === 0) return { text: 'SEO Desk: no pending changes.' }
      return { text: fixes.map(f => `${f.handle} · ${f.field}\n  before: ${f.before || '(none)'}\n  after:  ${f.after}`).join('\n') }
    }
    if (verb === 'fix' || verb === 'alt') {
      const item = scan.items.find(i => i.handle === handle) ?? scan.items.find(i => i.title.toLowerCase() === handle.toLowerCase())
      if (item === undefined) return { text: `SEO Desk: no product or collection with handle "${handle}" in the last scan.` }
      if (verb === 'alt') {
        void sendAlt($, [item])
        return { text: `SEO Desk: gathering ${item.title}'s images for Claude to describe.` }
      }
      void prepareAll($, [item])
      await openPane($)
      return { text: `SEO Desk: preparing fixes for ${item.title}; review and apply them in the pane.` }
    }
    return { text: 'Usage: /seo [open | scan | report | pending | fix <handle> | alt <handle>]' }
  })

  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    if (SHOPIFY_WRITE.test(String(e.tool)) && result.deny === undefined && result.isError !== true) {
      $.clock.after(4000, () => void checkAfterWrite($))
    }
    return result
  }).catch(($, e, next) => next(e))

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (!cfg.houseRulesInPrompt) return composed
    return { sections: [...composed.sections, { id: 'calimia-seo-desk:rules', text: HOUSE_RULES, scope: 'session' as const }] }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const a = await read($, alert)
    if (a === null || e.props.hasSurvey) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const names = a.titles.join(', ') + (a.count > a.titles.length ? ', …' : '')
    return (
      <Box gap={1}>
        <Text wrap="truncate-end">
          SEO Desk: {a.count} new product{a.count === 1 ? '' : 's'} need SEO ({names})
        </Text>
        <Button key="seo-open" label="Open" onPress={() => void openPane($)} />
        <Button key="seo-dismiss" label="Dismiss" role="dismiss" onPress={() => void acknowledge($)} />
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const v = await read($, view)
    const fixes = await read($, pending)
    const u = await read($, ui)
    const now = await $.clock.now()
    const t = v.totals

    const rows = rowsFor(v, u.filter)
    const height = e.viewport?.rows ?? 32
    const size = Math.max(3, Math.floor((height - 14 - (fixes.length > 0 ? 7 : 0)) / 2))
    scan.pageSize = size
    const pages = Math.max(1, Math.ceil(rows.length / size))
    const page = Math.min(u.page, pages - 1)
    const shown = rows.slice(page * size, page * size + size)

    return (
      <Box flexDirection="column" width={e.props.bodyColumns}>
        <Box gap={1}>
          <Text bold>Calimia SEO Desk</Text>
          <Text color={scoreColor(t.score)}>{v.scannedAt === null ? '' : `${t.score}/100`}</Text>
        </Box>
        <Text dimColor wrap="truncate-end">
          {v.scannedAt === null
            ? 'Not scanned yet: the first scan starts a few seconds after the session does.'
            : `${fmt(t.products)} products · ${fmt(t.collections)} collections · scanned ${ago(now - v.scannedAt)}`}
        </Text>
        <Text dimColor wrap="truncate-end">
          {`${fmt(t.altMissing)}/${fmt(t.imgs)} images without alt · ${fmt(t.metaIssues)} meta · ${fmt(t.badFiles)} bad file names`}
        </Text>
        {v.busy !== null && <Text color="yellow">{v.busy}</Text>}
        {v.error !== null && (
          <Text color="red" wrap="wrap">
            {v.error}
          </Text>
        )}

        <Box gap={1} flexWrap="wrap" marginTop={1}>
          {FILTERS.map(f => (
            <Button
              key={`filter-${f.id}`}
              label={`${f.label} ${fmt(rowsFor(v, f.id).length)}`}
              variant={u.filter === f.id ? 'primary' : 'secondary'}
              onPress={() => void setFilter($, f.id)}
            />
          ))}
        </Box>

        <Box flexDirection="column" marginTop={1}>
          {v.scannedAt !== null && shown.length === 0 && <Text dimColor>Nothing to fix here.</Text>}
          {shown.map(r => (
            <Box key={`row-${r.kind}-${r.id}`} flexDirection="column">
              <Box gap={1}>
                <Text color={scoreColor(r.score)}>{String(r.score).padStart(3)}</Text>
                <Text bold={r.isNew} wrap="truncate-end">
                  {`${r.title}${r.kind === 'collection' ? ' (collection)' : ''}${r.status === 'DRAFT' ? ' · draft' : ''}${r.isNew ? ' · new' : ''}`}
                </Text>
              </Box>
              <Box gap={1} paddingLeft={4}>
                {r.groups.includes('meta') && <Button key={`meta-${r.kind}-${r.id}`} label="Meta" onPress={() => void rowMeta($, r)} />}
                {r.groups.includes('files') && cfg.renameFiles && (
                  <Button key={`files-${r.kind}-${r.id}`} label="Files" onPress={() => void rowFiles($, r)} />
                )}
                {r.groups.includes('alt') && <Button key={`alt-${r.kind}-${r.id}`} label="Alt" onPress={() => void rowAlt($, r)} />}
                <Button key={`open-${r.kind}-${r.id}`} label="Open" onPress={() => void openAdmin($, r)} />
                <Text dimColor wrap="truncate-end">
                  {r.summary}
                </Text>
              </Box>
            </Box>
          ))}
        </Box>

        <Box gap={1} marginTop={1}>
          <Button key="prev" label="‹ Prev" onPress={() => void setPage($, Math.max(0, page - 1))} />
          <Text dimColor>{`${page + 1}/${pages}`}</Text>
          <Button key="next" label="Next ›" onPress={() => void setPage($, Math.min(pages - 1, page + 1))} />
        </Box>
        <Box gap={1} flexWrap="wrap">
          <Button key="page-meta" label="Meta: this page" onPress={() => void pageMeta($)} />
          {cfg.renameFiles && <Button key="page-files" label="Files: this page" onPress={() => void pageFiles($)} />}
          <Button key="page-alt" label="Alt: first 5" onPress={() => void pageAlt($)} />
          <Button key="rescan" label={v.busy !== null ? 'Busy…' : 'Rescan'} onPress={() => void fullScan($)} />
        </Box>

        {fixes.length > 0 && (
          <Box flexDirection="column" marginTop={1} borderStyle="round" paddingX={1}>
            <Text bold>{`${fixes.length} change${fixes.length === 1 ? '' : 's'} waiting for your OK`}</Text>
            {fixes.slice(0, 3).map(f => (
              <Text key={`fix-${f.key}`} dimColor wrap="truncate-end">
                {`${f.handle} · ${f.field}: ${f.after}`}
              </Text>
            ))}
            {fixes.some(f => f.field === 'filename') && (
              <Text color="yellow" wrap="wrap">
                Renaming changes image URLs; images pasted into descriptions by URL need updating.
              </Text>
            )}
            <Box gap={1}>
              <Button key="apply" label={`Apply ${fixes.length}`} variant="primary" onPress={() => void applyPending($)} />
              <Button key="review" label="Review all" onPress={() => void reviewAll($)} />
              <Button key="discard" label="Discard" onPress={() => void discard($)} />
            </Box>
          </Box>
        )}
      </Box>
    )
  })
}
