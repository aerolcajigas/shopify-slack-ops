// Runs the generated Code nodes (workflows/*.json, run `node build.mjs` first) the way n8n does: same jsCode,
// with $input / $() / $getWorkflowStaticData mocked and fake Shopify responses fed in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { order, variant, gqlOrder, checkout } from './fixtures.mjs';

const wf = (f) => JSON.parse(readFileSync(new URL(`../workflows/${f}.json`, import.meta.url), 'utf8'));
const node = (w, name) => w.nodes.find((n) => n.name === name);

function run(codeNode, inputs, { nodes = {}, staticData = {} } = {}) {
  const items = inputs.map((json) => ({ json }));
  const $input = { all: () => items, first: () => items[0] };
  const $ = (name) => ({ all: () => (nodes[name] || []).map((json) => ({ json })) });
  const fn = new Function('$input', '$', '$getWorkflowStaticData', codeNode.parameters.jsCode);
  return fn($input, $, () => staticData).map((i) => i.json);
}

test('every workflow is a straight chain ending in Slack', () => {
  for (const f of ['order-alerts', 'low-stock', 'daily-digest', 'abandoned-checkouts']) {
    const w = wf(f);
    assert.equal(Object.keys(w.connections).length, w.nodes.length - 1, f);
    assert.equal(w.nodes.at(-1).type, 'n8n-nodes-base.slack', f);
  }
});

test('order alerts: one webhook order -> two Slack messages when it needs review', () => {
  const risky = order({ total_price: '900.00', customer: { ...order().customer, orders_count: 1 },
    shipping_address: { country_code: 'GB' }, billing_address: { country_code: 'US' } });
  const out = run(node(wf('order-alerts'), 'Build Slack Messages'), [order(), risky]);
  assert.deepEqual(out.map((m) => m.channel), ['orders', 'orders', 'ops-alerts']);
  for (const m of out) assert.ok(Array.isArray(m.blocks) && m.text);
});

test('low stock: posts once, stays quiet next hour', () => {
  const n = node(wf('low-stock'), 'Pick New Alerts');
  const res = { data: { productVariants: { nodes: [variant(1, 2), variant(2, 0)] } } };
  const staticData = {};
  assert.equal(run(n, [res], { staticData }).length, 1);
  assert.deepEqual(run(n, [res], { staticData }), []);
});

test('GraphQL errors stop the run instead of posting', () => {
  const n = node(wf('low-stock'), 'Pick New Alerts');
  assert.throws(() => run(n, [{ errors: [{ message: 'Access denied for productVariants field' }] }]), /Access denied/);
});

test('daily digest: date items in, one digest out', () => {
  const w = wf('daily-digest');
  const days = run(node(w, 'Yesterday And Day Before'), [{}]);
  assert.equal(days.length, 2);
  assert.match(days[0].query, /^created_at:>='/);
  assert.ok(days[0].day > days[1].day);
  const page = (nodes, more = false) => ({ data: { orders: { pageInfo: { hasNextPage: more }, nodes } } });
  const [msg] = run(node(w, 'Build Digest'), [page([gqlOrder(120, [['Mug', 2, 120]])]), page([gqlOrder(60, [['Mug', 1, 60]])])],
    { nodes: { 'Yesterday And Day Before': days } });
  assert.equal(msg.channel, 'daily-numbers');
  assert.match(msg.text, new RegExp(`Sales for ${days[0].day}: \\$120\\.00 from 1 orders`));
  assert.match(msg.blocks[1].fields[0].text, /100%/);
});

test('abandoned checkouts: picks, then remembers', () => {
  const n = node(wf('abandoned-checkouts'), 'Pick Follow-ups');
  const now = new Date().toISOString();
  const res = { data: { abandonedCheckouts: { nodes: [checkout(1, 150, 4, now), checkout(2, 20, 4, now)] } } };
  const staticData = {};
  const [msg] = run(n, [res], { staticData });
  assert.equal(msg.channel, 'sales');
  assert.equal(Object.keys(staticData.checkouts).length, 1);
  assert.deepEqual(run(n, [res], { staticData }), []);
});
