import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../db/client.js', () => ({ db: { query: vi.fn() } }));
vi.mock('../../db/repos/EmailEventRepo.js', () => ({
  EmailEventRepo: { findStuck: vi.fn().mockResolvedValue([]), findRecentFinalFailures: vi.fn().mockResolvedValue([]) },
}));
vi.mock('../../db/repos/AlertConfigRepo.js', () => ({
  AlertConfigRepo: { findByTenant: vi.fn() },
}));
vi.mock('../../db/repos/ImapAccountRepo.js', () => ({
  findStuckCursor: vi.fn(),
}));
vi.mock('../../logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { AlertService } from '../../alerts/AlertService.js';
import * as ImapAccountRepo from '../../db/repos/ImapAccountRepo.js';
import { AlertConfigRepo } from '../../db/repos/AlertConfigRepo.js';

describe('AlertService stuck-cursor detection', () => {
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

  it('does nothing when no cursor is stuck', async () => {
    ImapAccountRepo.findStuckCursor.mockResolvedValue([]);
    await service._checkStuckCursors();
    expect(AlertConfigRepo.findByTenant).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('delivers a webhook alert for a stuck cursor with the waiting count', async () => {
    ImapAccountRepo.findStuckCursor.mockResolvedValue([
      { id: 'a1', tenant_id: 't1', email: 'x@x.com', label: 'Cond',
        last_seen_uid: 149872, last_uid_next: 150034, last_poll_at: new Date(), last_event_at: '2026-09-04T23:05:00Z' },
    ]);
    AlertConfigRepo.findByTenant.mockResolvedValue([
      { id: 'cfg1', alert_type: 'WEBHOOK', destination: 'https://hook.example/x', sla_minutes: 15 },
    ]);

    await service._checkStuckCursors();

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(payload.alert).toBe('cursor_stuck');
    expect(payload.accounts[0].waiting).toBe(150034 - 149872);
  });

  it('dedups within the stuck window (no double alert)', async () => {
    ImapAccountRepo.findStuckCursor.mockResolvedValue([
      { id: 'a1', tenant_id: 't1', email: 'x@x.com', last_seen_uid: 100, last_uid_next: 200, last_poll_at: new Date(), last_event_at: null },
    ]);
    AlertConfigRepo.findByTenant.mockResolvedValue([
      { id: 'cfg1', alert_type: 'WEBHOOK', destination: 'https://hook.example/x', sla_minutes: 15 },
    ]);

    await service._checkStuckCursors();
    await service._checkStuckCursors();

    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('logs even when the tenant has no alert channel configured', async () => {
    ImapAccountRepo.findStuckCursor.mockResolvedValue([
      { id: 'a1', tenant_id: 't1', email: 'x@x.com', last_seen_uid: 100, last_uid_next: 200, last_poll_at: new Date(), last_event_at: null },
    ]);
    AlertConfigRepo.findByTenant.mockResolvedValue([]);

    await service._checkStuckCursors();

    expect(global.fetch).not.toHaveBeenCalled();
  });
});
