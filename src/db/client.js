import pg from 'pg';

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle database client', err);
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
