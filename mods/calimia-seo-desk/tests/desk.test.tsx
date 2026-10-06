import type { McpToolResult, ModelCompleteResult } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

// A store of two products: one with no SEO at all, one clean.
const PRODUCTS = {
  data: {
    products: {
      pageInfo: { hasNextPage: false, endCursor: null },
      nodes: [
        {
          id: 'gid://shopify/Product/101',
          title: 'Astrid Toiletry Bag, Sand: Small',
          handle: 'astrid-toiletry-bag-sand-small',
          vendor: 'Il Buco Vita',
          status: 'ACTIVE',
          createdAt: '2020-01-01T00:00:00Z',
          updatedAt: '2020-01-01T00:00:00Z',
          seo: { title: null, description: null },
          media: {
            nodes: [
              {
                id: 'gid://shopify/MediaImage/9001',
                mediaContentType: 'IMAGE',
                alt: '',
                image: { url: 'https://cdn.shopify.com/s/files/1/files/663bce5cbcd0c4374533e114b129ecefdd983eecdf985e3112b0a5d5d7ae8dc2.png?v=1' },
              },
            ],
          },
        },
        {
          id: 'gid://shopify/Product/102',
          title: 'Primrose Sand Pillow',
          handle: 'primrose-sand-pillow',
          vendor: 'Maison Venu',
          status: 'ACTIVE',
          createdAt: '2020-01-01T00:00:00Z',
          updatedAt: '2020-01-01T00:00:00Z',
          seo: {
            title: 'Primrose Sand Pillow | Maison Venu | Calimia Home',
            description: 'The Primrose Sand Pillow reimagines classic Indian floral motifs with a single silhouette bloom and contrasting trim.',
          },
          media: { nodes: [{ id: 'gid://shopify/MediaImage/9002', mediaContentType: 'IMAGE', alt: 'Primrose Sand Pillow by Maison Venu', image: { url: 'https://cdn/x/primrose-sand-pillow-8242587.png' } }] },
        },
      ],
    },
  },
}

const DETAIL = {
  data: { product: { description: 'A small zip toiletry bag in sand-colored cotton canvas.', productType: 'Bath', tags: ['bath'], media: { nodes: [] } } },
}

const textResult = (json: unknown): { value: McpToolResult } => ({ value: { content: [{ type: 'text', text: JSON.stringify(json) }], isError: false } })

const PANE_PROPS = {
  title: 'SEO Desk',
  isFocused: false,
  bodyColumns: 96,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 40 },
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`scan, prepare and apply fixes on ${surface}`, { timeoutMs: 20000 }, async ($, on) => {
    const mutations: { query: string; variables: Record<string, any> }[] = []
    mock.clock(on, { now: Date.parse('2026-10-06T12:00:00Z') })
    mock.store(on)

    on('mcp.call', async ($, e) => {
      const query = String(e.args.query ?? '')
      if (e.tool === 'graphql_mutation') {
        mutations.push({ query, variables: e.args.variables as Record<string, any> })
        return textResult({ data: { productUpdate: { userErrors: [] }, fileUpdate: { userErrors: [] } } })
      }
      if (query.includes('products(')) return textResult(PRODUCTS)
      if (query.includes('collections(')) return textResult({ data: { collections: { pageInfo: { hasNextPage: false }, nodes: [] } } })
      if (query.includes('product(id')) return textResult(DETAIL)
      return textResult({ data: {} })
    })
    const reply: ModelCompleteResult = {
      isAnswered: true,
      text: 'A small zip toiletry bag in sand cotton canvas from Il Buco Vita, sized for travel and everyday essentials.',
      usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    }
    on('model.complete', async () => ({ value: reply }))

    const pane = await $.ui.mount({
      plugin: 'calimia-seo-desk',
      surface,
      component: 'Pane',
      requestId: 'seo-desk',
      props: PANE_PROPS as never,
      viewport: { columns: 140, rows: 48, isFullscreen: true },
    })

    await pane.press({ key: 'rescan' })
    expect(await pane.find({ text: /Astrid Toiletry Bag/ })).toBeDefined()
    expect(await pane.find({ text: /Primrose/ })).toBeUndefined()

    await pane.press({ key: 'meta-product-101' })
    await pane.press({ key: 'files-product-101' })
    expect(await pane.find({ text: /3 changes waiting for your OK/ })).toBeDefined()
    expect(mutations).toHaveLength(0)

    await pane.press({ key: 'apply' })
    const seo = mutations.find(m => m.query.includes('productUpdate'))
    expect(seo?.variables.product).toEqual({
      id: 'gid://shopify/Product/101',
      seo: {
        title: 'Astrid Toiletry Bag, Sand: Small | Il Buco Vita',
        description: 'A small zip toiletry bag in sand cotton canvas from Il Buco Vita, sized for travel and everyday essentials.',
      },
    })
    const files = mutations.find(m => m.query.includes('fileUpdate'))
    expect(files?.variables.files).toEqual([{ id: 'gid://shopify/MediaImage/9001', filename: 'astrid-toiletry-bag-sand-small.png' }])
    expect(await pane.find({ text: /waiting for your OK/ })).toBeUndefined()

    await pane.unmount()
  })
}

const BAND_PROPS = { hasSurvey: false, maxRows: 6, bodyColumns: 100, scroll: { offset: 0, bodyRows: 6 }, view: {} }

for (const surface of ['terminal', 'desktop'] as const) {
  test(`a new product without SEO raises the banner until dismissed on ${surface}`, { timeoutMs: 20000 }, async ($, on) => {
    mock.clock(on, { now: Date.parse('2026-10-06T12:00:00Z') })
    mock.store(on)
    const fresh = structuredClone(PRODUCTS)
    const astrid = fresh.data.products.nodes[0]!
    astrid.createdAt = '2026-10-05T09:00:00Z'
    on('mcp.call', async ($, e) => {
      const query = String(e.args.query ?? '')
      if (query.includes('products(')) return textResult(fresh)
      return textResult({ data: { collections: { pageInfo: { hasNextPage: false }, nodes: [] } } })
    })
    // The engine's own band, which the mod's answer falls back to once dismissed.
    on('ui.render', { component: 'AbovePrompt' }, async ($, e) => {
      const { Text } = $.ui.resolve(e)
      return <Text>engine band</Text>
    })

    const pane = await $.ui.mount({ plugin: 'calimia-seo-desk', surface, component: 'Pane', requestId: 'seo-desk', props: PANE_PROPS as never })
    await pane.press({ key: 'rescan' })
    expect(await pane.find({ text: /Astrid Toiletry Bag, Sand: Small · new/ })).toBeDefined()

    const band = await $.ui.mount({ plugin: 'calimia-seo-desk', surface, component: 'AbovePrompt', props: BAND_PROPS as never })
    expect(await band.find({ text: /1 new product need SEO \(Astrid Toiletry Bag/ })).toBeDefined()
    await band.press({ key: 'seo-dismiss' })
    expect(await band.find({ text: /need SEO/ })).toBeUndefined()
    expect(await band.find({ text: 'engine band' })).toBeDefined()

    await band.unmount()
    await pane.unmount()
  })
}
