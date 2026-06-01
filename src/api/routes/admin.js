import { db } from '../../db/client.js';
import logger from '../../logger.js';

const ADMIN_DOMAIN = 'manda4.bitrix24.com.br';

/**
 * Middleware: only allow access from the admin portal (manda4.bitrix24.com.br)
 */
async function requireAdmin(request, reply) {
  if (!request.user) {
    return reply.code(401).send({ error: 'Authentication required' });
  }
  // Check if the user's tenant is the admin portal
  const { rows } = await db.query(
    'SELECT bitrix_url FROM tenants WHERE id = (SELECT tenant_id FROM user_tenants WHERE user_id = $1 LIMIT 1)',
    [request.user.id]
  );
  const isAdmin = rows.some(r => r.bitrix_url && r.bitrix_url.includes(ADMIN_DOMAIN));
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
