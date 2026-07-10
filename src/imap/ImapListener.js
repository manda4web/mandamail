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
    // Do NOT hold a mailbox lock across the idle loop — _fetchNew acquires
    // its own short-lived lock. Holding it here would deadlock the re-entrant
    // lock acquisition inside _fetchNew (ImapFlow locks are not re-entrant).
    await this._fetchNew();

    // Use exists event for new messages
    this.client.on('exists', async () => {
      if (this._alive()) {
        await this._fetchNew();
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
      await this._fetchNew();
      if (!this._alive()) break;
      await ImapAccountRepo.updateLastPoll(this.account.id, null);
      await this._sleep(this.account.poll_interval_sec * 1000);
    }
  }

  /**
   * Resolve the UID cursor to start fetching from. Uses the persisted cursor
   * when UIDVALIDITY still matches; otherwise initializes it to only cover the
   * last few days (recovers recent leads without reprocessing the whole folder;
   * the DB dedup layer prevents duplicate deals for already-processed emails).
   */
  async _resolveCursor(uidValidity) {
    const acc = this.account;
    if (acc.last_seen_uid != null && Number(acc.uid_validity) === uidValidity) {
      return Number(acc.last_seen_uid);
    }

    const INIT_WINDOW_DAYS = 3;
    let startCursor;
    try {
      const since = new Date(Date.now() - INIT_WINDOW_DAYS * 24 * 60 * 60 * 1000);
      const uids = await this.client.search({ since }, { uid: true });
      if (uids && uids.length > 0) {
        startCursor = Math.min(...uids) - 1;
      } else {
        startCursor = Number(this.client.mailbox.uidNext || 1) - 1;
      }
    } catch {
      startCursor = Number(this.client.mailbox.uidNext || 1) - 1;
    }

    await this._saveCursor(uidValidity, startCursor);
    logger.info(`[IMAP][${this.account.email}] UID cursor initialized at ${startCursor} (uidValidity=${uidValidity})`);
    return startCursor;
  }

  async _saveCursor(uidValidity, cursor) {
    this.account.uid_validity = uidValidity;
    this.account.last_seen_uid = cursor;
    try {
      await ImapAccountRepo.updateUidState(this.account.id, uidValidity, cursor);
    } catch (e) {
      logger.warn(`[IMAP][${this.account.email}] failed to persist UID cursor: ${e.message}`);
    }
  }

  /**
   * Fetch and process messages with UID greater than the stored cursor.
   * Independent of the \Seen flag, so leads are never missed just because the
   * email was opened/read elsewhere (phone, Gmail web, etc.).
   */
  async _fetchNew() {
    if (!this.client?.usable) {
      this.connectionLost = true;
      return;
    }
    let lock;
    try {
      lock = await this.client.getMailboxLock(this.account.mailbox);
    } catch (err) {
      // Failure to acquire the lock almost always means the connection died.
      logger.error(`[IMAP][${this.account.email}] fetchNew lock error: ${err.message}`);
      this.connectionLost = true;
      return;
    }

    try {
      const uidValidity = Number(this.client.mailbox?.uidValidity || 0);
      let cursor = await this._resolveCursor(uidValidity);

      // Fetch messages with UID strictly greater than the cursor. The `*` in a
      // UID range can return the highest message even when the range start is
      // beyond it, so we explicitly filter msg.uid > cursor.
      const messages = [];
      for await (const msg of this.client.fetch(
        `${cursor + 1}:*`,
        { uid: true, source: true },
        { uid: true }
      )) {
        if (msg.uid > cursor) messages.push(msg);
      }
      messages.sort((a, b) => a.uid - b.uid);

      for (const msg of messages) {
        if (!this._alive()) break;

        // Oversized message — skip and advance cursor (will never parse well).
        if (msg.source && msg.source.length > 20_000_000) {
          logger.warn(`[IMAP][${this.account.email}] skipping oversized message uid=${msg.uid} (${Math.round(msg.source.length / 1024 / 1024)}MB)`);
          await this._saveCursor(uidValidity, msg.uid);
          continue;
        }

        let parsed;
        try {
          parsed = await simpleParser(msg.source);
        } catch (parseErr) {
          // Malformed email — retrying won't help. Advance past it.
          logger.error(`[IMAP][${this.account.email}] parse error uid=${msg.uid} (skipping): ${parseErr.message}`);
          await this._saveCursor(uidValidity, msg.uid);
          continue;
        }

        try {
          await EmailPipeline.process(this.account, parsed);
          await this._markSeen(msg.uid);
          // Advance the cursor only AFTER the pipeline persisted/handled the
          // email, so a transient failure doesn't skip a lead.
          await this._saveCursor(uidValidity, msg.uid);
        } catch (err) {
          // process() throws only on catastrophic failure (e.g. DB down). Do
          // NOT advance the cursor — retry this UID on the next cycle.
          logger.error(`[IMAP][${this.account.email}] error processing uid=${msg.uid} (will retry): ${err.message}`);
          break;
        }
      }
    } catch (err) {
      logger.error(`[IMAP][${this.account.email}] fetchNew error: ${err.message}`);
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
