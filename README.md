# Shopify Slack Ops

Four n8n workflows that bring a Shopify store's day-to-day operations into Slack, so the team sees what needs
attention without living in the Shopify admin.

| Workflow | Trigger | Posts to | What it does |
|---|---|---|---|
| **Order Alerts** | `orders/create` webhook | `#orders` (+ `#ops-alerts`) | Every new order with its items and flags: high value, first order, VIP, heavy discount, international, express shipping, customer note, ship/bill country mismatch. Risky combinations also go to `#ops-alerts` to check before fulfilling. |
| **Low Stock** | Every hour | `#inventory` | Active variants at or below the threshold, sold-out first. Posts once per drop, again only on sell-out, and resets after a restock, so the channel isn't spammed every hour. |
| **Daily Digest** | Every morning | `#daily-numbers` | Yesterday's revenue, orders, average order value, refunds and top products, with the change vs the day before. "Yesterday" is the store's calendar day, DST included. |
| **Abandoned Checkouts** | Every hour | `#sales` | Checkouts worth a personal follow-up (old enough, recent enough, above a value floor, not completed, not posted before), biggest first, with a link to send Shopify's recovery email. A person decides; nothing is emailed automatically. |

## Design

- **Logic in plain JavaScript, tested.** All decisions live in `src/core.js`. `build.mjs` pastes it into the n8n Code
  nodes and generates the workflow JSON, so the workflows and the tests run the same code.
- **Shopify Admin GraphQL** through n8n's HTTP Request node with the Shopify credential, so any query is available.
  GraphQL answers HTTP 200 even when a query fails; the Code nodes check `errors` and stop instead of posting an
  empty alert. HTTP and Slack nodes retry 3 times.
- **No repeat alerts.** Low stock and abandoned checkouts remember what they already posted in n8n workflow static
  data (pruned after 7 days for checkouts).
- **Slack Block Kit** messages with buttons that open the order, product or checkout in Shopify. Customer text is
  escaped so it can't break the formatting.
- **One config file** for the shop, time zone, channels and thresholds.

## Try it without a store

```
npm test        # builds the workflows, then 21 tests: core logic + the generated Code nodes run with mocked n8n
npm run demo    # prints the Slack messages for sample data (paste the blocks into Slack's Block Kit Builder)
```

The tests cover flag rules, Slack escaping, alert de-duplication and reset, digest math (refunds, cancellations,
empty days), DST-change days, the checkout age and value window, and GraphQL error handling.

## Set up

1. In Shopify, create a custom app with Admin API scopes `read_orders`, `read_products` and `read_inventory`. If a
   query is missing a scope, Shopify answers with an access-denied error naming it, and the workflow stops with
   that message, so add the scope it names.
   Create a Slack app with `chat:write` and invite it to the channels.
2. In n8n, add a **Shopify Access Token** credential and a **Slack** credential.
3. `cp config.example.json config.json`, then set your shop, time zone, channels, thresholds and the two credential IDs.
4. `npm run build` and import `workflows/*.json` in n8n, or `N8N_API_URL=... N8N_API_KEY=... npm run deploy`.
5. Activate the workflows. The Shopify trigger registers its webhook when Order Alerts is activated.

Notes: the digest reads up to 250 orders per day and says so in the message when a day has more. Static data is
only saved on production (activated) runs, not manual test runs in the editor.

Built with n8n, the Shopify Admin GraphQL API, Slack Block Kit and Node.js (tests with `node:test`, no dependencies).
