// Pure order logic for Calimia Home: parsing Shopify and Asana answers, each order's
// stage and flags, and the Asana updates a sync makes. No `$`, no I/O.

type Json = Record<string, any>

export type Line = { title: string; qty: number; vendor: string; list: number; paid: number }

export type Tracking = { number: string; company: string; url: string }

export type Order = {
  id: string
  name: string
  createdAt: string
  source: string
  financial: string
  fulfillment: string
  isCancelled: boolean
  total: number
  customer: string
  email: string
  city: string
  shipTitle: string
  hasAddress: boolean
  lines: Line[]
  tracking: Tracking | null
  shippedAt: string | null
  deliveredAt: string | null
}

export type Draft = {
  id: string
  name: string
  status: string
  createdAt: string
  updatedAt: string
  invoiceSentAt: string | null
  invoiceUrl: string
  total: number
  customer: string
  email: string
  tags: string[]
  note: string
  orderName: string | null
}

export type Task = {
  gid: string
  name: string
  section: SectionKey | null
  sectionName: string
  isCompleted: boolean
  assignee: string
  dueOn: string | null
  modifiedAt: string
  url: string
}

export type SectionKey = 'quotes' | 'new' | 'production' | 'packing' | 'shipped' | 'pickup' | 'delivered' | 'claims' | 'archived'

/** Section names in Shopify Web Orders, matched loosely so a rename keeps working. */
const SECTION_PATTERNS: [SectionKey, RegExp][] = [
  ['quotes', /quote/i],
  ['new', /^new/i],
  ['production', /production/i],
  ['packing', /pack|processing/i],
  ['shipped', /^shipped/i],
  ['pickup', /pick-?\s?up/i],
  ['delivered', /deliver/i],
  ['claims', /claim|csi/i],
  ['archived', /archiv/i],
]

export function sectionKeyOf(name: string): SectionKey | null {
  return SECTION_PATTERNS.find(([, re]) => re.test(name))?.[0] ?? null
}

export type Sections = Partial<Record<SectionKey, string>>

export function sectionsFrom(list: readonly { gid: string; name: string }[]): Sections {
  const out: Sections = {}
  for (const s of list) {
    const key = sectionKeyOf(s.name)
    if (key !== null && out[key] === undefined) out[key] = s.gid
  }
  return out
}

const num = (gid: string): string => gid.slice(gid.lastIndexOf('/') + 1)
const money = (m: Json | undefined): number => Number(m?.shopMoney?.amount ?? 0)

export function orderFrom(node: Json): Order {
  const f = (node.fulfillments ?? []) as Json[]
  const withTracking = f.find(x => (x.trackingInfo ?? []).length > 0)
  const t = withTracking?.trackingInfo?.[0]
  const delivered = f.find(x => x.deliveredAt || x.displayStatus === 'DELIVERED')
  return {
    id: num(node.id),
    name: node.name ?? '',
    createdAt: node.createdAt ?? '',
    source: node.sourceName ?? '',
    financial: node.displayFinancialStatus ?? '',
    fulfillment: node.displayFulfillmentStatus ?? '',
    isCancelled: Boolean(node.cancelledAt),
    total: money(node.totalPriceSet),
    customer: node.customer?.displayName ?? '',
    email: node.email ?? '',
    city: [node.shippingAddress?.city, node.shippingAddress?.provinceCode].filter(Boolean).join(', '),
    shipTitle: node.shippingLine?.title ?? '',
    hasAddress: Boolean(node.shippingAddress?.city),
    lines: (node.lineItems?.nodes ?? []).map((l: Json) => ({
      title: l.title ?? '',
      qty: Number(l.quantity ?? 0),
      vendor: l.vendor ?? '',
      list: money(l.originalTotalSet),
      paid: money(l.discountedTotalSet),
    })),
    tracking: t ? { number: t.number ?? '', company: t.company ?? '', url: t.url ?? '' } : null,
    shippedAt: f[0]?.createdAt ?? null,
    deliveredAt: delivered ? (delivered.deliveredAt ?? delivered.createdAt ?? null) : null,
  }
}

