import { ImapListener } from './ImapListener.js';
import * as ImapAccountRepo from '../db/repos/ImapAccountRepo.js';
import { SubscriptionRepo } from '../db/repos/SubscriptionRepo.js';
import logger from '../logger.js';

// Map: accountId (uuid) → ImapListener
const workers = new Map();

export const TenantScheduler = {
  async startAll() {
    const accounts = await ImapAccountRepo.findAllActive();
    logger.info(`[Scheduler] checking subscriptions for ${accounts.length} IMAP account(s)`);

    let started = 0;
    let skipped = 0;

    for (const account of accounts) {
      // Check if tenant has active subscription before starting worker
      const access = await SubscriptionRepo.checkAccess(account.tenant_id);
      if (!access.allowed) {
        logger.info(`[Scheduler] skipping ${account.email} — plan inactive (${access.reason})`);
        skipped++;
        continue;
      }
      await this.startAccount(account);
      started++;
    }

    logger.info(`[Scheduler] started ${started} worker(s), skipped ${skipped} (inactive plan)`);
  },

  async startAccount(account) {
    if (workers.has(account.id)) {
      logger.warn(`[Scheduler] worker ${account.email} already running, skipped`);
      return;
    }

    // A corrupted/unreadable stored password must disable ONLY this account —
    // failing here (instead of at connect time) keeps the other workers alive.
    if (!account.password) {
      logger.error(`[Scheduler] cannot start ${account.email}: stored password could not be decrypted (re-save the account credentials)`);
      try {
        await ImapAccountRepo.updateLastPoll(account.id, 'senha não pôde ser descriptografada — re-salve as credenciais da conta');
      } catch { /* observability only */ }
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

  /**
   * Stops every running worker and the supervisor timer.
   * Used by graceful shutdown (SIGTERM/SIGINT) so no processing is killed
   * mid-flight by process.exit.
   */
  async stopAll() {
    if (this._supervisorTimer) {
      clearInterval(this._supervisorTimer);
      this._supervisorTimer = null;
    }

    const entries = [...workers.entries()];
    let count = 0;
    for (const [id, worker] of entries) {
      try {
        await worker.stop();
      } catch (err) {
        logger.error(`[Scheduler] error stopping worker ${id}: ${err.message}`);
      }
      workers.delete(id);
      count++;
    }
    logger.info(`[Scheduler] stopped all workers (${count})`);
  },

  async stopTenant(tenantId) {
    let count = 0;
    for (const [id, worker] of workers.entries()) {
      if (worker.account.tenant_id === tenantId) {
        await worker.stop();
        workers.delete(id);
        count++;
      }
    }
    logger.info(`[Scheduler] stopped ${count} worker(s) for tenant ${tenantId}`);
    return count;
  },

  /**
   * Called when a subscription is activated — start all IMAP workers for the tenant.
   */
  async startTenant(tenantId) {
    const accounts = await ImapAccountRepo.findAllActive();
    const tenantAccounts = accounts.filter(a => a.tenant_id === tenantId);
    let started = 0;
    for (const account of tenantAccounts) {
      if (!workers.has(account.id)) {
        await this.startAccount(account);
        started++;
      }
    }
    logger.info(`[Scheduler] started ${started} worker(s) for tenant ${tenantId} (subscription activated)`);
    return started;
  },

  /**
   * Called when a subscription is canceled/expired — stop all IMAP workers for the tenant.
   */
  async handleSubscriptionInactive(tenantId, reason) {
    const count = await this.stopTenant(tenantId);
    logger.warn(`[Scheduler] tenant ${tenantId} plan inactive (${reason}), stopped ${count} worker(s)`);
    return count;
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

  /**
   * Periodic supervisor: ensures every active account (with a valid plan) has a
   * running worker. Restarts any worker that died or was never started.
   * This keeps email processing running 24/7 without depending on the UI.
   */
  startSupervisor(intervalMs = 120000) {
    if (this._supervisorTimer) return;
    this._supervisorTimer = setInterval(async () => {
      try {
        const accounts = await ImapAccountRepo.findAllActive();
        const activeIds = new Set(accounts.map(a => a.id));

        // Stop workers whose account/tenant was deactivated after they started
        // (the PATCH routes can't be the only line of defense — they may fail
        // or be bypassed by direct DB changes).
        for (const [id] of [...workers.entries()]) {
          if (!activeIds.has(id)) {
            logger.warn(`[Scheduler][Supervisor] stopping worker of deactivated account ${id}`);
            await this.stopAccount(id);
          }
        }

        for (const account of accounts) {
          const existing = workers.get(account.id);
          const alive = existing && existing.running;
          if (alive) continue;

          // Worker missing or not running — check plan then (re)start
          const access = await SubscriptionRepo.checkAccess(account.tenant_id);
          if (!access.allowed) {
            // Plan inactive — make sure any lingering worker is stopped
            if (existing) await this.stopAccount(account.id);
            continue;
          }
          // Remove dead worker reference and restart
          if (existing) {
            try { await existing.stop(); } catch {}
            workers.delete(account.id);
          }
          logger.warn(`[Scheduler][Supervisor] restarting dead worker: ${account.email}`);
          await this.startAccount(account);
        }
      } catch (err) {
        logger.error(`[Scheduler][Supervisor] error: ${err.message}`);
      }
    }, intervalMs);
    logger.info(`[Scheduler] supervisor started — checking every ${Math.round(intervalMs/1000)}s`);
  },
};
