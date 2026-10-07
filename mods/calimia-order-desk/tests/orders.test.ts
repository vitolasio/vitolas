import { describe, expect, test } from 'claude-code/testing'

import {
  addBusinessDays,
  businessDaysBetween,
  DEFAULT_RULES,
  draftFlags,
  orderFlags,
  orderNameIn,
  draftNameIn,
  planSync,
  sectionsFrom,
  stageOf,
  type Draft,
  type Order,
  type Task,
} from '../hooks/orders'

const NOW = Date.parse('2026-10-07T15:00:00Z') // a Wednesday
const rules = DEFAULT_RULES

const order = (over: Partial<Order>): Order => ({
  id: '1',
  name: '#2300',
  createdAt: '2026-10-06T14:00:00Z',
  source: 'web',
  financial: 'PAID',
  fulfillment: 'UNFULFILLED',
  isCancelled: false,
  total: 100,
  customer: 'Jane Doe',
  email: 'jane@example.com',
  city: 'Miami, FL',
  shipTitle: 'Shipping',
  hasAddress: true,
  lines: [{ title: 'Pillow', qty: 1, vendor: 'One Bi One', list: 100, paid: 100 }],
  tracking: null,
  shippedAt: null,
  deliveredAt: null,
  ...over,
})

const task = (over: Partial<Task>): Task => ({
  gid: 't1',
  name: 'Order #2300 — Jane Doe ($100.00)',
  section: 'new',
  sectionName: 'New Orders',
  isCompleted: false,
  assignee: 'gustaf@calimiahome.com',
  dueOn: null,
  modifiedAt: '2026-10-06T14:00:00Z',
  url: 'https://app.asana.com/0/0/t1/f',
  ...over,
})

const draft = (over: Partial<Draft>): Draft => ({
  id: '9',
  name: '#D384',
  status: 'INVOICE_SENT',
  createdAt: '2026-10-01T16:00:00Z',
  updatedAt: '2026-10-01T16:00:00Z',
  invoiceSentAt: '2026-10-01T16:22:00Z',
  invoiceUrl: 'https://calimiahome.com/invoices/abc',
  total: 4039.25,
  customer: 'Lisa Dowling',
  email: 'lisa@example.com',
  tags: [],
  note: '',
  orderName: null,
  ...over,
})

const SECTIONS = sectionsFrom([
  { gid: 's-new', name: 'New Orders' },
  { gid: 's-prod', name: 'In Production' },
  { gid: 's-pack', name: 'Processing / Packing' },
  { gid: 's-ship', name: 'Shipped' },
  { gid: 's-pick', name: 'Ready for In-Store Pick-up' },
  { gid: 's-del', name: 'Delivered' },
  { gid: 's-claim', name: 'Claims + CSIs' },
  { gid: 's-arch', name: 'Archived' },
])

const opts = { rules, sections: SECTIONS, createTasks: true, lookbackDays: 30, completeDeliveredAfterDays: 14 }
const admin = (kind: string, id: string) => `https://admin.shopify.com/store/x/${kind}/${id}`

describe('names and sections', () => {
  test('the Asana sections of Shopify Web Orders map to stages', () => {
    expect(SECTIONS).toEqual({
      new: 's-new',
      production: 's-prod',
      packing: 's-pack',
      shipped: 's-ship',
      pickup: 's-pick',
      delivered: 's-del',
      claims: 's-claim',
      archived: 's-arch',
    })
  })

  test('order and quote numbers come out of task names', () => {
    expect(orderNameIn('Order #2207 — Eric Leffler ($435.00)')).toBe('#2207')
    expect(orderNameIn('Erika Velazques - Seagrass Tumbler x6')).toBeNull()
    expect(draftNameIn('Quote #D384 — Lisa Dowling ($4,039.25)')).toBe('#D384')
  })

  test('business days skip weekends', () => {
    expect(businessDaysBetween('2026-10-02T12:00:00Z', NOW)).toBe(3) // Fri → Wed: Mon, Tue, Wed
    expect(addBusinessDays('2026-10-02T12:00:00Z', 3)).toBe('2026-10-07')
  })
})

