import 'dotenv/config';
import { db } from './db/client.js';
import { buildApp } from './api/server.js';
import { TenantScheduler } from './imap/TenantScheduler.js';
import { RetryWorker } from './jobs/RetryWorker.js';
import { AlertService } from './alerts/AlertService.js';
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

  // 4. Run database migrations
  try {
    const { readdir, readFile } = await import('node:fs/promises');
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');

    const __dirname = dirname(fileURLToPath(import.meta.url));
    const MIGRATIONS_DIR = join(__dirname, 'db', 'migrations');

    // Ensure migrations table exists
    await db.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        applied_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    const applied = await db.query('SELECT name FROM _migrations ORDER BY name');
    const appliedSet = new Set(applied.rows.map((row) => row.name));

    const files = await readdir(MIGRATIONS_DIR);
    const sqlFiles = files.filter((f) => f.endsWith('.sql')).sort();

    let migrationsRun = 0;
    for (const file of sqlFiles) {
      if (appliedSet.has(file)) continue;

      const filePath = join(MIGRATIONS_DIR, file);
      const sql = await readFile(filePath, 'utf-8');

      const client = await db.getClient();
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO _migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        migrationsRun++;
        logger.info(`[Startup] Migration applied: ${file}`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    }

    if (migrationsRun === 0) {
      logger.info('[Startup] No new migrations to apply');
    } else {
      logger.info(`[Startup] ${migrationsRun} migration(s) applied`);
    }
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

  // 9. Log startup complete
  logger.info('=== Application startup complete — ready to accept requests ===');

  // Graceful shutdown
  const shutdown = async (signal) => {
    logger.info(`[Shutdown] Received ${signal}, shutting down gracefully...`);
    alertService.stop();
    retryWorker.stop();
    await app.close();
    logger.info('[Shutdown] Complete');
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  logger.fatal(`Unhandled startup error: ${err.message}`);
  process.exit(1);
});
