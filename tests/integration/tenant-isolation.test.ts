import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  setupFixtures,
  login,
  selectTenant,
  request,
  type Fixtures,
} from './helpers.js';
import { withTenant, readTenantSetting } from '../../platform/db/src/index.js';

describe('Phase 0 tenant isolation gate', () => {
  let fx: Fixtures;

  beforeAll(async () => {
    fx = await setupFixtures();
  }, 120_000);

  afterAll(async () => {
    await fx.pool.end();
  });

  it('rejects unrecognised hosts', async () => {
    const res = await request(fx.app).get('/v1/health').set('Host', 'daypi.example.evil.com');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('HOST_REJECTED');
  });

  it('tenant A cannot read tenant B child via API', async () => {
    const token = await login(fx.app, fx.ownerA.email, fx.ownerA.password);
    await selectTenant(fx.app, token, fx.tenantA);

    const res = await request(fx.app)
      .get(`/v1/children/${fx.childB1}`)
      .set('Host', 'localhost')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toMatch(/Casey|Brook/i);
  });

  it('tenant A cannot list tenant B children', async () => {
    const token = await login(fx.app, fx.ownerA.email, fx.ownerA.password);
    await selectTenant(fx.app, token, fx.tenantA);

    const res = await request(fx.app)
      .get('/v1/children')
      .set('Host', 'localhost')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    const names = res.body.data.map((c: { given_name: string }) => c.given_name);
    expect(names).toContain('Amelia');
    expect(names).not.toContain('Casey');
  });

  it('rejects forged cross-tenant child write at DB (composite FK / RLS)', async () => {
    await expect(
      withTenant(fx.tenantA, async (db) => {
        await db.query(
          `INSERT INTO child_guardian_relationships (
             tenant_id, child_id, guardian_id, relationship, access_level
           ) VALUES ($1, $2, $3, 'forged', 'full')`,
          [fx.tenantA, fx.childB1, fx.childA1],
        );
      }, fx.pool),
    ).rejects.toThrow();
  });

  it('RLS hides other tenant rows even with forged id in query', async () => {
    const rows = await withTenant(fx.tenantA, async (db) => {
      const r = await db.query(`SELECT given_name FROM children WHERE id = $1`, [fx.childB1]);
      return r.rows;
    }, fx.pool);
    expect(rows).toHaveLength(0);
  });

  it('missing tenant context fails closed', async () => {
    const client = await fx.pool.connect();
    try {
      await client.query('BEGIN');
      // no set_config
      await expect(client.query('SELECT * FROM children')).rejects.toThrow();
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  it('pooled connection does not leak prior tenant context', async () => {
    await withTenant(fx.tenantA, async (db) => {
      const r = await db.query('SELECT current_tenant_id() AS tid');
      expect(r.rows[0].tid).toBe(fx.tenantA);
    }, fx.pool);

    const client = await fx.pool.connect();
    try {
      const leaked = await readTenantSetting(client);
      expect(leaked).toBeNull();
      await client.query('BEGIN');
      await expect(client.query('SELECT count(*) FROM children')).rejects.toThrow();
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  it('parent sees only linked sibling', async () => {
    const token = await login(fx.app, fx.parentA.email, fx.parentA.password);
    await selectTenant(fx.app, token, fx.tenantA);

    const list = await request(fx.app)
      .get('/v1/children')
      .set('Host', 'localhost')
      .set('Authorization', `Bearer ${token}`);

    expect(list.status).toBe(200);
    const ids = list.body.data.map((c: { id: string }) => c.id);
    expect(ids).toContain(fx.childA1);
    expect(ids).not.toContain(fx.childA2);

    const denied = await request(fx.app)
      .get(`/v1/children/${fx.childA2}`)
      .set('Host', 'localhost')
      .set('Authorization', `Bearer ${token}`);
    expect([403, 404]).toContain(denied.status);
  });

  it('session for tenant A cannot act after switching without membership on B', async () => {
    const token = await login(fx.app, fx.ownerA.email, fx.ownerA.password);
    const switchRes = await request(fx.app)
      .post('/v1/auth/tenant/select')
      .set('Host', 'localhost')
      .set('Authorization', `Bearer ${token}`)
      .send({ tenant_id: fx.tenantB });
    expect(switchRes.status).toBe(403);
  });

  it('tenant A cannot fetch tenant B file even if object id guessed', async () => {
    const tokenB = await login(fx.app, fx.ownerB.email, fx.ownerB.password);
    await selectTenant(fx.app, tokenB, fx.tenantB);

    const upload = await request(fx.app)
      .post('/v1/files')
      .set('Host', 'localhost')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({
        content_type: 'text/plain',
        content_base64: Buffer.from('secret-b').toString('base64'),
        filename: 'b.txt',
      });
    expect(upload.status).toBe(201);
    const objectId = upload.body.data.id as string;

    const tokenA = await login(fx.app, fx.ownerA.email, fx.ownerA.password);
    await selectTenant(fx.app, tokenA, fx.tenantA);

    const steal = await request(fx.app)
      .get(`/v1/files/${objectId}`)
      .set('Host', 'localhost')
      .set('Authorization', `Bearer ${tokenA}`);

    expect(steal.status).toBe(404);
    expect(JSON.stringify(steal.body)).not.toMatch(/secret-b/);
  });

  it('integration client is tenant-bound', async () => {
    const res = await request(fx.app)
      .get('/v1/children')
      .set('Host', 'localhost')
      .set('Authorization', `Bearer ${fx.integrationTokenA}`);
    // client has children.read but must select tenant via activeTenantId from binding
    // Our middleware sets activeTenantId from client tenant — should work
    expect([200, 403]).toContain(res.status);
    if (res.status === 200) {
      const names = res.body.data.map((c: { given_name: string }) => c.given_name);
      expect(names).not.toContain('Casey');
    }
  });
});