describe('stages', () => {
  test('a pickup order fulfilled in Shopify waits in pickup, never jumps to delivered', () => {
    const o = order({ shipTitle: 'Pick-up in Store', fulfillment: 'FULFILLED' })
    expect(stageOf(o, task({ section: 'pickup', sectionName: 'Ready for In-Store Pick-up' }), rules)).toBe('pickup')
    expect(stageOf(o, task({ section: 'new' }), rules)).toBe('pickup')
    expect(stageOf(o, task({ section: 'delivered' }), rules)).toBe('delivered')
  })

  test('$0 "Calimia Home" shipping counts as pickup', () => {
    expect(stageOf(order({ shipTitle: 'Calimia Home', hasAddress: false }), undefined, rules)).toBe('new')
    expect(orderFlags(order({ shipTitle: 'Calimia Home', hasAddress: false }), undefined, 'new', NOW, rules)).not.toContain('no-address')
  })

  test('shipped with tracking, then delivered by the carrier', () => {
    const shipped = order({ fulfillment: 'FULFILLED', tracking: { number: '8780', company: 'FedEx', url: '' }, shippedAt: '2026-10-05T00:00:00Z' })
    expect(stageOf(shipped, task({}), rules)).toBe('shipped')
    expect(stageOf({ ...shipped, deliveredAt: '2026-10-07T10:00:00Z' }, task({}), rules)).toBe('delivered')
  })

  test('an in-store sale fulfilled at the register is done, not shipped', () => {
    expect(stageOf(order({ source: 'pos', fulfillment: 'FULFILLED', shipTitle: '', hasAddress: false }), undefined, rules)).toBe('delivered')
  })

  test('a local delivery a person moved to Delivered stays delivered', () => {
    expect(stageOf(order({ fulfillment: 'FULFILLED', shipTitle: 'Threshold Delivery' }), task({ section: 'delivered' }), rules)).toBe('delivered')
  })

  test('a pickup on an agreed date is never late', () => {
    const o = order({ shipTitle: 'In-store pickup only · Oct. 27, 28, or 29', createdAt: '2026-09-25T15:55:00Z' })
    expect(orderFlags(o, task({}), stageOf(o, task({}), rules), NOW, rules)).not.toContain('late')
  })

  test('claims are left alone whatever Shopify says', () => {
    expect(stageOf(order({ financial: 'REFUNDED' }), task({ section: 'claims' }), rules)).toBe('claims')
  })
})

describe('flags', () => {
  test('a paid order unshipped past 3 business days is late', () => {
    expect(orderFlags(order({ createdAt: '2026-10-01T12:00:00Z' }), task({}), 'new', NOW, rules)).toContain('late')
    expect(orderFlags(order({}), task({}), 'new', NOW, rules)).not.toContain('late')
  })

  test('no address on a shipped-to order, and a 100% discounted line', () => {
    const o = order({ hasAddress: false, lines: [{ title: 'Small Iron Bar Mirror', qty: 1, vendor: 'Four Hands', list: 749, paid: 0 }] })
    const flags = orderFlags(o, task({}), 'new', NOW, rules)
    expect(flags).toContain('no-address')
    expect(flags).toContain('free-line')
  })

  test('unpaid invoices, unsent quotes and a customer with two open quotes', () => {
    const sent = draft({})
    const unsent = draft({ id: '8', name: '#D371', status: 'OPEN', invoiceSentAt: null, createdAt: '2026-09-24T20:57:00Z' })
    const twin = draft({ id: '7', name: '#D357', status: 'OPEN', invoiceSentAt: null, createdAt: '2026-10-06T12:00:00Z' })
    expect(draftFlags(sent, [sent], NOW, rules)).toEqual(['invoice-unpaid'])
    expect(draftFlags(unsent, [unsent], NOW, rules)).toEqual(['quote-unsent'])
    expect(draftFlags(twin, [sent, twin], NOW, rules)).toEqual(['quote-duplicate'])
  })
})