export function draftFrom(node: Json): Draft {
  return {
    id: num(node.id),
    name: node.name ?? '',
    status: node.status ?? '',
    createdAt: node.createdAt ?? '',
    updatedAt: node.updatedAt ?? '',
    invoiceSentAt: node.invoiceSentAt ?? null,
    invoiceUrl: node.invoiceUrl ?? '',
    total: money(node.totalPriceSet),
    customer: node.customer?.displayName ?? '',
    email: node.email ?? '',
    tags: node.tags ?? [],
    note: node.note2 ?? '',
    orderName: node.order?.name ?? null,
  }
}

export function taskFrom(node: Json, projectGid: string): Task {
  const memberships = (node.memberships ?? []) as Json[]
  const m = memberships.find(x => x.project?.gid === projectGid) ?? memberships.find(x => x.section)
  const sectionName = m?.section?.name ?? ''
  return {
    gid: String(node.gid ?? ''),
    name: node.name ?? '',
    section: sectionKeyOf(sectionName),
    sectionName,
    isCompleted: Boolean(node.completed),
    assignee: node.assignee?.email ?? node.assignee?.name ?? '',
    dueOn: node.due_on ?? null,
    modifiedAt: node.modified_at ?? '',
    url: node.permalink_url ?? `https://app.asana.com/0/0/${node.gid}/f`,
  }
}

/** "#2207" in "Order #2207 — Eric Leffler ($435.00)"; draft tasks name "#D384". */
export function orderNameIn(taskName: string): string | null {
  const m = taskName.match(/#(\d{3,7})\b/)
  return m ? `#${m[1]}` : null
}

export function draftNameIn(taskName: string): string | null {
  const m = taskName.match(/#D(\d{1,7})\b/i)
  return m ? `#D${m[1]}` : null
}

// ── time ───────────────────────────────────────────────────────────────────────

const DAY = 24 * 3600 * 1000

export function daysBetween(from: string | number, to: number): number {
  const start = typeof from === 'number' ? from : Date.parse(from)
  return Number.isNaN(start) ? 0 : Math.floor((to - start) / DAY)
}

/** Weekdays from `from` to `to`, not counting the start day. */
export function businessDaysBetween(from: string, to: number): number {
  const start = Date.parse(from)
  if (Number.isNaN(start) || to <= start) return 0
  let count = 0
  const d = new Date(start)
  d.setUTCHours(12, 0, 0, 0)
  for (;;) {
    d.setUTCDate(d.getUTCDate() + 1)
    if (d.getTime() > to) break
    const wd = d.getUTCDay()
    if (wd !== 0 && wd !== 6) count += 1
  }
  return count
}

export function addBusinessDays(from: string, n: number): string {
  const d = new Date(Date.parse(from))
  let left = n
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1)
    const wd = d.getUTCDay()
    if (wd !== 0 && wd !== 6) left -= 1
  }
  return d.toISOString().slice(0, 10)
}

// ── stage and flags ────────────────────────────────────────────────────────────

export type Rules = {
  shipSlaDays: number
  productionSlaDays: number
  invoiceReminderDays: number
  quoteStaleDays: number
  pickupReminderDays: number
  shippedCheckDays: number
  pickupPattern: RegExp
}

export const DEFAULT_RULES: Rules = {
  shipSlaDays: 3,
  productionSlaDays: 30,
  invoiceReminderDays: 3,
  quoteStaleDays: 7,
  pickupReminderDays: 7,
  shippedCheckDays: 10,
  pickupPattern: /pick ?-?up|in[- ]store|^calimia home$/i,
}

export type Stage = 'new' | 'production' | 'packing' | 'shipped' | 'pickup' | 'delivered' | 'claims' | 'closed'

