import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupFixtures, type Fixtures } from './helpers.js';
import { withTenant } from '../../platform/db/src/index.js';
import { enqueueOutbox, OutboxWorker } from '../../platform/jobs/src/index.js';

describe('outbox worker isolation and retry', () => {
  let fx: Fixtures;

  beforeAll(async () => {
    fx = await setupFixtures();
  }, 120_000);

  afterAll(async () => {
    await fx.pool.end();
  });

  it('retries after simulated provider failure then succeeds', async () => {
    const eventId = await withTenant(fx.tenantA, async (db) => {
      return enqueueOutbox(db, {
        tenantId: fx.tenantA,
        aggregateType: 'demo',
        eventType: 'demo.fail_once',
        payload: { n: 1 },
      });
    }, fx.pool);

    let failCount = 0;
    const worker = new OutboxWorker(fx.pool, {
      maxAttempts: 5,
      handlers: {
        'demo.fail_once': async () => {
          failCount += 1;
          if (failCount === 1) throw new Error('simulated provider failure');
        },
      },
    });

    await worker.tick();
    // make available immediately for retry
    await withTenant(fx.tenantA, async (db) => {
      await db.query(`UPDATE outbox_events SET available_at = now() WHERE id = $1`, [eventId]);
    }, fx.pool);
    await worker.tick();

    const status = await withTenant(fx.tenantA, async (db) => {
      const r = await db.query<{ status: string; attempt_count: number }>(
        `SELECT status, attempt_count FROM outbox_events WHERE id = $1`,
        [eventId],
      );
      return r.rows[0]!;
    }, fx.pool);

    expect(status.status).toBe('done');
    expect(status.attempt_count).toBeGreaterThanOrEqual(2);

    const attempts = await withTenant(fx.tenantA, async (db) => {
      // job_attempts is not RLS tenant-scoped — query via outbox id
      const r = await db.query(
        `SELECT attempt_no, error_summary FROM job_attempts WHERE outbox_event_id = $1 ORDER BY attempt_no`,
        [eventId],
      );
      return r.rows;
    }, fx.pool);
    expect(attempts.length).toBeGreaterThanOrEqual(1);
  });

  it('worker tenant context cannot read other tenant children', async () => {
    let sawForeign = false;
    const eventId = await withTenant(fx.tenantA, async (db) => {
      return enqueueOutbox(db, {
        tenantId: fx.tenantA,
        aggregateType: 'demo',
        eventType: 'demo.isolation_check',
        payload: {},
      });
    }, fx.pool);

    const worker = new OutboxWorker(fx.pool, {
      handlers: {
        'demo.isolation_check': async (event) => {
          await withTenant(event.tenant_id!, async (db) => {
            const r = await db.query(`SELECT id FROM children WHERE id = $1`, [fx.childB1]);
            sawForeign = r.rowCount! > 0;
          }, fx.pool);
        },
      },
    });

    await worker.tick();
    expect(sawForeign).toBe(false);

    const status = await withTenant(fx.tenantA, async (db) => {
      const r = await db.query(`SELECT status FROM outbox_events WHERE id = $1`, [eventId]);
      return r.rows[0]?.status;
    }, fx.pool);
    expect(status).toBe('done');
  });
});
