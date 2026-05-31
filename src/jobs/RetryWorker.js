import { RetryJobRepo } from '../db/repos/RetryJobRepo.js';
import { EmailEventRepo } from '../db/repos/EmailEventRepo.js';
import * as ImapAccountRepo from '../db/repos/ImapAccountRepo.js';
import { EmailPipeline } from '../pipeline/EmailPipeline.js';
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

  async _executeJob(job) {
    try {
      const event = await EmailEventRepo.findById(job.email_event_id);
      if (!event) {
        await RetryJobRepo.markFailed(job.id, 'email_event not found');
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

      // Reconstruct email object from saved event data
      const email = {
        messageId: event.message_id,
        fromEmail: event.from_email,
        fromName: event.from_name,
        replyTo: event.reply_to,
        subject: event.subject,
        bodyHtml: event.body_html,
        bodyText: event.body_text,
        toEmails: event.to_emails ?? [],
        ccEmails: event.cc_emails ?? [],
        attachments: [], // no binary re-send on retry
        date: event.received_at,
      };

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
