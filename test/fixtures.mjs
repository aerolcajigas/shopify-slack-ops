// Sample payloads shaped like Shopify's: orders/create webhook (REST JSON) and Admin GraphQL nodes. Fake data.

export const order = (over = {}) => ({
  id: 5800000000001,
  name: '#1042',
  currency: 'USD',
  total_price: '129.00',
  subtotal_price: '119.00',
  total_discounts: '0.00',
  note: null,
  customer: { id: 7100000000001, first_name: 'Dana', last_name: 'Reyes', orders_count: 4, tags: '' },
  shipping_address: { country_code: 'US' },
  billing_address: { country_code: 'US' },
  shipping_lines: [{ title: 'Standard' }],
  line_items: [
    { title: 'Ceramic Pour-Over Set', variant_title: 'Sand', quantity: 1 },
    { title: 'Paper Filters (100)', variant_title: null, quantity: 2 },
  ],
  ...over,
});

export const variant = (id, qty, over = {}) => ({
  id: `gid://shopify/ProductVariant/${id}`,
  sku: `SKU-${id}`,
  displayName: `Item ${id} - Default`,
  inventoryQuantity: qty,
  product: { id: `gid://shopify/Product/${id}00`, title: `Item ${id}`, status: 'ACTIVE' },
  ...over,
});

export const gqlOrder = (total, items, over = {}) => ({
  id: `gid://shopify/Order/${Math.round(total * 100)}`,
  createdAt: '2026-10-29T15:00:00Z',
  cancelledAt: null,
  totalPriceSet: { shopMoney: { amount: String(total), currencyCode: 'USD' } },
  totalRefundedSet: { shopMoney: { amount: '0.0' } },
  customer: { id: `gid://shopify/Customer/${Math.round(total)}` },
  lineItems: { nodes: items.map(([title, quantity, amount]) => ({ title, quantity, originalTotalSet: { shopMoney: { amount: String(amount) } } })) },
  ...over,
});

export const checkout = (id, value, hoursAgo, now, over = {}) => ({
  id: `gid://shopify/AbandonedCheckout/${id}`,
  createdAt: new Date(new Date(now).getTime() - hoursAgo * 3600000).toISOString(),
  completedAt: null,
  totalPriceSet: { shopMoney: { amount: String(value), currencyCode: 'USD' } },
  customer: { displayName: 'Sam Lee' },
  lineItems: { nodes: [{ title: 'Grinder', quantity: 1 }] },
  ...over,
});
