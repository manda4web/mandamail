import { db } from '../../db/client.js';
import logger from '../../logger.js';

const ADMIN_DOMAIN = process.env.ADMIN_PORTAL_DOMAIN || 'manda4.bitrix24.com.br';

/**
 * Middleware: only allow access from the admin portal (manda4.bitrix24.com.br).
 * Hostname comparison is EXACT (no substring) across ALL the user's tenants.
 */
async function requireAdmin(request, reply) {
  if (!request.user) {
    return reply.code(401).send({ error: 'Authentication required' });
  }
  const { rows } = await db.query(
    `SELECT t.bitrix_url FROM tenants t
     JOIN user_tenants ut ON ut.tenant_id = t.id
     WHERE ut.user_id = $1`,
    [request.user.id]
  );
  const isAdmin = rows.some(r => {
    try {
      return new URL(r.bitrix_url).hostname === ADMIN_DOMAIN;
    } catch {
      return false;
    }
  });
  if (!isAdmin && request.user.role !== 'admin') {
    return reply.code(403).send({ error: 'Admin access required' });
  }
}

export default async function adminRoutes(fastify) {
  // ===== PLANS =====

  fastify.get('/admin/plans', { preHandler: [requireAdmin] }, async (request, reply) => {
    const { rows } = await db.query('SELECT * FROM plans ORDER BY email_limit ASC');
    return rows;
  });

  fastify.post('/admin/plans', { preHandler: [requireAdmin] }, async (request, reply) => {
    const { name, description, price_monthly, price_yearly, email_limit, imap_limit, stripe_price_monthly, stripe_price_yearly } = request.body;
    if (!name || !price_monthly) {
      return reply.code(400).send({ error: 'name and price_monthly are required' });
    }
    const { rows } = await db.query(
      `INSERT INTO plans (name, description, price_monthly, price_yearly, email_limit, imap_limit, stripe_price_monthly, stripe_price_yearly)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [name, description || '', price_monthly, price_yearly || 0, email_limit || 5000, imap_limit || 50, stripe_price_monthly || null, stripe_price_yearly || null]
    );
    return reply.code(201).send(rows[0]);
  });

  fastify.patch('/admin/plans/:planId', { preHandler: [requireAdmin] }, async (request, reply) => {
    const { planId } = request.params;
    const data = request.body || {};
    const allowed = ['name', 'description', 'price_monthly', 'price_yearly', 'email_limit', 'imap_limit', 'stripe_price_monthly', 'stripe_price_yearly', 'active'];
    const sets = [];
    const values = [];
    let idx = 1;
    for (const field of allowed) {
      if (data[field] !== undefined) {
        sets.push(`${field} = $${idx++}`);
        values.push(data[field]);
      }
    }
    if (sets.length === 0) return reply.code(400).send({ error: 'No fields to update' });
    sets.push(`updated_at = NOW()`);
    values.push(planId);
    const { rows } = await db.query(
      `UPDATE plans SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`,
      values
    );
    return rows[0] || reply.code(404).send({ error: 'Plan not found' });
  });

  fastify.delete('/admin/plans/:planId', { preHandler: [requireAdmin] }, async (request, reply) => {
    await db.query('DELETE FROM plans WHERE id = $1', [request.params.planId]);
    return reply.code(204).send();
  });

  // ===== COUPONS =====

  fastify.get('/admin/coupons', { preHandler: [requireAdmin] }, async (request, reply) => {
    const { rows } = await db.query('SELECT * FROM coupons ORDER BY created_at DESC');
    return rows;
  });

  fastify.post('/admin/coupons', { preHandler: [requireAdmin] }, async (request, reply) => {
    const { code, description, discount_type, discount_value, max_uses, valid_from, valid_until } = request.body;
    if (!code || !discount_value) {
      return reply.code(400).send({ error: 'code and discount_value are required' });
    }
    const { rows } = await db.query(
      `INSERT INTO coupons (code, description, discount_type, discount_value, max_uses, valid_from, valid_until)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [code.toUpperCase(), description || '', discount_type || 'percent', discount_value, max_uses || null, valid_from || null, valid_until || null]
    );
    return reply.code(201).send(rows[0]);
  });

  fastify.patch('/admin/coupons/:couponId', { preHandler: [requireAdmin] }, async (request, reply) => {
    const { couponId } = request.params;
    const { active } = request.body;
    if (active === undefined) return reply.code(400).send({ error: 'active field required' });
    const { rows } = await db.query(
      'UPDATE coupons SET active = $1 WHERE id = $2 RETURNING *',
      [active, couponId]
    );
    return rows[0] || reply.code(404).send({ error: 'Coupon not found' });
  });

  fastify.delete('/admin/coupons/:couponId', { preHandler: [requireAdmin] }, async (request, reply) => {
    await db.query('DELETE FROM coupons WHERE id = $1', [request.params.couponId]);
    return reply.code(204).send();
  });

  // ===== SUBSCRIPTIONS (admin view) =====

  fastify.get('/admin/subscriptions', { preHandler: [requireAdmin] }, async (request, reply) => {
    const { rows } = await db.query(
      `SELECT s.*, t.name as tenant_name, t.bitrix_url, p.name as plan_name
       FROM subscriptions s
       JOIN tenants t ON t.id = s.tenant_id
       LEFT JOIN plans p ON p.id = s.plan_id
       ORDER BY s.created_at DESC`
    );
    return rows;
  });

  // PATCH /admin/subscriptions/:tenantId — manually change a tenant's plan/status
  fastify.patch('/admin/subscriptions/:tenantId', { preHandler: [requireAdmin] }, async (request, reply) => {
    const { tenantId } = request.params;
    const { plan_id, status, billing_cycle, current_period_end } = request.body || {};

    const allowed = [];
    const values = [];
    let idx = 1;
    if (plan_id !== undefined) { allowed.push(`plan_id = $${idx++}`); values.push(plan_id || null); }
    if (status !== undefined) {
      if (!['trial', 'active', 'canceled', 'past_due', 'expired'].includes(status)) {
        return reply.code(400).send({ error: 'Invalid status' });
      }
      allowed.push(`status = $${idx++}`); values.push(status);
    }
    if (billing_cycle !== undefined) { allowed.push(`billing_cycle = $${idx++}`); values.push(billing_cycle); }
    if (current_period_end !== undefined) { allowed.push(`current_period_end = $${idx++}`); values.push(current_period_end || null); }

    if (allowed.length === 0) return reply.code(400).send({ error: 'No fields to update' });

    allowed.push('updated_at = NOW()');
    values.push(tenantId);

    // Upsert: if no subscription exists, create one
    const { rows: existing } = await db.query('SELECT id FROM subscriptions WHERE tenant_id = $1', [tenantId]);
    if (existing.length === 0) {
      await db.query(
        `INSERT INTO subscriptions (tenant_id, plan_id, status, billing_cycle, current_period_end)
         VALUES ($1, $2, $3, $4, $5)`,
        [tenantId, plan_id || null, status || 'active', billing_cycle || 'monthly', current_period_end || null]
      );
    } else {
      await db.query(
        `UPDATE subscriptions SET ${allowed.join(', ')} WHERE tenant_id = $${idx}`,
        values
      );
    }

    // Restart/stop workers based on new status
    try {
      const { TenantScheduler } = await import('../../imap/TenantScheduler.js');
      if (status === 'active' || status === 'trial') {
        await TenantScheduler.startTenant(tenantId);
      } else if (status === 'canceled' || status === 'expired') {
        await TenantScheduler.handleSubscriptionInactive(tenantId, 'admin_' + status);
      }
    } catch (err) {
      logger.error(`[Admin] Failed to update workers for tenant ${tenantId}: ${err.message}`);
    }

    const { rows } = await db.query(
      `SELECT s.*, t.name as tenant_name, t.bitrix_url, p.name as plan_name
       FROM subscriptions s JOIN tenants t ON t.id = s.tenant_id
       LEFT JOIN plans p ON p.id = s.plan_id WHERE s.tenant_id = $1`,
      [tenantId]
    );
    logger.info({ tenantId, status, plan_id }, '[Admin] Subscription manually updated');
    return rows[0];
  });

  // ===== PUBLIC: Get plans (for tenant plan page) =====
  fastify.get('/plans', async (request, reply) => {
    const { rows } = await db.query('SELECT id, name, description, price_monthly, price_yearly, email_limit, imap_limit FROM plans WHERE active = true ORDER BY email_limit ASC');
    return rows;
  });

  // ===== VALIDATE COUPON =====
  fastify.post('/coupons/validate', async (request, reply) => {
    const { code } = request.body || {};
    if (!code) return reply.code(400).send({ error: 'code is required' });

    const { rows } = await db.query(
      'SELECT * FROM coupons WHERE UPPER(code) = UPPER($1) AND active = true',
      [code]
    );
    const coupon = rows[0];
    if (!coupon) return reply.code(404).send({ error: 'Cupom não encontrado ou inativo' });

    // Check usage limit
    if (coupon.max_uses && coupon.current_uses >= coupon.max_uses) {
      return reply.code(400).send({ error: 'Cupom esgotado' });
    }

    // Check validity dates
    const now = new Date();
    if (coupon.valid_from && new Date(coupon.valid_from) > now) {
      return reply.code(400).send({ error: 'Cupom ainda não é válido' });
    }
    if (coupon.valid_until && new Date(coupon.valid_until) < now) {
      return reply.code(400).send({ error: 'Cupom expirado' });
    }

    return { valid: true, discount_type: coupon.discount_type, discount_value: coupon.discount_value, id: coupon.id };
  });
}
