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
}
