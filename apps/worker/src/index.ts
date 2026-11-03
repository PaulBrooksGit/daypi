import { loadConfig } from '../../../platform/config/src/index.js';
import { createPool, withTenant } from '../../../platform/db/src/index.js';
import { OutboxWorker } from '../../../platform/jobs/src/index.js';
import { sendMessageInTx } from '../../../modules/messaging/src/index.js';

async function main() {
  const config = loadConfig();
  const pool = createPool(config.DATABASE_URL);

  const worker = new OutboxWorker(pool, {
    pollIntervalMs: 1000,
    handlers: {
      'demo.echo': async () => {
        /* success no-op */
      },
      'storage.scan': async (event) => {
        const objectId = (event.payload as { objectId?: string }).objectId;
        if (!event.tenant_id || !objectId) return;
        await withTenant(event.tenant_id, async (db) => {
          await db.query(
            `UPDATE stored_objects SET scan_status = 'clean'
             WHERE id = $1 AND scan_status = 'pending'`,
            [objectId],
          );
        }, pool);
      },
      'messages.send_sandbox': async (event) => {
        const messageId = (event.payload as { messageId?: string }).messageId;
        if (!event.tenant_id || !messageId) return;
        // Worker already wraps tenant context; call DB work via nested withTenant is fine.
        await withTenant(event.tenant_id, async (db) => {
          await sendMessageInTx(db, { tenantId: event.tenant_id!, messageId });
        }, pool);
      },
      'payments.sandbox_intent_created': async () => {
        /* Intent recorded; settlement arrives via Stripe sandbox webhook. */
      },
      'demo.fail_once': async (event) => {
        const attempts = event.attempt_count;
        if (attempts <= 1) {
          throw new Error('simulated provider failure');
        }
      },
    },
  });

  worker.start();
  console.info('DayPush worker started');

  const shutdown = () => {
    worker.stop();
    void pool.end().then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
