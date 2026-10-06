// Pure SEO rules for Calimia Home: no `$`, no I/O, so tests run them directly.

export const BRAND = 'Calimia Home'
export const TITLE_MAX = 60
export const DESC_MIN = 70
export const DESC_MAX = 155
export const ALT_MAX = 125

export type TitleFormat = 'product-vendor-brand' | 'product-brand'

export type Img = { id: string; alt: string; file: string }

export type Item = {
  kind: 'product' | 'collection'
  id: string
  title: string
  handle: string
  vendor: string
  status: string
  createdAt: string
  updatedAt: string
  seoTitle: string | null
  seoDesc: string | null
  imgs: Img[]
}

export type IssueCode =
  | 'title-missing'
  | 'title-long'
  | 'title-sep'
  | 'title-dup'
  | 'desc-missing'
  | 'desc-long'
  | 'desc-short'
  | 'desc-cut'
  | 'desc-dup'
  | 'alt-missing'
  | 'alt-generic'
  | 'alt-long'
  | 'file-bad'

export type Issue = { code: IssueCode; count?: number }

export type Group = 'meta' | 'alt' | 'files'

export const GROUP_OF: Record<IssueCode, Group> = {
  'title-missing': 'meta',
  'title-long': 'meta',
  'title-sep': 'meta',
  'title-dup': 'meta',
  'desc-missing': 'meta',
  'desc-long': 'meta',
  'desc-short': 'meta',
  'desc-cut': 'meta',
  'desc-dup': 'meta',
  'alt-missing': 'alt',
  'alt-generic': 'alt',
  'alt-long': 'alt',
  'file-bad': 'files',
}

export const LABEL: Record<IssueCode, string> = {
  'title-missing': 'no SEO title',
  'title-long': 'title >60',
  'title-sep': 'title separator',
  'title-dup': 'duplicate title',
  'desc-missing': 'no meta description',
  'desc-long': 'meta >155',
  'desc-short': 'meta <70',
  'desc-cut': 'meta cut off',
  'desc-dup': 'duplicate meta',
  'alt-missing': 'missing alt',
  'alt-generic': 'generic alt',
  'alt-long': 'alt >125',
  'file-bad': 'bad filename',
}

/** The file name of a Shopify CDN URL, without query string. */
export function fileOf(url: string): string {
  const path = url.split('?')[0] ?? ''
  return decodeURIComponent(path.slice(path.lastIndexOf('/') + 1))
}

function stemOf(file: string): string {
  const dot = file.lastIndexOf('.')
  return dot > 0 ? file.slice(0, dot) : file
}

function extOf(file: string): string {
  const dot = file.lastIndexOf('.')
  return dot > 0 ? file.slice(dot + 1).toLowerCase() : 'jpg'
}

const BAD_FILE =
  /^([0-9a-f]{24,}|[0-9a-f-]{32,}|screen ?shot.*|(img|dsc|dscn|pxl|mvimg)[-_ ]?\d.*|(photo|image|untitled|download|unnamed)([-_ ]?\(?\d+\)?)?)$/i

/** A file name that says nothing about the product: hashes, camera and screenshot names. */
export function isBadFile(file: string): boolean {
  const stem = stemOf(file).replace(/_[0-9a-f]{8}-[0-9a-f-]{27,}$/i, '')
  return BAD_FILE.test(stem)
}

const GENERIC_ALT = /^(image|photo|picture|img|product image|product photo|untitled)\b/i

export function isGenericAlt(alt: string, title: string): boolean {
  const a = alt.trim().toLowerCase()
  return GENERIC_ALT.test(a) || a === title.trim().toLowerCase() || /\.(jpe?g|png|webp|gif)$/i.test(a)
}

