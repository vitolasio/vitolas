# Calimia Order Desk

One board inside Claude Code for every Calimia Home sale (web, POS and draft-order quotes)
from quote to delivery. It keeps the **Shopify Web Orders** Asana project in step with
Shopify all day, not just at midnight, and flags what is slipping.

## The board (`/orders`)

| Column | What is in it |
| --- | --- |
| **Issues** | Everything flagged, worst first (red = act now, yellow = watch) |
| **Quotes** | Open and sent draft orders, with their totals |
| **New** | Paid, not started |
| **Production** | Made to order / waiting on the vendor (Asana: In Production) |
| **Packing** | Being prepared (Asana: Processing / Packing) |
| **Shipped** | Fulfilled with a carrier, not yet delivered |
| **Pickup** | Pickup orders ready and waiting for the customer |
| **Claims** | Damages, returns, CSIs (Asana: Claims + CSIs) |

Each card shows the order, customer, total, age, flags, delivery and Asana section, with
buttons: **Shopify**, **Asana**, the email that fits (**Draft reminder**, **Draft pickup
email**, **Ask for address**) and moves (**→ Production**, **→ Packing**, **→ Ready for
pickup**, **→ Claims**). Below: **Sync now**, **Auto-sync on/off**, and the last updates.

Also:
- **Status line:** `Orders 6 to ship · 2 late · 3 pickup · quotes $41k (5 unpaid)`
- **Banner** when a new paid order arrives: `New order: #2372 Ana Ruiz $412.00 [Open] [Dismiss]`
- **`/order #2282`** (or `/order D384`): everything about one order or quote in the chat:
  items, delivery, tracking, flags, the Asana task, and the customer's recent Gmail threads.
- **`/orders report`**: the board as text, so you can ask Claude about it.

## The Asana workflow

Shopify is the source of truth for money and shipping; people own the work in between.

