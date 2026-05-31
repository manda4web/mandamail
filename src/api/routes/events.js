import { EmailEventRepo } from '../../db/repos/EmailEventRepo.js';
import { requireRole, requireTenantAccess } from '../middleware/auth.js';
import logger from '../../logger.js';

const VALID_STATUSES = [
  'RECEBIDO',
  'PROCESSANDO',
  'SUCESSO',
  'DUPLICADO',
  'IGNORADO',
  'ERRO',
  'FALHA_DEFINITIVA',
];

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
    if (limit > 100) {
      return reply.code(400).send({ error: 'limit must not exceed 100' });
    }

    // Validate status filter
    const { status, from_email, subject, start_date, end_date } = request.query;

    if (status && !VALID_STATUSES.includes(status)) {
      return reply.code(400).send({
        error: `Invalid status filter. Must be one of: ${VALID_STATUSES.join(', ')}`,
      });
    }

    // Validate date range
    if (start_date && end_date) {
      const start = new Date(start_date);
      const end = new Date(end_date);

      if (isNaN(start.getTime()) || isNaN(end.getTime())) {
        return reply.code(400).send({ error: 'Invalid date format for start_date or end_date' });
      }

      if (start > end) {
        return reply.code(400).send({ error: 'start_date must be before end_date' });
      }
    }

    const result = await EmailEventRepo.list({
      tenantId,
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

    const stats = await EmailEventRepo.getDailyStats(tenantId);

    return reply.send(stats);
  });

  /**
   * GET /tenants/:id/events/:eventId - Get event details (including error info)
   */
  fastify.get('/tenants/:id/events/:eventId', {
    preHandler: [requireTenantAccess],
  }, async (request, reply) => {
    const event = await EmailEventRepo.findById(request.params.eventId);
    if (!event) return reply.code(404).send({ error: 'Event not found' });

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
    if (!event) return reply.code(404).send({ error: 'Event not found' });

    if (!['ERRO', 'FALHA_DEFINITIVA'].includes(event.status)) {
      return reply.code(400).send({ error: 'Only events with ERRO or FALHA_DEFINITIVA status can be reprocessed' });
    }

    const ImapAccountRepoModule = await import('../../db/repos/ImapAccountRepo.js');
    const account = await ImapAccountRepoModule.findById(event.imap_account_id);
    if (!account) return reply.code(400).send({ error: 'IMAP account not found' });

    // Reset status to allow reprocessing
    await EmailEventRepo.setStatus(event.id, 'PROCESSANDO');

    // Reconstruct email object
    const email = {
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
      date: event.received_at,
    };

    // Reprocess in background
    const { EmailPipeline } = await import('../../pipeline/EmailPipeline.js');
    EmailPipeline._processInBitrix(account, email, event).catch(async (err) => {
      logger.error({ eventId: event.id, error: err.message }, 'Reprocess failed');
      await EmailEventRepo.setStatus(event.id, 'ERRO', { incrementRetry: true });
    });

    return { success: true, message: 'Reprocessing started', eventId: event.id };
  });
}