/** Ends like a finished sentence (or a closing quote/paren after one). */
export function endsCleanly(text: string): boolean {
  return /[.!?…]["”')]?$/.test(text.trim())
}

/** Issues for one item; `dupTitles`/`dupDescs` are the values seen more than once. */
export function issuesOf(item: Item, dupTitles: ReadonlySet<string>, dupDescs: ReadonlySet<string>): Issue[] {
  const out: Issue[] = []
  const t = item.seoTitle?.trim() ?? ''
  const d = item.seoDesc?.trim() ?? ''

  if (t === '') out.push({ code: 'title-missing' })
  else {
    if (t.length > TITLE_MAX) out.push({ code: 'title-long' })
    // A hyphen inside a product name ("Ice Bucket - Petite") is fine; dashes used as separators are not.
    if (/ [—–] /.test(t) || (!t.includes('|') && / - .+ - /.test(t))) out.push({ code: 'title-sep' })
    if (dupTitles.has(t.toLowerCase())) out.push({ code: 'title-dup' })
  }

  if (d === '') out.push({ code: 'desc-missing' })
  else {
    if (d.length > DESC_MAX) out.push({ code: 'desc-long' })
    if (d.length < DESC_MIN) out.push({ code: 'desc-short' })
    if (d.length >= 100 && !endsCleanly(d)) out.push({ code: 'desc-cut' })
    if (dupDescs.has(d.toLowerCase())) out.push({ code: 'desc-dup' })
  }

  const missing = item.imgs.filter(img => img.alt.trim() === '').length
  const generic = item.imgs.filter(img => img.alt.trim() !== '' && isGenericAlt(img.alt, item.title)).length
  const long = item.imgs.filter(img => img.alt.length > ALT_MAX).length
  const badFiles = item.imgs.filter(img => isBadFile(img.file)).length
  if (missing > 0) out.push({ code: 'alt-missing', count: missing })
  if (generic > 0) out.push({ code: 'alt-generic', count: generic })
  if (long > 0) out.push({ code: 'alt-long', count: long })
  if (badFiles > 0) out.push({ code: 'file-bad', count: badFiles })

  return out
}

const WEIGHT: Record<IssueCode, number> = {
  'title-missing': 15,
  'title-long': 8,
  'title-sep': 3,
  'title-dup': 8,
  'desc-missing': 15,
  'desc-long': 6,
  'desc-short': 5,
  'desc-cut': 8,
  'desc-dup': 8,
  'alt-missing': 25,
  'alt-generic': 6,
  'alt-long': 3,
  'file-bad': 10,
}

/** 0-100. Image issues weigh by the share of the item's images they touch. */
export function scoreOf(item: Item, issues: readonly Issue[]): number {
  const imgs = Math.max(1, item.imgs.length)
  let score = 100
  for (const issue of issues) {
    const share = issue.count === undefined ? 1 : Math.min(1, issue.count / imgs)
    score -= WEIGHT[issue.code] * share
  }
  return Math.max(0, Math.round(score))
}

export function duplicates(values: Iterable<string | null>): Set<string> {
  const seen = new Set<string>()
  const dup = new Set<string>()
  for (const v of values) {
    const key = v?.trim().toLowerCase() ?? ''
    if (key === '') continue
    if (seen.has(key)) dup.add(key)
    seen.add(key)
  }
  return dup
}

/** Product titles carry stock notes ("— 1 Available") that do not belong in search results. */
export function cleanTitle(title: string): string {
  return title
    .replace(/\s+[—–-]\s+\d+\s+available$/i, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function cutAtWord(text: string, max: number): string {
  if (text.length <= max) return text
  const cut = text.slice(0, max + 1)
  const space = cut.lastIndexOf(' ')
  return (space > max * 0.6 ? cut.slice(0, space) : text.slice(0, max)).replace(/[\s,;:|–—-]+$/, '')
}

/** House meta title: "Product | Vendor | Calimia Home", dropping parts until it fits in 60. */
export function proposeTitle(item: Pick<Item, 'title' | 'vendor'>, format: TitleFormat): string {
  const t = cleanTitle(item.title)
  const vendor = item.vendor.trim()
  const hasVendor = vendor !== '' && vendor.toLowerCase() !== BRAND.toLowerCase() && !t.toLowerCase().includes(vendor.toLowerCase())
  const candidates =
    format === 'product-vendor-brand' && hasVendor
      ? [`${t} | ${vendor} | ${BRAND}`, `${t} | ${vendor}`, `${t} | ${BRAND}`]
      : [`${t} | ${BRAND}`]
  return candidates.find(c => c.length <= TITLE_MAX) ?? cutAtWord(t, TITLE_MAX)
}

/** Trims a model's meta description to whole sentences within 155, else to a word. */
export function fitDescription(text: string): string {
  const d = text.replace(/\s+/g, ' ').replace(/^["“']|["”']$/g, '').trim()
  if (d.length <= DESC_MAX) return d
  const sentences = d.match(/[^.!?]+[.!?]+/g) ?? []
  let out = ''
  for (const s of sentences) {
    if ((out + s).trim().length > DESC_MAX) break
    out += s
  }
  out = out.trim()
  return out.length >= DESC_MIN ? out : `${cutAtWord(d, DESC_MAX - 1)}.`
}

export function slugify(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 70)
    .replace(/-+$/, '')
}

/** New file name for image `index` of an item: handle-based, keeping the extension. */
export function proposeFilename(item: Pick<Item, 'handle'>, img: Img, index: number): string {
  const base = slugify(item.handle)
  return `${base}${index === 0 ? '' : `-${index + 1}`}.${extOf(img.file)}`
}

export function describeIssues(issues: readonly Issue[]): string {
  return issues.map(i => (i.count === undefined ? LABEL[i.code] : `${i.count} ${LABEL[i.code]}`)).join(' · ')
}

export const HOUSE_RULES = [
  'Calimia Home SEO house rules (from the calimia-seo-desk mod):',
  `- SEO title: "Product | Vendor | ${BRAND}", at most ${TITLE_MAX} characters; drop "${BRAND}", then the vendor, when it does not fit. Use "|" as the only separator. Never put stock notes like "1 Available" in it.`,
  `- Meta description: ${DESC_MIN}-${DESC_MAX} characters, complete sentences, says what it is, the vendor and the material or size; no keyword stuffing, never cut mid-word.`,
  `- Image alt text: describe what the image shows (object, color, material, setting) in at most ${ALT_MAX} characters; name the product and vendor where natural; never "image of"; every image gets one, not just the first.`,
  '- Image file names: the product handle plus a descriptor, lowercase-hyphenated (ebony-oak-cabinet-2.jpg); never hashes or camera/screenshot names.',
  '- New products are created as DRAFT and get all of the above before they are published.',
].join('\n')
