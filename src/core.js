// Shopify -> Slack ops logic. Plain JS with no imports: build.mjs pastes this file into the n8n Code nodes, and
// test/core.test.mjs runs the same functions against sample Shopify payloads. Everything below "@export" is
// stripped from the n8n copy.

const DEFAULTS = {
  shop: 'your-store.myshopify.com',
  storeCountry: 'US',
  channels: { orders: 'orders', ops: 'ops-alerts', stock: 'inventory', digest: 'daily-numbers', checkouts: 'sales' },
  highValue: 300,          // order total (shop currency) that counts as high value
  heavyDiscount: 0.3,      // discount / subtotal at or above this is flagged
  lowStock: 5,             // alert when a variant has this many or fewer
  checkoutMinValue: 75,    // abandoned checkouts worth a human follow-up
  checkoutMinAgeH: 1,      // give the shopper an hour before it counts as abandoned
  checkoutMaxAgeH: 48,     // older than this is not worth chasing
  topProducts: 5,
};
const cfgOf = (c) => ({ ...DEFAULTS, ...(c || {}), channels: { ...DEFAULTS.channels, ...((c && c.channels) || {}) } });

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const round2 = (n) => Math.round(n * 100) / 100;
function money(n, cur) {
  try { return new Intl.NumberFormat('en-US', { style: 'currency', currency: cur || 'USD' }).format(n); }
  catch { return `${cur || ''} ${round2(n).toFixed(2)}`.trim(); }
}
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const adminUrl = (cfg, path) => `https://${cfg.shop}/admin/${path}`;
const gidNum = (gid) => String(gid || '').split('/').pop();

// ---------- 1. Order alerts (orders/create webhook, REST-shaped payload) ----------

function classifyOrder(order, c) {
  const cfg = cfgOf(c);
  const total = num(order.total_price);
  const subtotal = num(order.subtotal_price) + num(order.total_discounts);
  const discountShare = subtotal > 0 ? num(order.total_discounts) / subtotal : 0;
  const country = (order.shipping_address && order.shipping_address.country_code) || '';
  const shipping = (order.shipping_lines || []).map((s) => s.title || '').join(' ');
  const billingCountry = (order.billing_address && order.billing_address.country_code) || '';
  // orders_count is missing from some API versions' payloads; only trust it when present.
  const ordersCount = order.customer && order.customer.orders_count != null ? num(order.customer.orders_count) : null;
  const tags = String((order.customer && order.customer.tags) || '').toLowerCase().split(',').map((t) => t.trim());

  const flags = [];
  if (total >= cfg.highValue) flags.push('high_value');
  if (ordersCount === 1) flags.push('first_order');
  if (tags.includes('vip')) flags.push('vip');
  if (discountShare >= cfg.heavyDiscount) flags.push('heavy_discount');
  if (country && country !== cfg.storeCountry) flags.push('international');
  if (/express|overnight|next[- ]day|priority/i.test(shipping)) flags.push('express');
  if (order.note && String(order.note).trim()) flags.push('customer_note');
  if (country && billingCountry && country !== billingCountry) flags.push('address_mismatch');

  // Review = the combinations that usually precede chargebacks: a big first order shipped somewhere other than
  // the billing country, or a big first order paid with a heavy discount. A person decides, nothing is cancelled.
  const review = flags.includes('first_order') && flags.includes('high_value')
    && (flags.includes('address_mismatch') || flags.includes('heavy_discount'));
  const priority = review ? 'review' : (flags.includes('high_value') || flags.includes('vip') ? 'high' : 'normal');
  return { flags, priority, total, currency: order.currency || 'USD', discountShare: round2(discountShare), country };
}

const FLAG_LABEL = {
  high_value: ':moneybag: High value', first_order: ':wave: First order', vip: ':star: VIP',
  heavy_discount: ':label: Heavy discount', international: ':earth_americas: International', express: ':zap: Express shipping',
  customer_note: ':memo: Has a note', address_mismatch: ':warning: Ship/bill country differ',
};

