import pg from 'pg';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPool, type DbPool } from '../../platform/db/src/index.js';
import { loadConfig, resetConfigCache } from '../../platform/config/src/index.js';
import { createApp } from '../../apps/api/src/app.js';
import { hashPassword } from '../../platform/auth/src/passwords.js';
import { createTenantBootstrap } from '../../platform/tenancy/src/index.js';
import { seedMembershipGrants } from '../../platform/authz/src/index.js';
import { createHash, randomBytes } from 'node:crypto';
import type { Express } from 'express';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface Fixtures {
  pool: DbPool;
  app: Express;
  tenantA: string;
  tenantB: string;
  ownerA: { id: string; email: string; password: string };
  ownerB: { id: string; email: string; password: string };
  parentA: { id: string; email: string; password: string };
  childA1: string;
  childA2: string;
  childB1: string;
  integrationTokenA: string;
}

async function applyMigrations(url: string): Promise<void> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    const dir = path.resolve(__dirname, '../../db/migrations');
    const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      const exists = await client.query(`SELECT 1 FROM schema_migrations WHERE id = $1`, [file]);
      if (exists.rowCount) continue;
      const sql = await readFile(path.join(dir, file), 'utf8');
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
  } finally {
    await client.end();
  }
}

async function resetDatabase(migratorUrl: string): Promise<void> {
  // Schema reset requires a privileged connection (extensions). Prefer TEST_POSTGRES_URL.
  const adminUrl =
    process.env.TEST_POSTGRES_URL ||
    process.env.POSTGRES_URL ||
    'postgresql://postgres:postgres@127.0.0.1:5432/daypi_test';

  let client: pg.Client;
  try {
    client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
  } catch {
    // Fall back to migrator if admin is unavailable (extensions must already exist).
    client = new pg.Client({ connectionString: migratorUrl });
    await client.connect();
  }

  try {
    await client.query(`
      DROP SCHEMA public CASCADE;
      CREATE SCHEMA public;
      GRANT USAGE ON SCHEMA public TO daypi_app;
      GRANT USAGE ON SCHEMA public TO daypi_migrator;
      GRANT CREATE ON SCHEMA public TO daypi_migrator;
      ALTER DEFAULT PRIVILEGES FOR ROLE daypi_migrator IN SCHEMA public
        GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO daypi_app;
      ALTER DEFAULT PRIVILEGES FOR ROLE daypi_migrator IN SCHEMA public
        GRANT USAGE, SELECT ON SEQUENCES TO daypi_app;
      CREATE EXTENSION IF NOT EXISTS citext;
      CREATE EXTENSION IF NOT EXISTS pgcrypto;
    `);
  } finally {
    await client.end();
  }
}

