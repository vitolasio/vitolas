import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { DeskActivity, DeskAlert, DeskBoard, DeskCard, DeskColumn, DeskUi } from '../types'
import {
  addressRequest,
  DEFAULT_RULES,
  draftFlags,
  draftFrom,
  FLAG_LABEL,
  fmtMoney,
  invoiceReminder,
  isPaid,
  isPickup,
  orderFlags,
  orderFrom,
  orderNameIn,
  draftNameIn,
  pickupReminder,
  planSync,
  sectionsFrom,
  stageOf,
  taskFrom,
  daysBetween,
  type Action,
  type Draft,
  type Email,
  type Flag,
  type Order,
  type Rules,
  type SectionKey,
  type Sections,
  type Task,
} from './orders'

type Engine = EngineInterface
type Json = Record<string, any>

const PANE = 'order-desk'
const ACTIVITY_MAX = 40

const ORDERS = `query Orders($first: Int!, $after: String, $query: String) {
  orders(first: $first, after: $after, query: $query, sortKey: CREATED_AT, reverse: true) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id name createdAt cancelledAt sourceName email displayFinancialStatus displayFulfillmentStatus
      totalPriceSet { shopMoney { amount } } customer { displayName }
      shippingAddress { city provinceCode } shippingLine { title }
      lineItems(first: 8) { nodes { title quantity vendor originalTotalSet { shopMoney { amount } } discountedTotalSet { shopMoney { amount } } } }
      fulfillments(first: 3) { createdAt displayStatus deliveredAt trackingInfo(first: 1) { number company url } }
    }
  }
}`

const DRAFTS = `query Drafts($first: Int!, $after: String, $query: String) {
  draftOrders(first: $first, after: $after, query: $query, sortKey: UPDATED_AT, reverse: true) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id name status createdAt updatedAt invoiceSentAt invoiceUrl email tags note2
      totalPriceSet { shopMoney { amount } } customer { displayName } order { name }
    }
  }
}`

const COLUMNS: { id: DeskColumn; label: string }[] = [
  { id: 'issues', label: 'Issues' },
  { id: 'quotes', label: 'Quotes' },
  { id: 'new', label: 'New' },
  { id: 'production', label: 'Production' },
  { id: 'packing', label: 'Packing' },
  { id: 'shipped', label: 'Shipped' },
  { id: 'pickup', label: 'Pickup' },
  { id: 'claims', label: 'Claims' },
]

const URGENT: ReadonlySet<Flag> = new Set(['late', 'no-address', 'free-line', 'cleanup', 'invoice-unpaid', 'pickup-waiting'])

// Order-changing Shopify mutations and customer email Claude might run: asked about first.
const RISKY_MUTATION = /\b(draftOrderComplete|draftOrderInvoiceSend|orderMarkAsPaid|orderCancel|orderClose|refundCreate|returnCreate|fulfillmentCreate|fulfillmentCreateV2|orderEditCommit)\b/
const SHOPIFY_TOOL = /^mcp__.*shopify.*__/i
const ASANA_TOOL = /^mcp__.*asana.*__/i
const GMAIL_SEND = /^mcp__.*gmail.*__(send_message|reply|forward|send_draft)$/i

type Config = {
  shopify: string
  asana: string
  gmail: string
  projectGid: string
  adminStore: string
  assignee: string
  syncMinutes: number
  lookbackDays: number
  completeDeliveredAfterDays: number
  createTasks: boolean
  autoSync: boolean
  guards: boolean
  rules: Rules
}

const cfg: Config = {
  shopify: 'claude.ai Shopify',
  asana: 'claude.ai Asana',
  gmail: 'claude.ai Gmail',
  projectGid: '1215125736009076',
  adminStore: '1ba31e-2',
  assignee: 'gustaf@calimiahome.com',
  syncMinutes: 15,
  lookbackDays: 30,
  completeDeliveredAfterDays: 14,
  createTasks: true,
  autoSync: true,
  guards: true,
  rules: DEFAULT_RULES,
}

const desk = {
  orders: [] as Order[],
  drafts: [] as Draft[],
  tasks: [] as Task[],
  sections: {} as Sections,
  plan: [] as Action[],
  ackedAt: 0,
  isLoaded: false,
  running: null as Promise<unknown> | null,
}

const NO_BOARD: DeskBoard = {
  syncedAt: null,
  busy: null,
  error: null,
  isAutoSync: true,
  cards: [],
  toShip: 0,
  late: 0,
  pickups: 0,
  quotesTotal: 0,
  quotesUnpaid: 0,
  pendingUpdates: [],
  activity: [],
}

const board = atom({ plugin: 'calimia-order-desk', key: 'board' } as const, NO_BOARD)
const ui = atom({ plugin: 'calimia-order-desk', key: 'ui' } as const, { column: 'issues', page: 0 } as DeskUi)
const alert = atom({ plugin: 'calimia-order-desk', key: 'alert' } as const, null as DeskAlert | null)

function fmtK(n: number): string {
  return n >= 1000 ? `$${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : fmtMoney(n)
}

function ago(ms: number): string {
  const min = Math.round(ms / 60000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min} min ago`
  return `${Math.round(min / 60)} h ago`
}

