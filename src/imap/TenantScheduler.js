import { ImapListener } from './ImapListener.js';
import * as ImapAccountRepo from '../db/repos/ImapAccountRepo.js';
import logger from '../logger.js';

// Map: accountId (uuid) → ImapListener
const workers = new Map();

export const TenantScheduler = {
  async startAll() {
    const accounts = await ImapAccountRepo.findAllActive();
    logger.info(`[Scheduler] starting ${accounts.length} IMAP worker(s)`);
    for (const account of accounts) {
      await this.startAccount(account);
    }
  },

  async startAccount(account) {
    if (workers.has(account.id)) {
      logger.warn(`[Scheduler] worker ${account.email} already running, skipped`);
      return;
    }

    const worker = new ImapListener(account);
    workers.set(account.id, worker);

    worker.start().catch(err => {
      logger.error(`[Scheduler] worker ${account.email} failed to start: ${err.message}`);
      workers.delete(account.id);
    });

    logger.info(`[Scheduler] worker started: ${account.email} (${account.id})`);
  },

  async stopAccount(accountId) {
    const worker = workers.get(accountId);
    if (!worker) return;
    await worker.stop();
    workers.delete(accountId);
    logger.info(`[Scheduler] worker stopped: ${accountId}`);
  },

  async restartAccount(accountId) {
    await this.stopAccount(accountId);
    const account = await ImapAccountRepo.findById(accountId);
    if (account?.active) {
      await this.startAccount(account);
    }
  },

  async stopTenant(tenantId) {
    for (const [id, worker] of workers.entries()) {
      if (worker.account.tenant_id === tenantId) {
        await worker.stop();
        workers.delete(id);
      }
    }
    logger.info(`[Scheduler] all workers stopped for tenant ${tenantId}`);
  },

  status() {
    return [...workers.entries()].map(([id, w]) => ({
      accountId: id,
      email: w.account.email,
      tenantId: w.account.tenant_id,
      running: w.running,
      lastPollAt: w.account.last_poll_at,
      lastError: w.account.last_error,
    }));
  },
};
