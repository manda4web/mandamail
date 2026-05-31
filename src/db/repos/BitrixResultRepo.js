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
};
