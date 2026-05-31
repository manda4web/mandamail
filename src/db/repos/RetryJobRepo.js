import { db } from '../client.js';

const BACKOFF_DELAYS_MINUTES = [2, 5, 15, 30, 60];

export const RetryJobRepo = {
  async create(data) {
    const { rows } = await db.query(
      `INSERT INTO retry_jobs (
        email_event_id, attempt_number, error_message, error_stack, scheduled_at
      ) VALUES ($1,$2,$3,$4,$5)
      RETURNING *`,
      [
        data.email_event_id,
        data.attempt_number,
        data.error_message || null,
        data.error_stack || null,
        data.scheduled_at,
      ]
    );
    return rows[0];
  },

  async scheduleNext(eventId, attempt, err) {
    const delayIndex = Math.min(attempt - 1, BACKOFF_DELAYS_MINUTES.length - 1);
    const delayMinutes = BACKOFF_DELAYS_MINUTES[delayIndex];
    const scheduledAt = new Date(Date.now() + delayMinutes * 60 * 1000);

    return this.create({
      email_event_id: eventId,
      attempt_number: attempt,
      error_message: err?.message || null,
      error_stack: err?.stack || null,
      scheduled_at: scheduledAt,
    });
  },

  async findPending() {
    const { rows } = await db.query(
      `SELECT * FROM retry_jobs
       WHERE success IS NULL
         AND scheduled_at <= NOW()
       ORDER BY scheduled_at
       LIMIT 50`
    );
    return rows;
  },

  async markSuccess(id) {
    const { rows } = await db.query(
      `UPDATE retry_jobs
       SET success = true, executed_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [id]
    );
    return rows[0] || null;
  },

  async markFailed(id, errorMessage) {
    const { rows } = await db.query(
      `UPDATE retry_jobs
       SET success = false, executed_at = NOW(), error_message = $2
       WHERE id = $1
       RETURNING *`,
      [id, errorMessage]
    );
    return rows[0] || null;
  },
};
