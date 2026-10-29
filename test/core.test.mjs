import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { order, variant, gqlOrder, checkout } from './fixtures.mjs';

const core = createRequire(import.meta.url)('../src/core.js');
const NOW = '2026-10-30T12:00:00Z';

test('a plain repeat order is normal and goes to #orders only', () => {
  const r = core.classifyOrder(order());
  assert.equal(r.priority, 'normal');
  assert.deepEqual(r.flags, []);
  const msgs = core.orderMessages(order());
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].channel, 'orders');
  assert.match(msgs[0].text, /#1042 \$129\.00/);
});

test('high value and VIP orders are high priority', () => {
  assert.equal(core.classifyOrder(order({ total_price: '450.00' })).priority, 'high');
  const vip = order({ customer: { ...order().customer, tags: 'wholesale, VIP' } });
  assert.deepEqual(core.classifyOrder(vip).flags, ['vip']);
  assert.equal(core.classifyOrder(vip).priority, 'high');
});

test('big first order shipped abroad with a different billing country goes to review, also in #ops-alerts', () => {
  const o = order({
    total_price: '820.00',
    customer: { ...order().customer, orders_count: 1 },
    shipping_address: { country_code: 'NG' },
    billing_address: { country_code: 'US' },
    shipping_lines: [{ title: 'Express Overnight' }],
  });
  const r = core.classifyOrder(o);
  assert.equal(r.priority, 'review');
  for (const f of ['high_value', 'first_order', 'international', 'express', 'address_mismatch']) assert.ok(r.flags.includes(f), f);
  const msgs = core.orderMessages(o);
  assert.deepEqual(msgs.map((m) => m.channel), ['orders', 'ops-alerts']);
  assert.match(msgs[1].text, /^Review before fulfilling/);
});

test('heavy discount is measured against the pre-discount subtotal', () => {
  const r = core.classifyOrder(order({ subtotal_price: '70.00', total_discounts: '30.00', total_price: '70.00' }));
  assert.equal(r.discountShare, 0.3);
  assert.ok(r.flags.includes('heavy_discount'));
});

test('missing orders_count never claims a first order', () => {
  const o = order({ total_price: '900.00', customer: { id: 1, first_name: 'A' } });
  assert.ok(!core.classifyOrder(o).flags.includes('first_order'));
});

test('order message escapes Slack markup and caps the item list', () => {
  const items = Array.from({ length: 9 }, (_, i) => ({ title: `Mug <${i}> & co`, quantity: 1 }));
  const m = core.orderMessages(order({ line_items: items }))[0];
  const itemText = m.blocks[1].text.text;
  assert.match(itemText, /Mug &lt;0&gt; &amp; co/);
  assert.match(itemText, /\+3 more/);
  assert.equal(m.blocks.at(-1).elements[0].url, 'https://your-store.myshopify.com/admin/orders/5800000000001');
});

test('low stock alerts once, again on sell-out, and resets after a restock', () => {
  const cfg = { lowStock: 5 };
  let r = core.lowStock([variant(1, 3), variant(2, 40), variant(3, null)], {}, cfg);
  assert.deepEqual(r.fresh.map((v) => v.sku), ['SKU-1']);

  r = core.lowStock([variant(1, 2)], r.state, cfg);               // still low: no repeat
  assert.equal(r.fresh.length, 0);
  r = core.lowStock([variant(1, 0)], r.state, cfg);               // sold out: alert again
  assert.equal(r.fresh.length, 1);
  r = core.lowStock([variant(1, 25)], r.state, cfg);              // restocked: forgotten
  assert.deepEqual(r.state, {});
  r = core.lowStock([variant(1, 4)], r.state, cfg);               // low again later: alerts
  assert.equal(r.fresh.length, 1);
});

test('low stock skips draft products and sorts sold-out first', () => {
  const r = core.lowStock([variant(1, 4), variant(2, 0), variant(3, 1, { product: { id: 'x', title: 'Old', status: 'DRAFT' } })], {});
  assert.deepEqual(r.fresh.map((v) => v.inventoryQuantity), [0, 4]);
  const m = core.lowStockMessage(r.fresh);
  assert.equal(m.channel, 'inventory');
  assert.match(m.blocks[1].text.text, /Sold out/);
  assert.equal(core.lowStockMessage([]), null);
});

test('day range uses the store time zone', () => {
  const r = core.dayRange('2026-10-29', '-05:00');
  assert.equal(r.start, '2026-10-29T05:00:00.000Z');
  assert.equal(r.end, '2026-10-30T05:00:00.000Z');
  assert.match(r.query, /^created_at:>='2026-10-29T05:00:00.000Z' AND created_at:<'2026-10-30T05:00:00.000Z'$/);
});

