// Prints the Slack messages each workflow would send for sample data, no Shopify or Slack needed.
//   node demo.mjs            all four
//   node demo.mjs digest     one of: orders | stock | digest | checkouts
// Paste a message's blocks into https://app.slack.com/block-kit-builder to see it rendered.
import { createRequire } from 'node:module';
import { order, variant, gqlOrder, checkout } from './test/fixtures.mjs';

const core = createRequire(import.meta.url)('./src/core.js');
const now = new Date().toISOString();
const demos = {
  orders: () => core.orderMessages(order({
    total_price: '820.00', note: 'Gift, please no invoice in the box',
    customer: { id: 1, first_name: 'Alex', last_name: 'Kim', orders_count: 1, tags: '' },
    shipping_address: { country_code: 'CA' }, billing_address: { country_code: 'US' },
    shipping_lines: [{ title: 'Express' }],
  })),
  stock: () => [core.lowStockMessage(core.lowStock([variant(11, 0), variant(12, 3), variant(13, 40)], {}).fresh)],
  digest: () => [core.digestMessage('2026-10-29',
    [gqlOrder(129, [['Pour-Over Set', 1, 89], ['Filters', 2, 40]]), gqlOrder(64, [['Filters', 4, 64]]), gqlOrder(310, [['Grinder', 1, 310]])],
    [gqlOrder(220, [['Grinder', 1, 220]]), gqlOrder(40, [['Filters', 2, 40]])])],
  checkouts: () => [core.checkoutMessage(core.pickCheckouts([checkout(91, 240, 3, now), checkout(92, 120, 6, now), checkout(93, 30, 2, now)], {}, now).picked)],
};
for (const [name, fn] of Object.entries(demos)) {
  if (process.argv[2] && process.argv[2] !== name) continue;
  for (const m of fn()) {
    const { stats, ...msg } = m;
    console.log(`\n=== ${name} -> #${msg.channel}\n${msg.text}\n${JSON.stringify({ blocks: msg.blocks }, null, 2)}`);
  }
}
