import { RetryJobRepo } from '../db/repos/RetryJobRepo.js';
import { EmailEventRepo } from '../db/repos/EmailEventRepo.js';
import * as ImapAccountRepo from '../db/repos/ImapAccountRepo.js';
import { EmailPipeline } from '../pipeline/EmailPipeline.js';
import { fetchOriginalEmail } from '../imap/fetchOriginalEmail.js';
import logger from '../logger.js';

export class RetryWorker {
  constructor() {
    this.intervalId = null;
    this.running = false;
  }

  start() {
    this.running = true;
    this.intervalId = setInterval(() => this._runPending(), 30_000);
    this._runPending(); // run immediately
    logger.info('[RetryWorker] started — checking every 30s');
  }

  stop() {
    this.running = false;
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    logger.info('[RetryWorker] stopped');
  }

  async _runPending() {
    try {
      await this._recoverStale();

      const jobs = await RetryJobRepo.findPending();
      if (jobs.length === 0) return;

      logger.info(`[RetryWorker] ${jobs.length} job(s) to process`);

      for (const job of jobs) {
        await this._executeJob(job);
      }
    } catch (err) {
      logger.error(`[RetryWorker] error polling jobs: ${err.message}`);
    }
  }

  /**
   * Recovers events stuck in PROCESSANDO/RECEBIDO by a crash or killed
   * process — they would otherwise be stuck forever. Downgrades them to
   * ERRO and schedules a retry (or FALHA_DEFINITIVA when the retry budget is
   * exhausted). When the event already has a pending retry job (e.g. a
   * reprocess crashed mid-flight), the existing job is left alone — the next
   * tick executes it once the status is ERRO again.
   */
  async _recoverStale() {
    try {
      const stale = await EmailEventRepo.findStale(30, 60);
      for (const event of stale) {
        if ((event.retry_count ?? 0) >= 5) {
          await EmailEventRepo.setStatus(event.id, 'FALHA_DEFINITIVA');
          logger.error(`[RetryWorker] stale event ${event.id} (${event.status}) → FALHA_DEFINITIVA (retry budget exhausted)`);
          continue;
        }
        await EmailEventRepo.setStatus(event.id, 'ERRO', { incrementRetry: true });
        if (!event.has_pending_retry) {
          await RetryJobRepo.scheduleNext(event.id, (event.retry_count ?? 0) + 1, new Error(`recovered from stale ${event.status} (crash/timeout)`));
        }
        logger.warn(`[RetryWorker] stale event ${event.id} (${event.status}) recovered → ERRO${event.has_pending_retry ? ' (existing pending job will run)' : ' + retry scheduled'}`);
      }
    } catch (err) {
      logger.error(`[RetryWorker] recoverStale error: ${err.message}`);
    }
  }

  async _executeJob(job) {
    try {
      const event = await EmailEventRepo.findById(job.email_event_id);
      if (!event) {
        await RetryJobRepo.markFailed(job.id, 'email_event not found');
        return;
      }

      // Another run (manual reprocess) is in flight — leave the job pending;
      // the next tick re-evaluates after it finishes.
      if (event.status === 'PROCESSANDO') {
        logger.info(`[RetryWorker] event=${event.id} is PROCESSANDO (reprocess?), job=${job.id} deferred`);
        return;
      }

      // A manual reprocess (or a previous run) already completed the event.
      if (event.status === 'SUCESSO') {
        await RetryJobRepo.markSuccess(job.id);
        logger.info(`[RetryWorker] event=${event.id} already SUCESSO, job=${job.id} closed`);
        return;
      }

      // Check if max attempts reached (Req 13.6)
      if (job.attempt_number > 5) {
        await EmailEventRepo.setStatus(event.id, 'FALHA_DEFINITIVA');
        await RetryJobRepo.markFailed(job.id, 'max 5 attempts reached');
        logger.error(`[RetryWorker] FALHA_DEFINITIVA event=${event.id}`);
        return;
      }

      const account = await ImapAccountRepo.findById(event.imap_account_id);
      if (!account) {
        await RetryJobRepo.markFailed(job.id, 'imap_account not found');
        return;
      }

      // Mark as in-flight BEFORE doing anything slow: the reprocess route
      // rejects events in PROCESSANDO, so a concurrent manual click cannot
      // run in parallel with this job (double execution → duplicate deal).
      // If the process dies here, _recoverStale downgrades it back to ERRO.
      await EmailEventRepo.setStatus(event.id, 'PROCESSANDO');

      // Try to fetch the original email from IMAP first — attachments are
      // never stored in the DB and body_html is truncated, so the retry
      // would otherwise complete the deal without attachments. Falls back
      // to the DB reconstruction when the email is gone from the mailbox.
      let email = await fetchOriginalEmail(account, event.message_id);
      if (email) {
        logger.info(`[RetryWorker] refetched original email from IMAP for event=${event.id} (with attachments)`);
      } else {
        email = {
          messageId: event.message_id,
          fromEmail: event.from_email,
          fromName: event.from_name,
          replyTo: event.reply_to,
          subject: event.subject,
          bodyHtml: event.body_html,
          bodyText: event.body_text,
          toEmails: event.to_emails ?? [],
          ccEmails: event.cc_emails ?? [],
          attachments: [], // no binary re-send when IMAP refetch fails
          date: event.received_at,
        };
      }

      await EmailPipeline._processInBitrix(account, email, event);
      await RetryJobRepo.markSuccess(job.id);
      logger.info(`[RetryWorker] success job=${job.id} event=${event.id}`);
    } catch (err) {
      await RetryJobRepo.markFailed(job.id, err.message);

      // Schedule next retry if under limit (Req 13.5)
      const event = await EmailEventRepo.findById(job.email_event_id);
      if (event && job.attempt_number < 5) {
        const nextAttempt = job.attempt_number + 1;
        await RetryJobRepo.scheduleNext(job.email_event_id, nextAttempt, err);
        await EmailEventRepo.setStatus(event.id, 'ERRO', { incrementRetry: true });
      } else if (event) {
        await EmailEventRepo.setStatus(event.id, 'FALHA_DEFINITIVA');
      }

      logger.error(`[RetryWorker] failed job=${job.id}: ${err.message}`);
    }
  }
}