const PAID = /^(PAID|PARTIALLY_PAID|PARTIALLY_REFUNDED|AUTHORIZED)$/

export const isPaid = (o: Order): boolean => PAID.test(o.financial)
export const isPickup = (o: Order, rules: Rules): boolean => rules.pickupPattern.test(o.shipTitle.trim())
const isDead = (o: Order): boolean => o.isCancelled || o.financial === 'REFUNDED' || o.financial === 'VOIDED'
const isFulfilled = (o: Order): boolean => o.fulfillment === 'FULFILLED'

/** Fulfilled with no carrier and no shipping line: handed over in the store (most POS sales). */
export const isHandedOver = (o: Order): boolean => isFulfilled(o) && o.tracking === null && o.shipTitle.trim() === ''

export function stageOf(o: Order, task: Task | undefined, rules: Rules): Stage {
  if (task?.section === 'claims') return 'claims'
  if (task?.section === 'archived') return 'closed'
  if (isDead(o)) return 'closed'
  if (task?.section === 'delivered' || o.deliveredAt !== null || isHandedOver(o)) return 'delivered'
  if (isPickup(o, rules)) {
    // The team fulfills pickup orders in Shopify when they are ready, not when collected:
    // a fulfilled pickup order waits in Ready for Pick-up until someone moves it on.
    if (task?.section === 'pickup' || isFulfilled(o)) return 'pickup'
  } else if (isFulfilled(o) || (o.fulfillment === 'PARTIALLY_FULFILLED' && o.tracking !== null)) {
    return 'shipped'
  }
  if (task?.section === 'production') return 'production'
  if (task?.section === 'packing') return 'packing'
  if (task?.section === 'shipped') return 'shipped'
  return 'new'
}

export type Flag =
  | 'late'
  | 'production-long'
  | 'no-address'
  | 'free-line'
  | 'check-tracking'
  | 'pickup-waiting'
  | 'cleanup'
  | 'no-task'
  | 'invoice-unpaid'
  | 'quote-unsent'
  | 'quote-duplicate'

export const FLAG_LABEL: Record<Flag, string> = {
  late: 'late',
  'production-long': 'long in production',
  'no-address': 'no shipping address',
  'free-line': '100% discounted line',
  'check-tracking': 'not delivered yet',
  'pickup-waiting': 'pickup waiting',
  cleanup: 'refunded/cancelled but open',
  'no-task': 'no Asana task',
  'invoice-unpaid': 'invoice unpaid',
  'quote-unsent': 'quote never sent',
  'quote-duplicate': 'customer has another open quote',
}

export function orderFlags(o: Order, task: Task | undefined, stage: Stage, now: number, rules: Rules): Flag[] {
  const out: Flag[] = []
  const open = stage === 'new' || stage === 'packing'
  if (stage === 'closed') {
    if (!isFulfilled(o) && task !== undefined && task.section !== 'archived' && !task.isCompleted) out.push('cleanup')
    return out
  }
  // Pickup orders wait for the customer, often on an agreed date, so they are never late to ship.
  if (open && !isPickup(o, rules) && businessDaysBetween(o.createdAt, now) > rules.shipSlaDays) out.push('late')
  if (stage === 'production' && daysBetween(o.createdAt, now) > rules.productionSlaDays) out.push('production-long')
  if ((open || stage === 'production') && !o.hasAddress && !isPickup(o, rules)) out.push('no-address')
  if (stage !== 'shipped' && o.lines.some(l => l.list > 0 && l.paid === 0)) out.push('free-line')
  if (stage === 'shipped' && o.shippedAt !== null && daysBetween(o.shippedAt, now) > rules.shippedCheckDays && o.tracking !== null) {
    out.push('check-tracking')
  }
  if (stage === 'pickup' && task !== undefined && daysBetween(task.modifiedAt, now) > rules.pickupReminderDays) out.push('pickup-waiting')
  if (task === undefined && stage !== 'delivered' && isPaid(o)) out.push('no-task')
  return out
}