function adminUrl(kind: 'orders' | 'draft_orders', id: string): string {
  return `https://admin.shopify.com/store/${cfg.adminStore}/${kind}/${id}`
}

function jsonOf(server: string, tool: string, blocks: readonly { text?: string }[], isError: boolean): Json {
  const text = blocks.map(b => b.text ?? '').join('')
  if (isError) throw new Error(`${server} ${tool}: ${text.slice(0, 300)}`)
  try {
    return JSON.parse(text) as Json
  } catch {
    throw new Error(`${server} ${tool} answered something other than JSON: ${text.slice(0, 200)}`)
  }
}

function isTooLarge(err: unknown): boolean {
  return err instanceof Error && /exceeds maximum allowed tokens|output has been saved/i.test(err.message)
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// ── calls ──────────────────────────────────────────────────────────────────────

async function shopify($: Engine, query: string, variables: Json): Promise<Json> {
  const args: Json = { query, variables }
  if (typeof variables.first === 'number') args.first = variables.first
  if (typeof variables.after === 'string') args.after = variables.after
  const res = await $.mcp.call(cfg.shopify, 'graphql_query', args)
  const json = jsonOf(cfg.shopify, 'graphql_query', res.content, res.isError)
  if (Array.isArray(json.errors) && json.errors.length > 0) throw new Error(`Shopify: ${json.errors.map((e: Json) => e.message).join('; ')}`)
  return (json.data ?? json) as Json
}

/** Every page of a Shopify connection, halving the page when a result is too large for one tool call. */
async function shopifyAll($: Engine, query: string, field: string, filter: string, start: number): Promise<Json[]> {
  const out: Json[] = []
  let after: string | null = null
  let size = start
  for (let page = 0; page < 60; page += 1) {
    const vars: Json = { first: size, query: filter }
    if (after !== null) vars.after = after
    let conn: Json
    try {
      conn = (await shopify($, query, vars))[field]
    } catch (err) {
      if (!isTooLarge(err) || size <= 2) throw err
      size = Math.max(2, Math.floor(size / 2))
      continue
    }
    out.push(...(conn?.nodes ?? []))
    if (!conn?.pageInfo?.hasNextPage) break
    after = conn.pageInfo.endCursor
  }
  return out
}

async function asana($: Engine, tool: string, args: Json): Promise<Json> {
  const res = await $.mcp.call(cfg.asana, tool, args)
  return jsonOf(cfg.asana, tool, res.content, res.isError)
}

async function fetchOrders($: Engine, now: number): Promise<Order[]> {
  const since = new Date(now - cfg.lookbackDays * 24 * 3600 * 1000).toISOString().slice(0, 10)
  const filter = `created_at:>='${since}' OR fulfillment_status:unfulfilled OR fulfillment_status:partial`
  return (await shopifyAll($, ORDERS, 'orders', filter, 10)).map(orderFrom)
}

async function fetchDrafts($: Engine, now: number): Promise<Draft[]> {
  const since = new Date(now - 7 * 24 * 3600 * 1000).toISOString().slice(0, 10)
  const filter = `status:open OR status:invoice_sent OR (status:completed AND updated_at:>='${since}')`
  return (await shopifyAll($, DRAFTS, 'draftOrders', filter, 25)).map(draftFrom)
}

async function fetchSections($: Engine): Promise<Sections> {
  const json = await asana($, 'get_project', { project_id: cfg.projectGid, include_sections: true, opt_fields: 'name' })
  const data = json.data ?? json
  return sectionsFrom((data.sections ?? []) as { gid: string; name: string }[])
}

async function fetchTasks($: Engine, now: number): Promise<Task[]> {
  const out: Task[] = []
  let offset: string | null = null
  for (let page = 0; page < 20; page += 1) {
    const args: Json = {
      project: cfg.projectGid,
      // Incomplete tasks, plus those completed within the lookback, so no order gets a second task.
      completed_since: new Date(now - (cfg.lookbackDays + 1) * 24 * 3600 * 1000).toISOString().replace(/\.\d+Z$/, 'Z'),
      limit: 50,
      opt_fields: 'name,completed,due_on,modified_at,permalink_url,assignee.email,memberships.project.gid,memberships.section.name',
    }
    if (offset !== null) args.offset = offset
    const json = await asana($, 'get_tasks', args)
    for (const node of (json.data ?? []) as Json[]) out.push(taskFrom(node, cfg.projectGid))
    offset = json.next_page?.offset ?? null
    if (offset === null) break
  }
  return out
}

/** Applies the sync's Asana updates; resolves one line per update for the activity log. */
async function applyActions($: Engine, actions: readonly Action[]): Promise<string[]> {
  const done: string[] = []
  const creates = actions.filter(a => a.kind === 'create')
  for (let i = 0; i < creates.length; i += 25) {
    const chunk = creates.slice(i, i + 25)
    const json = await asana($, 'create_tasks', {
      default_project: cfg.projectGid,
      tasks: chunk.map(a => ({
        name: a.name,
        notes: a.notes,
        project_id: cfg.projectGid,
        section_id: desk.sections[a.section],
        due_on: a.dueOn,
        assignee: cfg.assignee,
      })),
    })
    const failed = (json.failed ?? json.data?.failed ?? []) as Json[]
    for (const a of chunk) done.push(`created “${a.name}” (${a.reason})`)
    if (failed.length > 0) throw new Error(`Asana refused ${failed.length} new task(s): ${JSON.stringify(failed).slice(0, 200)}`)
  }

  const updates: Json[] = []
  for (const a of actions) {
    if (a.kind === 'move') updates.push({ task: a.task.gid, add_projects: [{ project_id: cfg.projectGid, section_id: desk.sections[a.section] }] })
    if (a.kind === 'rename') updates.push({ task: a.task.gid, name: a.name, add_projects: [{ project_id: cfg.projectGid, section_id: desk.sections[a.section] }] })
    if (a.kind === 'complete') updates.push({ task: a.task.gid, completed: true })
  }
  for (let i = 0; i < updates.length; i += 50) {
    const json = await asana($, 'update_tasks', { tasks: updates.slice(i, i + 50) })
    const failed = (json.failed ?? json.data?.failed ?? []) as Json[]
    if (failed.length > 0) throw new Error(`Asana refused ${failed.length} update(s): ${JSON.stringify(failed).slice(0, 200)}`)
  }
  for (const a of actions) {
    if (a.kind === 'create') continue
    if (a.kind === 'move' || a.kind === 'rename') {
      await asana($, 'add_comment', { task_id: a.task.gid, text: `${a.comment} (Calimia Order Desk)` })
      done.push(`${a.kind === 'rename' ? 'converted' : 'moved'} ${a.task.name.slice(0, 40)} → ${a.section} (${a.reason})`)
    } else {
      done.push(`completed ${a.task.name.slice(0, 40)} (${a.reason})`)
    }
  }
  return done
}

// ── the board ──────────────────────────────────────────────────────────────────

function taskIndex(): { orders: Map<string, Task>; drafts: Map<string, Task> } {
  const orders = new Map<string, Task>()
  const drafts = new Map<string, Task>()
  for (const t of desk.tasks) {
    const o = orderNameIn(t.name)
    const d = draftNameIn(t.name)
    if (o !== null && !orders.has(o)) orders.set(o, t)
    if (d !== null && !drafts.has(d)) drafts.set(d, t)
  }
  return { orders, drafts }
}

function cardsOf(now: number): DeskCard[] {
  const idx = taskIndex()
  const cards: DeskCard[] = []
  for (const o of desk.orders) {
    const t = idx.orders.get(o.name)
    const stage = stageOf(o, t, cfg.rules)
    const flags = orderFlags(o, t, stage, now, cfg.rules)
    if (stage === 'delivered' || (stage === 'closed' && flags.length === 0)) continue
    const column = stage === 'closed' ? 'new' : stage
    const detail = [
      isPickup(o, cfg.rules) ? 'pickup' : o.city || (o.hasAddress ? '' : 'no address'),
      o.tracking ? `${o.tracking.company} ${o.tracking.number}` : '',
      t ? `Asana: ${t.sectionName || 'no section'}` : 'no Asana task',
      o.source === 'pos' ? 'POS' : o.source === 'shopify_draft_order' ? 'from quote' : '',
    ]
      .filter(Boolean)
      .join(' · ')
    cards.push({
      kind: 'order',
      id: o.id,
      name: o.name,
      customer: o.customer || o.email || 'Guest',
      email: o.email,
      total: o.total,
      ageDays: daysBetween(o.createdAt, now),
      column,
      flags: flags.map(f => FLAG_LABEL[f]),
      severity: flags.some(f => URGENT.has(f)) ? 2 : flags.length > 0 ? 1 : 0,
      detail,
      taskGid: t?.gid ?? null,
      taskUrl: t?.url ?? null,
      isPickup: isPickup(o, cfg.rules),
      canInvoiceEmail: false,
      canPickupEmail: stage === 'pickup' && o.email !== '',
      canAddressEmail: flags.includes('no-address') && o.email !== '',
    })
  }
  for (const d of desk.drafts) {
    if (d.status === 'COMPLETED') continue
    const t = idx.drafts.get(d.name)
    const flags = draftFlags(d, desk.drafts, now, cfg.rules)
    cards.push({
      kind: 'quote',
      id: d.id,
      name: d.name,
      customer: d.customer || d.email || 'Customer',
      email: d.email,
      total: d.total,
      ageDays: daysBetween(d.createdAt, now),
      column: 'quotes',
      flags: flags.map(f => FLAG_LABEL[f]),
      severity: flags.some(f => URGENT.has(f)) ? 2 : flags.length > 0 ? 1 : 0,
      detail: [d.status === 'INVOICE_SENT' ? `invoice sent ${daysBetween(d.invoiceSentAt ?? d.createdAt, now)}d ago` : 'not sent', d.tags.join(', '), d.note.slice(0, 50)]
        .filter(Boolean)
        .join(' · '),
      taskGid: t?.gid ?? null,
      taskUrl: t?.url ?? null,
      isPickup: false,
      canInvoiceEmail: d.status === 'INVOICE_SENT' && d.email !== '' && d.invoiceUrl !== '',
      canPickupEmail: false,
      canAddressEmail: false,
    })
  }
  return cards.sort((a, b) => b.severity - a.severity || b.ageDays - a.ageDays)
}

function describe(a: Action): string {
  if (a.kind === 'create') return `create “${a.name}” in ${a.section}`
  if (a.kind === 'complete') return `complete ${a.task.name.slice(0, 40)}`
  return `${a.kind === 'rename' ? 'convert' : 'move'} ${a.task.name.slice(0, 40)} → ${a.section}`
}

async function publish($: Engine): Promise<void> {
  const now = await $.clock.now()
  const cards = cardsOf(now)
  const toShip = cards.filter(c => c.kind === 'order' && (c.column === 'new' || c.column === 'production' || c.column === 'packing')).length
  const late = cards.filter(c => c.flags.includes(FLAG_LABEL.late)).length
  const pickups = cards.filter(c => c.column === 'pickup').length
  const quotes = desk.drafts.filter(d => d.status !== 'COMPLETED')
  const quotesTotal = quotes.reduce((n, d) => n + d.total, 0)
  const quotesUnpaid = quotes.filter(d => d.status === 'INVOICE_SENT').length
  const pendingUpdates = cfg.autoSync ? [] : desk.plan.map(describe)

  await update($, board, b => ({ ...b, cards, toShip, late, pickups, quotesTotal, quotesUnpaid, pendingUpdates, isAutoSync: cfg.autoSync }))

  const fresh = desk.orders.filter(o => isPaid(o) && Date.parse(o.createdAt) > desk.ackedAt && desk.ackedAt > 0)
  await update($, alert, () => (fresh.length > 0 ? { count: fresh.length, names: fresh.slice(0, 3).map(o => `${o.name} ${o.customer || o.email} ${fmtMoney(o.total)}`) } : null))
  $.ui.status(`Orders ${toShip} to ship · ${late} late · ${pickups} pickup · quotes ${fmtK(quotesTotal)} (${quotesUnpaid} unpaid)`)
}

async function logActivity($: Engine, lines: readonly string[]): Promise<void> {
  if (lines.length === 0) return
  const at = await $.clock.now()
  const entries: DeskActivity[] = lines.map(text => ({ at, text }))
  await update($, board, b => ({ ...b, activity: [...entries, ...b.activity].slice(0, ACTIVITY_MAX) }))
  const kept = await read($, board)
  await $.store.set('activity', kept.activity)
}

async function setBusy($: Engine, busy: string | null): Promise<void> {
  await update($, board, b => ({ ...b, busy }))
}

async function setError($: Engine, error: string | null): Promise<void> {
  await update($, board, b => ({ ...b, error }))
}

async function load($: Engine): Promise<void> {
  if (desk.isLoaded) return
  desk.ackedAt = Number((await $.store.get('ackedAt')) ?? 0)
  const stored = await $.store.get('autoSync')
  if (typeof stored === 'boolean') cfg.autoSync = stored
  const activity = await $.store.get('activity')
  if (Array.isArray(activity)) await update($, board, b => ({ ...b, activity: activity as DeskActivity[] }))
  desk.isLoaded = true
}

/** One sync at a time; a background one stays quiet when another runs. */
async function exclusive($: Engine, label: string, work: () => Promise<void>, isQuiet: boolean): Promise<void> {
  if (desk.running !== null) {
    if (!isQuiet) $.ui.toast('Order Desk is busy; try again in a moment.')
    return
  }
  const job = guarded($, label, work)
  desk.running = job
  try {
    await job
  } finally {
    desk.running = null
  }
}

async function guarded($: Engine, label: string, work: () => Promise<void>): Promise<void> {
  await setBusy($, label)
  await setError($, null)
  try {
    await work()
  } catch (err) {
    await setError($, errorText(err))
  } finally {
    await setBusy($, null)
  }
}

/** Reads Shopify and Asana, applies (or proposes) the Asana updates, redraws. */
async function sync($: Engine, isQuiet = true): Promise<void> {
  await exclusive(
    $,
    'Syncing Shopify and Asana…',
    async () => {
      await load($)
      const now = await $.clock.now()
      desk.orders = await fetchOrders($, now)
      desk.drafts = await fetchDrafts($, now)
      desk.sections = await fetchSections($)
      desk.tasks = await fetchTasks($, now)
      if (desk.ackedAt === 0) {
        desk.ackedAt = now
        await $.store.set('ackedAt', now)
      }
      desk.plan = planSync(
        desk.orders,
        desk.drafts,
        desk.tasks,
        now,
        {
          rules: cfg.rules,
          sections: desk.sections,
          createTasks: cfg.createTasks,
          lookbackDays: cfg.lookbackDays,
          completeDeliveredAfterDays: cfg.completeDeliveredAfterDays,
        },
        adminUrl,
      )
      if (cfg.autoSync && desk.plan.length > 0) {
        await setBusy($, `Updating Asana (${desk.plan.length})…`)
        const done = await applyActions($, desk.plan)
        await logActivity($, done)
        desk.plan = []
        desk.tasks = await fetchTasks($, now)
      }
      await update($, board, b => ({ ...b, syncedAt: now }))
      await publish($)
    },
    isQuiet,
  )
}

async function applyPlan($: Engine): Promise<void> {
  await exclusive(
    $,
    'Updating Asana…',
    async () => {
      const done = await applyActions($, desk.plan)
      await logActivity($, done)
      desk.plan = []
      desk.tasks = await fetchTasks($, await $.clock.now())
      await publish($)
    },
    false,
  )
}

async function setAutoSync($: Engine, isOn: boolean): Promise<void> {
  cfg.autoSync = isOn
  await $.store.set('autoSync', isOn)
  await publish($)
  if (isOn) await sync($, false)
}

async function moveCard($: Engine, card: DeskCard, section: SectionKey): Promise<void> {
  const gid = desk.sections[section]
  if (card.taskGid === null || gid === undefined) {
    $.ui.toast(card.taskGid === null ? `${card.name} has no Asana task yet.` : `No “${section}” section in the Asana project.`)
    return
  }
  const taskGid = card.taskGid
  await exclusive(
    $,
    `Moving ${card.name}…`,
    async () => {
      await asana($, 'update_tasks', { tasks: [{ task: taskGid, add_projects: [{ project_id: cfg.projectGid, section_id: gid }] }] })
      await logActivity($, [`moved ${card.name} → ${section} (you)`])
      desk.tasks = await fetchTasks($, await $.clock.now())
      await publish($)
    },
    false,
  )
}

/** Saves a customer email as a Gmail draft (never sends) and notes it on the Asana task. */
async function draftEmail($: Engine, card: DeskCard, kind: 'invoice' | 'pickup' | 'address'): Promise<void> {
  let email: Email | null = null
  if (kind === 'invoice') {
    const d = desk.drafts.find(x => x.id === card.id)
    if (d) email = invoiceReminder(d)
  } else {
    const o = desk.orders.find(x => x.id === card.id)
    if (o) email = kind === 'pickup' ? pickupReminder(o) : addressRequest(o)
  }
  if (email === null || email.to === '') {
    $.ui.toast(`No email address on ${card.name}.`)
    return
  }
  const draft = email
  await exclusive(
    $,
    `Drafting email for ${card.name}…`,
    async () => {
      await $.mcp.call(cfg.gmail, 'create_draft', { to: [draft.to], subject: draft.subject, body: draft.body })
      if (card.taskGid !== null) {
        await asana($, 'add_comment', { task_id: card.taskGid, text: `Drafted “${draft.subject}” to ${draft.to} in Gmail (Calimia Order Desk).` })
      }
      await logActivity($, [`drafted ${kind} email for ${card.name} → Gmail drafts`])
      $.ui.toast(`Draft saved in Gmail: “${draft.subject}”. Review and send it there.`)
    },
    false,
  )
}

async function openUrl($: Engine, url: string): Promise<void> {
  for (const opener of ['open', 'xdg-open']) {
    try {
      if ((await $.process.run([opener, url])).exitCode === 0) return
    } catch {
      // not this platform's opener
    }
  }
  await $.ui.copy({ text: url })
  $.ui.toast('Link copied to the clipboard.')
}

async function openShopify($: Engine, card: DeskCard): Promise<void> {
  await openUrl($, adminUrl(card.kind === 'order' ? 'orders' : 'draft_orders', card.id))
}

async function openAsana($: Engine, card: DeskCard): Promise<void> {
  if (card.taskUrl !== null) await openUrl($, card.taskUrl)
}

async function acknowledge($: Engine): Promise<void> {
  desk.ackedAt = await $.clock.now()
  await $.store.set('ackedAt', desk.ackedAt)
  await update($, alert, () => null)
}

async function openPane($: Engine): Promise<boolean> {
  return (await $.ui.open({ id: PANE, title: 'Order Desk' })).isPlaced
}

async function openAndAck($: Engine): Promise<void> {
  await update($, ui, () => ({ column: 'new', page: 0 }))
  await openPane($)
  await acknowledge($)
}

async function setColumn($: Engine, column: DeskColumn): Promise<void> {
  await update($, ui, () => ({ column, page: 0 }))
}

async function setPage($: Engine, page: number): Promise<void> {
  await update($, ui, u => ({ ...u, page }))
}

function report(b: DeskBoard): string {
  const lines = [
    `Calimia Order Desk, synced ${b.syncedAt === null ? 'never' : new Date(b.syncedAt).toISOString()}`,
    `${b.toShip} to ship (${b.late} late) · ${b.pickups} waiting for pickup · quotes ${fmtMoney(b.quotesTotal)} open (${b.quotesUnpaid} invoices unpaid)`,
    '',
  ]
  for (const c of b.cards.filter(c => c.severity > 0).slice(0, 30)) {
    lines.push(`${c.name} ${c.customer} ${fmtMoney(c.total)} · ${c.column} · ${c.ageDays}d · ${c.flags.join(', ')}${c.taskUrl ? ` · ${c.taskUrl}` : ''}`)
  }
  if (b.pendingUpdates.length > 0) lines.push('', 'Asana updates waiting (auto-sync off):', ...b.pendingUpdates.map(u => `- ${u}`))
  return lines.join('\n')
}

/** Everything known about one order or quote, plus the customer's recent Gmail threads. */
async function dossier($: Engine, query: string): Promise<string> {
  const q = query.trim().replace(/^#?/, '#').toUpperCase()
  const o = desk.orders.find(x => x.name.toUpperCase() === q)
  const d = desk.drafts.find(x => x.name.toUpperCase() === q)
  if (!o && !d) return `Order Desk: ${query} is not among the open orders and quotes from the last sync (/orders sync to refresh).`
  const idx = taskIndex()
  const t = o ? idx.orders.get(o.name) : d ? idx.drafts.get(d.name) : undefined
  const now = await $.clock.now()
  const lines: string[] = []
  if (o) {
    const stage = stageOf(o, t, cfg.rules)
    lines.push(
      `${o.name} · ${o.customer} <${o.email}> · ${fmtMoney(o.total)} · ${o.financial} / ${o.fulfillment} · ${daysBetween(o.createdAt, now)} days old`,
      `Stage: ${stage} · Delivery: ${isPickup(o, cfg.rules) ? `pickup (${o.shipTitle})` : o.hasAddress ? `${o.shipTitle} to ${o.city}` : 'NO ADDRESS'}`,
      `Tracking: ${o.tracking ? `${o.tracking.company} ${o.tracking.number} ${o.tracking.url}` : '—'}`,
      `Flags: ${orderFlags(o, t, stage, now, cfg.rules).map(f => FLAG_LABEL[f]).join(', ') || 'none'}`,
      ...o.lines.map(l => `  • ${l.qty} x ${l.title} (${l.vendor}) ${fmtMoney(l.paid)}${l.list > 0 && l.paid === 0 ? ` — list ${fmtMoney(l.list)}, 100% discounted` : ''}`),
      `Shopify: ${adminUrl('orders', o.id)}`,
    )
  }
  if (d) {
    lines.push(
      `${d.name} · ${d.customer} <${d.email}> · ${fmtMoney(d.total)} · ${d.status}${d.invoiceSentAt ? ` (sent ${d.invoiceSentAt.slice(0, 10)})` : ''}`,
      `Flags: ${draftFlags(d, desk.drafts, now, cfg.rules).map(f => FLAG_LABEL[f]).join(', ') || 'none'}`,
      d.note ? `Note: ${d.note}` : '',
      `Shopify: ${adminUrl('draft_orders', d.id)}`,
    )
  }
  lines.push(`Asana: ${t ? `${t.sectionName} · ${t.assignee || 'unassigned'} · due ${t.dueOn ?? '—'} · ${t.url}` : 'no task'}`)
  const email = o?.email || d?.email || ''
  const name = o?.name ?? d?.name ?? ''
  try {
    const res = await $.mcp.call(cfg.gmail, 'search_threads', { query: email ? `"${name}" OR from:${email} OR to:${email}` : `"${name}"`, pageSize: 5 })
    const threads = (jsonOf(cfg.gmail, 'search_threads', res.content, res.isError).threads ?? []) as Json[]
    lines.push('', `Recent Gmail threads (${threads.length}):`)
    for (const th of threads) {
      const m = (th.messages ?? th.relatedMessages ?? [])[0] ?? {}
      lines.push(`  • ${m.date ?? ''} ${m.subject ?? th.snippet ?? '(no subject)'} — ${m.sender ?? ''}`)
    }
  } catch (err) {
    lines.push('', `Gmail: ${errorText(err).slice(0, 120)}`)
  }
  return lines.filter(l => l !== '').join('\n')
}

/** What a tool call would do that needs a person's OK first, or null. */
function riskOf(tool: string, input: Json): string | null {
  if (SHOPIFY_TOOL.test(tool) && /graphql_mutation$/i.test(tool)) {
    const m = String(input.query ?? '').match(RISKY_MUTATION)
    if (m) return `Claude wants to run ${m[1]} on your Shopify store`
  }
  if (GMAIL_SEND.test(tool)) {
    const to = Array.isArray(input.to) ? input.to.join(', ') : String(input.to ?? 'a recipient')
    return `Claude wants to send an email to ${to}${input.subject ? ` (“${input.subject}”)` : ''}`
  }
  return null
}

async function confirmRisk($: Engine, risk: string): Promise<boolean> {
  try {
    return (await $.ui.ask(`${risk}. Allow it?`, ['Allow', 'Block'])) === 'Allow'
  } catch {
    return false
  }
}

function systemNote(): string {
  return [
    'Calimia Order Desk (mod) is active.',
    `- Online and showroom orders are tracked in the Asana project "Shopify Web Orders" (gid ${cfg.projectGid}); sections: New Orders → In Production → Processing / Packing → Shipped → Ready for In-Store Pick-up → Delivered, plus Quotes, Claims + CSIs, Archived.`,
    '- The mod creates tasks for new paid orders and moves tasks to Shipped and Delivered from Shopify itself; do not duplicate that. People move tasks into In Production, Packing, Pick-up and Claims.',
    "- Customer emails are drafted in Gmail for review, never sent directly. Marking a draft order paid, cancelling, refunding or fulfilling an order needs the person's explicit OK.",
    "- /orders opens the board; /order #1234 gives one order's full picture.",
  ].join('\n')
}

export const register: Register = (on, options) => {
  cfg.shopify = String(options.shopifyServer ?? cfg.shopify)
  cfg.asana = String(options.asanaServer ?? cfg.asana)
  cfg.gmail = String(options.gmailServer ?? cfg.gmail)
  cfg.projectGid = String(options.asanaProject ?? cfg.projectGid)
  cfg.adminStore = String(options.adminStore ?? cfg.adminStore)
  cfg.assignee = String(options.assignee ?? cfg.assignee)
  cfg.syncMinutes = Math.max(5, Number(options.syncMinutes ?? cfg.syncMinutes))
  cfg.lookbackDays = Math.max(3, Number(options.lookbackDays ?? cfg.lookbackDays))
  cfg.completeDeliveredAfterDays = Math.max(0, Number(options.completeDeliveredAfterDays ?? cfg.completeDeliveredAfterDays))
  cfg.createTasks = options.createTasks !== false
  cfg.autoSync = options.autoSync !== false
  cfg.guards = options.guards !== false
  cfg.rules = {
    ...DEFAULT_RULES,
    shipSlaDays: Number(options.shipSlaDays ?? DEFAULT_RULES.shipSlaDays),
    invoiceReminderDays: Number(options.invoiceReminderDays ?? DEFAULT_RULES.invoiceReminderDays),
    pickupReminderDays: Number(options.pickupReminderDays ?? DEFAULT_RULES.pickupReminderDays),
  }

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'orders', description: 'Calimia Order Desk: open | sync | report | auto on|off' })
    await $.command.register({ name: 'order', description: 'Calimia Order Desk: everything about one order or quote, e.g. /order #2282 or /order D384' })
    await load($)
    await publish($)
    $.clock.after(3000, () => void sync($))
    $.clock.every(cfg.syncMinutes * 60 * 1000, () => void sync($))
    return next(e)
  })

  on('command.run', { command: 'orders' }, async ($, e) => {
    await load($)
    const [verb = '', arg = ''] = e.args.trim().split(/\s+/)
    if (verb === '' || verb === 'open') {
      const isPlaced = await openPane($)
      return { text: isPlaced ? 'Order Desk opened.' : 'Order Desk is open; widen the terminal to see it beside the transcript.' }
    }
    if (verb === 'sync') {
      void sync($, false)
      return { text: 'Order Desk: syncing Shopify and Asana.' }
    }
    if (verb === 'report') return { text: report(await read($, board)) }
    if (verb === 'auto') {
      await setAutoSync($, arg !== 'off')
      return { text: `Order Desk: automatic Asana updates ${arg === 'off' ? 'off; the board lists them for you to apply' : 'on'}.` }
    }
    return { text: 'Usage: /orders [open | sync | report | auto on|off] · /order <#1234 | D384>' }
  })

  on('command.run', { command: 'order' }, async ($, e) => {
    await load($)
    if (e.args.trim() === '') return { text: 'Usage: /order #2282 (or /order D384 for a quote)' }
    return { text: await dossier($, e.args.trim()) }
  })

  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    const risk = cfg.guards ? riskOf(tool, e as Json) : null
    if (risk !== null && !(await confirmRisk($, risk))) return { deny: `Calimia Order Desk: blocked — ${risk}. Ask the person before trying again.` }
    const result = await next(e)
    if ((SHOPIFY_TOOL.test(tool) || ASANA_TOOL.test(tool)) && result.deny === undefined && result.isError !== true && /mutation|create|update|add_comment/i.test(tool)) {
      $.clock.after(5000, () => void sync($))
    }
    return result
  }).catch(($, e, next) => (next.called ? next(e) : riskOf(String(e.tool), e as Json) !== null ? { deny: 'Calimia Order Desk could not confirm this action; try again.' } : next(e)))

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    return { sections: [...composed.sections, { id: 'calimia-order-desk:workflow', text: systemNote(), scope: 'session' as const }] }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const a = await read($, alert)
    if (a === null || e.props.hasSurvey) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    return (
      <Box gap={1}>
        <Text wrap="truncate-end">{`New order${a.count === 1 ? '' : `s (${a.count})`}: ${a.names.join(' · ')}`}</Text>
        <Button key="orders-open" label="Open" onPress={() => void openAndAck($)} />
        <Button key="orders-dismiss" label="Dismiss" role="dismiss" onPress={() => void acknowledge($)} />
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const b = await read($, board)
    const u = await read($, ui)
    const now = await $.clock.now()
    const inColumn = (c: DeskColumn): DeskCard[] => (c === 'issues' ? b.cards.filter(x => x.severity > 0) : b.cards.filter(x => x.column === c))
    const cards = inColumn(u.column)
    const height = e.viewport?.rows ?? 32
    const size = Math.max(2, Math.floor((height - 16 - (b.pendingUpdates.length > 0 ? 4 : 0)) / 4))
    const pages = Math.max(1, Math.ceil(cards.length / size))
    const page = Math.min(u.page, pages - 1)
    const shown = cards.slice(page * size, page * size + size)
    const color = (sev: number): string => (sev >= 2 ? 'red' : sev === 1 ? 'yellow' : 'green')

    return (
      <Box flexDirection="column" width={e.props.bodyColumns}>
        <Box gap={1}>
          <Text bold>Calimia Order Desk</Text>
          <Text dimColor>{b.syncedAt === null ? 'not synced yet' : `synced ${ago(now - b.syncedAt)}`}</Text>
        </Box>
        <Text wrap="truncate-end">{`${b.toShip} to ship · ${b.late} late · ${b.pickups} pickup · quotes ${fmtK(b.quotesTotal)} (${b.quotesUnpaid} unpaid)`}</Text>
        {b.busy !== null && <Text color="yellow">{b.busy}</Text>}
        {b.error !== null && (
          <Text color="red" wrap="wrap">
            {b.error}
          </Text>
        )}

        <Box gap={1} flexWrap="wrap" marginTop={1}>
          {COLUMNS.map(c => (
            <Button
              key={`col-${c.id}`}
              label={`${c.label} ${inColumn(c.id).length}`}
              variant={u.column === c.id ? 'primary' : 'secondary'}
              onPress={() => void setColumn($, c.id)}
            />
          ))}
        </Box>

        <Box flexDirection="column" marginTop={1}>
          {b.syncedAt !== null && shown.length === 0 && <Text dimColor>Nothing here.</Text>}
          {shown.map(c => (
            <Box key={`card-${c.kind}-${c.id}`} flexDirection="column" marginBottom={1}>
              <Box gap={1}>
                <Text color={color(c.severity)} bold>
                  {c.name}
                </Text>
                <Text wrap="truncate-end">{`${c.customer} · ${fmtMoney(c.total)} · ${c.ageDays}d`}</Text>
              </Box>
              {c.flags.length > 0 && (
                <Text color={color(c.severity)} wrap="truncate-end">
                  {c.flags.join(' · ')}
                </Text>
              )}
              <Text dimColor wrap="truncate-end">
                {c.detail}
              </Text>
              <Box gap={1} flexWrap="wrap">
                <Button key={`shop-${c.kind}-${c.id}`} label="Shopify" onPress={() => void openShopify($, c)} />
                {c.taskUrl !== null && <Button key={`asana-${c.kind}-${c.id}`} label="Asana" onPress={() => void openAsana($, c)} />}
                {c.canInvoiceEmail && <Button key={`inv-${c.id}`} label="Draft reminder" onPress={() => void draftEmail($, c, 'invoice')} />}
                {c.canPickupEmail && <Button key={`pick-${c.id}`} label="Draft pickup email" onPress={() => void draftEmail($, c, 'pickup')} />}
                {c.canAddressEmail && <Button key={`addr-${c.id}`} label="Ask for address" onPress={() => void draftEmail($, c, 'address')} />}
                {c.kind === 'order' && c.column === 'new' && c.taskGid !== null && (
                  <Button key={`prod-${c.id}`} label="→ Production" onPress={() => void moveCard($, c, 'production')} />
                )}
                {c.kind === 'order' && (c.column === 'new' || c.column === 'production') && c.taskGid !== null && (
                  <Button key={`pack-${c.id}`} label="→ Packing" onPress={() => void moveCard($, c, 'packing')} />
                )}
                {c.kind === 'order' && c.isPickup && c.column !== 'pickup' && c.column !== 'shipped' && c.taskGid !== null && (
                  <Button key={`ready-${c.id}`} label="→ Ready for pickup" onPress={() => void moveCard($, c, 'pickup')} />
                )}
                {c.kind === 'order' && c.taskGid !== null && c.column !== 'claims' && (
                  <Button key={`claim-${c.id}`} label="→ Claims" onPress={() => void moveCard($, c, 'claims')} />
                )}
              </Box>
            </Box>
          ))}
        </Box>

        <Box gap={1}>
          <Button key="prev" label="‹ Prev" onPress={() => void setPage($, Math.max(0, page - 1))} />
          <Text dimColor>{`${page + 1}/${pages}`}</Text>
          <Button key="next" label="Next ›" onPress={() => void setPage($, Math.min(pages - 1, page + 1))} />
          <Button key="sync" label={b.busy !== null ? 'Busy…' : 'Sync now'} onPress={() => void sync($, false)} />
          <Button key="auto" label={b.isAutoSync ? 'Auto-sync: on' : 'Auto-sync: off'} onPress={() => void setAutoSync($, !b.isAutoSync)} />
        </Box>

        {b.pendingUpdates.length > 0 && (
          <Box flexDirection="column" marginTop={1} borderStyle="round" paddingX={1}>
            <Text bold>{`${b.pendingUpdates.length} Asana update${b.pendingUpdates.length === 1 ? '' : 's'} waiting`}</Text>
            {b.pendingUpdates.slice(0, 2).map((p, i) => (
              <Text key={`pend-${i}`} dimColor wrap="truncate-end">
                {p}
              </Text>
            ))}
            <Button key="apply" label="Apply" variant="primary" onPress={() => void applyPlan($)} />
          </Box>
        )}

        {b.activity.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text dimColor bold>
              Recent
            </Text>
            {b.activity.slice(0, 4).map((a, i) => (
              <Text key={`act-${i}`} dimColor wrap="truncate-end">
                {`${ago(now - a.at)} · ${a.text}`}
              </Text>
            ))}
          </Box>
        )}
      </Box>
    )
  })
}
