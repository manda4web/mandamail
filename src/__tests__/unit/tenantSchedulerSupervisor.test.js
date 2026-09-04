import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Control the worker instances the scheduler creates so we can simulate a
// "running but stalled" worker (the exact state that used to be invisible to
// the supervisor and forced clients to reconnect manually).
// vi.hoisted so both the (hoisted) vi.mock factory and the test body share it.
const { created, FakeListener } = vi.hoisted(() => {
  const created = [];
  class FakeListener {
    constructor(account) {
      this.account = account;
      this.running = false;
      this._stalled = false;
      this.startCalls = 0;
      this.stopCalls = 0;
      created.push(this);
    }
    async start() { this.running = true; this.startCalls++; }
    async stop() { this.running = false; this.stopCalls++; }
    isStalled() { return this._stalled; }
    msSinceActivity() { return this._stalled ? 999_999 : 0; }
  }
  return { created, FakeListener };
});

vi.mock('../../imap/ImapListener.js', () => ({ ImapListener: FakeListener }));

vi.mock('../../db/repos/ImapAccountRepo.js', () => ({
  findAllActive: vi.fn(),
  findById: vi.fn(),
}));

vi.mock('../../db/repos/SubscriptionRepo.js', () => ({
  SubscriptionRepo: { checkAccess: vi.fn() },
}));

vi.mock('../../logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { TenantScheduler } from '../../imap/TenantScheduler.js';
import * as ImapAccountRepo from '../../db/repos/ImapAccountRepo.js';
import { SubscriptionRepo } from '../../db/repos/SubscriptionRepo.js';

const acc = { id: 'acc-1', email: 'a@x.com', tenant_id: 't-1', active: true, password: 'p' };

describe('TenantScheduler supervisor & worker state', () => {
  beforeEach(() => {
    created.length = 0;
    vi.clearAllMocks();
    SubscriptionRepo.checkAccess.mockResolvedValue({ allowed: true });
  });

  afterEach(async () => {
    await TenantScheduler.stopAll();
  });

  describe('getWorkerState', () => {
    it('returns null when there is no worker for the account', () => {
      expect(TenantScheduler.getWorkerState('missing')).toBeNull();
    });

    it('reflects a running, healthy worker', async () => {
      await TenantScheduler.startAccount({ ...acc });
      const state = TenantScheduler.getWorkerState('acc-1');
      expect(state).toMatchObject({ running: true, stalled: false });
      expect(state.msSinceActivity).toBe(0);
    });

    it('reflects a stalled worker', async () => {
      await TenantScheduler.startAccount({ ...acc });
      created[0]._stalled = true;
      expect(TenantScheduler.getWorkerState('acc-1')).toMatchObject({
        running: true,
        stalled: true,
      });
    });
  });

  describe('supervisor restarts stalled workers', () => {
    it('restarts a worker that is running but stalled', async () => {
      vi.useFakeTimers();
      try {
        // Start one healthy worker, then make it stall.
        await TenantScheduler.startAccount({ ...acc });
        const original = created[0];
        original._stalled = true;

        ImapAccountRepo.findAllActive.mockResolvedValue([{ ...acc }]);

        TenantScheduler.startSupervisor(1000);
        await vi.advanceTimersByTimeAsync(1000);

        // The stalled worker was stopped and a brand-new worker created.
        expect(original.stopCalls).toBeGreaterThanOrEqual(1);
        expect(created.length).toBe(2);
        expect(created[1].running).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it('leaves a healthy running worker untouched', async () => {
      vi.useFakeTimers();
      try {
        await TenantScheduler.startAccount({ ...acc }); // healthy
        ImapAccountRepo.findAllActive.mockResolvedValue([{ ...acc }]);

        TenantScheduler.startSupervisor(1000);
        await vi.advanceTimersByTimeAsync(1000);

        // No extra worker created, original still the only one.
        expect(created.length).toBe(1);
        expect(created[0].stopCalls).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
