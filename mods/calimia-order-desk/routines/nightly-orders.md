# Nightly order tasks (scheduled agent)

Runs at midnight ET alongside the Order Desk: it makes sure every paid order has a
well-written task by morning, and leaves moving tasks to the Order Desk and the team.
Paste the prompt below into the scheduled task (Claude desktop app → the task → edit).

```
Calimia Home — nightly order tasks (runs at midnight ET). Works alongside the Calimia
Order Desk mod, which moves tasks between sections during the day. Your job is only to
make sure every paid order has a well-written task by morning.

1. In Shopify, list orders created in the last 3 days that are paid (or partially paid)
   and not cancelled, plus every order still unfulfilled or partially fulfilled from the
   last 30 days. Skip in-store POS sales that are already fulfilled with no shipping line.

2. In the Asana project "Shopify Web Orders" (1215125736009076), read ALL tasks,
   including completed ones from the last 45 days. An order already has a task if any
   task name contains its order number (e.g. "#2282"), including quote tasks renamed
   with "[#D384]". NEVER create a second task for an order.

3. For each order with no task, create one in the "New Orders" section:
   - Name exactly: "Order #NNNN — Customer Name ($1,234.56)"
   - Assignee: gustaf@calimiahome.com; due date: 3 business days after the order date
     (for pickup orders with an agreed date, that date)
   - Notes in the usual format: ORDER DETAILS, CUSTOMER, SHIP TO, BILL TO (flag if it
     differs), PRODUCTS (vendor, SKU, list vs paid price), PAYMENT, Shopify admin link,
     TRACKING, FULFILLMENT CHECKLIST.
   - Put any warning at the top with ⚠️: no shipping address on a shipped order, a line
     discounted 100%, billing far from shipping, pickup vs. ship unclear.

4. For orders that already have a task, do NOT move the task and do NOT rewrite its
   notes — the Order Desk moves tasks to Shipped / Ready for Pick-up / Delivered /
   Archived and people move tasks to In Production, Packing and Claims. Only add a
   comment if Shopify shows something new and important that is not already on the task
   (for example, an order was refunded or the address changed).

5. Never touch tasks in "Claims + CSIs". Never change anything in Shopify. Never email
   customers.

6. Finish with a one-line summary in the "Notes" task's comments: how many tasks you
   created, and any order you could not handle and why.
```
