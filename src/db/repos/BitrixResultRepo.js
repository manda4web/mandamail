import { db } from '../client.js';

export const BitrixResultRepo = {
  async create(data) {
    const { rows } = await db.query(
      `INSERT INTO bitrix_results (
        email_event_id, tenant_id, bitrix_contact_id, contact_was_created,
        bitrix_deal_id, bitrix_activity_id, api_log
      ) VALUES ($1,$2,$3,$4,$5,$6,$7)
      RETURNING *`,
      [
        data.email_event_id,
        data.tenant_id,
        data.bitrix_contact_id || null,
        data.contact_was_created || false,
        data.bitrix_deal_id || null,
        data.bitrix_activity_id || null,
        JSON.stringify(data.api_log || {}),
      ]
    );
    return rows[0];
  },

  async findByEventId(eventId) {
    const { rows } = await db.query(
      'SELECT * FROM bitrix_results WHERE email_event_id = $1',
      [eventId]
    );
    return rows[0] || null;
  },

  async countDealsByTenant(tenantId) {
    const { rows } = await db.query(
      'SELECT COUNT(*) AS count FROM bitrix_results WHERE tenant_id = $1 AND bitrix_deal_id IS NOT NULL',
      [tenantId]
    );
    return parseInt(rows[0].count, 10);
  },

  /**
   * Check if a deal was already created for this message_id on this IMAP account.
   * Used to prevent re-creating deals when IMAP re-fetches old emails.
   * Excludes the current event from the check.
   * @param {string} imapAccountId - IMAP account UUID
   * @param {string} messageId - Email Message-ID header
   * @param {string} currentEventId - Current event ID to exclude
   * @returns {Promise<boolean>} true if a deal already exists for this message
   */
  async existsByMessageId(imapAccountId, messageId, currentEventId) {
    const { rows } = await db.query(
      `SELECT br.id FROM bitrix_results br
       JOIN email_events ee ON ee.id = br.email_event_id
       WHERE ee.imap_account_id = $1
         AND ee.message_id = $2
         AND ee.id != $3
         AND br.bitrix_deal_id IS NOT NULL
       LIMIT 1`,
      [imapAccountId, messageId, currentEventId]
    );
    return rows.length > 0;
  },
};