export function draftFlags(d: Draft, drafts: readonly Draft[], now: number, rules: Rules): Flag[] {
  const out: Flag[] = []
  if (d.status === 'INVOICE_SENT' && d.invoiceSentAt !== null && daysBetween(d.invoiceSentAt, now) >= rules.invoiceReminderDays) {
    out.push('invoice-unpaid')
  }
  if (d.status === 'OPEN' && daysBetween(d.createdAt, now) >= rules.quoteStaleDays) out.push('quote-unsent')
  const who = (d.email || d.customer).toLowerCase()
  if (who !== '' && drafts.some(x => x.id !== d.id && x.status !== 'COMPLETED' && (x.email || x.customer).toLowerCase() === who)) {
    out.push('quote-duplicate')
  }
  return out
}

// ── the sync plan: Shopify drives Asana ───────────────────────────────────────

export type Action =
  | { kind: 'create'; name: string; section: SectionKey; notes: string; dueOn: string; reason: string; key: string }
  | { kind: 'move'; task: Task; section: SectionKey; comment: string; reason: string; key: string }
  | { kind: 'rename'; task: Task; name: string; section: SectionKey; comment: string; reason: string; key: string }
  | { kind: 'complete'; task: Task; reason: string; key: string }

export type PlanOptions = {
  rules: Rules
  sections: Sections
  createTasks: boolean
  lookbackDays: number
  completeDeliveredAfterDays: number
}

export function fmtMoney(n: number): string {
  const [whole, cents] = n.toFixed(2).split('.')
  return `$${(whole ?? '0').replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${cents}`
}

export const orderTaskName = (o: Order): string => `Order ${o.name} — ${o.customer || o.email || 'Guest'} (${fmtMoney(o.total)})`
export const quoteTaskName = (d: Draft): string => `Quote ${d.name} — ${d.customer || d.email || 'Customer'} (${fmtMoney(d.total)})`

export function orderNotes(o: Order, adminUrl: string, rules: Rules): string {
  const lines = o.lines.map(l => {
    const price = l.list > 0 && l.paid === 0 ? `${fmtMoney(0)} (list ${fmtMoney(l.list)}) ⚠️` : fmtMoney(l.paid)
    return `• ${l.qty} x ${l.title}${l.vendor ? ` — ${l.vendor}` : ''} → ${price}`
  })
  const ship = isPickup(o, rules) ? `In-store pickup (${o.shipTitle})` : o.hasAddress ? `${o.shipTitle || 'Shipping'} to ${o.city}` : '⚠️ No shipping address on the order'
  return [
    `Order ${o.name} · ${o.financial} · ${o.fulfillment}`,
    `Placed: ${o.createdAt.slice(0, 10)} · Source: ${o.source || '—'}`,
    `Customer: ${o.customer || '—'} <${o.email || '—'}>`,
    `Delivery: ${ship}`,
    '',
    ...lines,
    '',
    `Total: ${fmtMoney(o.total)}`,
    `Shopify: ${adminUrl}`,
    '',
    'Created by the Calimia Order Desk. It moves this task to Shipped and Delivered from Shopify on its own; move it to In Production, Packing, Ready for Pick-up or Claims yourself.',
  ].join('\n')
}

export function quoteNotes(d: Draft, adminUrl: string): string {
  return [
    `Draft order ${d.name} · ${d.status === 'INVOICE_SENT' ? `invoice sent ${d.invoiceSentAt?.slice(0, 10) ?? ''}` : 'not sent'}`,
    `Customer: ${d.customer || '—'} <${d.email || '—'}>`,
    `Total: ${fmtMoney(d.total)}`,
    d.tags.length ? `Tags: ${d.tags.join(', ')}` : '',
    d.note ? `Note: ${d.note}` : '',
    d.invoiceUrl ? `Checkout link: ${d.invoiceUrl}` : '',
    `Shopify: ${adminUrl}`,
    '',
    'Created by the Calimia Order Desk. When the customer pays, this task becomes the order task and moves to New Orders.',
  ]
    .filter(Boolean)
    .join('\n')
}

