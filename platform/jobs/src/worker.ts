import type { DbPool } from '../../db/src/pool.js';
import { withTenant } from '../../db/src/with-tenant.js';
import {
  claimOutboxBatch,
  markOutboxDone,
  markOutboxRetry,
  recordJobAttempt,
  type ClaimedOutboxEvent,
} from './outbox.js';

export type JobHandler = (event: ClaimedOutboxEvent) => Promise<void>;

export interface WorkerOptions {
  pollIntervalMs?: number;
  batchSize?: number;
  maxAttempts?: number;
  handlers?: Record<string, JobHandler>;
}

/**
 * DayPush worker skeleton: polls outbox, sets explicit tenant context per job,
 * records attempts, retries with backoff.
 */
export class OutboxWorker {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly handlers: Record<string, JobHandler>;

  constructor(
    private readonly pool: DbPool,
    private readonly options: WorkerOptions = {},
  ) {
    this.handlers = options.handlers ?? {
      'demo.echo': async () => undefined,
      'storage.scan': async () => undefined,
    };
  }

  start(): void {
    if (this.timer) return;
    const interval = this.options.pollIntervalMs ?? 1000;
    this.timer = setInterval(() => {
      void this.tick();
    }, interval);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const client = await this.pool.connect();
      let events: ClaimedOutboxEvent[] = [];
      try {
        await client.query('BEGIN');
        events = await claimOutboxBatch(client, this.options.batchSize ?? 10);
        await client.query('COMMIT');
      } catch (err) {
        try {
          await client.query('ROLLBACK');
        } catch {
          /* ignore */
        }
        throw err;
      } finally {
        client.release();
      }

      for (const event of events) {
        await this.processOne(event);
      }
      return events.length;
    } finally {
      this.running = false;
    }
  }

  private async processOne(event: ClaimedOutboxEvent): Promise<void> {
    const maxAttempts = this.options.maxAttempts ?? 8;
    const handler = this.handlers[event.event_type];

    try {
      if (!handler) throw new Error(`No handler for ${event.event_type}`);

      if (event.tenant_id) {
        await withTenant(
          event.tenant_id,
          async (db) => {
            await handler(event);
            await markOutboxDone(db, event.id);
            await recordJobAttempt(db, event.id, event.attempt_count, null);
          },
          this.pool,
        );
      } else {
        const client = await this.pool.connect();
        try {
          await client.query('BEGIN');
          await handler(event);
          await markOutboxDone(client, event.id);
          await recordJobAttempt(client, event.id, event.attempt_count, null);
          await client.query('COMMIT');
        } catch (err) {
          try {
            await client.query('ROLLBACK');
          } catch {
            /* ignore */
          }
          throw err;
        } finally {
          client.release();
        }
      }
    } catch (err) {
      const summary = err instanceof Error ? err.message : String(err);
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        await recordJobAttempt(client, event.id, event.attempt_count, summary);
        await markOutboxRetry(client, event.id, summary, event.attempt_count, maxAttempts);
        await client.query('COMMIT');
      } catch {
        try {
          await client.query('ROLLBACK');
        } catch {
          /* ignore */
        }
      } finally {
        client.release();
      }
    }
  }
}
