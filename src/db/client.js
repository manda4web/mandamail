import pg from 'pg';
import logger from '../logger.js';

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  // A hung query must never hold a pool connection forever — with max:20 a
  // handful of stuck queries would exhaust the pool and every other query
  // would then fail. statement_timeout lets Postgres ABORT a runaway query
  // server-side (properly cancelling it and freeing the connection), tunable
  // via env for slow maintenance ops. We intentionally do NOT set node-pg's
  // client-side query_timeout: it only rejects the promise without cancelling
  // the server query, which can surface a query as failed while it keeps
  // running (and get retried, doubling load). Migrations lift this per-tx via
  // `SET LOCAL statement_timeout = 0` (see migrate.js).
  statement_timeout: Number(process.env.DB_STATEMENT_TIMEOUT_MS ?? 30000),
});

// An idle-client error on a pg Pool would crash the process if unhandled.
// Route it through the structured logger so it is captured like everything
// else; the pool transparently replaces the dead connection.
pool.on('error', (err) => {
  logger.error(`[DB] Unexpected error on idle database client: ${err.message}`);
});

export const db = {
  query: (text, params) => pool.query(text, params),
  getClient: () => pool.connect(),
};

/**
 * Closes the pool gracefully on shutdown.
 * @returns {Promise<void>}
 */
export async function endPool() {
  await pool.end();
}
