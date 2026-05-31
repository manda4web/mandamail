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
  }

  async start() {
    this.running = true;
    await this._connect();
  }

  async stop() {
    this.running = false;
    try { await this.client?.logout(); } catch {}
    this.client = null;
    logger.info(`[IMAP][${this.account.email}] worker stopped`);
  }

  async _connect() {
    this.client = new ImapFlow({
      host: this.account.host,
      port: this.account.port,
      secure: this.account.use_ssl,
      auth: {
        user: this.account.username,
        pass: this.account.password,
      },
      logger: false,
    });

    this.client.on('error', async (err) => {
      logger.error(`[IMAP][${this.account.email}] error: ${err.message}`);
      await ImapAccountRepo.updateLastPoll(this.account.id, err.message);
      if (this.running) {
        await this._reconnect();
      }
    });

    try {
      await this.client.connect();
      this.retryCount = 0; // reset on successful connection
      await ImapAccountRepo.updateLastPoll(this.account.id, null);
      logger.info(`[IMAP][${this.account.email}] connected — mode: ${this.account.poll_mode}`);

      if (this.account.poll_mode === 'idle') {
        await this._runIdle();
      } else {
        await this._runPoll();
      }
    } catch (err) {
      logger.error(`[IMAP][${this.account.email}] connection failed: ${err.message}`);
      await ImapAccountRepo.updateLastPoll(this.account.id, err.message);
      if (this.running) {
        await this._reconnect();
      }
    }
  }

  async _reconnect() {
    this.retryCount++;
    if (this.retryCount > this.maxRetries) {
      logger.error(`[IMAP][${this.account.email}] exhausted ${this.maxRetries} retries, stopping`);
      // Mark account as having connection failure (Req 3.4)
      await ImapAccountRepo.updateLastPoll(this.account.id, `Connection failed after ${this.maxRetries} retries`);
      return;
    }

    // Exponential backoff: 5s, 10s, 20s, 40s, 80s (Req 3.1)
    const delay = this.baseDelay * Math.pow(2, this.retryCount - 1);
    logger.info(`[IMAP][${this.account.email}] reconnecting in ${delay}ms (attempt ${this.retryCount}/${this.maxRetries})`);
    await this._sleep(delay);

    if (this.running) {
      await this._connect();
    }
  }

  async _runIdle() {
    const lock = await this.client.getMailboxLock(this.account.mailbox);
    try {
      await this._fetchUnseen();
      // Use exists event for new messages
      this.client.on('exists', async () => {
        if (this.running) {
          await this._fetchUnseen();
        }
      });
      // Keep connection alive with IDLE
      while (this.running) {
        await this._sleep(30_000);
        await ImapAccountRepo.updateLastPoll(this.account.id, null);
      }
    } finally {
      lock.release();
    }
  }

  async _runPoll() {
    while (this.running) {
      await this._fetchUnseen();
      await ImapAccountRepo.updateLastPoll(this.account.id, null);
      await this._sleep(this.account.poll_interval_sec * 1000);
    }
  }

  async _fetchUnseen() {
    try {
      const lock = await this.client.getMailboxLock(this.account.mailbox);
      try {
        const messages = [];
        for await (const msg of this.client.fetch({ seen: false }, { source: true })) {
          messages.push(msg);
        }

        for (const msg of messages) {
          try {
            const parsed = await simpleParser(msg.source);
            await EmailPipeline.process(this.account, parsed);
            await this.client.messageFlagsAdd(msg.uid, ['\\Seen'], { uid: true });
          } catch (err) {
            logger.error(`[IMAP][${this.account.email}] error processing message: ${err.message}`);
          }
        }
      } finally {
        lock.release();
      }
    } catch (err) {
      logger.error(`[IMAP][${this.account.email}] fetchUnseen error: ${err.message}`);
    }
  }

  _sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }
}