function trackingLine(o: Order): string {
  return o.tracking ? `${o.tracking.company || 'Carrier'} ${o.tracking.number}${o.tracking.url ? ` — ${o.tracking.url}` : ''}` : 'no tracking number (local delivery?)'
}

/**
 * What a sync does in Asana, given Shopify's orders and drafts and the project's tasks.
 * Each action changes the state that called for it, so the next sync finds nothing to repeat.
 */
export function planSync(
  orders: readonly Order[],
  drafts: readonly Draft[],
  tasks: readonly Task[],
  now: number,
  opts: PlanOptions,
  adminUrl: (kind: 'orders' | 'draft_orders', id: string) => string,
): Action[] {
  const { rules, sections } = opts
  const actions: Action[] = []
  const open = tasks.filter(t => !t.isCompleted)
  const taskOfOrder = new Map<string, Task>()
  const taskOfDraft = new Map<string, Task>()
  for (const t of tasks) {
    const o = orderNameIn(t.name)
    const d = draftNameIn(t.name)
    if (o !== null && !taskOfOrder.has(o)) taskOfOrder.set(o, t)
    if (d !== null && !taskOfDraft.has(d)) taskOfDraft.set(d, t)
  }
  const has = (key: SectionKey): boolean => sections[key] !== undefined

  // Paid quotes: the quote's task becomes the order's task.
  for (const d of drafts) {
    if (d.status !== 'COMPLETED' || d.orderName === null) continue
    const t = taskOfDraft.get(d.name)
    if (t === undefined || t.isCompleted || taskOfOrder.has(d.orderName) || t.section !== 'quotes' || !has('new')) continue
    const order = orders.find(o => o.name === d.orderName)
    const name = order ? orderTaskName(order) : `Order ${d.orderName} — ${d.customer} (${fmtMoney(d.total)}) [${d.name}]`
    actions.push({
      kind: 'rename',
      task: t,
      name: `${name.replace(/\s*\[#D\d+\]$/, '')} [${d.name}]`,
      section: 'new',
      comment: `Paid: draft ${d.name} became order ${d.orderName}.`,
      reason: `${d.name} paid → ${d.orderName}`,
      key: `rename:${t.gid}`,
    })
    taskOfOrder.set(d.orderName, t)
  }

  // Sent quotes get a task in Quotes, when the project has that section.
  if (opts.createTasks && has('quotes')) {
    for (const d of drafts) {
      if (d.status !== 'INVOICE_SENT' || taskOfDraft.has(d.name)) continue
      actions.push({
        kind: 'create',
        name: quoteTaskName(d),
        section: 'quotes',
        notes: quoteNotes(d, adminUrl('draft_orders', d.id)),
        dueOn: addBusinessDays(d.invoiceSentAt ?? d.createdAt, rules.invoiceReminderDays),
        reason: `quote ${d.name} sent`,
        key: `create:${d.name}`,
      })
    }
  }

  for (const o of orders) {
    const t = taskOfOrder.get(o.name)
    const stage = stageOf(o, t, rules)

    if (t === undefined) {
      const isRecent = daysBetween(o.createdAt, now) <= opts.lookbackDays
      if (opts.createTasks && has('new') && isRecent && isPaid(o) && !isFulfilled(o) && !isDead(o)) {
        actions.push({
          kind: 'create',
          name: orderTaskName(o),
          section: 'new',
          notes: orderNotes(o, adminUrl('orders', o.id), rules),
          dueOn: addBusinessDays(o.createdAt, rules.shipSlaDays),
          reason: `new order ${o.name}`,
          key: `create:${o.name}`,
        })
      }
      continue
    }
    if (t.isCompleted || t.section === 'claims') continue

    const before = t.section
    if (stage === 'shipped' && (before === 'new' || before === 'production' || before === 'packing' || before === 'quotes' || before === null) && has('shipped')) {
      actions.push({ kind: 'move', task: t, section: 'shipped', comment: `Shipped in Shopify: ${trackingLine(o)}.`, reason: `${o.name} shipped`, key: `move:${t.gid}` })
    } else if (stage === 'pickup' && isFulfilled(o) && (before === 'new' || before === 'production' || before === 'packing' || before === null) && has('pickup')) {
      actions.push({ kind: 'move', task: t, section: 'pickup', comment: 'Fulfilled in Shopify as an in-store pickup: ready for the customer.', reason: `${o.name} ready for pickup`, key: `move:${t.gid}` })
    } else if (stage === 'delivered' && before !== 'delivered' && before !== 'archived' && has('delivered')) {
      const comment = o.deliveredAt !== null ? `Delivered, per the carrier (${o.deliveredAt.slice(0, 10)}).` : 'Fulfilled in Shopify with no carrier: handed over in the store.'
      actions.push({ kind: 'move', task: t, section: 'delivered', comment, reason: `${o.name} delivered`, key: `move:${t.gid}` })
    } else if (stage === 'closed' && !isFulfilled(o) && before !== 'archived' && has('archived')) {
      actions.push({ kind: 'move', task: t, section: 'archived', comment: `Order is ${o.isCancelled ? 'cancelled' : o.financial.toLowerCase()} in Shopify; archived.`, reason: `${o.name} closed`, key: `move:${t.gid}` })
    } else if (
      stage === 'delivered' &&
      before === 'delivered' &&
      opts.completeDeliveredAfterDays > 0 &&
      o.deliveredAt !== null &&
      daysBetween(o.deliveredAt, now) >= opts.completeDeliveredAfterDays
    ) {
      actions.push({ kind: 'complete', task: t, reason: `${o.name} delivered ${opts.completeDeliveredAfterDays}+ days ago`, key: `complete:${t.gid}` })
    }
  }

  return actions.filter((a, i) => actions.findIndex(b => b.key === a.key) === i && (a.kind === 'create' || open.includes(a.task)))
}

