import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from '../tests/load-env.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
loadEnv();

async function main() {
  const envKeyArg = process.argv.find((a) => a.startsWith('--database-url-env'));
  let url: string | undefined;
  if (envKeyArg) {
    const idx = process.argv.indexOf(envKeyArg);
    const key =
      envKeyArg.includes('=')
        ? envKeyArg.split('=')[1]
        : process.argv[idx + 1];
    url = key ? process.env[key] : undefined;
  }
  url =
    url ||
    process.env.MIGRATION_DATABASE_URL ||
    process.env.DATABASE_URL;
  if (!url) {
    throw new Error('MIGRATION_DATABASE_URL (or DATABASE_URL) is required');
  }

  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    const dir = path.resolve(__dirname, '../db/migrations');
    const files = (await readdir(dir))
      .filter((f) => f.endsWith('.sql'))
      .sort();

    for (const file of files) {
      const exists = await client.query(`SELECT 1 FROM schema_migrations WHERE id = $1`, [file]);
      if (exists.rowCount) {
        console.info(`skip ${file}`);
        continue;
      }
      const sql = await readFile(path.join(dir, file), 'utf8');
      console.info(`apply ${file}`);
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(`INSERT INTO schema_migrations (id) VALUES ($1)`, [file]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }
    console.info('migrations complete');
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
