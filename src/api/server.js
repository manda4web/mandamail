import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import { authenticate } from './middleware/auth.js';
import authRoutes from './routes/auth.js';
import bitrixAppRoutes from './routes/bitrixApp.js';
import adminRoutes from './routes/admin.js';
import stripeRoutes from './routes/stripe.js';
import { tenantsRoutes } from './routes/tenants.js';
import imapAccountsRoutes from './routes/imapAccounts.js';
import eventsRoutes from './routes/events.js';
import subscriptionRoutes from './routes/subscriptions.js';
import userRoutes from './routes/users.js';
import routingRulesRoutes from './routes/routingRules.js';

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
    // Behind the Caddy reverse proxy: honor X-Forwarded-For so the rate
    // limit is per-client instead of one global bucket for everybody.
    trustProxy: true,
    // Limit body size to 25MB (for emails with large inline images)
    bodyLimit: 25 * 1024 * 1024,
  });

  // Store raw body for Stripe webhook signature verification
  app.addHook('preParsing', async (request, reply, payload) => {
    if (request.url.startsWith('/stripe/webhook')) {
      const chunks = [];
      for await (const chunk of payload) {
        chunks.push(chunk);
      }
      request.rawBody = Buffer.concat(chunks).toString('utf8');
      // Return a new readable stream from the raw body
      const { Readable } = await import('node:stream');
      return Readable.from([request.rawBody]);
    }
    return payload;
  });

  // === SECURITY: Rate Limiting ===
  app.register(rateLimit, {
    max: 200, // 200 requests per minute per IP
    timeWindow: '1 minute',
    keyGenerator: (request) => request.ip,
    // Don't rate limit static Bitrix app routes (they make multiple requests on load).
    // NOTE: /auth/bitrix is intentionally NOT allowlisted — it auto-creates
    // tenants/trials/users and must stay under the global rate limit.
    allowList: (request) => {
      return request.url.startsWith('/bitrix/') || request.url.startsWith('/assets/');
    },
  });

  // === SECURITY: CORS ===
  app.register(cors, {
    origin: true, // Allow all origins (app runs inside Bitrix24 iframe from any portal)
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
  app.register(stripeRoutes); // webhook is public (verified by signature); checkout/portal/cancel carry their own auth preHandlers

  // Liveness probe for the Docker healthcheck / monitoring
  app.get('/health', async () => ({ status: 'ok', uptime: process.uptime() }));

  // Protected routes (require authentication)
  app.register(async function protectedRoutes(protectedApp) {
    protectedApp.addHook('preHandler', authenticate);
    protectedApp.register(tenantsRoutes);
    protectedApp.register(imapAccountsRoutes);
    protectedApp.register(eventsRoutes);
    protectedApp.register(subscriptionRoutes);
    protectedApp.register(adminRoutes);
    protectedApp.register(userRoutes);
    protectedApp.register(routingRulesRoutes);
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
      // Don't leak internal error details (SQL, paths) on server errors
      error: statusCode >= 500 ? 'Erro interno do servidor' : (error.message || 'Error'),
      statusCode,
    });
  });

  return app;
}
