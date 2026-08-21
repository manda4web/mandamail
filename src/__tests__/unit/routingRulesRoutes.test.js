import { describe, it, expect, vi, beforeEach } from 'vitest';
import Ajv from 'ajv';

// Mock dependencies before importing the module under test
vi.mock('../../db/repos/RoutingRuleRepo.js', () => ({
  RoutingRuleRepo: {
    findActiveByTenant: vi.fn(),
    findByTenant: vi.fn(),
    findById: vi.fn(),
    findActiveByMatch: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock('../../api/middleware/auth.js', () => ({
  requireTenantAccess: vi.fn(),
}));

import { RoutingRuleRepo } from '../../db/repos/RoutingRuleRepo.js';
import routingRulesRoutes from '../../api/routes/routingRules.js';

/**
 * Helper to create a minimal mock Fastify app that captures route
 * registrations (handler + route options, so JSON schemas can be asserted).
 */
function createMockApp() {
  const routes = {};
  const routeOptions = {};

  const capture = (method) => (path, ...args) => {
    const handler = args[args.length - 1];
    routes[`${method} ${path}`] = handler;
    routeOptions[`${method} ${path}`] =
      args.length > 1 && args[0] && typeof args[0] === 'object' ? args[0] : {};
  };

  const app = {
    get: capture('GET'),
    post: capture('POST'),
    patch: capture('PATCH'),
    delete: capture('DELETE'),
  };

  return { app, routes, routeOptions };
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

describe('routingRulesRoutes', () => {
  let routes;
  let routeOptions;

  const baseRule = {
    id: 'rule-1',
    tenant_id: 'tenant-1',
    name: 'Regra OLX',
    match_type: 'domain',
    match_value: 'olx.com.br',
    bitrix_category_id: 5,
    bitrix_stage_id: 'C5:NEW',
    bitrix_responsible_id: 7,
    priority: 100,
    is_active: true,
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    RoutingRuleRepo.findByTenant.mockResolvedValue([]);
    RoutingRuleRepo.findById.mockResolvedValue(baseRule);
    RoutingRuleRepo.findActiveByMatch.mockResolvedValue(null);
    const { app, routes: r, routeOptions: o } = createMockApp();
    routes = r;
    routeOptions = o;
    await routingRulesRoutes(app);
  });

  describe('GET /tenants/:id/routing-rules', () => {
    it('returns the tenant rules as an array', async () => {
      RoutingRuleRepo.findByTenant.mockResolvedValue([
        baseRule,
        { ...baseRule, id: 'rule-2', match_value: 'mercadolivre.com' },
      ]);

      const reply = createMockReply();
      await routes['GET /tenants/:id/routing-rules'](
        { params: { id: 'tenant-1' } },
        reply
      );

      expect(RoutingRuleRepo.findByTenant).toHaveBeenCalledWith('tenant-1');
      expect(reply.statusCode).toBe(200);
      expect(reply.body).toHaveLength(2);
      expect(reply.body[1].match_value).toBe('mercadolivre.com');
    });
  });

  describe('POST /tenants/:id/routing-rules', () => {
    it('creates a domain rule normalizing "@Empresa.COM.br " to "empresa.com.br"', async () => {
      RoutingRuleRepo.create.mockResolvedValue({ ...baseRule, id: 'rule-new' });

      const reply = createMockReply();
      await routes['POST /tenants/:id/routing-rules'](
        {
          params: { id: 'tenant-1' },
          body: { match_type: 'domain', match_value: '@Empresa.COM.br ', bitrix_category_id: 5 },
        },
        reply
      );

      expect(reply.statusCode).toBe(201);
      expect(reply.body.id).toBe('rule-new');
      expect(RoutingRuleRepo.create).toHaveBeenCalledWith(expect.objectContaining({
        tenant_id: 'tenant-1',
        match_type: 'domain',
        match_value: 'empresa.com.br',
        bitrix_category_id: 5,
      }));
    });

    it('creates an exact rule normalizing "Cliente@X.com " to "cliente@x.com"', async () => {
      RoutingRuleRepo.create.mockResolvedValue({ ...baseRule, id: 'rule-new' });

      const reply = createMockReply();
      await routes['POST /tenants/:id/routing-rules'](
        {
          params: { id: 'tenant-1' },
          body: { match_type: 'exact', match_value: 'Cliente@X.com ', bitrix_stage_id: 'C5:NEW' },
        },
        reply
      );

      expect(reply.statusCode).toBe(201);
      expect(RoutingRuleRepo.create).toHaveBeenCalledWith(expect.objectContaining({
        match_type: 'exact',
        match_value: 'cliente@x.com',
      }));
    });

    it('rejects a rule with no destination (all three null/absent)', async () => {
      const reply = createMockReply();
      await routes['POST /tenants/:id/routing-rules'](
        {
          params: { id: 'tenant-1' },
          body: { match_type: 'domain', match_value: 'olx.com.br' },
        },
        reply
      );

      expect(reply.statusCode).toBe(400);
      expect(reply.body.error).toBe('Pelo menos um destino (pipeline, estágio ou responsável) deve ser definido');
      expect(RoutingRuleRepo.create).not.toHaveBeenCalled();
    });

    it('accepts bitrix_category_id 0 as a real destination (default pipeline override)', async () => {
      RoutingRuleRepo.create.mockResolvedValue({ ...baseRule, bitrix_category_id: 0 });

      const reply = createMockReply();
      await routes['POST /tenants/:id/routing-rules'](
        {
          params: { id: 'tenant-1' },
          body: { match_type: 'domain', match_value: 'olx.com.br', bitrix_category_id: 0 },
        },
        reply
      );

      expect(reply.statusCode).toBe(201);
      expect(RoutingRuleRepo.create).toHaveBeenCalledWith(expect.objectContaining({
        bitrix_category_id: 0,
      }));
    });

    it('rejects exact match_value without @', async () => {
      const reply = createMockReply();
      await routes['POST /tenants/:id/routing-rules'](
        {
          params: { id: 'tenant-1' },
          body: { match_type: 'exact', match_value: 'cliente.x.com', bitrix_category_id: 5 },
        },
        reply
      );

      expect(reply.statusCode).toBe(400);
      expect(reply.body.error).toMatch(/endereço de e-mail/i);
      expect(RoutingRuleRepo.create).not.toHaveBeenCalled();
    });

    it('rejects domain match_value with an internal @', async () => {
      const reply = createMockReply();
      await routes['POST /tenants/:id/routing-rules'](
        {
          params: { id: 'tenant-1' },
          body: { match_type: 'domain', match_value: 'a@empresa.com', bitrix_category_id: 5 },
        },
        reply
      );

      expect(reply.statusCode).toBe(400);
      expect(reply.body.error).toMatch(/domínio/i);
    });

    it('rejects domain match_value with an internal space', async () => {
      const reply = createMockReply();
      await routes['POST /tenants/:id/routing-rules'](
        {
          params: { id: 'tenant-1' },
          body: { match_type: 'domain', match_value: 'empresa .com.br', bitrix_category_id: 5 },
        },
        reply
      );

      expect(reply.statusCode).toBe(400);
      expect(reply.body.error).toMatch(/domínio/i);
    });

    it('rejects malformed domains that would never match any sender (REGRESSION: empty/edge-hyphen labels)', async () => {
      const cases = ['empresa..com.br', 'a-.com.br', 'empresa.-com.br', '-empresa.com', 'empresa.com-', 'localhost'];
      for (const value of cases) {
        const reply = createMockReply();
        await routes['POST /tenants/:id/routing-rules'](
          { params: { id: 'tenant-1' }, body: { match_type: 'domain', match_value: value, bitrix_category_id: 5 } },
          reply
        );
        expect(reply.statusCode, `match_value "${value}" should be rejected`).toBe(400);
        expect(reply.body.error).toMatch(/domínio/i);
      }
      expect(RoutingRuleRepo.create).not.toHaveBeenCalled();
    });

    it('accepts well-formed multi-label domains', async () => {
      RoutingRuleRepo.create.mockResolvedValue({ ...baseRule, id: 'rule-new' });

      for (const value of ['a.co', 'empresa.com.br', 'xn--80ak6aa92e.com']) {
        const reply = createMockReply();
        await routes['POST /tenants/:id/routing-rules'](
          { params: { id: 'tenant-1' }, body: { match_type: 'domain', match_value: value, bitrix_category_id: 5 } },
          reply
        );
        expect(reply.statusCode, `match_value "${value}" should be accepted`).toBe(201);
      }
    });

    it('REGRESSION race check-then-insert: a 23505 unique violation from create still returns 409, not 500', async () => {
      RoutingRuleRepo.create.mockRejectedValue(Object.assign(new Error('duplicate key'), {
        code: '23505',
        constraint: 'uq_routing_rules_active_match',
      }));

      const reply = createMockReply();
      await routes['POST /tenants/:id/routing-rules'](
        { params: { id: 'tenant-1' }, body: { match_type: 'domain', match_value: 'olx.com.br', bitrix_category_id: 5 } },
        reply
      );

      expect(reply.statusCode).toBe(409);
      expect(reply.body.error).toBe('Já existe uma regra ativa para este remetente');
    });

    it('returns 409 when an active rule with the same match exists', async () => {
      RoutingRuleRepo.findActiveByMatch.mockResolvedValue({ id: 'rule-other', match_type: 'domain', match_value: 'olx.com.br' });

      const reply = createMockReply();
      await routes['POST /tenants/:id/routing-rules'](
        {
          params: { id: 'tenant-1' },
          body: { match_type: 'domain', match_value: 'olx.com.br', bitrix_category_id: 5 },
        },
        reply
      );

      expect(reply.statusCode).toBe(409);
      expect(reply.body.error).toBe('Já existe uma regra ativa para este remetente');
      expect(RoutingRuleRepo.findActiveByMatch).toHaveBeenCalledWith('tenant-1', 'domain', 'olx.com.br');
      expect(RoutingRuleRepo.create).not.toHaveBeenCalled();
    });

    it('normalizes empty string bitrix_stage_id to null', async () => {
      RoutingRuleRepo.create.mockResolvedValue({ ...baseRule, id: 'rule-new' });

      const reply = createMockReply();
      await routes['POST /tenants/:id/routing-rules'](
        {
          params: { id: 'tenant-1' },
          body: { match_type: 'domain', match_value: 'olx.com.br', bitrix_category_id: 5, bitrix_stage_id: '' },
        },
        reply
      );

      expect(reply.statusCode).toBe(201);
      expect(RoutingRuleRepo.create).toHaveBeenCalledWith(expect.objectContaining({
        bitrix_stage_id: null,
      }));
    });

    it('rejects priority 0 and 10000 at the schema level (Fastify 400)', () => {
      const validate = new Ajv({ allErrors: true }).compile(
        routeOptions['POST /tenants/:id/routing-rules'].schema.body
      );
      const base = { match_type: 'domain', match_value: 'olx.com.br', bitrix_category_id: 5 };

      expect(validate({ ...base, priority: 0 })).toBe(false);
      expect(validate({ ...base, priority: 10000 })).toBe(false);
      expect(validate({ ...base, priority: 1 })).toBe(true);
      expect(validate({ ...base, priority: 9999 })).toBe(true);
    });
  });

  describe('PATCH /tenants/:id/routing-rules/:ruleId', () => {
    it('returns 404 when the rule belongs to another tenant', async () => {
      RoutingRuleRepo.findById.mockResolvedValue({ ...baseRule, tenant_id: 'tenant-OUTRO' });

      const reply = createMockReply();
      await routes['PATCH /tenants/:id/routing-rules/:ruleId'](
        { params: { id: 'tenant-1', ruleId: 'rule-1' }, body: { priority: 10 } },
        reply
      );

      expect(reply.statusCode).toBe(404);
      expect(reply.body.error).toBe('Routing rule not found');
      expect(RoutingRuleRepo.update).not.toHaveBeenCalled();
    });

    it('returns 404 when the rule does not exist', async () => {
      RoutingRuleRepo.findById.mockResolvedValue(null);

      const reply = createMockReply();
      await routes['PATCH /tenants/:id/routing-rules/:ruleId'](
        { params: { id: 'tenant-1', ruleId: 'inexistente' }, body: { priority: 10 } },
        reply
      );

      expect(reply.statusCode).toBe(404);
      expect(RoutingRuleRepo.update).not.toHaveBeenCalled();
    });

    it('passes bitrix_category_id 0 through to the repo (0 is a real write)', async () => {
      RoutingRuleRepo.update.mockResolvedValue({ ...baseRule, bitrix_category_id: 0 });

      const reply = createMockReply();
      await routes['PATCH /tenants/:id/routing-rules/:ruleId'](
        { params: { id: 'tenant-1', ruleId: 'rule-1' }, body: { bitrix_category_id: 0 } },
        reply
      );

      expect(reply.statusCode).toBe(200);
      // ONLY the fields present in the body — absent keys preserve current values
      expect(RoutingRuleRepo.update).toHaveBeenCalledWith('rule-1', { bitrix_category_id: 0 });
    });

    it('normalizes empty string bitrix_stage_id to null (clears the override)', async () => {
      RoutingRuleRepo.update.mockResolvedValue({ ...baseRule, bitrix_stage_id: null });

      const reply = createMockReply();
      await routes['PATCH /tenants/:id/routing-rules/:ruleId'](
        { params: { id: 'tenant-1', ruleId: 'rule-1' }, body: { bitrix_stage_id: '' } },
        reply
      );

      expect(reply.statusCode).toBe(200);
      expect(RoutingRuleRepo.update).toHaveBeenCalledWith('rule-1', { bitrix_stage_id: null });
    });

    it('rejects clearing all three destinations (merged state has none)', async () => {
      const reply = createMockReply();
      await routes['PATCH /tenants/:id/routing-rules/:ruleId'](
        {
          params: { id: 'tenant-1', ruleId: 'rule-1' },
          body: { bitrix_category_id: null, bitrix_stage_id: null, bitrix_responsible_id: null },
        },
        reply
      );

      expect(reply.statusCode).toBe(400);
      expect(reply.body.error).toBe('Pelo menos um destino (pipeline, estágio ou responsável) deve ser definido');
      expect(RoutingRuleRepo.update).not.toHaveBeenCalled();
    });

    it('returns 409 when reactivating (is_active: true) collides with an active rule', async () => {
      RoutingRuleRepo.findById.mockResolvedValue({ ...baseRule, is_active: false });
      RoutingRuleRepo.findActiveByMatch.mockResolvedValue({ id: 'rule-other', match_value: 'olx.com.br' });

      const reply = createMockReply();
      await routes['PATCH /tenants/:id/routing-rules/:ruleId'](
        { params: { id: 'tenant-1', ruleId: 'rule-1' }, body: { is_active: true } },
        reply
      );

      expect(reply.statusCode).toBe(409);
      expect(reply.body.error).toBe('Já existe uma regra ativa para este remetente');
      // The dup check must exclude the rule being edited
      expect(RoutingRuleRepo.findActiveByMatch).toHaveBeenCalledWith('tenant-1', 'domain', 'olx.com.br', 'rule-1');
      expect(RoutingRuleRepo.update).not.toHaveBeenCalled();
    });

    it('REGRESSION race: a 23505 unique violation from update still returns 409, not 500', async () => {
      RoutingRuleRepo.update.mockRejectedValue(Object.assign(new Error('duplicate key'), {
        code: '23505',
        constraint: 'uq_routing_rules_active_match',
      }));

      const reply = createMockReply();
      await routes['PATCH /tenants/:id/routing-rules/:ruleId'](
        { params: { id: 'tenant-1', ruleId: 'rule-1' }, body: { is_active: true } },
        reply
      );

      expect(reply.statusCode).toBe(409);
      expect(reply.body.error).toBe('Já existe uma regra ativa para este remetente');
    });

    it('normalizes a patched match_value and checks for duplicates excluding itself', async () => {
      RoutingRuleRepo.update.mockResolvedValue({ ...baseRule, match_value: 'mercadolivre.com' });

      const reply = createMockReply();
      await routes['PATCH /tenants/:id/routing-rules/:ruleId'](
        { params: { id: 'tenant-1', ruleId: 'rule-1' }, body: { match_value: 'MercadoLivre.com ' } },
        reply
      );

      expect(reply.statusCode).toBe(200);
      expect(RoutingRuleRepo.findActiveByMatch).toHaveBeenCalledWith('tenant-1', 'domain', 'mercadolivre.com', 'rule-1');
      expect(RoutingRuleRepo.update).toHaveBeenCalledWith('rule-1', { match_value: 'mercadolivre.com' });
    });

    it('does not run the duplicate check when identity and is_active are untouched', async () => {
      RoutingRuleRepo.update.mockResolvedValue({ ...baseRule, priority: 5 });

      const reply = createMockReply();
      await routes['PATCH /tenants/:id/routing-rules/:ruleId'](
        { params: { id: 'tenant-1', ruleId: 'rule-1' }, body: { priority: 5 } },
        reply
      );

      expect(reply.statusCode).toBe(200);
      expect(RoutingRuleRepo.findActiveByMatch).not.toHaveBeenCalled();
      expect(RoutingRuleRepo.update).toHaveBeenCalledWith('rule-1', { priority: 5 });
    });
  });

  describe('DELETE /tenants/:id/routing-rules/:ruleId', () => {
    it('deletes the rule and returns 204', async () => {
      RoutingRuleRepo.delete.mockResolvedValue({ id: 'rule-1' });

      const reply = createMockReply();
      await routes['DELETE /tenants/:id/routing-rules/:ruleId'](
        { params: { id: 'tenant-1', ruleId: 'rule-1' } },
        reply
      );

      expect(RoutingRuleRepo.delete).toHaveBeenCalledWith('rule-1');
      expect(reply.statusCode).toBe(204);
    });

    it('returns 404 when repo.delete finds nothing', async () => {
      RoutingRuleRepo.delete.mockResolvedValue(null);

      const reply = createMockReply();
      await routes['DELETE /tenants/:id/routing-rules/:ruleId'](
        { params: { id: 'tenant-1', ruleId: 'rule-1' } },
        reply
      );

      expect(reply.statusCode).toBe(404);
      expect(reply.body.error).toBe('Routing rule not found');
    });

    it('returns 404 when the rule belongs to another tenant', async () => {
      RoutingRuleRepo.findById.mockResolvedValue({ ...baseRule, tenant_id: 'tenant-OUTRO' });

      const reply = createMockReply();
      await routes['DELETE /tenants/:id/routing-rules/:ruleId'](
        { params: { id: 'tenant-1', ruleId: 'rule-1' } },
        reply
      );

      expect(reply.statusCode).toBe(404);
      expect(RoutingRuleRepo.delete).not.toHaveBeenCalled();
    });
  });
});
