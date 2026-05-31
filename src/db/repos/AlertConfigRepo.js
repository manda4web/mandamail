import { db } from '../client.js';

export const AlertConfigRepo = {
  async findByTenant(tenantId) {
    const { rows } = await db.query(
      'SELECT * FROM alert_configs WHERE tenant_id = $1 AND active = true',
      [tenantId]
    );
    return rows;
  },

  async findById(id) {
    const { rows } = await db.query(
      'SELECT * FROM alert_configs WHERE id = $1',
      [id]
    );
    return rows[0] || null;
  },

  async create(data) {
    const { rows } = await db.query(
      `INSERT INTO alert_configs (tenant_id, alert_type, destination, sla_minutes)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [data.tenant_id, data.alert_type, data.destination, data.sla_minutes || 15]
    );
    return rows[0];
  },

  async update(id, data) {
    const fields = [];
    const values = [];
    let paramIndex = 1;

    for (const [key, value] of Object.entries(data)) {
      if (key === 'id') continue;
      fields.push(`${key} = $${paramIndex}`);
      values.push(value);
      paramIndex++;
    }

    if (fields.length === 0) return this.findById(id);

    values.push(id);
    const { rows } = await db.query(
      `UPDATE alert_configs SET ${fields.join(', ')} WHERE id = $${paramIndex} RETURNING *`,
      values
    );
    return rows[0] || null;
  },

  async setActive(id, active) {
    const { rows } = await db.query(
      'UPDATE alert_configs SET active = $1 WHERE id = $2 RETURNING *',
      [active, id]
    );
    return rows[0] || null;
  },
};
