import Stripe from 'stripe';
import { db } from '../../db/client.js';
import { TenantScheduler } from '../../imap/TenantScheduler.js';
import logger from '../../logger.js';

// Instantiate with a placeholder when the key is missing so the app can boot
// (Stripe routes fail at call time with a clear error instead of crashing
// startup/tests in environments without billing configured).
const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
if (!stripeSecretKey) {
  logger.warn('STRIPE_SECRET_KEY not configured — Stripe billing routes will fail until it is set');
}
const stripe = new Stripe(stripeSecretKey || 'MISSING_STRIPE_KEY_PLACEHOLDER');

/**
 * Stripe routes: checkout session creation and webhook handling.
 * Webhook route is public (no auth) — verified by Stripe signature.
 */
export default async function stripeRoutes(fastify) {

  // POST /stripe/checkout — Create a Stripe Checkout Session
  fastify.post('/stripe/checkout', async (request, reply) => {
    const { plan_id, billing_cycle, tenant_id, coupon_code } = request.body || {};

    if (!plan_id || !tenant_id) {
      return reply.code(400).send({ error: 'plan_id and tenant_id are required' });
    }

    // Get plan
    const { rows: plans } = await db.query('SELECT * FROM plans WHERE id = $1 AND active = true', [plan_id]);
    const plan = plans[0];
    if (!plan) return reply.code(404).send({ error: 'Plan not found' });

    // Determine price ID
    const cycle = billing_cycle === 'yearly' ? 'yearly' : 'monthly';
    const priceId = cycle === 'yearly' ? plan.stripe_price_yearly : plan.stripe_price_monthly;
    if (!priceId) return reply.code(400).send({ error: `No Stripe Price ID configured for ${cycle} billing` });

    // Get tenant
    const { rows: tenants } = await db.query('SELECT * FROM tenants WHERE id = $1', [tenant_id]);
    const tenant = tenants[0];
    if (!tenant) return reply.code(404).send({ error: 'Tenant not found' });

    // Build checkout session params
    const sessionParams = {
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `https://mandamail.manda4.com.br/bitrix/app?DOMAIN=${tenant.bitrix_url.replace('https://', '')}&checkout=success`,
      cancel_url: `https://mandamail.manda4.com.br/bitrix/app?DOMAIN=${tenant.bitrix_url.replace('https://', '')}&checkout=cancel`,
      metadata: {
        tenant_id,
        plan_id,
        billing_cycle: cycle,
      },
      subscription_data: {
        metadata: { tenant_id, plan_id },
      },
    };

    // Apply coupon if provided
    if (coupon_code) {
      const { rows: coupons } = await db.query(
        'SELECT * FROM coupons WHERE UPPER(code) = UPPER($1) AND active = true',
        [coupon_code]
      );
      const coupon = coupons[0];
      if (coupon) {
        // Check validity
        const now = new Date();
        const valid = (!coupon.max_uses || coupon.current_uses < coupon.max_uses)
          && (!coupon.valid_from || new Date(coupon.valid_from) <= now)
          && (!coupon.valid_until || new Date(coupon.valid_until) >= now);

        if (valid) {
          // Create Stripe coupon on-the-fly
          const stripeCoupon = await stripe.coupons.create({
            percent_off: coupon.discount_type === 'percent' ? coupon.discount_value : undefined,
            amount_off: coupon.discount_type === 'fixed' ? coupon.discount_value : undefined,
            currency: coupon.discount_type === 'fixed' ? 'brl' : undefined,
            duration: 'once',
            name: coupon.code,
          });
          sessionParams.discounts = [{ coupon: stripeCoupon.id }];
          sessionParams.metadata.coupon_id = coupon.id;
        }
      }
    }

    // Find or create Stripe customer
    let customerId;
    const { rows: subs } = await db.query(
      'SELECT stripe_customer_id FROM subscriptions WHERE tenant_id = $1 AND stripe_customer_id IS NOT NULL LIMIT 1',
      [tenant_id]
    );
    if (subs[0]?.stripe_customer_id) {
      customerId = subs[0].stripe_customer_id;
    } else {
      const customer = await stripe.customers.create({
        name: tenant.name,
        metadata: { tenant_id, bitrix_url: tenant.bitrix_url },
      });
      customerId = customer.id;
    }
    sessionParams.customer = customerId;

    const session = await stripe.checkout.sessions.create(sessionParams);

    return { url: session.url, session_id: session.id };
  });

  // POST /stripe/webhook — Handle Stripe webhook events
  fastify.post('/stripe/webhook', {
    config: { rawBody: true },
  }, async (request, reply) => {
    const sig = request.headers['stripe-signature'];
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

    let event;
    try {
      // Fastify gives us the raw body for signature verification
      const rawBody = request.rawBody || request.body;
      const bodyStr = typeof rawBody === 'string' ? rawBody : JSON.stringify(rawBody);
      event = stripe.webhooks.constructEvent(bodyStr, sig, webhookSecret);
    } catch (err) {
      logger.error({ error: err.message }, '[Stripe] Webhook signature verification failed');
      return reply.code(400).send({ error: 'Invalid signature' });
    }

    logger.info({ type: event.type, id: event.id }, '[Stripe] Webhook received');

    // Idempotency: skip if this event was already processed (Stripe retries deliver
    // the same event multiple times, which would e.g. inflate coupon usage counts).
    try {
      const ins = await db.query(
        'INSERT INTO processed_stripe_events (event_id, type) VALUES ($1, $2) ON CONFLICT (event_id) DO NOTHING RETURNING event_id',
        [event.id, event.type]
      );
      if (ins.rowCount === 0) {
        logger.info({ id: event.id }, '[Stripe] Duplicate webhook event ignored');
        return { received: true, duplicate: true };
      }
    } catch (err) {
      logger.error({ error: err.message }, '[Stripe] Idempotency check failed');
      // Continue anyway — better to risk a rare double than to drop the event
    }

    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const { tenant_id, plan_id, billing_cycle, coupon_id } = session.metadata || {};

        if (tenant_id && plan_id) {
          // Period length depends on billing cycle (monthly vs yearly)
          const interval = billing_cycle === 'yearly' ? "1 year" : "1 month";
          // Create or update subscription record
          await db.query(
            `INSERT INTO subscriptions (tenant_id, plan_id, billing_cycle, status, stripe_subscription_id, stripe_customer_id, coupon_id, current_period_start, current_period_end)
             VALUES ($1, $2, $3, 'active', $4, $5, $6, NOW(), NOW() + ($7)::interval)
             ON CONFLICT (tenant_id) DO UPDATE SET
               plan_id = $2, billing_cycle = $3, status = 'active',
               stripe_subscription_id = $4, stripe_customer_id = $5,
               coupon_id = $6, current_period_start = NOW(),
               current_period_end = NOW() + ($7)::interval, updated_at = NOW()`,
            [tenant_id, plan_id, billing_cycle || 'monthly', session.subscription, session.customer, coupon_id || null, interval]
          );

          // Update tenant plan
          await db.query('UPDATE tenants SET plan = $1 WHERE id = $2', [plan_id, tenant_id]);

          // Increment coupon usage
          if (coupon_id) {
            await db.query('UPDATE coupons SET current_uses = current_uses + 1 WHERE id = $1', [coupon_id]);
          }

          // Start IMAP workers for this tenant (subscription now active)
          try {
            await TenantScheduler.startTenant(tenant_id);
          } catch (err) {
            logger.error(`[Stripe] Failed to start workers for tenant ${tenant_id}: ${err.message}`);
          }

          logger.info({ tenant_id, plan_id }, '[Stripe] Subscription activated');
        }
        break;
      }

      case 'customer.subscription.updated': {
        const sub = event.data.object;
        const status = sub.status === 'active' ? 'active' : sub.status === 'past_due' ? 'past_due' : sub.status;
        await db.query(
          'UPDATE subscriptions SET status = $1, current_period_start = $2, current_period_end = $3, updated_at = NOW() WHERE stripe_subscription_id = $4',
          [status, sub.current_period_start ? new Date(sub.current_period_start * 1000) : null, sub.current_period_end ? new Date(sub.current_period_end * 1000) : null, sub.id]
        );

        // Resolve tenant: prefer metadata, fallback to the subscription record
        let tenantId = sub.metadata?.tenant_id;
        if (!tenantId) {
          const { rows } = await db.query('SELECT tenant_id FROM subscriptions WHERE stripe_subscription_id = $1', [sub.id]);
          tenantId = rows[0]?.tenant_id;
        }

        if (tenantId) {
          try {
            if (status === 'active') {
              await TenantScheduler.startTenant(tenantId);
            } else if (status === 'canceled' || status === 'unpaid' || status === 'incomplete_expired') {
              await TenantScheduler.handleSubscriptionInactive(tenantId, status);
            }
          } catch (err) {
            logger.error(`[Stripe] Worker update failed for tenant ${tenantId}: ${err.message}`);
          }
          logger.info({ tenant_id: tenantId, status }, '[Stripe] Subscription updated');
        }
        break;
      }

      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        await db.query(
          'UPDATE subscriptions SET status = $1, canceled_at = NOW(), updated_at = NOW() WHERE stripe_subscription_id = $2',
          ['canceled', sub.id]
        );

        // Resolve tenant: prefer metadata, fallback to the subscription record
        let tenantId = sub.metadata?.tenant_id;
        if (!tenantId) {
          const { rows } = await db.query('SELECT tenant_id FROM subscriptions WHERE stripe_subscription_id = $1', [sub.id]);
          tenantId = rows[0]?.tenant_id;
        }

        // Stop IMAP workers for this tenant
        if (tenantId) {
          try {
            await TenantScheduler.handleSubscriptionInactive(tenantId, 'canceled');
          } catch (err) {
            logger.error(`[Stripe] Failed to stop workers for tenant ${tenantId}: ${err.message}`);
          }
        }
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        if (invoice.subscription) {
          await db.query(
            'UPDATE subscriptions SET status = $1, updated_at = NOW() WHERE stripe_subscription_id = $2',
            ['past_due', invoice.subscription]
          );
        }
        break;
      }
    }

    return { received: true };
  });

  // GET /stripe/portal — Create a Stripe Customer Portal session
  fastify.post('/stripe/portal', async (request, reply) => {
    const { tenant_id } = request.body || {};
    if (!tenant_id) return reply.code(400).send({ error: 'tenant_id required' });

    const { rows } = await db.query(
      'SELECT stripe_customer_id FROM subscriptions WHERE tenant_id = $1 AND stripe_customer_id IS NOT NULL LIMIT 1',
      [tenant_id]
    );
    if (!rows[0]?.stripe_customer_id) {
      return reply.code(404).send({ error: 'No subscription found' });
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: rows[0].stripe_customer_id,
      return_url: `https://mandamail.manda4.com.br/bitrix/app`,
    });

    return { url: session.url };
  });

  // POST /stripe/cancel — Cancel a subscription (stop billing at period end)
  fastify.post('/stripe/cancel', async (request, reply) => {
    const { tenant_id, immediate } = request.body || {};
    if (!tenant_id) return reply.code(400).send({ error: 'tenant_id required' });

    const { rows } = await db.query(
      'SELECT stripe_subscription_id, current_period_end FROM subscriptions WHERE tenant_id = $1',
      [tenant_id]
    );
    const sub = rows[0];
    if (!sub || !sub.stripe_subscription_id) {
      return reply.code(404).send({ error: 'Nenhuma assinatura ativa encontrada' });
    }

    try {
      if (immediate) {
        // Cancel immediately and stop billing now
        await stripe.subscriptions.cancel(sub.stripe_subscription_id);
        await db.query(
          "UPDATE subscriptions SET status = 'canceled', canceled_at = NOW(), updated_at = NOW() WHERE tenant_id = $1",
          [tenant_id]
        );
        try {
          const { TenantScheduler } = await import('../../imap/TenantScheduler.js');
          await TenantScheduler.handleSubscriptionInactive(tenant_id, 'canceled_by_user');
        } catch (e) { logger.error(`[Stripe] worker stop failed: ${e.message}`); }
      } else {
        // Cancel at period end — service stays active until current_period_end, no renewal
        await stripe.subscriptions.update(sub.stripe_subscription_id, { cancel_at_period_end: true });
        await db.query(
          "UPDATE subscriptions SET canceled_at = NOW(), updated_at = NOW() WHERE tenant_id = $1",
          [tenant_id]
        );
      }
      logger.info({ tenant_id, immediate: !!immediate }, '[Stripe] Subscription canceled by user');
      return { success: true, immediate: !!immediate, period_end: sub.current_period_end };
    } catch (err) {
      logger.error({ tenant_id, error: err.message }, '[Stripe] Cancel failed');
      return reply.code(502).send({ error: 'Não foi possível cancelar: ' + err.message });
    }
  });
}
