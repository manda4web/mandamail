import { db } from '../db/client.js';
import logger from '../logger.js';

/**
 * CleanupWorker - Runs daily to clean up old data and prevent database bloat.
 * 
 * Policy:
 * - email_events older than 30 days: DELETE (cascade to bitrix_results, retry_jobs)
 * - body_html in events older than 7 days: SET to NULL (save space, keep metadata)
 * - Bitrix Drive images: deleted via API after 30 days (TODO: track uploaded file IDs)
 */
export class CleanupWorker {
  constructor(intervalHours = 24) {
    this.intervalMs = intervalHours * 60 * 60 * 1000;
    this.timer = null;
  }

  start() {
    // Run once on startup (after 5 minutes to let things settle)
    setTimeout(() => this._run(), 5 * 60 * 1000);
    // Then run every intervalMs
    this.timer = setInterval(() => this._run(), this.intervalMs);
    logger.info(`[CleanupWorker] started — runs every ${this.intervalMs / 3600000}h`);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async _run() {
    try {
      logger.info('[CleanupWorker] starting cleanup...');

      // 1. Delete email_events older than 30 days (cascades to bitrix_results via FK)
      const deleteResult = await db.query(
        `DELETE FROM email_events WHERE created_at < NOW() - INTERVAL '30 days' RETURNING id`
      );
      const deletedEvents = deleteResult.rowCount;

      // 2. Clear body_html for events older than 7 days (keep metadata, save space)
      const clearResult = await db.query(
        `UPDATE email_events SET body_html = NULL WHERE body_html IS NOT NULL AND created_at < NOW() - INTERVAL '7 days'`
      );
      const clearedBodies = clearResult.rowCount;

      // 3. Delete orphaned retry_jobs (where email_event no longer exists)
      const retryResult = await db.query(
        `DELETE FROM retry_jobs WHERE email_event_id NOT IN (SELECT id FROM email_events) RETURNING id`
      );
      const deletedRetries = retryResult.rowCount;

      // 4. Delete orphaned bitrix_results
      const resultResult = await db.query(
        `DELETE FROM bitrix_results WHERE email_event_id NOT IN (SELECT id FROM email_events) RETURNING id`
      );
      const deletedResults = resultResult.rowCount;

      logger.info({
        deletedEvents,
        clearedBodies,
        deletedRetries,
        deletedResults,
      }, '[CleanupWorker] cleanup complete');
    } catch (err) {
      logger.error(`[CleanupWorker] error: ${err.message}`);
    }
  }
}
