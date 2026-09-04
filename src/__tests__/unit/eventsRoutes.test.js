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

    it('exports CSV allowing limit above the JSON cap (regression: 400 killed the export button)', async () => {
      EmailEventRepo.list.mockResolvedValue({
        data: [{
          created_at: '2026-08-20T10:00:00Z', status: 'SUCESSO', from_email: 'a@x.com',
          from_name: 'A', subject: '=SUM(A1)', account_email: 'acc@x.com',
          bitrix_deal_id: 1, bitrix_contact_id: 2, retry_count: 0,
        }],
        total: 1, page: 1, limit: 5000, totalPages: 1,
      });

      const response = await app.inject({
        method: 'GET',
        url: '/tenants/tenant-123/events?limit=5000&page=1&format=csv',
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('text/csv');
      expect(response.body).toContain('created_at,status,from_email');
      // Formula injection neutralized (= prefixed with ')
      expect(response.body).toContain("'=SUM(A1)");
      expect(EmailEventRepo.list).toHaveBeenCalledWith(expect.objectContaining({ limit: 5000 }));
    });

    it('still rejects limit>100 for JSON responses', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/tenants/tenant-123/events?limit=5000',
      });
      expect(response.statusCode).toBe(400);
    });

    it('rejects a non-UUID account_id with 400 instead of a Postgres 500', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/tenants/tenant-123/events?account_id=foo',
      });
      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body).error).toMatch(/account_id/i);
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
      // Dashboard now returns per-window deal counts alongside the all-time
      // total (all 0 here since countDealsByTenant is mocked to 0).
      expect(payload).toEqual({
        ...mockStats,
        deals_count: 0,
        deals_today: 0,
        deals_week: 0,
        deals_month: 0,
      });
      expect(EmailEventRepo.getDailyStats).toHaveBeenCalledWith('tenant-456');
    });
  });
});