describe('sync plan', () => {
  test('creates a task for a new paid order, due after the ship window', () => {
    const plan = planSync([order({ name: '#2370' })], [], [], NOW, opts, admin)
    expect(plan).toHaveLength(1)
    expect(plan[0]).toMatchObject({ kind: 'create', section: 'new', name: 'Order #2370 — Jane Doe ($100.00)', dueOn: '2026-10-09' })
  })

  test('never a second task: one for the order already exists, or the order is fulfilled, old or unpaid', () => {
    expect(planSync([order({})], [], [task({})], NOW, opts, admin)).toEqual([])
    expect(planSync([order({ fulfillment: 'FULFILLED' })], [], [], NOW, opts, admin)).toEqual([])
    expect(planSync([order({ createdAt: '2026-06-28T12:00:00Z' })], [], [], NOW, opts, admin)).toEqual([])
    expect(planSync([order({ financial: 'PENDING' })], [], [], NOW, opts, admin)).toEqual([])
  })

  test('moves to Shipped with tracking, and to Delivered when the carrier says so', () => {
    const shipped = order({ fulfillment: 'FULFILLED', tracking: { number: '877249937836', company: 'FedEx', url: 'https://fedex' } })
    const [move] = planSync([shipped], [], [task({ section: 'packing' })], NOW, opts, admin)
    expect(move).toMatchObject({ kind: 'move', section: 'shipped' })
    expect(move?.kind === 'move' && move.comment).toContain('FedEx 877249937836')

    const delivered = planSync([{ ...shipped, deliveredAt: '2026-10-06T18:00:00Z' }], [], [task({ section: 'shipped' })], NOW, opts, admin)
    expect(delivered[0]).toMatchObject({ kind: 'move', section: 'delivered' })
  })

  test('a fulfilled pickup order moves to Ready for Pick-up, and stays there', () => {
    const o = order({ shipTitle: 'In-store pick up only', fulfillment: 'FULFILLED' })
    expect(planSync([o], [], [task({ section: 'new' })], NOW, opts, admin)[0]).toMatchObject({ kind: 'move', section: 'pickup' })
    expect(planSync([o], [], [task({ section: 'pickup' })], NOW, opts, admin)).toEqual([])
  })

  test('refunded and unfulfilled with an open task: archived', () => {
    expect(planSync([order({ financial: 'REFUNDED' })], [], [task({})], NOW, opts, admin)[0]).toMatchObject({ kind: 'move', section: 'archived' })
  })

  test('delivered two weeks ago: the task is completed', () => {
    const o = order({ fulfillment: 'FULFILLED', tracking: { number: '1Z', company: 'UPS', url: '' }, deliveredAt: '2026-09-20T12:00:00Z' })
    expect(planSync([o], [], [task({ section: 'delivered' })], NOW, opts, admin)[0]).toMatchObject({ kind: 'complete' })
  })

  test('a paid quote turns its Quotes task into the order task', () => {
    const sections = { ...SECTIONS, quotes: 's-quote' }
    const paid = draft({ status: 'COMPLETED', orderName: '#2368' })
    const quoteTask = task({ gid: 'q1', name: 'Quote #D384 — Lisa Dowling ($4,039.25)', section: 'quotes', sectionName: 'Quotes' })
    const plan = planSync([order({ name: '#2368', customer: 'Lisa Dowling' })], [paid], [quoteTask], NOW, { ...opts, sections }, admin)
    expect(plan).toHaveLength(1)
    expect(plan[0]).toMatchObject({ kind: 'rename', section: 'new', name: 'Order #2368 — Lisa Dowling ($100.00) [#D384]' })
  })

  test('sent quotes get tasks only when the project has a Quotes section', () => {
    expect(planSync([], [draft({})], [], NOW, opts, admin)).toEqual([])
    const plan = planSync([], [draft({})], [], NOW, { ...opts, sections: { ...SECTIONS, quotes: 's-quote' } }, admin)
    expect(plan[0]).toMatchObject({ kind: 'create', section: 'quotes', name: 'Quote #D384 — Lisa Dowling ($4,039.25)' })
  })
})
