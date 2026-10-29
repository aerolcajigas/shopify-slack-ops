// Generates the four n8n workflows into workflows/*.json from src/core.js + config.json.
//   node build.mjs                 uses config.json, or config.example.json if there is none
//   node build.mjs --deploy        also creates/updates them through the n8n API (env N8N_API_URL, N8N_API_KEY)
// Import the JSON files in n8n (Workflows > Import from file) if you'd rather not use the API.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const here = (p) => new URL(p, import.meta.url);
const cfg = JSON.parse(readFileSync(here(existsSync(here('config.json')) ? 'config.json' : 'config.example.json'), 'utf8'));
const { credentials, apiVersion, timeZone, digestHour, ...logicCfg } = cfg;
const CORE = readFileSync(here('src/core.js'), 'utf8').split('// @export')[0].trim();
const PRELUDE = `${CORE}\n\nconst CONFIG = ${JSON.stringify(logicCfg)};\n`;
const GRAPHQL_URL = `https://${cfg.shop}/admin/api/${apiVersion}/graphql.json`;

// ---------- node helpers ----------
let x = 0;
const at = () => [(x++) * 260, 300];
const SHOPIFY = { shopifyAccessTokenApi: credentials.shopify };
const SLACK = { slackApi: credentials.slack };

const code = (name, js) => ({ id: randomUUID(), name, type: 'n8n-nodes-base.code', typeVersion: 2, position: at(),
  parameters: { mode: 'runOnceForAllItems', jsCode: `${PRELUDE}\n// ---- ${name} ----\n${js.trim()}\n` } });

const schedule = (name, rule) => ({ id: randomUUID(), name, type: 'n8n-nodes-base.scheduleTrigger', typeVersion: 1.2, position: at(),
  parameters: { rule: { interval: [rule] } } });

// Shopify Admin GraphQL through the HTTP Request node, so any query works (the built-in Shopify node covers a few).
const graphql = (name, query, variablesExpr) => ({
  id: randomUUID(), name, type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: at(),
  retryOnFail: true, maxTries: 3, waitBetweenTries: 5000,
  credentials: SHOPIFY,
  parameters: {
    method: 'POST', url: GRAPHQL_URL,
    authentication: 'predefinedCredentialType', nodeCredentialType: 'shopifyAccessTokenApi',
    sendBody: true, specifyBody: 'json',
    jsonBody: `={{ JSON.stringify({ query: ${JSON.stringify(query)}, variables: ${variablesExpr} }) }}`,
    options: {},
  },
});

const slack = (name = 'Post to Slack') => ({
  id: randomUUID(), name, type: 'n8n-nodes-base.slack', typeVersion: 2.3, position: at(),
  retryOnFail: true, maxTries: 3, waitBetweenTries: 3000,
  credentials: SLACK,
  parameters: {
    authentication: 'accessToken', resource: 'message', operation: 'post', select: 'channel',
    channelId: { __rl: true, mode: 'name', value: '={{ $json.channel }}' },
    messageType: 'block', blocksUi: '={{ JSON.stringify({ blocks: $json.blocks }) }}', text: '={{ $json.text }}',
    otherOptions: { includeLinkToWorkflow: false },
  },
});

// GraphQL answers HTTP 200 even when the query fails; stop loudly instead of posting an empty alert.
const GQL_CHECK = `
function gql(item) {
  const b = item.json;
  if (b.errors && b.errors.length) throw new Error('Shopify GraphQL: ' + b.errors.map((e) => e.message).join('; '));
  if (!b.data) throw new Error('Shopify GraphQL: empty response');
  return b.data;
}`;

function workflow(name, nodes, notes) {
  const connections = {};
  for (let i = 0; i < nodes.length - 1; i++) connections[nodes[i].name] = { main: [[{ node: nodes[i + 1].name, type: 'main', index: 0 }]] };
  x = 0;
  return { name, nodes, connections, settings: { executionOrder: 'v1', timezone: timeZone }, meta: { notes } };
}

// ---------- 1. Order alerts ----------
const orderAlerts = workflow('Shopify Ops / Order Alerts', [
  { id: randomUUID(), name: 'New Order', type: 'n8n-nodes-base.shopifyTrigger', typeVersion: 1, position: at(),
    webhookId: randomUUID(), credentials: SHOPIFY, parameters: { authentication: 'accessToken', topic: 'orders/create' } },
  code('Build Slack Messages', `
const out = [];
for (const item of $input.all()) for (const m of orderMessages(item.json, CONFIG)) out.push({ json: m });
return out;`),
  slack(),
], 'Every new order -> #orders with flags. Risky combinations also go to #ops-alerts for a person to check.');

