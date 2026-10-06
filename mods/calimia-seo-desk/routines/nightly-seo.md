# Nightly SEO check (scheduled routine)

The mod only runs while Claude Code is open. This routine covers the rest: products your
team adds in Shopify admin overnight or on days nobody opens Claude Code.

Create it as a Routine (claude.ai/code → Routines, or ask Claude "create a routine from
mods/calimia-seo-desk/routines/nightly-seo.md"), daily at about 6:50 am America/New_York, a
fresh session each run, with the **Shopify** and **Asana** connectors. It only reads Shopify;
it never changes a product. Fixes stay in the SEO Desk, where you approve them.

## Prompt

```
Calimia Home nightly SEO check. Read-only in Shopify: never run a mutation.

1. With the Shopify graphql_query tool, list products created or updated in the last 26 hours
   (query: "updated_at:>'<now minus 26h, ISO>' AND (status:active OR status:draft)"), with
   title, handle, vendor, status, createdAt, seo { title description } and
   media(first: 12) { nodes { alt ... on MediaImage { image { url } } } }.
2. Check each against the Calimia SEO house rules:
   - SEO title set, at most 60 characters, "Product | Vendor | Calimia Home" with "|" only,
     no stock notes like "1 Available".
   - Meta description set, 70-155 characters, ends with a full sentence.
   - Every image has alt text that is not just the product title or "image".
   - No image file named as a hash, screenshot or camera file (IMG_1234).
3. If nothing fails, stop without posting anything.
4. Otherwise create ONE Asana task with no project (so it lands in My Tasks), assigned
   to gustaf@calimiahome.com, due today, named "SEO: N products need fixes (<date>)", whose
   notes list each product (title, admin link
   https://admin.shopify.com/store/1ba31e-2/products/<numeric id>, status, what fails) and end
   with: "Open Claude Code and run /seo to review and apply fixes."
```
