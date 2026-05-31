import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock auth middleware
vi.mock('../../api/middleware/auth.js', () => ({
  authenticate: vi.fn(),
  requireRole: vi.fn(() => vi.fn()),
  requireTenantAccess: vi.fn(),
}));

// Mock TenantRepo
vi.mock('../../db/repos/TenantRepo.js', () => ({
  findAllActive: vi.fn(),
  findByBitrixUrl: vi.fn(),
  findById: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
}));

// Mock ImapAccountRepo
vi.mock('../../db/repos/ImapAccountRepo.js', () => ({
  findAllActiveByTenant: vi.fn(),
}));

// Mock TenantScheduler
vi.mock('../../imap/TenantScheduler.js', () => ({
  TenantScheduler: {
    stopTenant: vi.fn(),
    startAccount: vi.fn(),
    status: vi.fn(),
  },
}));

// Mock BitrixClient
vi.mock('../../bitrix/BitrixClient.js', () => ({
  BitrixClient: vi.fn().mockImplementation(() => ({
    call: vi.fn().mockResolvedValue({ version: '1.0' }),
    timeout: 30000,
    maxAttempts: 3,
  })),
}));

// Mock imapflow
vi.mock('imapflow', () => ({
  ImapFlow: vi.fn(),
}));

import tenantsRoutes from '../../api/routes/tenants.js';
import { tenantsRoutes as tenantsRoutesNamed } from '../../api/routes/tenants.js';
import * as TenantRepo from '../../db/repos/TenantRepo.js';
import * as ImapAccountRepo from '../../db/repos/ImapAccountRepo.js';
import { TenantScheduler } from '../../imap/TenantScheduler.js';

/**
 * Creates a mock Fastify instance that captures route registrations.
 */
function createMockFastify() {
  const routes = {};
  const fastify = {
    get: (path, opts, handler) => { routes[`GET ${path}`] = handler; },
    post: (path, opts, handler) => { routes[`POST ${path}`] = handler; },
    patch: (path, opts, handler) => { routes[`PATCH ${path}`] = handler; },
  };
  return { fastify, routes };
}

function createMockReply() {
  const reply = {
    statusCode: 200,
    body: null,
    code(c) { this.statusCode = c; return this; },
    send(data) { this.body = data; return data; },
  };
  return reply;
}

