import Fastify from 'fastify';
import { authenticate } from './middleware/auth.js';
import authRoutes from './routes/auth.js';
import bitrixAppRoutes from './routes/bitrixApp.js';
import { tenantsRoutes } from './routes/tenants.js';
import imapAccountsRoutes from './routes/imapAccounts.js';
import eventsRoutes from './routes/events.js';

/**
 * Creates and configures the Fastify application instance.
 * Registers all route plugins with appropriate authentication:
 * - /auth/* routes are public (no auth required)
 * - All other routes require JWT authentication via preHandler hook
 *
 * @returns {import('fastify').FastifyInstance} Configured Fastify instance (not yet listening)
 */
export function buildApp() {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL || 'info',
    },
  });

  // Support application/x-www-form-urlencoded (Bitrix24 sends POST with this content-type)
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (req, body, done) => {
    try {
      const parsed = Object.fromEntries(new URLSearchParams(body));
      done(null, parsed);
    } catch (err) {
      done(err);
    }
  });

  // Public routes (no auth required)
  app.register(authRoutes);
  app.register(bitrixAppRoutes);

  // Protected routes (require authentication)
  app.register(async function protectedRoutes(protectedApp) {
    protectedApp.addHook('preHandler', authenticate);
    protectedApp.register(tenantsRoutes);
    protectedApp.register(imapAccountsRoutes);
    protectedApp.register(eventsRoutes);
  });

  // Global error handler — returns structured JSON errors
  app.setErrorHandler((error, request, reply) => {
    const statusCode = error.statusCode || 500;

    // Log server errors at error level, client errors at warn level
    if (statusCode >= 500) {
      request.log.error({ err: error }, 'Internal server error');
    } else {
      request.log.warn({ err: error }, 'Client error');
    }

    reply.status(statusCode).send({
      error: error.message || 'Internal Server Error',
      statusCode,
    });
  });

  return app;
}
