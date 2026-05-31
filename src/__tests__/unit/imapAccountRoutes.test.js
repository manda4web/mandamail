import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies before importing the module under test
vi.mock('../../db/repos/ImapAccountRepo.js', () => ({
  findAllActiveByTenant: vi.fn(),
  countByTenant: vi.fn(),
  create: vi.fn(),
  findById: vi.fn(),
  setActive: vi.fn(),
}));

vi.mock('../../imap/TenantScheduler.js', () => ({
  TenantScheduler: {
    startAccount: vi.fn(),
    stopAccount: vi.fn(),
  },
}));

vi.mock('../../api/middleware/auth.js', () => ({
  requireTenantAccess: vi.fn(),
}));

vi.mock('../../logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import * as ImapAccountRepo from '../../db/repos/ImapAccountRepo.js';
import { TenantScheduler } from '../../imap/TenantScheduler.js';
import imapAccountsRoutes from '../../api/routes/imapAccounts.js';

/**
 * Helper to create a minimal mock Fastify app that captures route registrations.
 */
function createMockApp() {
  const routes = {};

  const app = {
    get: (path, ...args) => {
      const handler = args[args.length - 1];
      routes[`GET ${path}`] = handler;
    },
    post: (path, ...args) => {
      const handler = args[args.length - 1];
      routes[`POST ${path}`] = handler;
    },
    patch: (path, ...args) => {
      const handler = args[args.length - 1];
      routes[`PATCH ${path}`] = handler;
    },
    delete: (path, ...args) => {
      const handler = args[args.length - 1];
      routes[`DELETE ${path}`] = handler;
    },
  };

  return { app, routes };
}

function createMockReply() {
  const reply = {
    statusCode: 200,
    body: null,
    code(c) { reply.statusCode = c; return reply; },
    send(data) { reply.body = data; return reply; },
  };
  return reply;
}

describe('imapAccountsRoutes', () => {
  let routes;

  beforeEach(async () => {
    vi.clearAllMocks();
    const { app, routes: r } = createMockApp();
    routes = r;
    await imapAccountsRoutes(app);
  });

  describe('GET /tenants/:id/imap-accounts', () => {
    it('returns accounts without password field', async () => {
      const mockAccounts = [
        { id: 'acc-1', email: 'a@test.com', host: 'imap.test.com', password: 'secret123' },
        { id: 'acc-2', email: 'b@test.com', host: 'imap.test.com', password: 'secret456' },
      ];
      ImapAccountRepo.findAllActiveByTenant.mockResolvedValue(mockAccounts);

      const reply = createMockReply();
      await routes['GET /tenants/:id/imap-accounts'](
        { params: { id: 'tenant-1' } },
        reply
      );

      expect(ImapAccountRepo.findAllActiveByTenant).toHaveBeenCalledWith('tenant-1');
      expect(reply.body).toHaveLength(2);
      expect(reply.body[0]).not.toHaveProperty('password');
      expect(reply.body[1]).not.toHaveProperty('password');
      expect(reply.body[0].email).toBe('a@test.com');
    });
  });

  describe('POST /tenants/:id/imap-accounts', () => {
    it('rejects when tenant has 50 accounts', async () => {
      ImapAccountRepo.countByTenant.mockResolvedValue(50);

      const reply = createMockReply();
      await routes['POST /tenants/:id/imap-accounts'](
        { params: { id: 'tenant-1' }, body: { email: 'x@t.com', host: 'h', username: 'u', password: 'p' } },
        reply
      );

      expect(reply.statusCode).toBe(400);
      expect(reply.body.error).toMatch(/maximum account limit/i);
    });

    it('creates account and starts worker, returns 201', async () => {
      ImapAccountRepo.countByTenant.mockResolvedValue(10);
      const createdAccount = { id: 'new-acc', email: 'x@t.com', host: 'h' };
      ImapAccountRepo.create.mockResolvedValue(createdAccount);
      const fullAccount = { ...createdAccount, tenant_id: 'tenant-1', password: 'p' };
      ImapAccountRepo.findById.mockResolvedValue(fullAccount);
      TenantScheduler.startAccount.mockResolvedValue();

      const reply = createMockReply();
      await routes['POST /tenants/:id/imap-accounts'](
        { params: { id: 'tenant-1' }, body: { email: 'x@t.com', host: 'h', username: 'u', password: 'p' } },
        reply
      );

      expect(reply.statusCode).toBe(201);
      expect(reply.body).toEqual(createdAccount);
      expect(ImapAccountRepo.create).toHaveBeenCalledWith('tenant-1', { email: 'x@t.com', host: 'h', username: 'u', password: 'p' });
      expect(TenantScheduler.startAccount).toHaveBeenCalledWith(fullAccount);
    });
  });

  describe('PATCH /tenants/:id/imap-accounts/:accountId/toggle', () => {
    it('pauses worker when active is false', async () => {
      ImapAccountRepo.setActive.mockResolvedValue({ id: 'acc-1', active: false });

      const reply = createMockReply();
      await routes['PATCH /tenants/:id/imap-accounts/:accountId/toggle'](
        { params: { id: 'tenant-1', accountId: 'acc-1' }, body: { active: false } },
        reply
      );

      expect(ImapAccountRepo.setActive).toHaveBeenCalledWith('acc-1', false);
      expect(TenantScheduler.stopAccount).toHaveBeenCalledWith('acc-1');
      expect(reply.body.active).toBe(false);
    });

    it('resumes worker when active is true', async () => {
      ImapAccountRepo.setActive.mockResolvedValue({ id: 'acc-1', active: true });
      const fullAccount = { id: 'acc-1', active: true, email: 'a@t.com' };
      ImapAccountRepo.findById.mockResolvedValue(fullAccount);

      const reply = createMockReply();
      await routes['PATCH /tenants/:id/imap-accounts/:accountId/toggle'](
        { params: { id: 'tenant-1', accountId: 'acc-1' }, body: { active: true } },
        reply
      );

      expect(TenantScheduler.startAccount).toHaveBeenCalledWith(fullAccount);
    });

    it('returns 404 when account not found', async () => {
      ImapAccountRepo.setActive.mockResolvedValue(null);

      const reply = createMockReply();
      await routes['PATCH /tenants/:id/imap-accounts/:accountId/toggle'](
        { params: { id: 'tenant-1', accountId: 'nonexistent' }, body: { active: true } },
        reply
      );

      expect(reply.statusCode).toBe(404);
      expect(reply.body.error).toMatch(/not found/i);
    });
  });

  describe('DELETE /tenants/:id/imap-accounts/:accountId', () => {
    it('stops worker, deactivates account, returns 204', async () => {
      TenantScheduler.stopAccount.mockResolvedValue();
      ImapAccountRepo.setActive.mockResolvedValue({ id: 'acc-1', active: false });

      const reply = createMockReply();
      await routes['DELETE /tenants/:id/imap-accounts/:accountId'](
        { params: { id: 'tenant-1', accountId: 'acc-1' } },
        reply
      );

      expect(TenantScheduler.stopAccount).toHaveBeenCalledWith('acc-1');
      expect(ImapAccountRepo.setActive).toHaveBeenCalledWith('acc-1', false);
      expect(reply.statusCode).toBe(204);
    });
  });
});
