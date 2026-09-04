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
      // Isolate each account: a failure checking one tenant's plan (e.g. a DB
      // blip) must NOT abort the loop and leave the remaining accounts without
      // a worker until the supervisor's next tick. The supervisor is the
      // backstop, but startup should start everything it can right away.
      try {
        // Check if tenant has active subscription before starting worker
        const access = await SubscriptionRepo.checkAccess(account.tenant_id);
        if (!access.allowed) {
          logger.info(`[Scheduler] skipping ${account.email} — plan inactive (${access.reason})`);
          skipped++;
          continue;
        }
        await this.startAccount(account);
        started++;
      } catch (err) {
        logger.error(`[Scheduler] failed to start ${account.email} (continuing with others): ${err.message}`);
        skipped++;
      }
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
        try {
          await this.startAccount(account);
          started++;
        } catch (err) {
          logger.error(`[Scheduler] failed to start ${account.email} for tenant ${tenantId} (continuing): ${err.message}`);
        }
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
   * In-memory state of a single account's worker, or null when no worker
   * exists (never started, stopped, or plan inactive). Used by the per-account
   * health endpoint to distinguish "worker running & healthy" from "worker
   * present but stalled" from "no worker at all".
   * @param {string} accountId
   * @returns {{ running: boolean, stalled: boolean, msSinceActivity: number|null }|null}
   */
  getWorkerState(accountId) {
    const w = workers.get(accountId);
    if (!w) return null;
    return {
      running: !!w.running,
      stalled: typeof w.isStalled === 'function' ? w.isStalled() : false,
      msSinceActivity: typeof w.msSinceActivity === 'function' ? w.msSinceActivity() : null,
    };
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

          // A worker counts as healthy only if it is running AND actually
          // making progress. The old check trusted `running` alone, so a
          // worker that was "alive but stuck" (hung socket, frozen idle loop)
          // stayed invisible to the supervisor and the account silently
          // stopped receiving email until someone reconnected it by hand.
          const stalled = existing && typeof existing.isStalled === 'function' && existing.isStalled();
          const alive = existing && existing.running && !stalled;
          if (alive) continue;

          // Worker missing, not running, or stalled — check plan then (re)start
          const access = await SubscriptionRepo.checkAccess(account.tenant_id);
          if (!access.allowed) {
            // Plan inactive — make sure any lingering worker is stopped
            if (existing) await this.stopAccount(account.id);
            continue;
          }
          // Remove dead/stalled worker reference and restart
          if (existing) {
            if (stalled) {
              const idleSec = Math.round(existing.msSinceActivity() / 1000);
              logger.warn(`[Scheduler][Supervisor] worker ${account.email} stalled (no activity for ${idleSec}s) — forcing restart`);
            }
            try { await existing.stop(); } catch {}
            workers.delete(account.id);
          }
          logger.warn(`[Scheduler][Supervisor] restarting ${stalled ? 'stalled' : 'dead'} worker: ${account.email}`);
          await this.startAccount(account);
        }
      } catch (err) {
        logger.error(`[Scheduler][Supervisor] error: ${err.message}`);
      }
    }, intervalMs);
    logger.info(`[Scheduler] supervisor started — checking every ${Math.round(intervalMs/1000)}s`);
  },
};
