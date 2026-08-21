import { db } from '../client.js';

// Allowlist for update(): the `!== undefined` guard (NOT truthiness) is what
// distinguishes the three write kinds — 0 (bitrix_category_id = default
// pipeline override) and null (clear the override) are both real writes,
// while an absent key means "keep the current value".
const UPDATE_FIELDS = [
  'name',
  'match_type',
  'match_value',
  'bitrix_category_id',
  'bitrix_stage_id',
  'bitrix_responsible_id',
  'priority',
  'is_active',
];

export const RoutingRuleRepo = {
  /** Active rules of a tenant in application order — the only read the pipeline needs. */
  async findActiveByTenant(tenantId) {
    const { rows } = await db.query(
      'SELECT * FROM routing_rules WHERE tenant_id = $1 AND is_active = true ORDER BY priority ASC, created_at ASC',
      [tenantId]
    );
    return rows;
  },

  /** All rules (active and inactive) of a tenant, for the SPA listing. */
  async findByTenant(tenantId) {
    const { rows } = await db.query(
      'SELECT * FROM routing_rules WHERE tenant_id = $1 ORDER BY priority ASC, created_at ASC',
      [tenantId]
    );
    return rows;
  },

  async findById(id) {
    const { rows } = await db.query('SELECT * FROM routing_rules WHERE id = $1', [id]);
    return rows[0] || null;
  },

  /** Active rule with the same (match_type, match_value) in the tenant — for the 409 check. */
  async findActiveByMatch(tenantId, matchType, matchValue, excludeId = null) {
    const { rows } = await db.query(
      `SELECT * FROM routing_rules
       WHERE tenant_id = $1 AND match_type = $2 AND match_value = $3 AND is_active = true
         AND ($4::uuid IS NULL OR id <> $4::uuid)
       LIMIT 1`,
      [tenantId, matchType, matchValue, excludeId]
    );
    return rows[0] || null;
  },

  async create(data) {
    const { rows } = await db.query(
      `INSERT INTO routing_rules
         (tenant_id, name, match_type, match_value,
          bitrix_category_id, bitrix_stage_id, bitrix_responsible_id,
          priority, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        data.tenant_id,
        data.name ?? null,
        data.match_type,
        data.match_value,
        data.bitrix_category_id ?? null, // ?? on purpose: 0 is a valid category (default pipeline)
        data.bitrix_stage_id ?? null,
        data.bitrix_responsible_id ?? null,
        data.priority ?? 100,
        data.is_active ?? true,
      ]
    );
    return rows[0];
  },

  async update(id, data) {
    const setClauses = [];
    const values = [];
    let paramIndex = 1;

    for (const field of UPDATE_FIELDS) {
      if (data[field] !== undefined) {
        setClauses.push(`${field} = $${paramIndex}`);
        values.push(data[field]);
        paramIndex++;
      }
    }

    if (setClauses.length === 0) return this.findById(id);

    setClauses.push('updated_at = now()');
    values.push(id);
    const { rows } = await db.query(
      `UPDATE routing_rules SET ${setClauses.join(', ')} WHERE id = $${paramIndex} RETURNING *`,
      values
    );
    return rows[0] || null;
  },

  /** @returns {Object|null} the deleted row id holder — null when nothing was deleted */
  async delete(id) {
    const { rows } = await db.query('DELETE FROM routing_rules WHERE id = $1 RETURNING id', [id]);
    return rows[0] || null;
  },
};
