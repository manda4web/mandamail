import { EmailEventRepo } from '../../db/repos/EmailEventRepo.js';
import { SubscriptionRepo } from '../../db/repos/SubscriptionRepo.js';
import { requireRole, requireTenantAccess } from '../middleware/auth.js';
import { fetchOriginalEmail } from '../../imap/fetchOriginalEmail.js';
import logger from '../../logger.js';

const VALID_STATUSES = [
  'RECEBIDO',
  'PROCESSANDO',
  'SUCESSO',
  'DUPLICADO',
  'IGNORADO',
  'ERRO',
  'FALHA_DEFINITIVA',
  'PLANO_INATIVO',
];

/** CSV columns for the export endpoint. */
const CSV_COLUMNS = [
  'created_at', 'status', 'from_email', 'from_name', 'subject',
  'account_email', 'bitrix_deal_id', 'bitrix_contact_id', 'retry_count',
];

function csvEscape(value) {
  if (value === null || value === undefined) return '';
  let s = String(value);
  // Formula injection: values starting with =/+/-/@ would execute in Excel
  if (/^[=+\-@\t\r]/.test(s)) s = `'` + s;
  s = s.replace(/"/g, '""');
  return /[",\n\r;]/.test(s) ? `"${s}"` : s;
}

/**
 * Registers event log and dashboard routes on the Fastify instance.
 * Authentication is handled at the encapsulation level (protectedRoutes in server.js).
 * @param {import('fastify').FastifyInstance} fastify
 */
export default async function eventsRoutes(fastify) {
  /**
   * GET /tenants/:id/events - Paginated event log with filters.
   * Query params: page, limit, status, from_email, subject, start_date, end_date
   */
  fastify.get('/tenants/:id/events', {
    preHandler: [requireTenantAccess],
  }, async (request, reply) => {
    const tenantId = request.params.id;

    // Parse and validate pagination
    let page = parseInt(request.query.page, 10) || 1;
    let limit = parseInt(request.query.limit, 10) || 20;

    if (page < 1) page = 1;
    if (limit < 1) limit = 20;

    const isCsv = request.query.format === 'csv';
    // JSON responses are capped at 100; the CSV export may fetch up to 10000
    if (!isCsv && limit > 100) {
      return reply.code(400).send({ error: 'limit must not exceed 100' });
    }
    if (isCsv && limit > 10000) {
      return reply.code(400).send({ error: 'limit must not exceed 10000 for CSV export' });
    }

    // Validate status filter
    const { status, from_email, subject, start_date, end_date, account_id, format } = request.query;

    // account_id must be a UUID — anything else would hit a UUID column and 500
    if (account_id && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(account_id)) {
      return reply.code(400).send({ error: 'Invalid account_id (must be a UUID)' });
    }

    if (status && !VALID_STATUSES.includes(status)) {
      return reply.code(400).send({
        error: `Invalid status filter. Must be one of: ${VALID_STATUSES.join(', ')}`,
      });
    }

    // Validate each date independently (a lone invalid date used to reach the
    // repo and blow up as a 500)
    for (const [name, value] of [['start_date', start_date], ['end_date', end_date]]) {
      if (value && isNaN(new Date(value).getTime())) {
        return reply.code(400).send({ error: `Invalid date format for ${name}` });
      }
    }
    if (start_date && end_date && new Date(start_date) > new Date(end_date)) {
      return reply.code(400).send({ error: 'start_date must be before end_date' });
    }

    // CSV export: fetch everything (bounded) and stream a file instead of JSON
    if (format === 'csv') {
      const csvLimit = Math.min(parseInt(limit, 10) || 1000, 10000);
      const result = await EmailEventRepo.list({
        tenantId,
        accountId: account_id || undefined,
        status: status || undefined,
        fromEmail: from_email || undefined,
        subject: subject || undefined,
        startDate: start_date || undefined,
        endDate: end_date || undefined,
        page: 1,
        limit: csvLimit,
      });
      const header = CSV_COLUMNS.join(',');
      const lines = result.data.map(row =>
        CSV_COLUMNS.map(c => csvEscape(row[c])).join(',')
      );
      return reply
        .header('Content-Type', 'text/csv; charset=utf-8')
        .header('Content-Disposition', `attachment; filename="eventos-mandamail.csv"`)
        .send([header, ...lines].join('\n'));
    }

    const result = await EmailEventRepo.list({
      tenantId,
      accountId: account_id || undefined,
      status: status || undefined,
      fromEmail: from_email || undefined,
      subject: subject || undefined,
      startDate: start_date || undefined,
      endDate: end_date || undefined,
      page,
      limit,
    });

    return reply.send(result);
  });

  /**
   * GET /tenants/:id/dashboard - Daily stats for the tenant.
   */
  fastify.get('/tenants/:id/dashboard', {
    preHandler: [requireTenantAccess],
  }, async (request, reply) => {
    const tenantId = request.params.id;

    // Selected period drives the per-account breakdown window. Accepts
    // today/7d/30d (matches the dashboard selector); defaults to 7 days.
    const periodParam = request.query.period;
    const periodDays = periodParam === 'today' ? 1 : periodParam === '30d' ? 30 : 7;

    const { BitrixResultRepo } = await import('../../db/repos/BitrixResultRepo.js');
    // Deal counts per window so the dashboard's "Negócios criados" matches the
    // selected period instead of showing the all-time total (which dwarfed the
    // period's email count and looked inconsistent). deals_count stays as the
    // all-time total for backward compatibility.
    // Volume chart shows one bar per day; "today" still shows a small 7-day
    // context so the chart isn't a single lonely bar.
    const seriesDays = periodParam === '30d' ? 30 : 7;

    const [stats, dealsAll, dealsToday, dealsWeek, dealsMonth, byAccount, timeseries] = await Promise.all([
      EmailEventRepo.getDailyStats(tenantId),
      BitrixResultRepo.countDealsByTenant(tenantId),
      BitrixResultRepo.countDealsByTenant(tenantId, 1),
      BitrixResultRepo.countDealsByTenant(tenantId, 7),
      BitrixResultRepo.countDealsByTenant(tenantId, 30),
      EmailEventRepo.countByAccount(tenantId, periodDays),
      EmailEventRepo.getDailyTimeseries(tenantId, seriesDays),
    ]);

    return reply.send({
      ...stats,
      deals_count: dealsAll,
      deals_today: dealsToday,
      deals_week: dealsWeek,
      deals_month: dealsMonth,
      by_account: byAccount,
      timeseries,
    });
  });

  /**
   * GET /tenants/:id/events/:eventId - Get event details (including error info)
   */
  fastify.get('/tenants/:id/events/:eventId', {
    preHandler: [requireTenantAccess],
  }, async (request, reply) => {
    const event = await EmailEventRepo.findById(request.params.eventId);
    if (!event || event.tenant_id !== request.params.id) {
      return reply.code(404).send({ error: 'Event not found' });
    }

    // Get retry jobs for this event
    const { db } = await import('../../db/client.js');
    const { rows: retryJobs } = await db.query(
      'SELECT * FROM retry_jobs WHERE email_event_id = $1 ORDER BY attempt_number DESC',
      [event.id]
    );

    // Get bitrix result if exists
    const { BitrixResultRepo } = await import('../../db/repos/BitrixResultRepo.js');
    const bitrixResult = await BitrixResultRepo.findByEventId(event.id);

    return { event, retryJobs, bitrixResult };
  });

  /**
   * POST /tenants/:id/events/:eventId/reprocess - Reprocess a failed email
   */
  fastify.post('/tenants/:id/events/:eventId/reprocess', {
    preHandler: [requireTenantAccess],
  }, async (request, reply) => {
    const event = await EmailEventRepo.findById(request.params.eventId);
    if (!event || event.tenant_id !== request.params.id) {
      return reply.code(404).send({ error: 'Event not found' });
    }

    if (event.status === 'PROCESSANDO') {
      return reply.code(400).send({ error: 'This event is already being processed' });
    }

    // Same plan gate as the pipeline (STEP 0) — the reprocess route must not
    // be a side door for tenants with inactive/canceled subscriptions or
    // exhausted monthly quota.
    try {
      const access = await SubscriptionRepo.checkAccess(event.tenant_id);
      const quota = await SubscriptionRepo.checkQuota(event.tenant_id);
      if (!access.allowed || !quota.allowed) {
        const reason = !access.allowed ? access.reason : quota.reason;
        return reply.code(403).send({ error: `Plano inativo/limite atingido (${reason}) — reprocessamento bloqueado` });
      }
    } catch (err) {
      logger.error({ eventId: event.id, error: err.message }, 'Reprocess: plan check failed');
      return reply.code(503).send({ error: 'Falha ao verificar plano, tente novamente' });
    }

    const ImapAccountRepoModule = await import('../../db/repos/ImapAccountRepo.js');
    const account = await ImapAccountRepoModule.findById(event.imap_account_id);
    if (!account) return reply.code(400).send({ error: 'IMAP account not found' });

    // Reset status to allow reprocessing
    await EmailEventRepo.setStatus(event.id, 'PROCESSANDO');

    // Try to fetch the original email from IMAP (to get attachments and the
    // untruncated body); falls back to the stored DB data.
    let email = await fetchOriginalEmail(account, event.message_id);
    if (email) {
      logger.info({ eventId: event.id }, 'Reprocess: fetched original email from IMAP with attachments');
    } else {
      email = {
        messageId: event.message_id,
        fromEmail: event.from_email,
        fromName: event.from_name,
        replyTo: event.reply_to,
        subject: event.subject,
        bodyHtml: event.body_html,
        bodyText: event.body_text,
        toEmails: event.to_emails || [],
        ccEmails: event.cc_emails || [],
        attachments: [],
        inlineImages: [],
        date: event.received_at,
      };
    }

    // Reprocess in background — idempotent: a deal/contact/activity already
    // recorded in bitrix_results for this event is reused, not duplicated.
    const { EmailPipeline } = await import('../../pipeline/EmailPipeline.js');
    EmailPipeline._processInBitrix(account, email, event).catch(async (err) => {
      logger.error({ eventId: event.id, error: err.message }, 'Reprocess failed');
      await EmailEventRepo.setStatus(event.id, 'ERRO', { incrementRetry: true });
    });

    return { success: true, message: 'Reprocessing started', eventId: event.id };
  });
}