// ---------- 2. Low stock ----------
const VARIANTS_Q = `query($q: String!) { productVariants(first: 250, query: $q) { nodes { id sku displayName inventoryQuantity product { id title status } } } }`;
const lowStockWf = workflow('Shopify Ops / Low Stock', [
  schedule('Every Hour', { field: 'hours', hoursInterval: 1 }),
  graphql('Get Low Variants', VARIANTS_Q, `{ q: 'inventory_quantity:<=${cfg.lowStock}' }`),
  code('Pick New Alerts', `${GQL_CHECK}
// Remembers what was already posted (workflow static data persists between production runs, not manual tests).
const store = $getWorkflowStaticData('global');
const r = lowStock(gql($input.first()).productVariants.nodes, store.lowStock, CONFIG);
store.lowStock = r.state;
const msg = lowStockMessage(r.fresh, CONFIG);
return msg ? [{ json: msg }] : [];`),
  slack(),
], 'Hourly: variants at or below the threshold -> #inventory, once per drop (again on sell-out, reset on restock).');

// ---------- 3. Daily digest ----------
const ORDERS_Q = `query($q: String!) { orders(first: 250, query: $q, sortKey: CREATED_AT) { pageInfo { hasNextPage } nodes { id createdAt cancelledAt totalPriceSet { shopMoney { amount currencyCode } } totalRefundedSet { shopMoney { amount } } customer { id } lineItems(first: 50) { nodes { title quantity originalTotalSet { shopMoney { amount } } } } } } }`;
const digestWf = workflow('Shopify Ops / Daily Digest', [
  schedule(`Every Day ${digestHour}:00`, { field: 'days', triggerAtHour: digestHour }),
  code('Yesterday And Day Before', `
const now = new Date().toISOString();
const tz = ${JSON.stringify(timeZone)};
return [{ json: storeDay(now, tz, 1) }, { json: storeDay(now, tz, 2) }];`),
  graphql('Get Orders', ORDERS_Q, '{ q: $json.query }'),
  code('Build Digest', `${GQL_CHECK}
const days = $('Yesterday And Day Before').all().map((i) => i.json);
const [y, p] = $input.all().map((i) => gql(i).orders);
return [{ json: digestMessage(days[0].day, y.nodes, p.nodes, CONFIG, y.pageInfo.hasNextPage || p.pageInfo.hasNextPage) }];`),
  slack(),
], 'Daily: yesterday\'s revenue, orders, AOV, refunds and top products vs the day before -> #daily-numbers.');

// ---------- 4. Abandoned checkouts ----------
const CHECKOUTS_Q = `query($q: String!) { abandonedCheckouts(first: 100, query: $q, reverse: true) { nodes { id createdAt completedAt totalPriceSet { shopMoney { amount currencyCode } } customer { displayName } lineItems(first: 5) { nodes { title quantity } } } } }`;
const checkoutsWf = workflow('Shopify Ops / Abandoned Checkouts', [
  schedule('Every Hour', { field: 'hours', hoursInterval: 1 }),
  graphql('Get Abandoned Checkouts', CHECKOUTS_Q, `{ q: 'created_at:>=' + new Date(Date.now() - ${cfg.checkoutMaxAgeH} * 3600000).toISOString() }`),
  code('Pick Follow-ups', `${GQL_CHECK}
const store = $getWorkflowStaticData('global');
const r = pickCheckouts(gql($input.first()).abandonedCheckouts.nodes, store.checkouts, new Date().toISOString(), CONFIG);
store.checkouts = r.state;
const msg = checkoutMessage(r.picked, CONFIG);
return msg ? [{ json: msg }] : [];`),
  slack(),
], 'Hourly: abandoned checkouts worth a personal follow-up -> #sales. A person decides; nothing is emailed automatically.');

// ---------- write / deploy ----------
const all = { 'order-alerts': orderAlerts, 'low-stock': lowStockWf, 'daily-digest': digestWf, 'abandoned-checkouts': checkoutsWf };
mkdirSync(here('workflows/'), { recursive: true });
for (const [file, wf] of Object.entries(all)) writeFileSync(here(`workflows/${file}.json`), JSON.stringify(wf, null, 2) + '\n');
console.log(`wrote ${Object.keys(all).length} workflows to workflows/`);

if (process.argv.includes('--deploy')) {
  const base = String(process.env.N8N_API_URL || '').replace(/\/$/, ''), key = process.env.N8N_API_KEY;
  if (!base || !key) throw new Error('set N8N_API_URL and N8N_API_KEY');
  const api = async (method, path, body) => {
    const r = await fetch(base + path, { method, headers: { 'X-N8N-API-KEY': key, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
    if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${(await r.text()).slice(0, 300)}`);
    return r.json();
  };
  const existing = (await api('GET', '/api/v1/workflows?limit=250')).data;
  for (const wf of Object.values(all)) {
    const { meta, ...body } = wf; // the public API rejects unknown top-level fields
    const found = existing.find((w) => w.name === wf.name);
    if (found) await api('PUT', `/api/v1/workflows/${found.id}`, body); else await api('POST', '/api/v1/workflows', body);
    console.log(`${found ? 'updated' : 'created'} ${wf.name} (inactive until you activate it in n8n)`);
  }
}