export async function setupFixtures(): Promise<Fixtures> {
  const migratorUrl =
    process.env.TEST_MIGRATION_DATABASE_URL ||
    process.env.MIGRATION_DATABASE_URL ||
    'postgresql://daypi_migrator:daypi_migrator_dev@127.0.0.1:5432/daypi_test';
  const appUrl =
    process.env.TEST_DATABASE_URL ||
    'postgresql://daypi_app:daypi_app_dev@127.0.0.1:5432/daypi_test';

  process.env.DATABASE_URL = appUrl;
  process.env.MIGRATION_DATABASE_URL = migratorUrl;
  process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret-32chars!!';
  process.env.ALLOWED_HOSTS = 'localhost,127.0.0.1';
  process.env.CORS_ORIGINS = 'http://localhost:3000';
  process.env.STORAGE_LOCAL_ROOT = './.data/test-storage';
  process.env.NODE_ENV = 'test';
  resetConfigCache();

  await resetDatabase(migratorUrl);
  await applyMigrations(migratorUrl);

  const pool = createPool(appUrl, { max: 5 });
  const config = loadConfig();
  const app = createApp(pool, config);

  const password = 'Passw0rd!dev';
  const passwordHash = await hashPassword(password);
  const client = await pool.connect();

  let fixtures: Fixtures;
  try {
    await client.query('BEGIN');

    const ownerA = await client.query<{ id: string }>(
      `INSERT INTO users (email, password_hash) VALUES ('owner-a@example.test', $1) RETURNING id`,
      [passwordHash],
    );
    const ownerB = await client.query<{ id: string }>(
      `INSERT INTO users (email, password_hash) VALUES ('owner-b@example.test', $1) RETURNING id`,
      [passwordHash],
    );
    const parentA = await client.query<{ id: string }>(
      `INSERT INTO users (email, password_hash) VALUES ('parent-a@example.test', $1) RETURNING id`,
      [passwordHash],
    );

    const tenantA = await createTenantBootstrap(client, {
      displayName: 'Tenant A',
      ownerUserId: ownerA.rows[0]!.id,
    });
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantA.tenantId]);

    const parentMem = await client.query<{ id: string }>(
      `INSERT INTO memberships (tenant_id, user_id, role_template, status)
       VALUES ($1, $2, 'parent', 'active') RETURNING id`,
      [tenantA.tenantId, parentA.rows[0]!.id],
    );
    await seedMembershipGrants(client, tenantA.tenantId, parentMem.rows[0]!.id, 'parent');

    const childA1 = await client.query<{ id: string }>(
      `INSERT INTO children (tenant_id, given_name, family_name, date_of_birth, enrolment_status)
       VALUES ($1, 'Amelia', 'Ash', '2021-03-12', 'active') RETURNING id`,
      [tenantA.tenantId],
    );
    const childA2 = await client.query<{ id: string }>(
      `INSERT INTO children (tenant_id, given_name, family_name, date_of_birth, enrolment_status)
       VALUES ($1, 'Ben', 'Ash', '2019-08-01', 'active') RETURNING id`,
      [tenantA.tenantId],
    );
    const guardian = await client.query<{ id: string }>(
      `INSERT INTO guardians (tenant_id, user_id, given_name, family_name, email)
       VALUES ($1, $2, 'Pat', 'Ash', 'parent-a@example.test') RETURNING id`,
      [tenantA.tenantId, parentA.rows[0]!.id],
    );
    await client.query(
      `INSERT INTO child_guardian_relationships (
         tenant_id, child_id, guardian_id, relationship, access_level, has_parental_responsibility
       ) VALUES ($1, $2, $3, 'parent', 'full', true)`,
      [tenantA.tenantId, childA1.rows[0]!.id, guardian.rows[0]!.id],
    );

    const secret = randomBytes(16).toString('base64url');
    const secretHash = createHash('sha256').update(secret).digest('hex');
    const integ = await client.query<{ id: string }>(
      `INSERT INTO integration_clients (tenant_id, name, secret_hash, scopes)
       VALUES ($1, 'Client A', $2, $3) RETURNING id`,
      [tenantA.tenantId, secretHash, ['children.read', 'tenant.read']],
    );

    await client.query("SELECT set_config('app.tenant_id', '', true)");
    const tenantB = await createTenantBootstrap(client, {
      displayName: 'Tenant B',
      ownerUserId: ownerB.rows[0]!.id,
    });
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantB.tenantId]);
    const childB1 = await client.query<{ id: string }>(
      `INSERT INTO children (tenant_id, given_name, family_name, date_of_birth, enrolment_status)
       VALUES ($1, 'Casey', 'Brook', '2020-01-20', 'active') RETURNING id`,
      [tenantB.tenantId],
    );

    await client.query('COMMIT');

    fixtures = {
      pool,
      app,
      tenantA: tenantA.tenantId,
      tenantB: tenantB.tenantId,
      ownerA: { id: ownerA.rows[0]!.id, email: 'owner-a@example.test', password },
      ownerB: { id: ownerB.rows[0]!.id, email: 'owner-b@example.test', password },
      parentA: { id: parentA.rows[0]!.id, email: 'parent-a@example.test', password },
      childA1: childA1.rows[0]!.id,
      childA2: childA2.rows[0]!.id,
      childB1: childB1.rows[0]!.id,
      integrationTokenA: `client_${integ.rows[0]!.id}.${secret}`,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    client.release();
    await pool.end();
    throw err;
  }
  client.release();
  return fixtures;
}

export async function login(
  app: Express,
  email: string,
  password: string,
): Promise<string> {
  const res = await request(app)
    .post('/v1/auth/login')
    .set('Host', 'localhost')
    .send({ email, password });
  if (res.status !== 200) {
    throw new Error(`login failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.data.access_token as string;
}

export async function selectTenant(
  app: Express,
  token: string,
  tenantId: string,
): Promise<void> {
  const res = await request(app)
    .post('/v1/auth/tenant/select')
    .set('Host', 'localhost')
    .set('Authorization', `Bearer ${token}`)
    .send({ tenant_id: tenantId });
  if (res.status !== 200) {
    throw new Error(`select tenant failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
}

// lazy import to keep types happy
import request from 'supertest';
export { request };
