export type DeskColumn = 'issues' | 'quotes' | 'new' | 'production' | 'packing' | 'shipped' | 'pickup' | 'claims'

export type DeskCard = {
  kind: 'order' | 'quote'
  /** Numeric Shopify id. */
  id: string
  /** #2282 or #D384. */
  name: string
  customer: string
  email: string
  total: number
  ageDays: number
  column: Exclude<DeskColumn, 'issues'>
  /** Readable flags, worst first. */
  flags: string[]
  /** 0 fine, 1 watch, 2 act now. */
  severity: number
  detail: string
  taskGid: string | null
  taskUrl: string | null
  isPickup: boolean
  canInvoiceEmail: boolean
  canPickupEmail: boolean
  canAddressEmail: boolean
}

export type DeskActivity = { at: number; text: string }

export type DeskBoard = {
  syncedAt: number | null
  busy: string | null
  error: string | null
  isAutoSync: boolean
  cards: DeskCard[]
  toShip: number
  late: number
  pickups: number
  quotesTotal: number
  quotesUnpaid: number
  pendingUpdates: string[]
  activity: DeskActivity[]
}

export type DeskUi = { column: DeskColumn; page: number }

export type DeskAlert = { count: number; names: string[] }

declare module 'claude-code' {
  interface PluginState {
    'calimia-order-desk': {
      board: DeskBoard
      ui: DeskUi
      alert: DeskAlert | null
    }
  }
}