| Stage | Asana section | Who moves it there |
| --- | --- | --- |
| Quote sent | **Quotes** (optional, see below) | Order Desk, when the invoice is sent |
| Paid | **New Orders** | Order Desk creates the task (or converts the quote's task) |
| Made to order | **In Production** | You (**→ Production**) |
| Being prepared | **Processing / Packing** | You (**→ Packing**) |
| Shipped | **Shipped** | Order Desk, when Shopify has the fulfillment, with the tracking number as a comment |
| Ready for pickup | **Ready for In-Store Pick-up** | Order Desk, when a pickup order is fulfilled in Shopify; or you |
| Delivered | **Delivered** | Order Desk, when the carrier confirms delivery or the sale was handed over in store; you, for pickups and local deliveries |
| Done | completed task | Order Desk, 14 days after delivery |
| Problem | **Claims + CSIs** | You (**→ Claims**); the Order Desk never touches these |
| Cancelled / refunded | **Archived** | Order Desk |

### Automatic updates (every 15 minutes while Claude Code is open)

1. **New paid order without a task** (last 30 days, not yet fulfilled): creates
   `Order #2372 — Customer ($total)` in New Orders. The task gets the items, delivery, a
   Shopify link and **you as assignee**, due after the 3-business-day ship window.
2. **Quote paid**: the quote's task is renamed to the order and moved to New Orders, with a comment.
3. **Fulfilled with a carrier**: New / Production / Packing → **Shipped**, with a comment
   holding the carrier and tracking number.
4. **Pickup order fulfilled** (your team fulfills pickups when they are ready):
   → **Ready for In-Store Pick-up**. It stays there until you move it.
5. **Carrier says delivered**, or **fulfilled in store with no carrier**: → **Delivered**.
6. **Cancelled or fully refunded and never fulfilled**: → **Archived**.
7. **Delivered 14+ days ago** (by the carrier): task completed.

The Order Desk never moves tasks out of Claims, never changes anything in Shopify, and never
sends email. With **Auto-sync: off**, the board lists these updates and waits for **Apply**.
Every update is in **Recent** on the board and as a comment on the task.

A task belongs to an order when its name contains the order number (`#2282`, quotes
`#D384`), so tasks made by hand or by your nightly agent are matched too.

### Quotes in Asana (optional, 30 seconds)

Add a section named **Quotes** to Shopify Web Orders. From the next sync, every draft order
whose invoice is sent gets a task there, due when the reminder is due, and becomes the
order's task when it is paid. Without the section, quotes live on the board only.

## Flags

| Flag | When |
| --- | --- |
| **late** | Paid, not shipped, not in production, past 3 business days (pickups excluded) |
| **long in production** | In production more than 30 days |
| **no shipping address** | Not a pickup and no address |
| **100% discounted line** | A line given away (a replacement? check before picking) |
| **not delivered yet** | Shipped with tracking more than 10 days ago |
| **pickup waiting** | Ready for pickup for more than 7 days |
| **refunded/cancelled but open** | Its task is still open |
| **no Asana task** | Paid and open but has no task |
| **invoice unpaid** | Draft invoice sent 3+ days ago |
| **quote never sent** | Draft open 7+ days without an invoice |
| **customer has another open quote** | Two open drafts for one customer (one may replace the other) |

Pickup means a shipping line like "In-store pickup", "Pick up", or your $0 "Calimia Home".

## Customer email: drafts only

**Draft reminder** (unpaid invoice, with the checkout link), **Draft pickup email** and
**Ask for address** save a Gmail **draft** to the customer and note it on the Asana task.
You read, edit and send it from Gmail.

## Guards

While the Order Desk runs, Claude asks you first, in a dialog, before it:
marks a draft order paid or sends its invoice, cancels, closes, edits, refunds or fulfills
an order, or sends any email. Dismissing the dialog blocks it.

Claude also gets a short note about this workflow, so it moves tasks the same way you do
and never duplicates the Order Desk's updates.

## Install

```bash
cd ~/vitolas && git pull
claude --plugin-dir ~/vitolas/mods/calimia-seo-desk --plugin-dir ~/vitolas/mods/calimia-order-desk
```

Check `/mcp`: it needs `claude.ai Shopify`, `claude.ai Asana` and `claude.ai Gmail` (all
connected on your account). Then `/orders`.

## What the first sync will do

From a read-only dry run on 7 Oct 2026:
- **Create** tasks for #2368 (POS, pickup Oct 27-29), #2366 (web, $117.70) and #2332 (POS pickup, partly fulfilled).
- **Move to Delivered:** #2285 (FedEx, delivered Oct 1) and #2278 (FedEx, delivered Oct 6);
  older Shipped tasks whose carrier shows delivered move too.
- **Complete:** tasks in Delivered whose carrier delivery was 14+ days ago.
- **Flag, without touching:** #2207 (late, 100% discounted mirror), #2182 (60+ days in
  production), #2109 and #2088 (unfulfilled since June, no open task), and the six invoices
  sent 3+ days ago and still unpaid.
- #2282 and #2297 have $0 "Calimia Home" shipping and no address, so they count as pickups:
  they stay in New, never flagged late. Move them to Ready for pickup when they are ready
  (or set a real shipping line in Shopify if they ship).

To see the list before anything is written, turn **Auto-sync off** first (`/orders auto off`),
open `/orders`, read the waiting updates, then **Apply**.

## Your nightly agent

The midnight agent that creates order tasks keeps working. Add this line to its prompt so
the two never make the same task twice:

> Skip any order that already has a task in Shopify Web Orders whose name contains its order number (e.g. "#2282").

## Settings (`/config` → calimia-order-desk)

Ship window (3 business days), invoice reminder (3 days), pickup reminder (7 days), sync
every (15 min), days of orders to watch (30), complete delivered after (14 days, 0 = never),
default assignee (gustaf@calimiahome.com), create tasks, auto-sync, guards, and the
connector names, Asana project and Shopify store.

## Limits

- It runs while Claude Code is open; the nightly agent covers the rest.
- "Delivered" comes from carrier tracking in Shopify (UPS, FedEx, USPS…). Local and
  threshold deliveries without tracking stay in Shipped until you move them.
- The Showroom Order Fulfillment project is not synced; it can be added the same way.

## Develop

`claude plugin validate .` and `claude plugin test .` (24 tests: stages, flags and every
sync rule on cases from the real board, plus the board, Asana sync, Gmail draft and the
guard driven end to end against stand-in connectors on terminal and desktop).
`hooks/orders.ts` holds every rule and threshold.
