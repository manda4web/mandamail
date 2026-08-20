import { describe, it, expect, vi, beforeEach } from 'vitest';

// Regression tests for the security batch:
// - requireTenantBodyAccess (Stripe routes took tenant_id from the body with
//   no ownership check — anyone could cancel any tenant's subscription)
// - SubscriptionRepo.checkAccess ACTIVE grace (a lost Stripe webhook used to
//   keep service on forever)
// - checkQuota monthly email limit

vi.mock('../../db/repos/UserRepo.js', () => ({
  UserRepo: { hasAccessToTenant: vi.fn() },
}));

vi.mock('../../db/client.js', () => ({
  db: { query: vi.fn() },
}));

vi.mock('../../logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { requireTenantBodyAccess } from '../../api/middleware/auth.js';
import { UserRepo } from '../../db/repos/UserRepo.js';
import { SubscriptionRepo } from '../../db/repos/SubscriptionRepo.js';
import { db } from '../../db/client.js';

function mockReply() {
  const reply = { statusCode: null, body: null };
  reply.code = (c) => { reply.statusCode = c; return reply; };
  reply.send = (b) => { reply.body = b; return reply; };
  return reply;
}

describe('requireTenantBodyAccess', () => {
  beforeEach(() => vi.clearAllMocks());

  it('lets a global admin through', async () => {
    const reply = mockReply();
    await requireTenantBodyAccess({ user: { role: 'admin' }, body: { tenant_id: 't1' } }, reply);
    expect(reply.statusCode).toBeNull();
  });

  it('rejects without tenant_id in the body', async () => {
    const reply = mockReply();
    await requireTenantBodyAccess({ user: { role: 'tenant_user', id: 'u1' }, body: {} }, reply);
    expect(reply.statusCode).toBe(400);
  });

  it('rejects a user without access to the target tenant (the IDOR fix)', async () => {
    UserRepo.hasAccessToTenant.mockResolvedValue(false);
    const reply = mockReply();
    await requireTenantBodyAccess({ user: { role: 'tenant_user', id: 'u1' }, body: { tenant_id: 'OUTRO_TENANT' } }, reply);
    expect(reply.statusCode).toBe(403);
    expect(UserRepo.hasAccessToTenant).toHaveBeenCalledWith('u1', 'OUTRO_TENANT');
  });

  it('allows the tenant owner', async () => {
    UserRepo.hasAccessToTenant.mockResolvedValue(true);
    const reply = mockReply();
    await requireTenantBodyAccess({ user: { role: 'tenant_user', id: 'u1' }, body: { tenant_id: 't1' } }, reply);
    expect(reply.statusCode).toBeNull();
  });
});

describe('SubscriptionRepo.checkAccess — ACTIVE with ended period', () => {
  beforeEach(() => vi.clearAllMocks());

  function stubSub(sub) {
    db.query.mockImplementation(async () => ({ rows: [sub] }));
  }

  it('allows within the 3-day webhook-delay grace', async () => {
    const periodEnd = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000); // 2 days ago
    stubSub({ status: 'active', current_period_end: periodEnd });
    const access = await SubscriptionRepo.checkAccess('t1');
    expect(access).toMatchObject({ allowed: true, reason: 'ACTIVE_GRACE' });
  });

  it('blocks after the grace expires (lost webhook no longer means free service)', async () => {
    const periodEnd = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000); // 5 days ago
    stubSub({ status: 'active', current_period_end: periodEnd });
    const access = await SubscriptionRepo.checkAccess('t1');
    expect(access).toMatchObject({ allowed: false, reason: 'ACTIVE_PERIOD_ENDED' });
  });
});

describe('SubscriptionRepo.checkQuota — monthly email limit', () => {
  beforeEach(() => vi.clearAllMocks());

  it('blocks when the monthly count reaches the plan limit', async () => {
    let call = 0;
    db.query.mockImplementation(async () => {
      call++;
      if (call === 1) return { rows: [{ email_limit: 100 }] };        // findByTenantId
      return { rows: [{ used: 100 }] };                                // monthly COUNT
    });
    const quota = await SubscriptionRepo.checkQuota('t1');
    expect(quota).toMatchObject({ allowed: false, reason: 'EMAIL_LIMIT', used: 100, limit: 100 });
  });

  it('allows when under the limit and when the plan has no limit', async () => {
    let call = 0;
    db.query.mockImplementation(async () => {
      call++;
      if (call === 1) return { rows: [{ email_limit: null }] };
      return { rows: [{ used: 999999 }] };
    });
    expect(await SubscriptionRepo.checkQuota('t1')).toMatchObject({ allowed: true, reason: 'UNLIMITED' });
  });
});
