import type { McpToolResult } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const NOW = Date.parse('2026-10-07T15:00:00Z')

const node = (over: Record<string, unknown>) => ({
  id: 'gid://shopify/Order/1',
  name: '#2300',
  createdAt: '2026-10-06T14:00:00Z',
  cancelledAt: null,
  sourceName: 'web',
  email: 'jane@example.com',
  displayFinancialStatus: 'PAID',
  displayFulfillmentStatus: 'UNFULFILLED',
  totalPriceSet: { shopMoney: { amount: '100.0' } },
  customer: { displayName: 'Jane Doe' },
  shippingAddress: { city: 'Miami', provinceCode: 'FL' },
  shippingLine: { title: 'Shipping' },
  lineItems: { nodes: [{ title: 'Pillow', quantity: 1, vendor: 'One Bi One', originalTotalSet: { shopMoney: { amount: '100.0' } }, discountedTotalSet: { shopMoney: { amount: '100.0' } } }] },
  fulfillments: [],
  ...over,
})

const ORDERS = [
  // New today, no task yet: the sync creates one.
  node({ id: 'gid://shopify/Order/2370', name: '#2370', customer: { displayName: 'Ana Ruiz' }, email: 'ana@example.com' }),
  // Paid a week ago, no address, still unfulfilled: late.
  node({ id: 'gid://shopify/Order/2282', name: '#2282', createdAt: '2026-09-28T21:43:00Z', customer: { displayName: 'Abbie Richman' }, shippingAddress: null }),
  // Shipped with FedEx while its task sits in Packing: moved to Shipped.
  node({
    id: 'gid://shopify/Order/2285',
    name: '#2285',
    displayFulfillmentStatus: 'FULFILLED',
    fulfillments: [{ createdAt: '2026-10-05T12:00:00Z', displayStatus: 'IN_TRANSIT', deliveredAt: null, trackingInfo: [{ number: '878000737911', company: 'FedEx', url: 'https://fedex' }] }],
  }),
]

const DRAFTS = [
  {
    id: 'gid://shopify/DraftOrder/384',
    name: '#D384',
    status: 'INVOICE_SENT',
    createdAt: '2026-10-01T16:18:00Z',
    updatedAt: '2026-10-01T16:22:00Z',
    invoiceSentAt: '2026-10-01T16:22:00Z',
    invoiceUrl: 'https://calimiahome.com/invoices/abc',
    email: 'lisa@example.com',
    tags: [],
    note2: null,
    totalPriceSet: { shopMoney: { amount: '4039.25' } },
    customer: { displayName: 'Lisa Dowling' },
    order: null,
  },
]

const SECTIONS = [
  { gid: 's-new', name: 'New Orders' },
  { gid: 's-prod', name: 'In Production' },
  { gid: 's-pack', name: 'Processing / Packing' },
  { gid: 's-ship', name: 'Shipped' },
  { gid: 's-pick', name: 'Ready for In-Store Pick-up' },
  { gid: 's-del', name: 'Delivered' },
  { gid: 's-claim', name: 'Claims + CSIs' },
  { gid: 's-arch', name: 'Archived' },
]

const asanaTask = (gid: string, name: string, section: string) => ({
  gid,
  name,
  completed: false,
  due_on: null,
  modified_at: '2026-10-01T00:00:00Z',
  permalink_url: `https://app.asana.com/0/0/${gid}/f`,
  assignee: { email: 'gustaf@calimiahome.com' },
  memberships: [{ project: { gid: '1215125736009076' }, section: { name: section } }],
})

const json = (value: unknown): { value: McpToolResult } => ({ value: { content: [{ type: 'text', text: JSON.stringify(value) }], isError: false } })

const PANE_PROPS = { title: 'Order Desk', isFocused: false, bodyColumns: 110, placement: 'dock', scroll: { offset: 0, bodyRows: 60 } }