test('store day: yesterday in the store time zone, across a DST change', () => {
  assert.equal(core.tzOffset('America/New_York', '2026-07-01T12:00:00Z'), '-04:00');
  assert.equal(core.tzOffset('America/New_York', '2026-12-01T12:00:00Z'), '-05:00');
  assert.equal(core.tzOffset('UTC', NOW), '+00:00');
  // 02:00 UTC on Oct 30 is still Oct 29 in New York, so "yesterday" there is Oct 28.
  const y = core.storeDay('2026-10-30T02:00:00Z', 'America/New_York', 1);
  assert.equal(y.day, '2026-10-28');
  assert.equal(y.start, '2026-10-28T04:00:00.000Z');
  // Nov 1 2026 is the US DST end: that local day is 25 hours long and starts at -04:00.
  const dst = core.storeDay('2026-11-02T15:00:00Z', 'America/New_York', 1);
  assert.equal(dst.day, '2026-11-01');
  assert.equal(dst.start, '2026-11-01T04:00:00.000Z');
  assert.equal(dst.end, '2026-11-02T05:00:00.000Z');
  // Mar 8 2026 is the DST start: a 23-hour day.
  const spring = core.storeDay('2026-03-09T15:00:00Z', 'America/New_York', 1);
  assert.equal(spring.start, '2026-03-08T05:00:00.000Z');
  assert.equal(spring.end, '2026-03-09T04:00:00.000Z');
});

test('digest totals, AOV, refunds, cancellations and day-over-day change', () => {
  const today = [
    gqlOrder(100, [['Mug', 2, 60], ['Beans', 1, 40]]),
    gqlOrder(50, [['Beans', 2, 50]], { totalRefundedSet: { shopMoney: { amount: '10' } } }),
    gqlOrder(999, [['Grinder', 1, 999]], { cancelledAt: '2026-10-29T16:00:00Z' }),
  ];
  const prev = [gqlOrder(100, [['Mug', 1, 100]])];
  const s = core.summarize(today);
  assert.equal(s.orders, 2);
  assert.equal(s.revenue, 150);
  assert.equal(s.refunded, 10);
  assert.equal(s.net, 140);
  assert.equal(s.aov, 75);
  assert.equal(s.cancelled, 1);
  assert.deepEqual(s.top.map((t) => t.title), ['Beans', 'Mug']);

  const m = core.digestMessage('2026-10-29', today, prev);
  assert.equal(m.channel, 'daily-numbers');
  assert.match(m.text, /\$150\.00 from 2 orders/);
  assert.match(m.blocks[1].fields[0].text, /arrow_up_small: 50%/);
  assert.match(m.blocks.at(-1).elements[0].text, /1 cancelled/);
  assert.match(core.digestMessage('2026-10-29', today, prev, {}, true).blocks.at(-1).elements[0].text, /first 250/);
});

test('empty day digest does not divide by zero', () => {
  const m = core.digestMessage('2026-10-29', [], []);
  assert.equal(m.stats.aov, 0);
  assert.match(m.text, /\$0\.00 from 0 orders/);
});

test('abandoned checkouts: age window, value floor, completed and already-posted are skipped', () => {
  const list = [
    checkout(1, 180, 3, NOW),                       // picked
    checkout(2, 40, 3, NOW),                        // below value floor
    checkout(3, 300, 0.5, NOW),                     // too fresh
    checkout(4, 300, 72, NOW),                      // too old
    checkout(5, 220, 5, NOW, { completedAt: NOW }), // bought after all
    checkout(6, 500, 10, NOW),                      // picked, highest first
  ];
  const r = core.pickCheckouts(list, {}, NOW);
  assert.deepEqual(r.picked.map((c) => c.value), [500, 180]);
  assert.equal(Object.keys(r.state).length, 2);
  const again = core.pickCheckouts(list, r.state, NOW);
  assert.equal(again.picked.length, 0);
  const m = core.checkoutMessage(r.picked);
  assert.equal(m.channel, 'sales');
  assert.equal(m.blocks[1].accessory.url, 'https://your-store.myshopify.com/admin/checkouts/6');
});

test('posted-checkout memory is pruned after 7 days', () => {
  const r = core.pickCheckouts([], { a: '2026-10-01T00:00:00Z', b: '2026-10-29T00:00:00Z' }, NOW);
  assert.deepEqual(Object.keys(r.state), ['b']);
});

test('config overrides merge with defaults', () => {
  const m = core.orderMessages(order({ total_price: '60.00' }), { highValue: 50, channels: { orders: 'shop-orders' } });
  assert.equal(m[0].channel, 'shop-orders');
  assert.match(m[0].text, /high_value/);
});
