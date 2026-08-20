import 'dotenv/config';
import { readdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { db } from './client.js';
import logger from '../logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, 'migrations');

async function ensureMigrationsTable() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      applied_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
}

async function getAppliedMigrations() {
  const result = await db.query('SELECT name FROM _migrations ORDER BY name');
  return new Set(result.rows.map((row) => row.name));
}

/**
 * Applies pending SQL migrations (each file in its own transaction).
 * Shared by `npm run migrate` and the app startup (src/index.js) — keep it as
 * the single implementation to avoid drift between the two entry points.
 * @returns {Promise<number>} number of migrations applied
 */
export async function runMigrations() {
  logger.info('Starting database migrations...');

  await ensureMigrationsTable();
  const applied = await getAppliedMigrations();

  const files = await readdir(MIGRATIONS_DIR);
  const sqlFiles = files
    .filter((f) => f.endsWith('.sql'))
    .sort();

  let migrationsRun = 0;

  for (const file of sqlFiles) {
    if (applied.has(file)) {
      logger.debug({ migration: file }, 'Already applied, skipping');
      continue;
    }

    const filePath = join(MIGRATIONS_DIR, file);
    const sql = await readFile(filePath, 'utf-8');

    const client = await db.getClient();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query(
        'INSERT INTO _migrations (name) VALUES ($1)',
        [file]
      );
      await client.query('COMMIT');
      migrationsRun++;
      logger.info({ migration: file }, 'Migration applied successfully');
    } catch (err) {
      await client.query('ROLLBACK');
      logger.error({ migration: file, error: err.message }, 'Migration failed');
      throw err;
    } finally {
      client.release();
    }
  }

  if (migrationsRun === 0) {
    logger.info('No new migrations to apply');
  } else {
    logger.info({ count: migrationsRun }, 'All migrations applied successfully');
  }

  return migrationsRun;
}

// CLI mode: `npm run migrate` → node src/db/migrate.js
const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  runMigrations()
    .then(() => process.exit(0))
    .catch((err) => {
      logger.error({ error: err.message }, 'Migration runner failed');
      process.exit(1);
    });
}
