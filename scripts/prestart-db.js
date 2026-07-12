/**
 * Railway prestart: legacy UbisoftUsage rows block adding ubisoftAppId.
 * Clear them once, then prisma db push can apply the per-game schema.
 */
const { Client } = require('pg');

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.warn('[prestart-db] DATABASE_URL not set — skipping UbisoftUsage prep');
    return;
  }

  const client = new Client({
    connectionString: url,
    ssl: url.includes('railway') || url.includes('rlwy.net') ? { rejectUnauthorized: false } : undefined,
  });

  await client.connect();
  try {
    const table = await client.query(`
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'UbisoftUsage'
    `);
    if (table.rowCount === 0) {
      console.log('[prestart-db] UbisoftUsage table not found yet — nothing to prep');
      return;
    }

    const col = await client.query(`
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'UbisoftUsage' AND column_name = 'ubisoftAppId'
    `);

    if (col.rowCount === 0) {
      const count = await client.query('SELECT COUNT(*)::int AS n FROM "UbisoftUsage"');
      const n = count.rows[0]?.n ?? 0;
      if (n > 0) {
        console.log(`[prestart-db] Clearing ${n} legacy UbisoftUsage row(s) before per-game schema push`);
        await client.query('DELETE FROM "UbisoftUsage"');
      }
      await client.query(
        'ALTER TABLE "UbisoftUsage" DROP CONSTRAINT IF EXISTS "UbisoftUsage_accountId_usageDate_key"',
      );
      console.log('[prestart-db] UbisoftUsage ready for prisma db push');
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('[prestart-db] failed:', err.message || err);
  process.exit(1);
});
