import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ImapListener pulls in imapflow/mailparser/pipeline/repo/logger. We only test
// the liveness + watchdog logic here, so every heavy dependency is mocked out.
vi.mock('imapflow', () => ({ ImapFlow: vi.fn() }));
vi.mock('mailparser', () => ({ simpleParser: vi.fn() }));
vi.mock('../../pipeline/EmailPipeline.js', () => ({
  EmailPipeline: { process: vi.fn() },
}));
vi.mock('../../db/repos/ImapAccountRepo.js', () => ({
  updateLastPoll: vi.fn().mockResolvedValue(undefined),
  updateUidState: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { ImapListener } from '../../imap/ImapListener.js';

const account = {
  id: 'acc-1',
  email: 'lead@example.com',
  host: 'imap.example.com',
  port: 993,
  use_ssl: true,
  username: 'lead@example.com',
  password: 'secret',
  mailbox: 'INBOX',
  poll_mode: 'idle',
};

describe('ImapListener liveness / watchdog', () => {
  let listener;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    listener = new ImapListener({ ...account });
  });

  afterEach(() => {
    listener._stopWatchdog();
    vi.useRealTimers();
  });

  describe('activity tracking', () => {
    it('starts with fresh activity (not stalled)', () => {
      expect(listener.msSinceActivity()).toBeLessThan(50);
      listener.running = true;
      expect(listener.isStalled()).toBe(false);
    });

    it('_touch resets the activity clock', () => {
      vi.advanceTimersByTime(60_000);
      expect(listener.msSinceActivity()).toBeGreaterThanOrEqual(60_000);
      listener._touch();
      expect(listener.msSinceActivity()).toBeLessThan(50);
    });

    it('isStalled is true only when running AND past the stall timeout', () => {
      // Not running yet — never considered stalled regardless of inactivity.
      vi.advanceTimersByTime(listener.stallTimeoutMs + 10_000);
      expect(listener.isStalled()).toBe(false);

      // Running + inactive beyond the timeout → stalled.
      listener.running = true;
      expect(listener.isStalled()).toBe(true);

      // A touch clears it.
      listener._touch();
      expect(listener.isStalled()).toBe(false);
    });
  });

  describe('watchdog', () => {
    it('forces reconnect when no activity within the stall timeout', async () => {
      listener.running = true;
      const close = vi.fn().mockResolvedValue(undefined);
      listener.client = { usable: true, close, noop: vi.fn() };

      listener._startWatchdog();

      // Let inactivity exceed the stall timeout, then fire one watchdog tick.
      vi.setSystemTime(Date.now() + listener.stallTimeoutMs + 5_000);
      await vi.advanceTimersByTimeAsync(listener.watchdogIntervalMs);

      expect(listener.connectionLost).toBe(true);
      expect(close).toHaveBeenCalled();
    });

    it('probes the connection with NOOP and stays healthy on success', async () => {
      listener.running = true;
      const noop = vi.fn().mockResolvedValue(undefined);
      listener.client = { usable: true, noop, close: vi.fn() };

      listener._startWatchdog();
      await vi.advanceTimersByTimeAsync(listener.watchdogIntervalMs);

      expect(noop).toHaveBeenCalled();
      expect(listener.connectionLost).toBe(false);
    });

    it('forces reconnect when the NOOP probe fails', async () => {
      listener.running = true;
      const noop = vi.fn().mockRejectedValue(new Error('socket dead'));
      const close = vi.fn().mockResolvedValue(undefined);
      listener.client = { usable: true, noop, close };

      listener._startWatchdog();
      await vi.advanceTimersByTimeAsync(listener.watchdogIntervalMs);

      expect(listener.connectionLost).toBe(true);
      expect(close).toHaveBeenCalled();
    });

    it('does nothing once the worker is no longer running', async () => {
      listener.running = false;
      const noop = vi.fn().mockResolvedValue(undefined);
      listener.client = { usable: true, noop, close: vi.fn() };

      listener._startWatchdog();
      await vi.advanceTimersByTimeAsync(listener.watchdogIntervalMs * 2);

      expect(noop).not.toHaveBeenCalled();
    });

    it('_stopWatchdog clears the timer (no further probes)', async () => {
      listener.running = true;
      const noop = vi.fn().mockResolvedValue(undefined);
      listener.client = { usable: true, noop, close: vi.fn() };

      listener._startWatchdog();
      listener._stopWatchdog();
      await vi.advanceTimersByTimeAsync(listener.watchdogIntervalMs * 3);

      expect(noop).not.toHaveBeenCalled();
      expect(listener._watchdogTimer).toBeNull();
    });
  });
});
