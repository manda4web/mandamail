import 'dotenv/config';
import { db, endPool } from './db/client.js';
import { buildApp } from './api/server.js';
import { TenantScheduler } from './imap/TenantScheduler.js';
import { RetryWorker } from './jobs/RetryWorker.js';
import { AlertService } from './alerts/AlertService.js';
import { runMigrations } from './db/migrate.js';
import { loadEncryptionKey } from './crypto/passwords.js';
import logger from './logger.js';

async function main() {
  // 1. Validate critical environment variables
  try {
    loadEncryptionKey();
  } catch (err) {
    logger.fatal(`ENCRYPTION_KEY validation failed: ${err.message}`);
    process.exit(1);
  }

  if (!process.env.JWT_SECRET) {
    logger.fatal('JWT_SECRET environment variable is required');
    process.exit(1);
  }

  // /auth/bitrix auto-creates tenants/users — without the app token check it
  // trusts any request. Warn loudly so it never runs unprotected by accident.
  if (!process.env.BITRIX_APP_TOKEN) {
    logger.warn('BITRIX_APP_TOKEN not configured — /auth/bitrix accepts unverified install requests (tenant/user farming risk)');
  }

  // 2. Test database connection
  try {
    await db.query('SELECT 1');
    logger.info('[Startup] Database connection OK');
  } catch (err) {
    logger.fatal(`Database connection failed: ${err.message}`);
    process.exit(1);
  }

  // 3. Test Redis connection
  try {
    const Redis = (await import('ioredis')).default;
    const redis = new Redis(process.env.REDIS_URL);
    await redis.ping();
    await redis.quit();
    logger.info('[Startup] Redis connection OK');
  } catch (err) {
    logger.fatal(`Redis connection failed: ${err.message}`);
    process.exit(1);
  }

  // 4. Run database migrations (shared runner with `npm run migrate`)
  try {
    await runMigrations();
  } catch (err) {
    logger.fatal(`Database migration failed: ${err.message}`);
    process.exit(1);
  }

  // 5. Start Fastify API server
  const port = parseInt(process.env.PORT || '3000', 10);
  if (port < 1 || port > 65535) {
    logger.fatal(`Invalid PORT: ${port}. Must be between 1 and 65535.`);
    process.exit(1);
  }

  const app = buildApp();
  await app.listen({ port, host: '0.0.0.0' });
  logger.info(`[Startup] API server listening on port ${port}`);

  // 6. Start TenantScheduler (IMAP workers)
  try {
    await TenantScheduler.startAll();
    // Supervisor: restarts any dead worker every 2 minutes (24/7 processing)
    TenantScheduler.startSupervisor(120000);
    logger.info('[Startup] TenantScheduler started');
  } catch (err) {
    logger.error(`[Startup] TenantScheduler failed: ${err.message}`);
    // Don't exit — individual worker failures are logged but don't stop the app
  }

  // 7. Start RetryWorker
  const retryWorker = new RetryWorker();
  retryWorker.start();
  logger.info('[Startup] RetryWorker started');

  // 8. Start AlertService
  const alertIntervalSec = parseInt(process.env.ALERT_CHECK_INTERVAL_SEC || '60', 10);
  const alertService = new AlertService(alertIntervalSec);
  alertService.start();
  logger.info('[Startup] AlertService started');

  // 9. Start CleanupWorker (daily cleanup of old data)
  const { CleanupWorker } = await import('./jobs/CleanupWorker.js');
  const cleanupWorker = new CleanupWorker(24); // runs every 24 hours
  cleanupWorker.start();
  logger.info('[Startup] CleanupWorker started');

  // 10. Log startup complete
  logger.info('=== Application startup complete — ready to accept requests ===');

  // Graceful shutdown — stops every background worker so no processing is
  // killed mid-flight, with a hard timeout as a safety net.
  const shutdown = async (signal) => {
    logger.info(`[Shutdown] Received ${signal}, shutting down gracefully...`);
    const forceTimer = setTimeout(() => {
      logger.error('[Shutdown] timed out after 15s, forcing exit');
      process.exit(1);
    }, 15000);
    forceTimer.unref?.();

    try {
      alertService.stop();
      retryWorker.stop();
      cleanupWorker.stop();
      await TenantScheduler.stopAll();
      await app.close();
      await endPool();
      logger.info('[Shutdown] Complete');
    } catch (err) {
      logger.error(`[Shutdown] error during shutdown: ${err.message}`);
    }
    clearTimeout(forceTimer);
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  logger.fatal(`Unhandled startup error: ${err.message}`);
  process.exit(1);
});
