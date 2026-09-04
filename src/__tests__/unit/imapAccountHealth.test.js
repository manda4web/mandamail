import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../db/repos/ImapAccountRepo.js', () => ({
  findAllActiveByTenant: vi.fn(),
  countByTenant: vi.fn(),
  create: vi.fn(),
  findById: vi.fn(),
  setActive: vi.fn(),
  updateMapping: vi.fn(),
  findRawById: vi.fn(),
  update: vi.fn(),
  findHealthByTenant: vi.fn(),
}));

vi.mock('../../db/repos/TenantRepo.js', () => ({ findById: vi.fn() }));
vi.mock('../../db/client.js', () => ({ db: { query: vi.fn(), getClient: vi.fn() } }));

vi.mock('../../imap/TenantScheduler.js', () => ({
  TenantScheduler: {
    startAccount: vi.fn(),
    stopAccount: vi.fn(),
    getWorkerState: vi.fn(),
  },
}));

vi.mock('../../api/middleware/auth.js', () => ({ requireTenantAccess: vi.fn() }));
vi.mock('../../logger.js', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import * as ImapAccountRepo from '../../db/repos/ImapAccountRepo.js';
import { TenantScheduler } from '../../imap/TenantScheduler.js';
import imapAccountsRoutes from '../../api/routes/imapAccounts.js';

function createMockApp() {
  const routes = {};
  const reg = (m) => (path, ...args) => { routes[`${m} ${path}`] = args[args.length - 1]; };
  return { app: { get: reg('GET'), post: reg('POST'), patch: reg('PATCH'), delete: reg('DELETE') }, routes };
}
function createMockReply() {
  const reply = {
    statusCode: 200, body: null,
    code(c) { reply.statusCode = c; return reply; },
    send(d) { reply.body = d; return reply; },
  };
  return reply;
}

const now = Date.now();
const minsAgo = (m) => new Date(now - m * 60_000).toISOString();

describe('GET /tenants/:id/imap-accounts/health', () => {
  let routes;

  beforeEach(async () => {
    vi.clearAllMocks();
    process.env.SILENT_ACCOUNT_MINUTES = '15';
    const { app, routes: r } = createMockApp();
    routes = r;
    await imapAccountsRoutes(app);
  });

  async function callHealth() {
    const reply = createMockReply();
    await routes['GET /tenants/:id/imap-accounts/health']({ params: { id: 't-1' } }, reply);
    return reply;
  }

  it('classifies a healthy account (recent poll, running worker, no error)', async () => {
    ImapAccountRepo.findHealthByTenant.mockResolvedValue([
      { id: 'a1', email: 'h@x.com', active: true, last_poll_at: minsAgo(1), last_error: null },
    ]);
    TenantScheduler.getWorkerState.mockReturnValue({ running: true, stalled: false, msSinceActivity: 1000 });

    const reply = await callHealth();
    expect(reply.body.accounts[0].state).toBe('healthy');
    expect(reply.body.summary).toMatchObject({ total: 1, healthy: 1 });
  });

  it('classifies a silent account (poll older than threshold)', async () => {
    ImapAccountRepo.findHealthByTenant.mockResolvedValue([
      { id: 'a1', email: 's@x.com', active: true, last_poll_at: minsAgo(30), last_error: null },
    ]);
    TenantScheduler.getWorkerState.mockReturnValue({ running: true, stalled: false, msSinceActivity: 30 * 60_000 });

    const reply = await callHealth();
    expect(reply.body.accounts[0].state).toBe('silent');
    expect(reply.body.summary.silent).toBe(1);
  });

  it('classifies a stalled account (worker present but stalled)', async () => {
    ImapAccountRepo.findHealthByTenant.mockResolvedValue([
      { id: 'a1', email: 'st@x.com', active: true, last_poll_at: minsAgo(1), last_error: null },
    ]);
    TenantScheduler.getWorkerState.mockReturnValue({ running: true, stalled: true, msSinceActivity: 999999 });

    const reply = await callHealth();
    expect(reply.body.accounts[0].state).toBe('stalled');
    expect(reply.body.summary.stalled).toBe(1);
  });

  it('classifies a stopped account (active but no worker in memory)', async () => {
    ImapAccountRepo.findHealthByTenant.mockResolvedValue([
      { id: 'a1', email: 'sp@x.com', active: true, last_poll_at: minsAgo(1), last_error: null },
    ]);
    TenantScheduler.getWorkerState.mockReturnValue(null);

    const reply = await callHealth();
    expect(reply.body.accounts[0].state).toBe('stopped');
    expect(reply.body.summary.stopped).toBe(1);
  });

  it('classifies a paused account (active = false) regardless of worker', async () => {
    ImapAccountRepo.findHealthByTenant.mockResolvedValue([
      { id: 'a1', email: 'p@x.com', active: false, last_poll_at: minsAgo(120), last_error: null },
    ]);
    TenantScheduler.getWorkerState.mockReturnValue(null);

    const reply = await callHealth();
    expect(reply.body.accounts[0].state).toBe('paused');
    expect(reply.body.summary.paused).toBe(1);
  });

  it('classifies an error account (recent poll but last_error set)', async () => {
    ImapAccountRepo.findHealthByTenant.mockResolvedValue([
      { id: 'a1', email: 'e@x.com', active: true, last_poll_at: minsAgo(1), last_error: 'auth failed' },
    ]);
    TenantScheduler.getWorkerState.mockReturnValue({ running: true, stalled: false, msSinceActivity: 1000 });

    const reply = await callHealth();
    expect(reply.body.accounts[0].state).toBe('error');
    expect(reply.body.summary.error).toBe(1);
  });

  it('never leaks password fields and reports seconds_since_last_poll', async () => {
    ImapAccountRepo.findHealthByTenant.mockResolvedValue([
      { id: 'a1', email: 'h@x.com', active: true, last_poll_at: minsAgo(2), last_error: null, password_enc: 'SECRET' },
    ]);
    TenantScheduler.getWorkerState.mockReturnValue({ running: true, stalled: false, msSinceActivity: 2000 });

    const reply = await callHealth();
    expect(reply.body.accounts[0]).not.toHaveProperty('password_enc');
    expect(reply.body.accounts[0].seconds_since_last_poll).toBeGreaterThanOrEqual(115);
  });
});
