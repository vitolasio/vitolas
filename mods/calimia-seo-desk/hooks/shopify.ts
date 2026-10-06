// Shopify Admin GraphQL: the operations and the parsing of their answers. Pure; the
// hooks module makes the calls through the session's Shopify MCP server.

import { fileOf, fitDescription, HOUSE_RULES, type Item } from './rules'

type Json = Record<string, any>

const GID = {
  product: 'gid://shopify/Product/',
  collection: 'gid://shopify/Collection/',
  image: 'gid://shopify/MediaImage/',
}

export function gidOf(kind: keyof typeof GID, id: string): string {
  return GID[kind] + id
}

export function numOf(gid: string): string {
  return gid.slice(gid.lastIndexOf('/') + 1)
}

export const PRODUCTS = `query Scan($first: Int!, $after: String, $query: String) {
  products(first: $first, after: $after, query: $query, sortKey: UPDATED_AT, reverse: true) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id title handle vendor status createdAt updatedAt
      seo { title description }
      media(first: 12) { nodes { id mediaContentType alt ... on MediaImage { image { url } } } }
    }
  }
}`

export const COLLECTIONS = `query Cols($first: Int!, $after: String) {
  collections(first: $first, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes { id title handle updatedAt seo { title description } image { altText url } }
  }
}`

export const PRODUCT_DETAIL = `query P($id: ID!) { product(id: $id) { description(truncateAt: 800) productType tags
  media(first: 20) { nodes { id mediaContentType alt ... on MediaImage { image { url } } } } } }`

export const COLLECTION_DETAIL = `query C($id: ID!) { collection(id: $id) { description(truncateAt: 800) image { url altText } } }`

export const PRODUCT_SEO = `mutation SeoProduct($product: ProductUpdateInput!) { productUpdate(product: $product) { product { id } userErrors { field message } } }`

export const COLLECTION_SEO = `mutation SeoCollection($input: CollectionInput!) { collectionUpdate(input: $input) { collection { id } userErrors { field message } } }`

export const FILES = `mutation SeoFiles($files: [FileUpdateInput!]!) { fileUpdate(files: $files) { files { id } userErrors { field message code } } }`

/** The products query's filter: active and draft, optionally only those changed since `since`. */
export function productFilter(since: string | null): string {
  const statuses = '(status:active OR status:draft)'
  return since === null ? statuses : `${statuses} AND updated_at:>'${since}'`
}

/** The data of a Shopify MCP GraphQL answer; throws with Shopify's own words on an error. */
export function dataOf(tool: string, blocks: readonly { text?: string }[], isError: boolean): Json {
  const text = blocks.map(block => block.text ?? '').join('')
  if (isError) throw new Error(`Shopify ${tool}: ${text.slice(0, 300)}`)
  let json: Json
  try {
    json = JSON.parse(text)
  } catch {
    throw new Error(`Shopify ${tool} answered something other than JSON: ${text.slice(0, 200)}`)
  }
  if (Array.isArray(json.errors) && json.errors.length > 0) {
    throw new Error(`Shopify: ${json.errors.map((err: Json) => err.message).join('; ').slice(0, 300)}`)
  }
  return (json.data ?? json) as Json
}

export function productItem(node: Json): Item {
  const imgs = (node.media?.nodes ?? [])
    .filter((m: Json) => m.mediaContentType === 'IMAGE' && m.image?.url)
    .map((m: Json) => ({ id: numOf(m.id), alt: m.alt ?? '', file: fileOf(m.image.url) }))
  return {
    kind: 'product',
    id: numOf(node.id),
    title: node.title ?? '',
    handle: node.handle ?? '',
    vendor: node.vendor ?? '',
    status: node.status ?? '',
    createdAt: node.createdAt ?? '',
    updatedAt: node.updatedAt ?? '',
    seoTitle: node.seo?.title ?? null,
    seoDesc: node.seo?.description ?? null,
    imgs,
  }
}