// ── customer emails, always drafted for review ──────────────────────────────────

export type Email = { to: string; subject: string; body: string }

export function invoiceReminder(d: Draft): Email {
  const first = d.customer.split(' ')[0] || 'there'
  return {
    to: d.email,
    subject: `Your Calimia Home order ${d.name}`,
    body: [
      `Hi ${first},`,
      '',
      `Just following up on your Calimia Home order (${d.name}, ${fmtMoney(d.total)}). You can review and pay securely here:`,
      d.invoiceUrl,
      '',
      'Let us know if you have any questions or would like to make changes.',
      '',
      'Warmly,',
      'Calimia Home',
    ].join('\n'),
  }
}

export function pickupReminder(o: Order): Email {
  const first = o.customer.split(' ')[0] || 'there'
  return {
    to: o.email,
    subject: `Your Calimia Home order ${o.name} is ready for pickup`,
    body: [
      `Hi ${first},`,
      '',
      `Your order ${o.name} is ready and waiting for you at Calimia Home in Coral Gables. Reply to this email to let us know when you plan to stop by, or if you would prefer delivery.`,
      '',
      'Warmly,',
      'Calimia Home',
    ].join('\n'),
  }
}

export function addressRequest(o: Order): Email {
  const first = o.customer.split(' ')[0] || 'there'
  return {
    to: o.email,
    subject: `Delivery details for your Calimia Home order ${o.name}`,
    body: [
      `Hi ${first},`,
      '',
      `Thank you for your order ${o.name}! We do not have a delivery address on file for it. Could you reply with the address you would like it shipped to, or let us know if you will pick it up at our Coral Gables store?`,
      '',
      'Warmly,',
      'Calimia Home',
    ].join('\n'),
  }
}
