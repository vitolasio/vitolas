# Calimia SEO Desk

A Claude Code mod that does TinySEO's job for calimiahome.com, inside Claude Code:

| TinySEO feature | SEO Desk |
| --- | --- |
| SEO score / audit | `/seo` pane: a 0-100 score for every product and collection, worst and newest first, filters for Meta, Alt, Files and New |
| Meta titles | House format `Product \| Vendor \| Calimia Home`, parts dropped to fit 60 characters, stock notes ("— 1 Available") removed |
| Meta descriptions | Written from the listing's own facts, 70-155 characters, whole sentences (no more "…Mediterranean-inspired") |
| Image alt text | Claude **looks at each image** and describes it, covering every image, not just the first |
| Image file names | Hash, screenshot and camera names renamed to `product-handle(-n).ext` |
| Auto-optimize new products | Banner + toast when a product needs SEO; every product Claude writes is re-checked within seconds; the nightly routine catches products added in Shopify admin |
| JSON-LD | `theme/calimia-structured-data.liquid`, a one-time theme snippet (store, breadcrumbs, optional Product) |
| Image compression / speed | Not needed: Shopify's CDN already serves resized WebP/AVIF |
| 404 redirects | Shopify's own: tick "Create a URL redirect" when you change a handle |

Nothing is written to Shopify until you press **Apply** in the pane (alt text: until you
OK Claude's table). It also teaches Claude the house SEO rules, so new listings Claude
writes follow them from the start.

## Install (on your computer)

1. Get this folder: `git clone https://github.com/vitolasio/vitolas` (or pull the
   `claude/calimia-home-first-mods-v7803p` branch).
2. Load it:
   - Terminal: `claude --plugin-dir /path/to/vitolas/mods/calimia-seo-desk`
   - Desktop app or always on: add to `~/.claude/settings.json`
     ```json
     { "env": { "CLAUDE_CODE_PLUGIN_DIRS": "/path/to/vitolas/mods/calimia-seo-desk" } }
     ```
3. Check the Shopify connector's name with `/mcp`. If it is not `claude.ai Shopify`, set it
   in `/config` → calimia-seo-desk → Shopify MCP server.

The first scan starts a few seconds after the session does (about 1,900 products takes
a minute or two); after that it checks for changed products every hour and does a full
rescan weekly. The status line shows `SEO <score> · <n> no alt · <n> meta · <n> files`.

## Use

- `/seo` opens the pane. Per product: **Meta**, **Files**, **Alt**, **Open** (Shopify admin).
  Per page: **Meta: this page**, **Files: this page**, **Alt: first 5**, **Rescan**.
- Changes collect in the **waiting for your OK** box: **Review all** prints every
  before/after into the conversation, **Apply** writes them, **Discard** drops them.
- `/seo report` puts the score and the 25 worst listings in the conversation (handy for
  asking Claude about them). `/seo fix <handle>`, `/seo alt <handle>`, `/seo pending`,
  `/seo scan`.

Renaming a file changes its image URL. Product media follow automatically; an image
pasted into a description by URL must be updated by hand (the pane warns before Apply).

## Settings (`/config` → calimia-seo-desk)

`titleFormat` (`product-vendor-brand` or `product-brand`), `metaModel` (default `haiku`),
`rescanMinutes` (60), `newDays` (14), `renameFiles` (on), `houseRulesInPrompt` (on),
`shopifyServer`, `adminStore`.

## Retiring TinySEO

1. Run both for about a month; work through the pane until the **All** count is near zero.
2. Install the theme snippet on a duplicate theme, turn TinySEO's JSON-LD off, check a
   product in Google's Rich Results Test, publish.
3. Set up the nightly routine (`routines/nightly-seo.md`).
4. Uninstall TinySEO. The alt text and file names it already wrote are saved on your
   products in Shopify, so they stay.

## Develop

`claude plugin validate .` and `claude plugin test .` (16 tests: rules, plus the pane and
banner driven end to end against a stubbed Shopify on terminal and desktop).
`hooks/rules.ts` holds every rule and threshold.
