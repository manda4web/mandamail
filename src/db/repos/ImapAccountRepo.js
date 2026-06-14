import { db } from '../client.js';
import { encrypt, decrypt } from '../../crypto/passwords.js';

/**
 * Removes password_enc from a row and adds the decrypted password field.
 * @param {Object} row - Database row with password_enc
 * @returns {Object} Row with password field instead of password_enc
 */
function decryptRow(row) {
  if (!row) return null;
  const { password_enc, ...rest } = row;
  return { ...rest, password: decrypt(password_enc) };
}

/**
 * Find all active IMAP accounts for a given tenant, with decrypted passwords.
 * @param {string} tenantId - Tenant UUID
 * @returns {Promise<Array>}
 */
export async function findAllActiveByTenant(tenantId) {
  const { rows } = await db.query(
    'SELECT * FROM imap_accounts WHERE tenant_id = $1 AND active = true',
    [tenantId]
  );
  return rows.map(decryptRow);
}

/**
 * Find all active IMAP accounts with tenant configuration (JOIN).
 * Uses COALESCE for mapping fields: account value if non-NULL, else tenant value.
 * Decrypts passwords.
 * @returns {Promise<Array>}
 */
export async function findAllActive() {
  const { rows } = await db.query(
    `SELECT
       ia.*,
       t.bitrix_url,
       t.bitrix_webhook_token,
       t.ignore_from,
       t.ignore_subject,
       t.auth_id,
       t.refresh_id,
       COALESCE(ia.bitrix_category_id, t.bitrix_category_id) AS bitrix_category_id,
       COALESCE(ia.bitrix_stage_id, t.bitrix_stage_id) AS bitrix_stage_id,
       COALESCE(ia.bitrix_responsible_id, t.bitrix_responsible_id) AS bitrix_responsible_id,
       COALESCE(ia.field_mapping, t.field_mapping) AS field_mapping,
       COALESCE(ia.deal_mode, t.deal_mode) AS deal_mode,
       COALESCE(ia.sync_start_date, t.sync_start_date) AS sync_start_date
     FROM imap_accounts ia
     JOIN tenants t ON t.id = ia.tenant_id
     WHERE ia.active = true AND t.active = true`
  );
  return rows.map(decryptRow);
}

/**
 * Find an IMAP account by ID with tenant configuration (JOIN).
 * Uses COALESCE for mapping fields: account value if non-NULL, else tenant value.
 * Decrypts password.
 * @param {string} id - IMAP account UUID
 * @returns {Promise<Object|null>}
 */
export async function findById(id) {
  const { rows } = await db.query(
    `SELECT
       ia.*,
       t.bitrix_url,
       t.bitrix_webhook_token,
       t.ignore_from,
       t.ignore_subject,
       t.auth_id,
       t.refresh_id,
       COALESCE(ia.bitrix_category_id, t.bitrix_category_id) AS bitrix_category_id,
       COALESCE(ia.bitrix_stage_id, t.bitrix_stage_id) AS bitrix_stage_id,
       COALESCE(ia.bitrix_responsible_id, t.bitrix_responsible_id) AS bitrix_responsible_id,
       COALESCE(ia.field_mapping, t.field_mapping) AS field_mapping,
       COALESCE(ia.deal_mode, t.deal_mode) AS deal_mode,
       COALESCE(ia.sync_start_date, t.sync_start_date) AS sync_start_date
     FROM imap_accounts ia
     JOIN tenants t ON t.id = ia.tenant_id
     WHERE ia.id = $1`,
    [id]
  );
  return decryptRow(rows[0]);
}

/**
 * Find an IMAP account by ID returning raw values (without COALESCE).
 * Returns both account-level and tenant-level mapping values separately.
 * @param {string} id - IMAP account UUID
 * @returns {Promise<Object|null>} Object with account and tenant raw values
 */
export async function findRawById(id) {
  const { rows } = await db.query(
    `SELECT
       ia.id,
       ia.tenant_id,
       ia.label,
       ia.email,
       ia.host,
       ia.port,
       ia.username,
       ia.use_ssl,
       ia.mailbox,
       ia.poll_mode,
       ia.poll_interval_sec,
       ia.active,
       ia.last_poll_at,
       ia.last_error,
       ia.created_at,
       ia.bitrix_category_id AS account_bitrix_category_id,
       ia.bitrix_stage_id AS account_bitrix_stage_id,
       ia.bitrix_responsible_id AS account_bitrix_responsible_id,
       ia.field_mapping AS account_field_mapping,
       ia.deal_mode AS account_deal_mode,
       ia.sync_start_date AS account_sync_start_date,
       t.bitrix_category_id AS tenant_bitrix_category_id,
       t.bitrix_stage_id AS tenant_bitrix_stage_id,
       t.bitrix_responsible_id AS tenant_bitrix_responsible_id,
       t.field_mapping AS tenant_field_mapping,
       t.deal_mode AS tenant_deal_mode,
       t.sync_start_date AS tenant_sync_start_date
     FROM imap_accounts ia
     JOIN tenants t ON t.id = ia.tenant_id
     WHERE ia.id = $1`,
    [id]
  );
  return rows[0] || null;
}

