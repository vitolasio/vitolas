# Handoff: Calimia Home Claude Code mods

Start a local session in `~/vitolas` and say: "Read HANDOFF.md and continue."

## What is built (branch `claude/calimia-home-first-mods-v7803p`)

| Piece | Where | State |
| --- | --- | --- |
| **SEO Desk** mod (`/seo`) | `mods/calimia-seo-desk/` | Running on Gustaf's Mac. First scan done: score 93, 1,072 images without alt, 606 meta issues, 197 bad file names, 28 new products (Maison Poire batch first). No fixes applied yet. |
| **Order Desk** mod (`/orders`, `/order #1234`) | `mods/calimia-order-desk/` | Built, 24 tests pass, dry-run checked against live data. **Not yet run in Claude Code.** |
| **Nightly order tasks** cloud Routine | claude.ai/code → Routines, `trig_014GEM4t4uueBSmdoiqcKYxz` | Midnight ET, fresh session each run. Creates only missing tasks; never moves tasks. **Not working yet: no connectors** (see item 1). Prompt in `mods/calimia-order-desk/routines/nightly-orders.md`. |

Each mod's README has the full design: `mods/calimia-seo-desk/README.md`, `mods/calimia-order-desk/README.md`.

Run both mods:
```bash
claude --plugin-dir ~/vitolas/mods/calimia-seo-desk --plugin-dir ~/vitolas/mods/calimia-order-desk
```
Develop: in a mod folder, `claude plugin validate .` and `claude plugin test .`.

## Open items, in order

1. **Give the cloud Routine its connectors.** The test run on 7 Oct (~10:55 am ET) stopped
   safely without touching anything: Shopify and Asana are connected on the account but
   switched off for the Routine's sessions. Routines created through the API can't carry
   connectors in this organization, so either turn Shopify and Asana on in the Routine's edit
   page (claude.ai/code → Routines → Calimia nightly order tasks → connectors) or create the
   Routine there from the prompt in `mods/calimia-order-desk/routines/nightly-orders.md`
   (daily, midnight America/New_York, new session each run) and delete
   `trig_014GEM4t4uueBSmdoiqcKYxz`. Then fire it once and check for the "Test run" comment on
   the Asana task "Notes".
2. **Turn off the old desktop nightly agent** (a scheduled task in the Claude desktop app) once
   the Routine works, so two agents do not write to the board at midnight.
3. **First Order Desk run:** `/orders auto off`, `/orders`, read the waiting Asana updates
   (expected: create #2368, #2366, #2332 unless the Routine already did; move #2285 and #2278 to
   Delivered), **Apply**, then `/orders auto on`.
4. **First SEO Desk pass:** `/seo` → New → Meta: this page → Review all → Apply; then Files and
   Alt: first 5. House title format is `Product | Vendor | Calimia Home` (not yet confirmed by Gustaf).
5. Optional: add a **Quotes** section to Shopify Web Orders (sent invoices then get tasks).
6. Optional: remove the old wildcard rule in `~/.claude/settings.local.json` (Meta pixel grep)
   that Claude Code warns about at startup.

## Facts the next session needs

- Shopify store: Calimia Home (calimiahome.com), admin handle `1ba31e-2`, ~1,920 products,
  connector `claude.ai Shopify`. Asana connector `claude.ai Asana`, Gmail `claude.ai Gmail`.
- Asana project **Shopify Web Orders** `1215125736009076`. Sections: New Orders `1215125836109427`,
  In Production `1216258646432130`, Processing / Packing `1215125736210930`, Shipped
  `1215126316646673`, Ready for In-Store Pick-up `1217608898902272`, Delivered `1215125646696910`,
  Claims + CSIs `1215240515557175`, Archived `1215126316646674`. "Notes" task `1217608898902273`.
  Team: gustaf@, nina@, lauren@calimiahome.com. Separate project Showroom Order Fulfillment
  `1207448416388323` is not synced.
- Workflow facts learned from the data: the team fulfills **pickup** orders in Shopify when they
  are ready (not when collected); $0 "Calimia Home" shipping means pickup; POS sales are
  fulfilled at the register with no shipping line.
- One Shopify MCP result must stay under ~25k tokens: page products at 15, orders at 10.
- Mod rules (validator): functions taking `$` must be declared at the top level of the hooks
  module (never across an import); op-event test stubs answer `{ value }`.
- Other ideas discussed, not built: Shopify Safe-Write Guard, Meta Ads Budget Guard, Store
  Pulse status line, Catalog Health pane, and five Studio Designer team mods (Client Email
  Guard first).
