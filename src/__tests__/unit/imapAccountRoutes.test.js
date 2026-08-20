import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies before importing the module under test
vi.mock('../../db/repos/ImapAccountRepo.js', () => ({
  findAllActiveByTenant: vi.fn(),
  countByTenant: vi.fn(),
  create: vi.fn(),
  findById: vi.fn(),
  setActive: vi.fn(),
  updateMapping: vi.fn(),
  findRawById: vi.fn(),
  update: vi.fn(),
}));

vi.mock('../../db/repos/TenantRepo.js', () => ({
  findById: vi.fn(),
}));

// GET (list) and DELETE query the database directly — mock the pool so the
// suite never needs a running PostgreSQL.
vi.mock('../../db/client.js', () => ({
  db: { query: vi.fn(), getClient: vi.fn() },
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
import * as TenantRepo from '../../db/repos/TenantRepo.js';
import { db } from '../../db/client.js';
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
    db.query.mockResolvedValue({ rows: [] });
    TenantRepo.findById.mockResolvedValue({
      id: 'tenant-1',
      bitrix_category_id: 9,
      bitrix_stage_id: 'C9:NEW',
      bitrix_responsible_id: 1,
      field_mapping: {},
      deal_mode: 'create_new',
      sync_start_date: null,
    });
    const { app, routes: r } = createMockApp();
    routes = r;
    await imapAccountsRoutes(app);
  });

  describe('GET /tenants/:id/imap-accounts', () => {
    it('returns accounts without the encrypted password field', async () => {
      // The route queries the DB directly (shows active AND paused accounts)
      db.query.mockResolvedValue({
        rows: [
          { id: 'acc-1', email: 'a@test.com', host: 'imap.test.com', password_enc: 'enc-secret' },
          { id: 'acc-2', email: 'b@test.com', host: 'imap.test.com', password_enc: 'enc-secret2' },
        ],
      });

      const reply = createMockReply();
      await routes['GET /tenants/:id/imap-accounts'](
        { params: { id: 'tenant-1' } },
        reply
      );

      expect(db.query).toHaveBeenCalled();
      expect(reply.body).toHaveLength(2);
      expect(reply.body[0]).not.toHaveProperty('password_enc');
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

    it('creates account inheriting tenant mapping and starts worker, returns 201', async () => {
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
      // Tenant mapping must be inherited by the new account (Requirement 3)
      expect(ImapAccountRepo.create).toHaveBeenCalledWith('tenant-1', expect.objectContaining({
        email: 'x@t.com',
        host: 'h',
        username: 'u',
        password: 'p',
        bitrix_category_id: 9,
        bitrix_stage_id: 'C9:NEW',
      }));
      expect(TenantScheduler.startAccount).toHaveBeenCalledWith(fullAccount);
    });
  });

  describe('PATCH /tenants/:id/imap-accounts/:accountId/toggle', () => {
    it('pauses worker when active is false', async () => {
      ImapAccountRepo.findById.mockResolvedValue({ id: 'acc-1', tenant_id: 'tenant-1' });
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
      const fullAccount = { id: 'acc-1', tenant_id: 'tenant-1', active: true, email: 'a@t.com' };
      ImapAccountRepo.findById.mockResolvedValue(fullAccount);
      ImapAccountRepo.setActive.mockResolvedValue({ id: 'acc-1', active: true });

      const reply = createMockReply();
      await routes['PATCH /tenants/:id/imap-accounts/:accountId/toggle'](
        { params: { id: 'tenant-1', accountId: 'acc-1' }, body: { active: true } },
        reply
      );

      expect(TenantScheduler.startAccount).toHaveBeenCalledWith(fullAccount);
    });

    it('returns 404 when account not found', async () => {
      ImapAccountRepo.findById.mockResolvedValue(null);

      const reply = createMockReply();
      await routes['PATCH /tenants/:id/imap-accounts/:accountId/toggle'](
        { params: { id: 'tenant-1', accountId: 'nonexistent' }, body: { active: true } },
        reply
      );

      expect(reply.statusCode).toBe(404);
      expect(reply.body.error).toMatch(/not found/i);
    });

    it('returns 404 when the account belongs to another tenant', async () => {
      ImapAccountRepo.findById.mockResolvedValue({ id: 'acc-1', tenant_id: 'tenant-OUTRO' });

      const reply = createMockReply();
      await routes['PATCH /tenants/:id/imap-accounts/:accountId/toggle'](
        { params: { id: 'tenant-1', accountId: 'acc-1' }, body: { active: true } },
        reply
      );

      expect(reply.statusCode).toBe(404);
      expect(reply.body.error).toMatch(/not found/i);
    });
  });

  describe('PATCH /tenants/:id/imap-accounts/:accountId (general update)', () => {
    it('never leaks the decrypted password when update() short-circuits to findById()', async () => {
      // Regression: update({}) returns findById()'s decrypted shape, which
      // used to include the plaintext password in the HTTP response.
      ImapAccountRepo.findById.mockResolvedValue({ id: 'acc-1', tenant_id: 'tenant-1' });
      ImapAccountRepo.update.mockResolvedValue({ id: 'acc-1', tenant_id: 'tenant-1', email: 'a@t.com', password: 'PLAINTEXT-SECRET' });

      const reply = createMockReply();
      const result = await routes['PATCH /tenants/:id/imap-accounts/:accountId'](
        { params: { id: 'tenant-1', accountId: 'acc-1' }, body: {} },
        reply
      );

      // handler returns the sanitized object directly (Fastify serializes it)
      expect(result).not.toHaveProperty('password');
      expect(result).not.toHaveProperty('password_enc');
      expect(result.email).toBe('a@t.com');
    });
  });

  describe('DELETE /tenants/:id/imap-accounts/:accountId', () => {
    it('stops worker, deletes account and its data, returns 204', async () => {
      ImapAccountRepo.findById.mockResolvedValue({ id: 'acc-1', tenant_id: 'tenant-1' });
      TenantScheduler.stopAccount.mockResolvedValue();
      db.query.mockResolvedValue({ rowCount: 1 });

      const reply = createMockReply();
      await routes['DELETE /tenants/:id/imap-accounts/:accountId'](
        { params: { id: 'tenant-1', accountId: 'acc-1' } },
        reply
      );

      expect(TenantScheduler.stopAccount).toHaveBeenCalledWith('acc-1');
      // retry_jobs + bitrix_results + email_events + imap_accounts
      expect(db.query).toHaveBeenCalledTimes(4);
      expect(reply.statusCode).toBe(204);
    });

    it('returns 404 when the account belongs to another tenant', async () => {
      ImapAccountRepo.findById.mockResolvedValue({ id: 'acc-1', tenant_id: 'tenant-OUTRO' });

      const reply = createMockReply();
      await routes['DELETE /tenants/:id/imap-accounts/:accountId'](
        { params: { id: 'tenant-1', accountId: 'acc-1' } },
        reply
      );

      expect(reply.statusCode).toBe(404);
      expect(db.query).not.toHaveBeenCalled();
    });
  });
});
