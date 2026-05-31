import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import { authenticate } from './middleware/auth.js';
import authRoutes from './routes/auth.js';
import bitrixAppRoutes from './routes/bitrixApp.js';
import { tenantsRoutes } from './routes/tenants.js';
import imapAccountsRoutes from './routes/imapAccounts.js';
import eventsRoutes from './routes/events.js';

/**
 * Creates and configures the Fastify application instance.
 * Includes security middleware: rate limiting, CORS, security headers.
 *
 * @returns {import('fastify').FastifyInstance} Configured Fastify instance (not yet listening)
 */
export function buildApp() {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL || 'info',
    },
    // Limit body size to 25MB (for emails with large inline images)
    bodyLimit: 25 * 1024 * 1024,
  });

  // === SECURITY: Rate Limiting ===
  app.register(rateLimit, {
    max: 100, // 100 requests per minute per IP
    timeWindow: '1 minute',
    // Stricter limit for auth endpoints
    keyGenerator: (request) => request.ip,
  });

  // === SECURITY: CORS ===
  app.register(cors, {
    origin: [
      /\.bitrix24\.com\.br$/,
      /\.bitrix24\.com$/,
      /mandamail\.manda4\.com\.br$/,
    ],
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    credentials: true,
  });

  // === SECURITY: Headers (helmet) ===
  app.register(helmet, {
    contentSecurityPolicy: false, // Disabled because app is served in Bitrix iframe
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    frameguard: false, // Allow embedding in Bitrix24 iframe
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

    if (statusCode >= 500) {
      request.log.error({ err: error }, 'Internal server error');
    } else if (statusCode !== 429) { // Don't log rate limit hits
      request.log.warn({ err: error }, 'Client error');
    }

    reply.status(statusCode).send({
      error: error.message || 'Internal Server Error',
      statusCode,
    });
  });

  return app;
}
