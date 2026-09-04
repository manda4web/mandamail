import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../db/client.js', () => ({ db: { query: vi.fn() } }));
vi.mock('../../db/repos/EmailEventRepo.js', () => ({
  EmailEventRepo: {
    findStuck: vi.fn().mockResolvedValue([]),
    findRecentFinalFailures: vi.fn().mockResolvedValue([]),
  },
}));
vi.mock('../../db/repos/AlertConfigRepo.js', () => ({
  AlertConfigRepo: { findByTenant: vi.fn() },
}));
vi.mock('../../db/repos/ImapAccountRepo.js', () => ({
  findSilent: vi.fn(),
}));
vi.mock('../../logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { AlertService } from '../../alerts/AlertService.js';
import * as ImapAccountRepo from '../../db/repos/ImapAccountRepo.js';
import { AlertConfigRepo } from '../../db/repos/AlertConfigRepo.js';

describe('AlertService silent-account detection', () => {
  let service;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new AlertService(60);
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
  });

  afterEach(() => {
    service.stop();
    vi.restoreAllMocks();
  });

  it('does nothing when no accounts are silent', async () => {
    ImapAccountRepo.findSilent.mockResolvedValue([]);
    await service._checkSilentAccounts();
    expect(AlertConfigRepo.findByTenant).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('delivers a webhook alert for a silent account', async () => {
    ImapAccountRepo.findSilent.mockResolvedValue([
      { id: 'a1', tenant_id: 't1', email: 'x@x.com', label: 'Main', last_poll_at: null, last_error: null },
    ]);
    AlertConfigRepo.findByTenant.mockResolvedValue([
      { id: 'cfg1', alert_type: 'WEBHOOK', destination: 'https://hook.example/x', sla_minutes: 15 },
    ]);

    await service._checkSilentAccounts();

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, opts] = global.fetch.mock.calls[0];
    expect(url).toBe('https://hook.example/x');
    const payload = JSON.parse(opts.body);
    expect(payload.alert).toBe('accounts_silent');
    expect(payload.accounts[0].email).toBe('x@x.com');
  });

  it('does not re-alert the same account within the silence window (dedup)', async () => {
    ImapAccountRepo.findSilent.mockResolvedValue([
      { id: 'a1', tenant_id: 't1', email: 'x@x.com', label: null, last_poll_at: null, last_error: null },
    ]);
    AlertConfigRepo.findByTenant.mockResolvedValue([
      { id: 'cfg1', alert_type: 'WEBHOOK', destination: 'https://hook.example/x', sla_minutes: 15 },
    ]);

    await service._checkSilentAccounts();
    await service._checkSilentAccounts(); // immediate second run

    expect(global.fetch).toHaveBeenCalledTimes(1); // second was deduped
  });

  it('only logs (no delivery) when the tenant has no alert configs', async () => {
    ImapAccountRepo.findSilent.mockResolvedValue([
      { id: 'a1', tenant_id: 't1', email: 'x@x.com', label: null, last_poll_at: null, last_error: 'boom' },
    ]);
    AlertConfigRepo.findByTenant.mockResolvedValue([]);

    await service._checkSilentAccounts();

    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('groups silent accounts by tenant', async () => {
    ImapAccountRepo.findSilent.mockResolvedValue([
      { id: 'a1', tenant_id: 't1', email: 'a@x.com', last_poll_at: null },
      { id: 'a2', tenant_id: 't2', email: 'b@x.com', last_poll_at: null },
    ]);
    AlertConfigRepo.findByTenant.mockResolvedValue([
      { id: 'cfg', alert_type: 'WEBHOOK', destination: 'https://hook.example/x', sla_minutes: 15 },
    ]);

    await service._checkSilentAccounts();

    expect(AlertConfigRepo.findByTenant).toHaveBeenCalledTimes(2);
    expect(AlertConfigRepo.findByTenant).toHaveBeenCalledWith('t1');
    expect(AlertConfigRepo.findByTenant).toHaveBeenCalledWith('t2');
  });
});