// Returns the Slack messages to send (one per channel): [{ channel, text, blocks }].
function orderMessages(order, c) {
  const cfg = cfgOf(c);
  const r = classifyOrder(order, cfg);
  const who = order.customer ? [order.customer.first_name, order.customer.last_name].filter(Boolean).join(' ') : '';
  const items = (order.line_items || []).slice(0, 6).map((li) => `• ${li.quantity} × ${esc(li.title)}${li.variant_title ? ` (${esc(li.variant_title)})` : ''}`);
  if ((order.line_items || []).length > 6) items.push(`• +${order.line_items.length - 6} more`);
  const head = `${r.priority === 'review' ? ':rotating_light: Review' : r.priority === 'high' ? ':tada:' : ':shopping_bags:'} Order ${esc(order.name)} · ${money(r.total, r.currency)}`;
  const blocks = [
    { type: 'section', text: { type: 'mrkdwn', text: `*${head}*\n${esc(who) || 'Guest'}${r.country ? ` · ${r.country}` : ''}` } },
    { type: 'section', text: { type: 'mrkdwn', text: items.join('\n') || '_no line items_' } },
  ];
  if (r.flags.length) blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: r.flags.map((f) => FLAG_LABEL[f] || f).join('   ') }] });
  if (order.note) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `> ${esc(order.note).slice(0, 500)}` } });
  blocks.push({ type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: 'Open in Shopify' }, url: adminUrl(cfg, `orders/${order.id}`) }] });

  const text = `Order ${order.name} ${money(r.total, r.currency)}${r.flags.length ? ' (' + r.flags.join(', ') + ')' : ''}`;
  const out = [{ channel: cfg.channels.orders, text, blocks }];
  if (r.priority === 'review') out.push({ channel: cfg.channels.ops, text: `Review before fulfilling: ${text}`, blocks });
  return out;
}

// ---------- 2. Low stock (hourly GraphQL productVariants query) ----------

// variants: GraphQL productVariants nodes. alerted: { [variantId]: qtyWhenAlerted } kept in workflow static data.
// Alerts once when a variant drops to/below the threshold, again only if it sells out, and forgets it after a
// restock, so the channel doesn't get the same warning every hour.
function lowStock(variants, alerted, c) {
  const cfg = cfgOf(c);
  const prev = { ...(alerted || {}) };
  const next = {}, fresh = [];
  for (const v of variants || []) {
    if (v.product && v.product.status && v.product.status !== 'ACTIVE') continue;
    if (v.inventoryQuantity == null) continue; // not tracked
    const q = num(v.inventoryQuantity);
    if (q > cfg.lowStock) continue; // restocked: dropped from `next`, so it can alert again later
    next[v.id] = q;
    const before = prev[v.id];
    if (before === undefined || (q <= 0 && before > 0)) fresh.push({ ...v, inventoryQuantity: q });
  }
  fresh.sort((a, b) => a.inventoryQuantity - b.inventoryQuantity);
  return { fresh, state: next };
}

