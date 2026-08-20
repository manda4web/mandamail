import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';

// Mock dependencies
vi.mock('../../db/repos/EmailEventRepo.js', () => ({
  EmailEventRepo: {
    list: vi.fn(),
    getDailyStats: vi.fn(),
  },
}));

vi.mock('../../db/repos/BitrixResultRepo.js', () => ({
  BitrixResultRepo: {
    countDealsByTenant: vi.fn().mockResolvedValue(0),
  },
}));

vi.mock('../../imap/TenantScheduler.js', () => ({
  TenantScheduler: {
    status: vi.fn(),
  },
}));

vi.mock('../../api/middleware/auth.js', () => ({
  authenticate: vi.fn(async () => {}),
  requireRole: vi.fn(() => async () => {}),
  requireTenantAccess: vi.fn(async () => {}),
}));

vi.mock('../../logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../db/client.js', () => ({
  db: { query: vi.fn() },
}));

vi.mock('jsonwebtoken', () => ({
  default: { verify: vi.fn(), sign: vi.fn() },
}));

import { EmailEventRepo } from '../../db/repos/EmailEventRepo.js';
import { TenantScheduler } from '../../imap/TenantScheduler.js';
import eventsRoutes from '../../api/routes/events.js';

describe('Events Routes', () => {
  let app;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = Fastify();
    await app.register(eventsRoutes);
    await app.ready();
  });

  describe('GET /tenants/:id/events', () => {
    it('returns paginated events with default page and limit', async () => {
      const mockResult = {
        data: [{ id: '1', status: 'RECEBIDO' }],
        total: 1,
        page: 1,
        limit: 20,
        totalPages: 1,
      };
      EmailEventRepo.list.mockResolvedValue(mockResult);

      const response = await app.inject({
        method: 'GET',
        url: '/tenants/tenant-123/events',
      });

      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.payload)).toEqual(mockResult);
      expect(EmailEventRepo.list).toHaveBeenCalledWith({
        tenantId: 'tenant-123',
        status: undefined,
        fromEmail: undefined,
        subject: undefined,
        startDate: undefined,
        endDate: undefined,
        page: 1,
        limit: 20,
      });
    });

    it('passes filters to EmailEventRepo.list', async () => {
      const mockResult = { data: [], total: 0, page: 1, limit: 20, totalPages: 0 };
      EmailEventRepo.list.mockResolvedValue(mockResult);

      const response = await app.inject({
        method: 'GET',
        url: '/tenants/tenant-123/events?page=2&limit=50&status=SUCESSO&from_email=test@example.com&subject=hello&start_date=2024-01-01&end_date=2024-01-31',
      });

      expect(response.statusCode).toBe(200);
      expect(EmailEventRepo.list).toHaveBeenCalledWith({
        tenantId: 'tenant-123',
        status: 'SUCESSO',
        fromEmail: 'test@example.com',
        subject: 'hello',
        startDate: '2024-01-01',
        endDate: '2024-01-31',
        page: 2,
        limit: 50,
      });
    });

    it('returns 400 for invalid status filter', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/tenants/tenant-123/events?status=INVALID',
      });

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.payload);
      expect(body.error).toContain('Invalid status filter');
    });

    it('returns 400 when limit exceeds 100', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/tenants/tenant-123/events?limit=101',
      });

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.payload);
      expect(body.error).toContain('limit must not exceed 100');
    });

    it('returns 400 when start_date is after end_date', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/tenants/tenant-123/events?start_date=2024-12-31&end_date=2024-01-01',
      });

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.payload);
      expect(body.error).toContain('start_date must be before end_date');
    });

    it('returns 400 for invalid date format', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/tenants/tenant-123/events?start_date=not-a-date&end_date=also-not-a-date',
      });

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.payload);
      expect(body.error).toContain('Invalid date format');
    });

    it('accepts all 8 valid status values (incl. PLANO_INATIVO)', async () => {
      const validStatuses = [
        'RECEBIDO', 'PROCESSANDO', 'SUCESSO',
        'DUPLICADO', 'IGNORADO', 'ERRO', 'FALHA_DEFINITIVA', 'PLANO_INATIVO',
      ];

      EmailEventRepo.list.mockResolvedValue({ data: [], total: 0, page: 1, limit: 20, totalPages: 0 });

      for (const status of validStatuses) {
        const response = await app.inject({
          method: 'GET',
          url: `/tenants/tenant-123/events?status=${status}`,
        });
        expect(response.statusCode).toBe(200);
      }
    });
  });

  describe('GET /tenants/:id/dashboard', () => {
    it('returns daily stats for the tenant', async () => {
      const mockStats = {
        today: '15',
        week: '42',
        success_today: '10',
        errors: '2',
        pending: '3',
        recebido: '5',
        processando: '2',
        sucesso: '10',
        duplicado: '3',
        ignorado: '1',
        erro: '0',
        falha_definitiva: '0',
        total: '21',
      };
      EmailEventRepo.getDailyStats.mockResolvedValue(mockStats);

      const response = await app.inject({
        method: 'GET',
        url: '/tenants/tenant-456/dashboard',
      });

      expect(response.statusCode).toBe(200);
      const payload = JSON.parse(response.payload);
      expect(payload).toEqual({ ...mockStats, deals_count: 0 });
      expect(EmailEventRepo.getDailyStats).toHaveBeenCalledWith('tenant-456');
    });
  });
});