export function collectionItem(node: Json): Item {
  const imgs = node.image?.url ? [{ id: `c${numOf(node.id)}`, alt: node.image.altText ?? '', file: fileOf(node.image.url) }] : []
  return {
    kind: 'collection',
    id: numOf(node.id),
    title: node.title ?? '',
    handle: node.handle ?? '',
    vendor: '',
    status: 'ACTIVE',
    createdAt: node.updatedAt ?? '',
    updatedAt: node.updatedAt ?? '',
    seoTitle: node.seo?.title ?? null,
    seoDesc: node.seo?.description ?? null,
    imgs,
  }
}

export type Detail = {
  description: string
  productType: string
  tags: string[]
  images: { id: string; url: string; alt: string }[]
}

export function productDetail(data: Json): Detail {
  const p = data.product ?? {}
  return {
    description: p.description ?? '',
    productType: p.productType ?? '',
    tags: p.tags ?? [],
    images: (p.media?.nodes ?? [])
      .filter((m: Json) => m.mediaContentType === 'IMAGE' && m.image?.url)
      .map((m: Json) => ({ id: numOf(m.id), url: m.image.url, alt: m.alt ?? '' })),
  }
}

export function collectionDetail(data: Json, id: string): Detail {
  const c = data.collection ?? {}
  return {
    description: c.description ?? '',
    productType: 'collection',
    tags: [],
    images: c.image?.url ? [{ id: `c${id}`, url: c.image.url, alt: c.image.altText ?? '' }] : [],
  }
}

export function userErrors(data: Json, field: string): string[] {
  return (data[field]?.userErrors ?? []).map((err: Json) => `${err.code ?? ''} ${err.message}`.trim())
}

/** The request that writes one meta description from the listing's own facts. */
export function descriptionRequest(item: Item, detail: Detail, model: string) {
  const facts = [
    `Name: ${item.title}`,
    item.vendor ? `Vendor: ${item.vendor}` : '',
    detail.productType ? `Type: ${detail.productType}` : '',
    detail.tags.length ? `Tags: ${detail.tags.slice(0, 12).join(', ')}` : '',
    `Listing text: ${detail.description.replace(/\s+/g, ' ').slice(0, 700)}`,
  ]
    .filter(Boolean)
    .join('\n')
  return {
    model,
    system:
      'You write meta descriptions for Calimia Home, a home furnishings store and design studio in Coral Gables, Florida. ' +
      'Answer with the description only: no quotes, no preamble.',
    prompt:
      `Write one meta description of 120-150 characters for this ${item.kind}. Complete sentences; ` +
      'say what it is, its vendor and its material, size or finish where the facts give them. Use only these facts; ' +
      `never invent materials or sizes.\n\n${facts}`,
    maxTokens: 200,
    effort: 'low' as const,
    timeoutMs: 30000,
  }
}

export function descriptionFrom(reply: string): string | null {
  const text = fitDescription(reply)
  return text.length > 0 ? text : null
}

/** The prompt that hands alt text to the main Claude loop, which can look at images. */
export function altPrompt(server: string, entries: { item: Item; detail: Detail }[]): string {
  const blocks = entries.map(({ item, detail }) => {
    const imgs = detail.images
      .map((img, i) => {
        const id = img.id.startsWith('c') ? '(collection image)' : gidOf('image', img.id)
        return `  ${i + 1}. ${id}\n     ${img.url}\n     current alt: ${img.alt || '(none)'}`
      })
      .join('\n')
    return `- ${item.kind} "${item.title}"${item.vendor ? ` by ${item.vendor}` : ''} (${gidOf(item.kind, item.id)})\n${imgs}`
  })
  return [
    'Calimia SEO Desk: write image alt text by LOOKING at each image.',
    '',
    'For each image below: download it into a temp folder (curl -sL "<url>&width=800" -o <file>), view it with the Read tool, and write alt text that describes what the image actually shows.',
    '',
    HOUSE_RULES,
    '',
    blocks.join('\n'),
    '',
    'Show me a table (image, current alt, new alt) and wait for my OK. Then apply with the Shopify graphql_mutation tool:',
    FILES,
    'with variables { "files": [{ "id": "<MediaImage gid>", "alt": "<new alt>" }, ...] }, 25 per call. Check collectionUpdate in the schema before setting a collection image\'s altText.',
    `(Shopify MCP server: ${server}.) Leave an alt as it is when it already describes its image well.`,
  ].join('\n')
}
