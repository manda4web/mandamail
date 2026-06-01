import Stripe from 'stripe';
import { db } from '../../db/client.js';
import logger from '../../logger.js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

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

    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const { tenant_id, plan_id, billing_cycle, coupon_id } = session.metadata || {};

        if (tenant_id && plan_id) {
          // Create or update subscription record
          await db.query(
            `INSERT INTO subscriptions (tenant_id, plan_id, billing_cycle, status, stripe_subscription_id, stripe_customer_id, coupon_id, current_period_start, current_period_end)
             VALUES ($1, $2, $3, 'active', $4, $5, $6, NOW(), NOW() + INTERVAL '1 month')
             ON CONFLICT (tenant_id) DO UPDATE SET
               plan_id = $2, billing_cycle = $3, status = 'active',
               stripe_subscription_id = $4, stripe_customer_id = $5,
               coupon_id = $6, current_period_start = NOW(),
               current_period_end = NOW() + INTERVAL '1 month', updated_at = NOW()`,
            [tenant_id, plan_id, billing_cycle || 'monthly', session.subscription, session.customer, coupon_id || null]
          );

          // Update tenant plan
          await db.query('UPDATE tenants SET plan = $1 WHERE id = $2', [plan_id, tenant_id]);

          // Increment coupon usage
          if (coupon_id) {
            await db.query('UPDATE coupons SET current_uses = current_uses + 1 WHERE id = $1', [coupon_id]);
          }

          logger.info({ tenant_id, plan_id }, '[Stripe] Subscription activated');
        }
        break;
      }

      case 'customer.subscription.updated': {
        const sub = event.data.object;
        const tenantId = sub.metadata?.tenant_id;
        if (tenantId) {
          const status = sub.status === 'active' ? 'active' : sub.status === 'past_due' ? 'past_due' : sub.status;
          await db.query(
            'UPDATE subscriptions SET status = $1, updated_at = NOW() WHERE stripe_subscription_id = $2',
            [status, sub.id]
          );
        }
        break;
      }

      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        await db.query(
          'UPDATE subscriptions SET status = $1, canceled_at = NOW(), updated_at = NOW() WHERE stripe_subscription_id = $2',
          ['canceled', sub.id]
        );
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
}