for (const surface of ['terminal', 'desktop'] as const) {
  test(`sync keeps Asana in step with Shopify and drafts customer email on ${surface}`, { timeoutMs: 20000 }, async ($, on) => {
    mock.clock(on, { now: NOW })
    mock.store(on)
    const calls: { server: string; tool: string; args: Record<string, any> }[] = []
    let moved = false

    on('mcp.call', async ($, e) => {
      calls.push({ server: e.server, tool: e.tool, args: e.args as Record<string, any> })
      const q = String(e.args.query ?? '')
      if (e.tool === 'graphql_query' && q.includes('orders(')) return json({ data: { orders: { pageInfo: { hasNextPage: false }, nodes: ORDERS } } })
      if (e.tool === 'graphql_query' && q.includes('draftOrders(')) return json({ data: { draftOrders: { pageInfo: { hasNextPage: false }, nodes: DRAFTS } } })
      if (e.tool === 'get_project') return json({ data: { gid: '1215125736009076', sections: SECTIONS } })
      if (e.tool === 'get_tasks') {
        return json({
          data: [
            asanaTask('t2282', 'Order #2282 — Abbie Richman ($1975.22)', 'New Orders'),
            asanaTask('t2285', 'Order #2285 — Luis Aguirre ($1660.64)', moved ? 'Shipped' : 'Processing / Packing'),
            ...(calls.some(c => c.tool === 'create_tasks') ? [asanaTask('t2370', 'Order #2370 — Ana Ruiz ($100.00)', 'New Orders')] : []),
          ],
          next_page: null,
        })
      }
      if (e.tool === 'update_tasks') {
        moved = true
        return json({ succeeded: [{ gid: 't2285' }], failed: [] })
      }
      if (e.tool === 'create_tasks') return json({ succeeded: [{ gid: 't2370' }], failed: [] })
      if (e.tool === 'add_comment') return json({ data: { gid: 'c1' } })
      if (e.tool === 'create_draft') return json({ id: 'd1' })
      return json({})
    })

    const pane = await $.ui.mount({ plugin: 'calimia-order-desk', surface, component: 'Pane', requestId: 'order-desk', props: PANE_PROPS as never })
    await pane.press({ key: 'sync' })

    const created = calls.find(c => c.tool === 'create_tasks')
    expect(created?.args.tasks).toEqual([
      expect.objectContaining({ name: 'Order #2370 — Ana Ruiz ($100.00)', section_id: 's-new', due_on: '2026-10-09', assignee: 'gustaf@calimiahome.com' }),
    ])
    const updated = calls.find(c => c.tool === 'update_tasks')
    expect(updated?.args.tasks).toEqual([{ task: 't2285', add_projects: [{ project_id: '1215125736009076', section_id: 's-ship' }] }])
    const comment = calls.find(c => c.tool === 'add_comment')
    expect(String(comment?.args.text)).toContain('FedEx 878000737911')

    // Issues: the late order with no address and the unpaid invoice.
    expect(await pane.find({ text: /no shipping address/ })).toBeDefined()
    expect(await pane.find({ text: /invoice unpaid/ })).toBeDefined()
    expect(await pane.find({ text: /moved Order #2285/ })).toBeDefined()

    await pane.press({ key: 'inv-384' })
    const draft = calls.find(c => c.tool === 'create_draft')
    expect(draft?.server).toBe('claude.ai Gmail')
    expect(draft?.args.to).toEqual(['lisa@example.com'])
    expect(String(draft?.args.body)).toContain('https://calimiahome.com/invoices/abc')
    expect(calls.some(c => c.tool === 'send_message')).toBe(false)

    await pane.unmount()
  })
}

test('marking a draft order paid is blocked unless the person allows it', { timeoutMs: 20000 }, async ($, on) => {
  mock.clock(on, { now: NOW })
  mock.store(on)
  // The person dismisses the question.
  on('tool.call', { tool: 'AskUserQuestion' }, async () => ({ deny: 'dismissed' }))
  const ran = await $.tool.call({ tool: 'mcp__claude_ai_Shopify__graphql_mutation', query: 'mutation { draftOrderComplete(id: "gid://shopify/DraftOrder/384") { draftOrder { id } } }' })
  expect(ran.deny).toContain('blocked')
})
