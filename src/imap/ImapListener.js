import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { EmailPipeline } from '../pipeline/EmailPipeline.js';
import * as ImapAccountRepo from '../db/repos/ImapAccountRepo.js';
import logger from '../logger.js';

export class ImapListener {
  constructor(account) {
    this.account = account;
    this.client = null;
    this.running = false;
    this.retryCount = 0;
    this.maxRetries = 5;
    this.baseDelay = 5000; // 5 seconds
    this.connectionLost = false;
  }

  async start() {
    this.running = true;
    // Single non-recursive supervisor loop. Each iteration establishes a fresh
    // connection and runs the poll/idle loop until the connection is lost, then
    // backs off and reconnects. This guarantees the worker recovers 24/7 from
    // silent Gmail disconnects without growing the call stack.
    while (this.running) {
      this.connectionLost = false;
      try {
        await this._connectAndRun();
      } catch (err) {
        logger.error(`[IMAP][${this.account.email}] session ended with error: ${err.message}`);
      }

      // Clean up the dead client before reconnecting
      try { await this.client?.close?.(); } catch {}
      try { await this.client?.logout?.(); } catch {}
      this.client = null;

      if (!this.running) break;
      await this._backoff();
    }
  }

  async stop() {
    this.running = false;
    try { await this.client?.logout(); } catch {}
    try { await this.client?.close?.(); } catch {}
    this.client = null;
    logger.info(`[IMAP][${this.account.email}] worker stopped`);
  }

  async _connectAndRun() {
    this.client = new ImapFlow({
      host: this.account.host,
      port: this.account.port,
      secure: this.account.use_ssl,
      auth: {
        user: this.account.username,
        pass: this.account.password,
      },
      logger: false,
      // Keep the socket healthy; imapflow will emit 'close'/'error' if it drops.
      socketTimeout: 5 * 60 * 1000,
    });

    // These handlers only FLAG the connection as lost. The supervisor loop in
    // start() handles the actual reconnection so we never stack reconnects.
    this.client.on('error', (err) => {
      logger.error(`[IMAP][${this.account.email}] connection error: ${err.message}`);
      this.connectionLost = true;
    });
    this.client.on('close', () => {
      if (this.running && !this.connectionLost) {
        logger.warn(`[IMAP][${this.account.email}] connection closed by server`);
      }
      this.connectionLost = true;
    });

    try {
      await this.client.connect();
    } catch (err) {
      const detail = err.responseText || err.response || err.authenticationFailed || err.serverResponseCode || err.message;
      logger.error(`[IMAP][${this.account.email}] connection failed: ${err.message} | detail: ${detail}`);
      await ImapAccountRepo.updateLastPoll(this.account.id, String(detail).substring(0, 200));
      this.connectionLost = true;
      return;
    }

    this.retryCount = 0; // reset on successful connection
    await ImapAccountRepo.updateLastPoll(this.account.id, null);
    logger.info(`[IMAP][${this.account.email}] connected — mode: ${this.account.poll_mode}`);

    if (this.account.poll_mode === 'idle') {
      await this._runIdle();
    } else {
      await this._runPoll();
    }
  }

  async _backoff() {
    this.retryCount++;

    // Exponential backoff capped at 5 minutes. NEVER give up permanently —
    // the worker must keep trying so email processing runs 24/7 without
    // requiring anyone to open the app. Transient Gmail drops/timeouts recover.
    const MAX_DELAY = 5 * 60 * 1000; // 5 minutes
    let delay = this.baseDelay * Math.pow(2, Math.min(this.retryCount - 1, 6));
    if (delay > MAX_DELAY) delay = MAX_DELAY;

    if (this.retryCount > this.maxRetries) {
      logger.warn(`[IMAP][${this.account.email}] still failing (attempt ${this.retryCount}), retrying in ${Math.round(delay/1000)}s`);
      await ImapAccountRepo.updateLastPoll(this.account.id, `Reconectando... (tentativa ${this.retryCount})`);
    } else {
      logger.info(`[IMAP][${this.account.email}] reconnecting in ${delay}ms (attempt ${this.retryCount})`);
    }

    await this._sleep(delay);
  }

  _alive() {
    return this.running && !this.connectionLost && this.client?.usable;
  }

  async _runIdle() {
    // Do NOT hold a mailbox lock across the idle loop — _fetchUnseen acquires
    // its own short-lived lock. Holding it here would deadlock the re-entrant
    // lock acquisition inside _fetchUnseen (ImapFlow locks are not re-entrant).
    await this._fetchUnseen();

    // Use exists event for new messages
    this.client.on('exists', async () => {
      if (this._alive()) {
        await this._fetchUnseen();
      }
    });

    // Keep connection alive. Exit the loop as soon as the connection drops so
    // the supervisor in start() can reconnect.
    while (this._alive()) {
      await this._sleep(30_000);
      if (!this._alive()) break;
      await ImapAccountRepo.updateLastPoll(this.account.id, null);
    }
  }

  async _runPoll() {
    while (this._alive()) {
      await this._fetchUnseen();
      if (!this._alive()) break;
      await ImapAccountRepo.updateLastPoll(this.account.id, null);
      await this._sleep(this.account.poll_interval_sec * 1000);
    }
  }

  async _fetchUnseen() {
    if (!this.client?.usable) {
      this.connectionLost = true;
      return;
    }
    let lock;
    try {
      lock = await this.client.getMailboxLock(this.account.mailbox);
    } catch (err) {
      // Failure to acquire the lock almost always means the connection died.
      logger.error(`[IMAP][${this.account.email}] fetchUnseen error: ${err.message}`);
      this.connectionLost = true;
      return;
    }

    try {
      const messages = [];
      for await (const msg of this.client.fetch({ seen: false }, { source: true })) {
        messages.push(msg);
      }

      for (const msg of messages) {
        // Skip emails larger than 20MB to prevent memory issues.
        // These will never parse well, so mark seen to avoid re-fetching.
        if (msg.source && msg.source.length > 20_000_000) {
          logger.warn(`[IMAP][${this.account.email}] skipping oversized message (${Math.round(msg.source.length / 1024 / 1024)}MB)`);
          await this._markSeen(msg.uid);
          continue;
        }

        let parsed;
        try {
          parsed = await simpleParser(msg.source);
        } catch (parseErr) {
          // Malformed email — retrying won't help. Mark seen and skip so we
          // don't loop forever on a poison message.
          logger.error(`[IMAP][${this.account.email}] parse error (marking seen, skipping): ${parseErr.message}`);
          await this._markSeen(msg.uid);
          continue;
        }

        try {
          await EmailPipeline.process(this.account, parsed);
          // Only mark seen AFTER the pipeline persisted/handled the email.
          // If process() throws (e.g. transient DB failure), we leave the
          // message UNSEEN so it is retried on the next fetch instead of
          // being silently lost.
          await this._markSeen(msg.uid);
        } catch (err) {
          logger.error(`[IMAP][${this.account.email}] error processing message (left UNSEEN for retry): ${err.message}`);
        }
      }
    } catch (err) {
      logger.error(`[IMAP][${this.account.email}] fetchUnseen error: ${err.message}`);
      // A fetch failure typically means the connection dropped mid-operation.
      if (!this.client?.usable) this.connectionLost = true;
    } finally {
      try { lock.release(); } catch {}
    }
  }

  async _markSeen(uid) {
    try {
      await this.client.messageFlagsAdd(uid, ['\\Seen'], { uid: true });
    } catch (flagErr) {
      logger.warn(`[IMAP][${this.account.email}] failed to mark message as seen: ${flagErr.message}`);
    }
  }

  _sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }
}
