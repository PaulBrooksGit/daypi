import { createHmac, timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import type { DbPool } from '../../../../platform/db/src/index.js';
import type { AppConfig } from '../../../../platform/config/src/index.js';
import { processStripeSandboxWebhook } from '../../../../modules/finance/src/index.js';
import { processTwilioSandboxWebhook } from '../../../../modules/messaging/src/index.js';

function verifyHmacSha256(secret: string, rawBody: string, signature: string): boolean {
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  const provided = signature.replace(/^sha256=/, '');
  try {
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(provided, 'utf8');
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export function webhookRoutes(pool: DbPool, config: AppConfig): Router {
  const router = Router();

  router.post('/webhooks/stripe', async (req, res, next) => {
    try {
      if (config.FEATURE_STRIPE_LIVE) {
        res.status(403).json({
          error: {
            code: 'FEATURE_DISABLED',
            message: 'Live Stripe webhooks disabled pending D05',
          },
        });
        return;
      }

      const body = z
        .object({
          id: z.string().min(1),
          type: z.string().min(1),
          data: z.record(z.unknown()).optional(),
          provider_payment_intent_id: z.string().optional(),
        })
        .passthrough()
        .parse(req.body);

      const raw = JSON.stringify(req.body);
      const signature = req.header('stripe-signature') ?? req.header('x-daypi-sandbox-signature') ?? '';
      const signatureValid =
        !config.STRIPE_WEBHOOK_SECRET ||
        verifyHmacSha256(config.STRIPE_WEBHOOK_SECRET, raw, signature);

      const result = await processStripeSandboxWebhook(
        {
          providerEventId: body.id,
          eventType: body.type,
          payload: body as Record<string, unknown>,
          signatureValid,
        },
        pool,
      );

      res.json({ data: result });
    } catch (err) {
      next(err);
    }
  });

  router.post('/webhooks/twilio', async (req, res, next) => {
    try {
      const body = z
        .object({
          id: z.string().min(1).optional(),
          MessageSid: z.string().optional(),
          MessageStatus: z.string().optional(),
          message_sid: z.string().optional(),
          status: z.string().optional(),
          recipient_sid: z.string().optional(),
        })
        .passthrough()
        .parse(req.body);

      const providerEventId =
        body.id ??
        `twilio_${body.MessageSid ?? body.message_sid}_${body.MessageStatus ?? body.status}`;

      const raw = JSON.stringify(req.body);
      const signature = req.header('x-twilio-signature') ?? req.header('x-daypi-sandbox-signature') ?? '';
      const signatureValid =
        !config.TWILIO_WEBHOOK_SECRET ||
        verifyHmacSha256(config.TWILIO_WEBHOOK_SECRET, raw, signature);

      const result = await processTwilioSandboxWebhook(
        {
          providerEventId,
          payload: body as Record<string, unknown>,
          signatureValid,
        },
        pool,
      );

      res.json({ data: result });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
