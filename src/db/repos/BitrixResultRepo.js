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

  /**
   * Insert-or-replace the result row for an event (UNIQUE email_event_id).
   * Used both for the early write (right after the deal is created, so a
   * crash on later steps never orphans the deal) and for the final write
   * on success — atomic, no DELETE window.
   */
  async upsert(data) {
    const { rows } = await db.query(
      `INSERT INTO bitrix_results (
         email_event_id, tenant_id, bitrix_contact_id, contact_was_created,
         bitrix_deal_id, bitrix_activity_id, api_log
       ) VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (email_event_id) DO UPDATE SET
         bitrix_contact_id = EXCLUDED.bitrix_contact_id,
         contact_was_created = EXCLUDED.contact_was_created,
         bitrix_deal_id = EXCLUDED.bitrix_deal_id,
         bitrix_activity_id = EXCLUDED.bitrix_activity_id,
         api_log = EXCLUDED.api_log
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

  /** Records the activity ID once the activity is created (incremental write). */
  async setActivity(eventId, activityId) {
    const { rows } = await db.query(
      'UPDATE bitrix_results SET bitrix_activity_id = $2 WHERE email_event_id = $1 RETURNING *',
      [eventId, activityId]
    );
    return rows[0] || null;
  },

  /**
   * Marks the attachments step as done (api_log.attachments) right after the
   * upload completes — incremental write, preserves the rest of api_log.
   */
  async setAttachmentsMarker(eventId, attachmentsLog) {
    const { rows } = await db.query(
      `UPDATE bitrix_results
       SET api_log = jsonb_set(COALESCE(api_log, '{}'::jsonb), '{attachments}', $2::jsonb)
       WHERE email_event_id = $1
       RETURNING *`,
      [eventId, JSON.stringify(attachmentsLog)]
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
