import { db } from '../client.js';

const FINAL_STATUSES = ['SUCESSO', 'ERRO', 'FALHA_DEFINITIVA', 'DUPLICADO', 'IGNORADO'];

export const EmailEventRepo = {
  async create(data) {
    const { rows } = await db.query(
      `INSERT INTO email_events (
        tenant_id, imap_account_id, message_id, from_email, from_name,
        reply_to, subject, body_html, body_text, to_emails, cc_emails,
        attachment_count, status, received_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
      RETURNING *`,
      [
        data.tenant_id,
        data.imap_account_id,
        data.message_id || null,
        data.from_email,
        data.from_name || null,
        data.reply_to || null,
        data.subject || null,
        data.body_html || null,
        data.body_text || null,
        JSON.stringify(data.to_emails || []),
        JSON.stringify(data.cc_emails || []),
        data.attachment_count || 0,
        data.status || 'RECEBIDO',
        data.received_at || new Date(),
      ]
    );
    return rows[0];
  },

  async findById(id) {
    const { rows } = await db.query(
      'SELECT * FROM email_events WHERE id = $1',
      [id]
    );
    return rows[0] || null;
  },

  async setStatus(id, status, extra = {}) {
    const sets = ['status = $2'];
    const params = [id, status];

    if (FINAL_STATUSES.includes(status)) {
      sets.push('processed_at = NOW()');
    }

    if (extra.incrementRetry) {
      sets.push('retry_count = retry_count + 1');
    }

    const { rows } = await db.query(
      `UPDATE email_events SET ${sets.join(', ')} WHERE id = $1 RETURNING *`,
      params
    );
    return rows[0] || null;
  },

  async findByMessageId(imapAccountId, messageId) {
    const { rows } = await db.query(
      `SELECT id FROM email_events
       WHERE imap_account_id = $1
         AND message_id = $2
         AND created_at > NOW() - INTERVAL '24 hours'
       LIMIT 1`,
      [imapAccountId, messageId]
    );
    return rows[0] || null;
  },

  async findBySubjectFrom(imapAccountId, subject, fromEmail) {
    const { rows } = await db.query(
      `SELECT id FROM email_events
       WHERE imap_account_id = $1
         AND LOWER(subject) = LOWER($2)
         AND LOWER(from_email) = LOWER($3)
         AND created_at > NOW() - INTERVAL '2 minutes'
       LIMIT 1`,
      [imapAccountId, subject, fromEmail]
    );
    return rows[0] || null;
  },

  async findStuck(tenantId, sinceMinutes) {
    const { rows } = await db.query(
      `SELECT * FROM email_events
       WHERE tenant_id = $1
         AND status IN ('RECEBIDO', 'PROCESSANDO', 'ERRO')
         AND created_at < NOW() - ($2 || ' minutes')::INTERVAL`,
      [tenantId, sinceMinutes]
    );
    return rows;
  },

  async getDailyStats(tenantId) {
    const { rows } = await db.query(
      `SELECT
        COUNT(*) FILTER (WHERE created_at >= CURRENT_DATE) AS today,
        COUNT(*) FILTER (WHERE created_at >= date_trunc('week', CURRENT_DATE)) AS week,
        COUNT(*) FILTER (WHERE status = 'SUCESSO' AND created_at >= CURRENT_DATE) AS success_today,
        COUNT(*) FILTER (WHERE status IN ('ERRO','FALHA_DEFINITIVA') AND created_at >= CURRENT_DATE) AS errors,
        COUNT(*) FILTER (WHERE status IN ('RECEBIDO','PROCESSANDO') AND created_at >= CURRENT_DATE) AS pending,
        COUNT(*) FILTER (WHERE status = 'RECEBIDO') AS recebido,
        COUNT(*) FILTER (WHERE status = 'PROCESSANDO') AS processando,
        COUNT(*) FILTER (WHERE status = 'SUCESSO') AS sucesso,
        COUNT(*) FILTER (WHERE status = 'DUPLICADO') AS duplicado,
        COUNT(*) FILTER (WHERE status = 'IGNORADO') AS ignorado,
        COUNT(*) FILTER (WHERE status = 'ERRO') AS erro,
        COUNT(*) FILTER (WHERE status = 'FALHA_DEFINITIVA') AS falha_definitiva,
        COUNT(*) AS total
      FROM email_events
      WHERE tenant_id = $1`,
      [tenantId]
    );
    return rows[0];
  },

  async list({ tenantId, accountId, status, fromEmail, subject, startDate, endDate, page = 1, limit = 20 }) {
    const conditions = ['e.tenant_id = $1'];
    const params = [tenantId];
    let paramIndex = 2;

    if (accountId) {
      conditions.push(`e.imap_account_id = $${paramIndex++}`);
      params.push(accountId);
    }

    if (status) {
      conditions.push(`e.status = $${paramIndex++}`);
      params.push(status);
    }

    if (fromEmail) {
      conditions.push(`LOWER(e.from_email) LIKE LOWER($${paramIndex++})`);
      params.push(`%${fromEmail}%`);
    }

    if (subject) {
      conditions.push(`LOWER(e.subject) LIKE LOWER($${paramIndex++})`);
      params.push(`%${subject}%`);
    }

    if (startDate) {
      conditions.push(`e.created_at >= $${paramIndex++}`);
      params.push(startDate);
    }

    if (endDate) {
      // Include the entire end day (add 1 day to cover until 23:59:59)
      const endDatePlusOne = new Date(endDate);
      endDatePlusOne.setDate(endDatePlusOne.getDate() + 1);
      conditions.push(`e.created_at < $${paramIndex++}`);
      params.push(endDatePlusOne.toISOString().slice(0, 10));
    }

    const whereClause = conditions.join(' AND ');
    const offset = (page - 1) * limit;

    const countResult = await db.query(
      `SELECT COUNT(*) AS total FROM email_events e WHERE ${whereClause}`,
      params
    );

    const { rows } = await db.query(
      `SELECT e.*, ia.email AS account_email, ia.label AS account_label,
              br.bitrix_deal_id, br.bitrix_contact_id
       FROM email_events e
       JOIN imap_accounts ia ON ia.id = e.imap_account_id
       LEFT JOIN bitrix_results br ON br.email_event_id = e.id
       WHERE ${whereClause}
       ORDER BY e.created_at DESC
       LIMIT $${paramIndex++} OFFSET $${paramIndex++}`,
      [...params, limit, offset]
    );

    return {
      data: rows,
      total: parseInt(countResult.rows[0].total, 10),
      page,
      limit,
      totalPages: Math.ceil(parseInt(countResult.rows[0].total, 10) / limit),
    };
  },
};
