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

  async create(data) {
    const { rows } = await db.query(
      'INSERT INTO users (email, password_hash, role) VALUES ($1, $2, $3) RETURNING *',
      [data.email, data.password_hash, data.role || 'tenant_user']
    );
    return rows[0];
  },

  async findTenantsByUser(userId) {
    const { rows } = await db.query(
      'SELECT tenant_id, role FROM user_tenants WHERE user_id = $1',
      [userId]
    );
    return rows;
  },

  async addTenantAccess(userId, tenantId, role = 'owner') {
    const { rows } = await db.query(
      'INSERT INTO user_tenants (user_id, tenant_id, role) VALUES ($1, $2, $3) RETURNING *',
      [userId, tenantId, role]
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
};
