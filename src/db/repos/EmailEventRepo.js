import { db } from '../client.js';

const FINAL_STATUSES = ['SUCESSO', 'ERRO', 'FALHA_DEFINITIVA', 'DUPLICADO', 'IGNORADO', 'PLANO_INATIVO'];

export const EmailEventRepo = {
  async create(data) {
    const status = data.status || 'RECEBIDO';
    const { rows } = await db.query(
      `INSERT INTO email_events (
        tenant_id, imap_account_id, message_id, from_email, from_name,
        reply_to, subject, body_html, body_text, to_emails, cc_emails,
        attachment_count, status, received_at, processed_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
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
        status,
        data.received_at || new Date(),
        // Events created directly in a final status (e.g. PLANO_INATIVO)
        // are done the moment they exist.
        FINAL_STATUSES.includes(status) ? new Date() : null,
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

    if (status === 'PROCESSANDO') {
      // Restart the staleness clock every time processing (re)starts —
      // long-backoff retries would be falsely flagged as stale otherwise.
      sets.push('processing_started_at = NOW()');
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
         AND LOWER(BTRIM(subject)) = LOWER(BTRIM($2))
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

  /**
   * Finds events stuck in an in-flight status — the signature of a crash or
   * killed process mid-processing (normal processing takes seconds).
   * Uses created_at (ingestion time), NOT received_at (which is the email's
   * Date header and can be days old on backlog/backfill scenarios — those
   * events would be falsely flagged as stale the moment they start
   * processing).
   *
   * PROCESSANDO is recovered EVEN when a pending retry job exists — a crash
   * during a manual reprocess (which sets PROCESSANDO) must not stall the
   * event forever: the pending job is simply executed once the status is
   * downgraded back to ERRO. RECEBIDO is only recovered when no job exists,
   * to avoid double-scheduling.
   *
   * @param {number} processingMinutes - stale threshold for PROCESSANDO
   * @param {number} receivedMinutes - stale threshold for RECEBIDO
   * @returns {Promise<Array>} stale events (with has_pending_retry flag)
   */
  async findStale(processingMinutes = 30, receivedMinutes = 60) {
    const { rows } = await db.query(
      `SELECT e.*,
              EXISTS (
                SELECT 1 FROM retry_jobs rj
                WHERE rj.email_event_id = e.id AND rj.success IS NULL
              ) AS has_pending_retry
       FROM email_events e
       WHERE (
            (status = 'PROCESSANDO' AND COALESCE(e.processing_started_at, e.created_at) < NOW() - ($1 || ' minutes')::INTERVAL)
            OR (
              status = 'RECEBIDO'
              AND created_at < NOW() - ($2 || ' minutes')::INTERVAL
              AND NOT EXISTS (
                SELECT 1 FROM retry_jobs rj
                WHERE rj.email_event_id = e.id AND rj.success IS NULL
              )
            )
          )`,
      [processingMinutes, receivedMinutes]
    );
    return rows;
  },

  /**
   * Events that reached FALHA_DEFINITIVA recently (alert trigger — a lost
   * lead must notify someone regardless of SLA timers).
   */
  async findRecentFinalFailures(minutes = 10) {
    const { rows } = await db.query(
      `SELECT * FROM email_events
       WHERE status = 'FALHA_DEFINITIVA'
         AND processed_at > NOW() - ($1 || ' minutes')::INTERVAL`,
      [minutes]
    );
    return rows;
  },

  async getDailyStats(tenantId) {
    // The dashboard shows a success RATE per selected period (today / 7d /
    // 30d). The rate must divide successes and totals from the SAME window —
    // mixing (e.g. success_today / week_total) produces a meaningless number.
    // So we expose matching total_/success_ pairs for each window. The success
    // rate intentionally counts only "actionable" outcomes (SUCESSO vs
    // ERRO/FALHA_DEFINITIVA); DUPLICADO/IGNORADO/PLANO_INATIVO are neither a
    // success nor a failure and must not drag the rate down.
    //
    // Windows use rolling intervals from now (last 7 / 30 days), which is what
    // the "7 dias"/"30 dias" selector means to a user, rather than calendar
    // week/month boundaries.
    const { rows } = await db.query(
      `SELECT
        -- Totals per window (all ingested events)
        COUNT(*) FILTER (WHERE created_at >= CURRENT_DATE) AS today,
        COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days') AS week,
        COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days') AS month,

        -- "Actionable" totals per window = SUCESSO + ERRO + FALHA_DEFINITIVA
        -- (the denominator for the success rate).
        COUNT(*) FILTER (WHERE status IN ('SUCESSO','ERRO','FALHA_DEFINITIVA') AND created_at >= CURRENT_DATE) AS actionable_today,
        COUNT(*) FILTER (WHERE status IN ('SUCESSO','ERRO','FALHA_DEFINITIVA') AND created_at >= NOW() - INTERVAL '7 days') AS actionable_week,
        COUNT(*) FILTER (WHERE status IN ('SUCESSO','ERRO','FALHA_DEFINITIVA') AND created_at >= NOW() - INTERVAL '30 days') AS actionable_month,

        -- Successes per window (the numerator).
        COUNT(*) FILTER (WHERE status = 'SUCESSO' AND created_at >= CURRENT_DATE) AS success_today,
        COUNT(*) FILTER (WHERE status = 'SUCESSO' AND created_at >= NOW() - INTERVAL '7 days') AS success_week,
        COUNT(*) FILTER (WHERE status = 'SUCESSO' AND created_at >= NOW() - INTERVAL '30 days') AS success_month,

        -- Errors per window.
        COUNT(*) FILTER (WHERE status IN ('ERRO','FALHA_DEFINITIVA') AND created_at >= CURRENT_DATE) AS errors,
        COUNT(*) FILTER (WHERE status IN ('ERRO','FALHA_DEFINITIVA') AND created_at >= NOW() - INTERVAL '7 days') AS errors_week,
        COUNT(*) FILTER (WHERE status IN ('ERRO','FALHA_DEFINITIVA') AND created_at >= NOW() - INTERVAL '30 days') AS errors_month,

        -- Duplicates/ignored per window (quick-stats should match the period).
        COUNT(*) FILTER (WHERE status = 'DUPLICADO' AND created_at >= CURRENT_DATE) AS dup_today,
        COUNT(*) FILTER (WHERE status = 'DUPLICADO' AND created_at >= NOW() - INTERVAL '7 days') AS dup_week,
        COUNT(*) FILTER (WHERE status = 'DUPLICADO' AND created_at >= NOW() - INTERVAL '30 days') AS dup_month,
        COUNT(*) FILTER (WHERE status = 'IGNORADO' AND created_at >= CURRENT_DATE) AS ign_today,
        COUNT(*) FILTER (WHERE status = 'IGNORADO' AND created_at >= NOW() - INTERVAL '7 days') AS ign_week,
        COUNT(*) FILTER (WHERE status = 'IGNORADO' AND created_at >= NOW() - INTERVAL '30 days') AS ign_month,

        -- PREVIOUS window (immediately before the current one) for real trend
        -- arrows. today→yesterday, 7d→the 7 days before that, 30d→prior 30.
        COUNT(*) FILTER (WHERE created_at >= CURRENT_DATE - INTERVAL '1 day' AND created_at < CURRENT_DATE) AS prev_today,
        COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '14 days' AND created_at < NOW() - INTERVAL '7 days') AS prev_week,
        COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '60 days' AND created_at < NOW() - INTERVAL '30 days') AS prev_month,
        COUNT(*) FILTER (WHERE status = 'SUCESSO' AND created_at >= CURRENT_DATE - INTERVAL '1 day' AND created_at < CURRENT_DATE) AS prev_success_today,
        COUNT(*) FILTER (WHERE status = 'SUCESSO' AND created_at >= NOW() - INTERVAL '14 days' AND created_at < NOW() - INTERVAL '7 days') AS prev_success_week,
        COUNT(*) FILTER (WHERE status = 'SUCESSO' AND created_at >= NOW() - INTERVAL '60 days' AND created_at < NOW() - INTERVAL '30 days') AS prev_success_month,

        -- Deals (SUCESSO) in the previous window, for the deals trend arrow.
        COUNT(*) FILTER (WHERE status = 'SUCESSO' AND created_at >= CURRENT_DATE - INTERVAL '1 day' AND created_at < CURRENT_DATE) AS prev_deals_today,
        COUNT(*) FILTER (WHERE status = 'SUCESSO' AND created_at >= NOW() - INTERVAL '14 days' AND created_at < NOW() - INTERVAL '7 days') AS prev_deals_week,
        COUNT(*) FILTER (WHERE status = 'SUCESSO' AND created_at >= NOW() - INTERVAL '60 days' AND created_at < NOW() - INTERVAL '30 days') AS prev_deals_month,

        -- Real average processing time (seconds) per window: only SUCESSO
        -- events with a processed_at, capped at 24h to exclude backlog outliers.
        ROUND(AVG(EXTRACT(EPOCH FROM (processed_at - created_at))) FILTER (
          WHERE status = 'SUCESSO' AND processed_at IS NOT NULL
            AND processed_at >= created_at
            AND processed_at - created_at < INTERVAL '24 hours'
            AND created_at >= CURRENT_DATE))::int AS avg_seconds_today,
        ROUND(AVG(EXTRACT(EPOCH FROM (processed_at - created_at))) FILTER (
          WHERE status = 'SUCESSO' AND processed_at IS NOT NULL
            AND processed_at >= created_at
            AND processed_at - created_at < INTERVAL '24 hours'
            AND created_at >= NOW() - INTERVAL '7 days'))::int AS avg_seconds_week,
        ROUND(AVG(EXTRACT(EPOCH FROM (processed_at - created_at))) FILTER (
          WHERE status = 'SUCESSO' AND processed_at IS NOT NULL
            AND processed_at >= created_at
            AND processed_at - created_at < INTERVAL '24 hours'
            AND created_at >= NOW() - INTERVAL '30 days'))::int AS avg_seconds_month,

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

  /**
   * Email counts grouped by IMAP account for a tenant within a rolling window.
   * Feeds the dashboard "Por Conta" panel (which previously showed 0 because
   * the accounts list endpoint carries no volume data). Returns SUCESSO count
   * separately so the panel can show volume + how many became deals.
   * @param {string} tenantId
   * @param {number} sinceDays - rolling window in days
   * @returns {Promise<Array<{imap_account_id:string,total:number,success:number}>>}
   */
  async countByAccount(tenantId, sinceDays = 7) {
    const { rows } = await db.query(
      `SELECT imap_account_id,
              COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE status = 'SUCESSO')::int AS success
         FROM email_events
        WHERE tenant_id = $1
          AND created_at >= NOW() - ($2 || ' days')::INTERVAL
        GROUP BY imap_account_id`,
      [tenantId, String(sinceDays)]
    );
    return rows;
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
      // Include the entire end day in Brasília time (UTC-3): the raw date
      // string is midnight UTC, which would drop the 21:00–23:59 BRT window.
      // date+1day+3h covers the full BRT day regardless of server TZ.
      conditions.push(`e.created_at < ($${paramIndex++}::date + INTERVAL '1 day' + INTERVAL '3 hours')`);
      params.push(String(endDate).slice(0, 10));
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