/**
 * Update mapping fields for an IMAP account.
 * Only updates the 6 mapping fields (bitrix_category_id, bitrix_stage_id,
 * bitrix_responsible_id, field_mapping, deal_mode, sync_start_date).
 * @param {string} id - IMAP account UUID
 * @param {Object} data - Mapping fields to update
 * @returns {Promise<Object|null>} Updated account record
 */
export async function updateMapping(id, data) {
  const mappingFields = [
    'bitrix_category_id',
    'bitrix_stage_id',
    'bitrix_responsible_id',
    'field_mapping',
    'deal_mode',
    'sync_start_date',
  ];

  const setClauses = [];
  const values = [];
  let paramIndex = 1;

  for (const field of mappingFields) {
    if (data[field] !== undefined) {
      setClauses.push(`${field} = $${paramIndex}`);
      if (field === 'field_mapping' && data[field] !== null) {
        values.push(JSON.stringify(data[field]));
      } else {
        values.push(data[field]);
      }
      paramIndex++;
    }
  }

  if (setClauses.length === 0) {
    // No fields to update, return current record
    const { rows } = await db.query('SELECT * FROM imap_accounts WHERE id = $1', [id]);
    return rows[0] || null;
  }

  values.push(id);
  const { rows } = await db.query(
    `UPDATE imap_accounts SET ${setClauses.join(', ')} WHERE id = $${paramIndex} RETURNING *`,
    values
  );
  return rows[0] || null;
}

/**
 * Create a new IMAP account. Encrypts the password before storing.
 * @param {string} tenantId - Tenant UUID
 * @param {Object} data - Account fields (must include password)
 * @returns {Promise<Object>} Created account record
 */
export async function create(tenantId, data) {
  const passwordEnc = encrypt(data.password);

  const { rows } = await db.query(
    `INSERT INTO imap_accounts (tenant_id, label, email, host, port, username, password_enc, use_ssl, mailbox, poll_mode, poll_interval_sec, active, bitrix_category_id, bitrix_stage_id, bitrix_responsible_id, field_mapping, deal_mode, sync_start_date, parser_type)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
     RETURNING *`,
    [
      tenantId,
      data.label ?? null,
      data.email,
      data.host,
      data.port ?? 993,
      data.username,
      passwordEnc,
      data.use_ssl ?? true,
      data.mailbox ?? 'INBOX',
      data.poll_mode ?? 'idle',
      data.poll_interval_sec ?? 60,
      data.active ?? true,
      data.bitrix_category_id ?? null,
      data.bitrix_stage_id ?? null,
      data.bitrix_responsible_id ?? null,
      data.field_mapping ? JSON.stringify(data.field_mapping) : null,
      data.deal_mode ?? null,
      data.sync_start_date ?? null,
      data.parser_type ?? 'standard',
    ]
  );
  return rows[0];
}

/**
 * Update an IMAP account with only the provided fields.
 * Encrypts password if provided.
 * @param {string} id - IMAP account UUID
 * @param {Object} data - Fields to update
 * @returns {Promise<Object|null>} Updated account record
 */
export async function update(id, data) {
  const allowedFields = [
    'label',
    'email',
    'host',
    'port',
    'username',
    'use_ssl',
    'mailbox',
    'poll_mode',
    'poll_interval_sec',
    'active',
    'parser_type',
  ];

  const setClauses = [];
  const values = [];
  let paramIndex = 1;

  // Handle password separately — encrypt if provided
  if (data.password !== undefined) {
    setClauses.push(`password_enc = $${paramIndex}`);
    values.push(encrypt(data.password));
    paramIndex++;
  }

  for (const field of allowedFields) {
    if (data[field] !== undefined) {
      setClauses.push(`${field} = $${paramIndex}`);
      values.push(data[field]);
      paramIndex++;
    }
  }

  if (setClauses.length === 0) return findById(id);

  values.push(id);
  const { rows } = await db.query(
    `UPDATE imap_accounts SET ${setClauses.join(', ')} WHERE id = $${paramIndex} RETURNING *`,
    values
  );
  return rows[0] || null;
}

/**
 * Set the active status of an IMAP account.
 * @param {string} id - IMAP account UUID
 * @param {boolean} active - New active status
 * @returns {Promise<Object|null>} Updated account record
 */
export async function setActive(id, active) {
  const { rows } = await db.query(
    'UPDATE imap_accounts SET active = $1 WHERE id = $2 RETURNING *',
    [active, id]
  );
  return rows[0] || null;
}

/**
 * Update last_poll_at to NOW() and optionally set last_error.
 * @param {string} id - IMAP account UUID
 * @param {string|null} error - Error message or null on success
 * @returns {Promise<Object|null>} Updated account record
 */
export async function updateLastPoll(id, error = null) {
  const { rows } = await db.query(
    'UPDATE imap_accounts SET last_poll_at = NOW(), last_error = $1 WHERE id = $2 RETURNING *',
    [error, id]
  );
  return rows[0] || null;
}

/**
 * Count active IMAP accounts for a tenant.
 * @param {string} tenantId - Tenant UUID
 * @returns {Promise<number>}
 */
export async function countByTenant(tenantId) {
  const { rows } = await db.query(
    'SELECT COUNT(*)::int AS count FROM imap_accounts WHERE tenant_id = $1 AND active = true',
    [tenantId]
  );
  return rows[0].count;
}
