import { db } from '../client.js';

/**
 * Find a tenant by its UUID.
 * @param {string} id - Tenant UUID
 * @returns {Promise<Object|null>}
 */
export async function findById(id) {
  const { rows } = await db.query('SELECT * FROM tenants WHERE id = $1', [id]);
  return rows[0] || null;
}

/**
 * Find a tenant by its Bitrix24 URL.
 * @param {string} url - Bitrix24 URL
 * @returns {Promise<Object|null>}
 */
export async function findByBitrixUrl(url) {
  const { rows } = await db.query('SELECT * FROM tenants WHERE bitrix_url = $1', [url]);
  return rows[0] || null;
}

/**
 * Find all active tenants ordered by name.
 * @returns {Promise<Array>}
 */
export async function findAllActive() {
  const { rows } = await db.query(
    'SELECT * FROM tenants WHERE active = true ORDER BY name'
  );
  return rows;
}

/**
 * Create a new tenant.
 * @param {Object} data - Tenant fields
 * @returns {Promise<Object>} Created tenant record
 */
export async function create(data) {
  const { rows } = await db.query(
    `INSERT INTO tenants (name, bitrix_url, bitrix_webhook_token, bitrix_responsible_id, bitrix_category_id, bitrix_stage_id, ignore_from, ignore_subject, plan, active)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING *`,
    [
      data.name,
      data.bitrix_url,
      data.bitrix_webhook_token,
      data.bitrix_responsible_id,
      data.bitrix_category_id ?? 9,
      data.bitrix_stage_id ?? 'C9:NEW',
      data.ignore_from ?? [],
      data.ignore_subject ?? [],
      data.plan ?? 'basic',
      data.active ?? true,
    ]
  );
  return rows[0];
}

/**
 * Update a tenant with only the provided fields.
 * @param {string} id - Tenant UUID
 * @param {Object} data - Fields to update
 * @returns {Promise<Object|null>} Updated tenant record
 */
export async function update(id, data) {
  const allowedFields = [
    'name',
    'bitrix_url',
    'bitrix_webhook_token',
    'bitrix_responsible_id',
    'bitrix_category_id',
    'bitrix_stage_id',
    'ignore_from',
    'ignore_subject',
    'field_mapping',
    'plan',
    'active',
    'auth_id',
    'refresh_id',
    'server_endpoint',
    'application_token',
    'member_id',
    'auth_expires_at',
    'deal_mode',
    'sync_start_date',
  ];

  const setClauses = [];
  const values = [];
  let paramIndex = 1;

  for (const field of allowedFields) {
    if (data[field] !== undefined) {
      setClauses.push(`${field} = $${paramIndex}`);
      // JSONB fields need to be stringified
      if (field === 'field_mapping') {
        values.push(JSON.stringify(data[field]));
      } else {
        values.push(data[field]);
      }
      paramIndex++;
    }
  }

  if (setClauses.length === 0) return findById(id);

  values.push(id);
  const { rows } = await db.query(
    `UPDATE tenants SET ${setClauses.join(', ')} WHERE id = $${paramIndex} RETURNING *`,
    values
  );
  return rows[0] || null;
}

/**
 * Set the active status of a tenant.
 * @param {string} id - Tenant UUID
 * @param {boolean} active - New active status
 * @returns {Promise<Object|null>} Updated tenant record
 */
export async function setActive(id, active) {
  const { rows } = await db.query(
    'UPDATE tenants SET active = $1 WHERE id = $2 RETURNING *',
    [active, id]
  );
  return rows[0] || null;
}