function lowStockMessage(fresh, c) {
  const cfg = cfgOf(c);
  if (!fresh.length) return null;
  const line = (v) => `${v.inventoryQuantity <= 0 ? ':red_circle: *Sold out*' : `:large_yellow_circle: *${v.inventoryQuantity} left*`} · <${adminUrl(cfg, `products/${gidNum(v.product && v.product.id)}`)}|${esc(v.displayName || (v.product && v.product.title))}>${v.sku ? ` \`${esc(v.sku)}\`` : ''}`;
  const lines = fresh.slice(0, 25).map(line);
  if (fresh.length > 25) lines.push(`+${fresh.length - 25} more`);
  return {
    channel: cfg.channels.stock,
    text: `${fresh.length} variant${fresh.length === 1 ? '' : 's'} low on stock`,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: `*:package: Low stock (≤ ${cfg.lowStock})*` } },
      { type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') } },
    ],
  };
}

// ---------- 3. Daily digest (GraphQL orders for yesterday + the day before) ----------

// UTC offset ('-04:00') of an IANA time zone at a given moment, so DST is handled.
function tzOffset(timeZone, at) {
  const name = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' })
    .formatToParts(new Date(at)).find((p) => p.type === 'timeZoneName').value; // "GMT-04:00" or "GMT"
  return name === 'GMT' ? '+00:00' : name.slice(3);
}

// The store-local date `daysBack` days before `now`, as { day, query } for the orders search.
function storeDay(now, timeZone, daysBack) {
  const local = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now));
  const d = new Date(`${local}T12:00:00Z`); d.setUTCDate(d.getUTCDate() - daysBack);
  const day = d.toISOString().slice(0, 10);
  d.setUTCDate(d.getUTCDate() + 1);
  const start = localMidnight(day, timeZone), end = localMidnight(d.toISOString().slice(0, 10), timeZone);
  return { day, start, end, query: `created_at:>='${start}' AND created_at:<'${end}'` };
}

// The UTC instant of 00:00 local time on `day`. Guess with the midday offset, then re-check the offset at the guess:
// on a DST-change day midnight and midday have different offsets (and the day is 23 or 25 hours long).
function localMidnight(day, timeZone) {
  let t = new Date(`${day}T00:00:00${tzOffset(timeZone, `${day}T12:00:00Z`)}`);
  t = new Date(`${day}T00:00:00${tzOffset(timeZone, t)}`);
  return t.toISOString();
}

// day: 'YYYY-MM-DD' in the store's time zone. tzOffset like '-05:00'. Returns the search string for orders(query:).
function dayRange(day, tzOffset) {
  const start = new Date(`${day}T00:00:00${tzOffset || 'Z'}`);
  const end = new Date(start.getTime() + 86400000);
  return { start: start.toISOString(), end: end.toISOString(), query: `created_at:>='${start.toISOString()}' AND created_at:<'${end.toISOString()}'` };
}

function summarize(orders) {
  let revenue = 0, refunded = 0, units = 0, cancelled = 0, currency = 'USD';
  const products = {}, customers = new Set();
  for (const o of orders || []) {
    if (o.cancelledAt) { cancelled++; continue; }
    const m = o.totalPriceSet && o.totalPriceSet.shopMoney;
    revenue += num(m && m.amount); currency = (m && m.currencyCode) || currency;
    refunded += num(o.totalRefundedSet && o.totalRefundedSet.shopMoney && o.totalRefundedSet.shopMoney.amount);
    if (o.customer && o.customer.id) customers.add(o.customer.id);
    for (const li of (o.lineItems && o.lineItems.nodes) || []) {
      const k = li.title; const p = products[k] || (products[k] = { title: k, units: 0, sales: 0 });
      p.units += num(li.quantity); units += num(li.quantity);
      p.sales += num(li.originalTotalSet && li.originalTotalSet.shopMoney && li.originalTotalSet.shopMoney.amount);
    }
  }
  const count = (orders || []).length - cancelled;
  return {
    orders: count, revenue: round2(revenue), net: round2(revenue - refunded), refunded: round2(refunded), units, cancelled,
    aov: count ? round2(revenue / count) : 0, customers: customers.size, currency,
    top: Object.values(products).sort((a, b) => b.sales - a.sales || b.units - a.units).map((p) => ({ ...p, sales: round2(p.sales) })),
  };
}

function change(now, before) {
  if (!before) return now ? 'new' : '';
  const pct = Math.round(((now - before) / before) * 100);
  return `${pct >= 0 ? ':arrow_up_small:' : ':arrow_down_small:'} ${Math.abs(pct)}%`;
}

function digestMessage(day, today, prev, c, partial) {
  const cfg = cfgOf(c);
  const s = summarize(today), p = summarize(prev);
  const m = (n) => money(n, s.currency);
  const field = (label, val, cmp) => ({ type: 'mrkdwn', text: `*${label}*\n${val}${cmp ? `  ${cmp}` : ''}` });
  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: `Sales for ${day}` } },
    { type: 'section', fields: [
      field('Revenue', m(s.revenue), change(s.revenue, p.revenue)),
      field('Orders', String(s.orders), change(s.orders, p.orders)),
      field('Avg order', m(s.aov), change(s.aov, p.aov)),
      field('Refunded', m(s.refunded), ''),
    ] },
  ];
  const top = s.top.slice(0, cfg.topProducts);
  if (top.length) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: '*Top products*\n' + top.map((t, i) => `${i + 1}. ${esc(t.title)} · ${t.units} sold · ${m(t.sales)}`).join('\n') } });
  const notes = [`vs the day before · ${s.customers} customers · ${s.units} units`];
  if (s.cancelled) notes.push(`${s.cancelled} cancelled (not counted)`);
  if (partial) notes.push(':warning: over 250 orders, totals cover the first 250');
  blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: notes.join(' · ') }] });
  return { channel: cfg.channels.digest, text: `Sales for ${day}: ${m(s.revenue)} from ${s.orders} orders`, blocks, stats: s };
}

// ---------- 4. Abandoned checkouts (hourly GraphQL abandonedCheckouts) ----------

// Picks checkouts worth a personal follow-up: old enough to be abandoned, not too old, above the value floor, not
// completed, not already posted. seen: { [checkoutId]: isoPostedAt } in static data, pruned after 7 days.
function pickCheckouts(checkouts, seen, now, c) {
  const cfg = cfgOf(c);
  const t = new Date(now || Date.now()).getTime();
  const state = {};
  for (const [id, at] of Object.entries(seen || {})) if (t - new Date(at).getTime() < 7 * 86400000) state[id] = at;
  const picked = [];
  for (const ch of checkouts || []) {
    if (ch.completedAt || state[ch.id]) continue;
    const ageH = (t - new Date(ch.createdAt).getTime()) / 3600000;
    const value = num(ch.totalPriceSet && ch.totalPriceSet.shopMoney && ch.totalPriceSet.shopMoney.amount);
    if (ageH < cfg.checkoutMinAgeH || ageH > cfg.checkoutMaxAgeH || value < cfg.checkoutMinValue) continue;
    picked.push({ ...ch, ageH: Math.round(ageH), value });
    state[ch.id] = new Date(t).toISOString();
  }
  picked.sort((a, b) => b.value - a.value);
  return { picked, state };
}

function checkoutMessage(picked, c) {
  const cfg = cfgOf(c);
  if (!picked.length) return null;
  const cur = (ch) => (ch.totalPriceSet && ch.totalPriceSet.shopMoney && ch.totalPriceSet.shopMoney.currencyCode) || 'USD';
  const blocks = [{ type: 'section', text: { type: 'mrkdwn', text: `*:shopping_trolley: ${picked.length} abandoned checkout${picked.length === 1 ? '' : 's'} worth a follow-up*` } }];
  for (const ch of picked.slice(0, 10)) {
    const items = ((ch.lineItems && ch.lineItems.nodes) || []).map((li) => `${li.quantity} × ${esc(li.title)}`).join(', ');
    const name = (ch.customer && ch.customer.displayName) || 'Guest';
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*${money(ch.value, cur(ch))}* · ${esc(name)} · ${ch.ageH}h ago\n${items || '_no items_'}` },
      accessory: { type: 'button', text: { type: 'plain_text', text: 'Open checkout' }, url: adminUrl(cfg, `checkouts/${gidNum(ch.id)}`) },
    });
  }
  blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: 'Send the recovery email from Shopify, or reply here with who is taking it.' }] });
  return { channel: cfg.channels.checkouts, text: `${picked.length} abandoned checkouts to follow up`, blocks };
}

// @export
if (typeof module !== 'undefined') {
  module.exports = { DEFAULTS, classifyOrder, orderMessages, lowStock, lowStockMessage, tzOffset, storeDay, dayRange, summarize, digestMessage, pickCheckouts, checkoutMessage };
}
