import process from 'node:process';
import { Pool } from 'pg';
import { atomicWriteJson } from '../src/warehouse/dashboard-materializer.mjs';
import { materializeShippingOrdersFromDatabase } from '../src/warehouse/shipping-orders-materializer.mjs';

async function main() {
  const databaseUrl = process.env.FULL_BI_DATABASE_URL || process.env.DATABASE_URL;
  const output = process.env.FULL_BI_SHIPPING_ORDERS_FILE;
  if (!databaseUrl) throw new TypeError('FULL_BI_DATABASE_URL or DATABASE_URL is required.');
  if (!output) throw new TypeError('FULL_BI_SHIPPING_ORDERS_FILE is required.');

  // This runs in a separate process after the large homepage materializer.
  // Exiting that process first releases its heap before the order index is
  // built, while the wrapper still promotes every completed staging file as
  // one publication.
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  try {
    const shippingOrders = await materializeShippingOrdersFromDatabase(pool);
    const written = await atomicWriteJson(output, shippingOrders);
    console.log(JSON.stringify({
      ok: true,
      output: written,
      updatedAt: shippingOrders.updatedAt,
      storeCount: shippingOrders.source.storeCount,
      orderCount: shippingOrders.source.orderCount,
      lineCount: shippingOrders.source.lineCount,
    }, null, 2));
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Shipping-order materialization failed.');
  process.exitCode = 1;
});
