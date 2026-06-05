import { db } from '../client.js';

export const UserRepo = {
  async findByEmail(email) {
    const { rows } = await db.query(
      'SELECT * FROM users WHERE email = $1',
      [email]
    );
    return rows[0] || null;
  },

  async findById(id) {
    const { rows } = await db.query(
      'SELECT * FROM users WHERE id = $1',
      [id]
    );
    return rows[0] || null;
  },

  async findByBitrixUserIdAndTenant(bitrixUserId, tenantId) {
    const { rows } = await db.query(
      `SELECT u.* FROM users u
       JOIN user_tenants ut ON ut.user_id = u.id
       WHERE u.bitrix_user_id = $1 AND ut.tenant_id = $2`,
      [bitrixUserId, tenantId]
    );
    return rows[0] || null;
  },

  async create(data) {
    const { rows } = await db.query(
      'INSERT INTO users (email, password_hash, role, bitrix_user_id, display_name, is_bitrix_admin) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
      [data.email, data.password_hash, data.role || 'tenant_user', data.bitrix_user_id || null, data.display_name || null, data.is_bitrix_admin || false]
    );
    return rows[0];
  },

  async updateBitrixInfo(userId, { bitrix_user_id, display_name, is_bitrix_admin }) {
    const fields = [];
    const values = [];
    let idx = 1;

    if (bitrix_user_id !== undefined) { fields.push(`bitrix_user_id = $${idx++}`); values.push(bitrix_user_id); }
    if (display_name !== undefined) { fields.push(`display_name = $${idx++}`); values.push(display_name); }
    if (is_bitrix_admin !== undefined) { fields.push(`is_bitrix_admin = $${idx++}`); values.push(is_bitrix_admin); }

    if (fields.length === 0) return;

    values.push(userId);
    const { rows } = await db.query(
      `UPDATE users SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
      values
    );
    return rows[0];
  },

  async findTenantsByUser(userId) {
    const { rows } = await db.query(
      'SELECT tenant_id, role, is_admin FROM user_tenants WHERE user_id = $1',
      [userId]
    );
    return rows;
  },

  async addTenantAccess(userId, tenantId, role = 'owner', { is_admin = false, granted_by = null } = {}) {
    const { rows } = await db.query(
      `INSERT INTO user_tenants (user_id, tenant_id, role, is_admin, granted_by, granted_at)
       VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (user_id, tenant_id) DO UPDATE SET role = $3, is_admin = $4, granted_by = $5, granted_at = now()
       RETURNING *`,
      [userId, tenantId, role, is_admin, granted_by]
    );
    return rows[0];
  },

  async hasAccessToTenant(userId, tenantId) {
    const { rows } = await db.query(
      'SELECT 1 FROM user_tenants WHERE user_id = $1 AND tenant_id = $2',
      [userId, tenantId]
    );
    return rows.length > 0;
  },

  async isAdminOfTenant(userId, tenantId) {
    const { rows } = await db.query(
      `SELECT 1 FROM user_tenants WHERE user_id = $1 AND tenant_id = $2 AND (is_admin = true OR role = 'owner')`,
      [userId, tenantId]
    );
    return rows.length > 0;
  },

  async findUsersByTenant(tenantId) {
    const { rows } = await db.query(
      `SELECT u.id, u.email, u.display_name, u.bitrix_user_id, u.is_bitrix_admin,
              ut.role, ut.is_admin, ut.granted_by, ut.granted_at
       FROM users u
       JOIN user_tenants ut ON ut.user_id = u.id
       WHERE ut.tenant_id = $1
       ORDER BY ut.granted_at ASC`,
      [tenantId]
    );
    return rows;
  },

  async removeTenantAccess(userId, tenantId) {
    const { rows } = await db.query(
      'DELETE FROM user_tenants WHERE user_id = $1 AND tenant_id = $2 RETURNING *',
      [userId, tenantId]
    );
    return rows[0] || null;
  },

  async updateTenantRole(userId, tenantId, isAdmin) {
    const { rows } = await db.query(
      'UPDATE user_tenants SET is_admin = $3 WHERE user_id = $1 AND tenant_id = $2 RETURNING *',
      [userId, tenantId, isAdmin]
    );
    return rows[0] || null;
  },
};
