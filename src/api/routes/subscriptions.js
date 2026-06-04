import { db } from '../../db/client.js';
import { SubscriptionRepo } from '../../db/repos/SubscriptionRepo.js';
import logger from '../../logger.js';

/**
 * Subscription routes for tenant-facing plan page.
 * All routes here require authentication.
 */
export default async function subscriptionRoutes(fastify) {

  // GET /subscriptions/status — Get current subscription status for the tenant
  fastify.get('/subscriptions/status', async (request, reply) => {
    const tenantId = request.user?.tenant_id;
    if (!tenantId) {
      return reply.code(400).send({ error: 'tenant_id not found in user context' });
    }

    const sub = await SubscriptionRepo.findByTenantId(tenantId);

    if (!sub) {
      return {
        status: 'none',
        plan_name: null,
        billing_cycle: null,
        current_period_start: null,
        current_period_end: null,
        trial_ends_at: null,
      };
    }

    // Check if trial expired and update
    if (sub.status === 'trial' && sub.trial_ends_at && new Date(sub.trial_ends_at) < new Date()) {
      await SubscriptionRepo.updateStatus(tenantId, 'expired');
      sub.status = 'expired';
    }

    return {
      status: sub.status,
      plan_name: sub.plan_name || null,
      billing_cycle: sub.billing_cycle,
      current_period_start: sub.current_period_start,
      current_period_end: sub.current_period_end,
      trial_ends_at: sub.trial_ends_at,
      plan_id: sub.plan_id,
      email_limit: sub.email_limit,
      imap_limit: sub.imap_limit,
    };
  });

  // GET /subscriptions/plans — Get available plans (public-ish, but authenticated for tenant context)
  fastify.get('/subscriptions/plans', async (request, reply) => {
    const { rows: plans } = await db.query(
      'SELECT id, name, description, price_monthly, price_yearly, email_limit, imap_limit FROM plans WHERE active = true ORDER BY email_limit ASC'
    );

    // Get current subscription to mark current plan
    const tenantId = request.user?.tenant_id;
    let currentPlanId = null;
    if (tenantId) {
      const sub = await SubscriptionRepo.findByTenantId(tenantId);
      if (sub && (sub.status === 'active' || sub.status === 'trial')) {
        currentPlanId = sub.plan_id;
      }
    }

    return {
      plans,
      current_plan_id: currentPlanId,
    };
  });
}
