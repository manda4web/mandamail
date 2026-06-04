import { db } from '../client.js';

/**
 * Repository for subscription-related database operations.
 */
export const SubscriptionRepo = {
  /**
   * Find the subscription for a tenant (there's a unique index on tenant_id).
   * @param {string} tenantId
   * @returns {Promise<Object|null>}
   */
  async findByTenantId(tenantId) {
    const { rows } = await db.query(
      `SELECT s.*, p.name as plan_name, p.email_limit, p.imap_limit
       FROM subscriptions s
       LEFT JOIN plans p ON p.id = s.plan_id
       WHERE s.tenant_id = $1`,
      [tenantId]
    );
    return rows[0] || null;
  },

  /**
   * Create a trial subscription for a new tenant.
   * @param {string} tenantId
   * @returns {Promise<Object>}
   */
  async createTrial(tenantId) {
    const { rows } = await db.query(
      `INSERT INTO subscriptions (tenant_id, status, trial_ends_at)
       VALUES ($1, 'trial', NOW() + INTERVAL '14 days')
       ON CONFLICT (tenant_id) DO NOTHING
       RETURNING *`,
      [tenantId]
    );
    // If conflict (already exists), return existing
    if (!rows[0]) {
      return this.findByTenantId(tenantId);
    }
    return rows[0];
  },

  /**
   * Update subscription status.
   * @param {string} tenantId
   * @param {string} status
   * @returns {Promise<Object|null>}
   */
  async updateStatus(tenantId, status) {
    const { rows } = await db.query(
      `UPDATE subscriptions SET status = $1, updated_at = NOW() WHERE tenant_id = $2 RETURNING *`,
      [status, tenantId]
    );
    return rows[0] || null;
  },

  /**
   * Find subscription by stripe_subscription_id.
   * @param {string} stripeSubId
   * @returns {Promise<Object|null>}
   */
  async findByStripeSubscriptionId(stripeSubId) {
    const { rows } = await db.query(
      'SELECT * FROM subscriptions WHERE stripe_subscription_id = $1',
      [stripeSubId]
    );
    return rows[0] || null;
  },

  /**
   * Check if a tenant has an active or valid trial subscription.
   * Returns { allowed: boolean, reason: string }
   */
  async checkAccess(tenantId) {
    const sub = await this.findByTenantId(tenantId);

    if (!sub) {
      return { allowed: false, reason: 'NO_SUBSCRIPTION' };
    }

    const now = new Date();

    switch (sub.status) {
      case 'active': {
        if (sub.current_period_end && new Date(sub.current_period_end) > now) {
          return { allowed: true, reason: 'ACTIVE' };
        }
        // Period ended but status not updated yet — still allow (webhook may be delayed)
        return { allowed: true, reason: 'ACTIVE' };
      }

      case 'trial': {
        if (sub.trial_ends_at && new Date(sub.trial_ends_at) > now) {
          return { allowed: true, reason: 'TRIAL' };
        }
        // Trial expired — update status
        await this.updateStatus(tenantId, 'expired');
        return { allowed: false, reason: 'TRIAL_EXPIRED' };
      }

      case 'past_due': {
        // Grace period: 7 days after current_period_end
        if (sub.current_period_end) {
          const graceEnd = new Date(sub.current_period_end);
          graceEnd.setDate(graceEnd.getDate() + 7);
          if (now <= graceEnd) {
            return { allowed: true, reason: 'PAST_DUE_GRACE' };
          }
        }
        return { allowed: false, reason: 'PAST_DUE_EXPIRED' };
      }

      case 'canceled':
        return { allowed: false, reason: 'CANCELED' };

      case 'expired':
        return { allowed: false, reason: 'EXPIRED' };

      default:
        return { allowed: false, reason: 'UNKNOWN_STATUS' };
    }
  },
};