describe('tenantsRoutes', () => {
  let routes;
  let reply;

  beforeEach(async () => {
    vi.clearAllMocks();
    const mock = createMockFastify();
    await tenantsRoutes(mock.fastify);
    routes = mock.routes;
    reply = createMockReply();
  });

  describe('GET /tenants', () => {
    it('returns all active tenants', async () => {
      const tenants = [{ id: '1', name: 'Tenant A' }, { id: '2', name: 'Tenant B' }];
      TenantRepo.findAllActive.mockResolvedValue(tenants);

      const result = await routes['GET /tenants']({}, reply);
      expect(result).toEqual(tenants);
      expect(TenantRepo.findAllActive).toHaveBeenCalled();
    });
  });

  describe('POST /tenants', () => {
    it('returns 400 if required fields are missing', async () => {
      const request = { body: { name: 'Test' } };
      await routes['POST /tenants'](request, reply);

      expect(reply.statusCode).toBe(400);
      expect(reply.body.fields).toContain('bitrix_url');
      expect(reply.body.fields).toContain('bitrix_webhook_token');
    });

    it('returns 400 if all fields are missing', async () => {
      const request = { body: {} };
      await routes['POST /tenants'](request, reply);

      expect(reply.statusCode).toBe(400);
      expect(reply.body.fields).toContain('name');
      expect(reply.body.fields).toContain('bitrix_url');
      expect(reply.body.fields).toContain('bitrix_webhook_token');
    });

    it('returns 409 if bitrix_url already exists', async () => {
      TenantRepo.findByBitrixUrl.mockResolvedValue({ id: 'existing' });

      const request = {
        body: { name: 'Test', bitrix_url: 'https://test.bitrix24.com', bitrix_webhook_token: 'token123' },
      };
      await routes['POST /tenants'](request, reply);

      expect(reply.statusCode).toBe(409);
      expect(reply.body.error).toContain('already in use');
    });

    it('returns 201 on successful creation', async () => {
      TenantRepo.findByBitrixUrl.mockResolvedValue(null);
      const created = { id: 'new-id', name: 'Test', bitrix_url: 'https://test.bitrix24.com' };
      TenantRepo.create.mockResolvedValue(created);

      const request = {
        body: { name: 'Test', bitrix_url: 'https://test.bitrix24.com', bitrix_webhook_token: 'token123' },
      };
      const result = await routes['POST /tenants'](request, reply);

      expect(reply.statusCode).toBe(201);
      expect(result).toEqual(created);
    });
  });

  describe('PATCH /tenants/:id', () => {
    it('returns 404 if tenant not found', async () => {
      TenantRepo.findById.mockResolvedValue(null);

      const request = { params: { id: 'nonexistent' }, body: { name: 'Updated' } };
      await routes['PATCH /tenants/:id'](request, reply);

      expect(reply.statusCode).toBe(404);
    });

    it('returns 409 if new bitrix_url conflicts', async () => {
      const existing = { id: 't1', bitrix_url: 'https://old.bitrix24.com', bitrix_webhook_token: 'old-token' };
      TenantRepo.findById.mockResolvedValue(existing);
      TenantRepo.findByBitrixUrl.mockResolvedValue({ id: 'other-tenant' });

      const request = {
        params: { id: 't1' },
        body: { bitrix_url: 'https://taken.bitrix24.com' },
      };
      await routes['PATCH /tenants/:id'](request, reply);

      expect(reply.statusCode).toBe(409);
    });

    it('updates tenant and restarts workers if bitrix_url changes', async () => {
      const existing = { id: 't1', bitrix_url: 'https://old.bitrix24.com', bitrix_webhook_token: 'old-token' };
      TenantRepo.findById.mockResolvedValue(existing);
      TenantRepo.findByBitrixUrl.mockResolvedValue(null);
      TenantRepo.update.mockResolvedValue({ ...existing, bitrix_url: 'https://new.bitrix24.com' });
      ImapAccountRepo.findAllActiveByTenant.mockResolvedValue([{ id: 'acc1' }, { id: 'acc2' }]);

      const request = {
        params: { id: 't1' },
        body: { bitrix_url: 'https://new.bitrix24.com' },
      };
      await routes['PATCH /tenants/:id'](request, reply);

      expect(TenantScheduler.stopTenant).toHaveBeenCalledWith('t1');
      expect(TenantScheduler.startAccount).toHaveBeenCalledTimes(2);
      expect(TenantScheduler.startAccount).toHaveBeenCalledWith({ id: 'acc1' });
      expect(TenantScheduler.startAccount).toHaveBeenCalledWith({ id: 'acc2' });
    });

    it('updates tenant and restarts workers if bitrix_webhook_token changes', async () => {
      const existing = { id: 't1', bitrix_url: 'https://test.bitrix24.com', bitrix_webhook_token: 'old-token' };
      TenantRepo.findById.mockResolvedValue(existing);
      TenantRepo.update.mockResolvedValue({ ...existing, bitrix_webhook_token: 'new-token' });
      ImapAccountRepo.findAllActiveByTenant.mockResolvedValue([]);

      const request = {
        params: { id: 't1' },
        body: { bitrix_webhook_token: 'new-token' },
      };
      await routes['PATCH /tenants/:id'](request, reply);

      expect(TenantScheduler.stopTenant).toHaveBeenCalledWith('t1');
    });

    it('updates tenant without restarting workers if no connection fields change', async () => {
      const existing = { id: 't1', bitrix_url: 'https://test.bitrix24.com', bitrix_webhook_token: 'token' };
      TenantRepo.findById.mockResolvedValue(existing);
      TenantRepo.update.mockResolvedValue({ ...existing, name: 'New Name' });

      const request = { params: { id: 't1' }, body: { name: 'New Name' } };
      await routes['PATCH /tenants/:id'](request, reply);

      expect(TenantScheduler.stopTenant).not.toHaveBeenCalled();
    });
  });

  describe('POST /tenants/test-bitrix', () => {
    it('returns 400 if required fields are missing', async () => {
      const request = { body: {} };
      await routes['POST /tenants/test-bitrix'](request, reply);

      expect(reply.statusCode).toBe(400);
      expect(reply.body.fields).toContain('bitrix_url');
      expect(reply.body.fields).toContain('bitrix_webhook_token');
    });
  });

  describe('POST /tenants/test-imap', () => {
    it('returns 400 if required fields are missing', async () => {
      const request = { body: { host: 'imap.test.com' } };
      await routes['POST /tenants/test-imap'](request, reply);

      expect(reply.statusCode).toBe(400);
      expect(reply.body.fields).toContain('username');
      expect(reply.body.fields).toContain('password');
    });
  });

  describe('GET /admin/workers', () => {
    it('returns TenantScheduler status', async () => {
      const status = [{ accountId: 'a1', email: 'test@test.com', running: true }];
      TenantScheduler.status.mockReturnValue(status);

      const result = await routes['GET /admin/workers']({}, reply);
      expect(result).toEqual(status);
    });
  });

});
