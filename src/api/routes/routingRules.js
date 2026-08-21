import { RoutingRuleRepo } from '../../db/repos/RoutingRuleRepo.js';
import { requireTenantAccess } from '../middleware/auth.js';

// Full email address: local part and domain cannot contain '@' or whitespace
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Bare domain (no '@'): valid labels only — no empty labels ('..'), no hyphen
// at label edges ('a-.com'), and at least one dot (a bare 'localhost' is not
// a routable email domain).
const DOMAIN_REGEX = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/**
 * Shared body schema for POST/PATCH.
 * CRITICAL: bitrix_category_id 0 is a LEGITIMATE write (override to the
 * default pipeline) and NULL means "inherit" — both must pass the schema.
 */
const ruleBodySchema = {
  type: 'object',
  properties: {
    name: { type: ['string', 'null'], maxLength: 100 },
    match_type: { type: 'string', enum: ['exact', 'domain'] },
    match_value: { type: 'string', minLength: 3, maxLength: 254 },
    bitrix_category_id: { type: ['integer', 'null'], minimum: 0 },
    bitrix_stage_id: { type: ['string', 'null'], maxLength: 50 },
    bitrix_responsible_id: { type: ['integer', 'null'] },
    priority: { type: 'integer', minimum: 1, maximum: 9999 },
    is_active: { type: 'boolean' },
  },
  additionalProperties: false,
};

const FIELDS = [
  'name',
  'match_type',
  'match_value',
  'bitrix_category_id',
  'bitrix_stage_id',
  'bitrix_responsible_id',
  'priority',
  'is_active',
];

/**
 * Normalizes the raw match_value: trim + lowercase. 'exact' requires a full
 * email address; 'domain' accepts a leading '@' (users paste '@empresa.com.br')
 * which is stripped. Returns null when the value is invalid for the match type.
 * @param {string} matchType
 * @param {string} rawValue
 * @returns {string|null}
 */
function normalizeMatchValue(matchType, rawValue) {
  const value = String(rawValue).trim().toLowerCase();
  if (matchType === 'exact') {
    return EMAIL_REGEX.test(value) ? value : null;
  }
  const domain = value.startsWith('@') ? value.slice(1) : value;
  if (domain.includes('@') || /\s/.test(domain) || !DOMAIN_REGEX.test(domain)) {
    return null;
  }
  return domain;
}

/**
 * True when the error is the partial unique index on active (match_type,
 * match_value) — the DB-level backstop for the 409 check above. A concurrent
 * request that passed findActiveByMatch before this one committed lands here,
 * and the client should still see 409 (not a 500).
 * @param {Error} err
 * @returns {boolean}
 */
function isActiveMatchViolation(err) {
  return err && (err.code === '23505' || err.constraint === 'uq_routing_rules_active_match');
}

function matchValueError(matchType) {
  return matchType === 'exact'
    ? 'match_value deve ser um endereço de e-mail válido para match_type "exact"'
    : 'match_value deve ser um domínio válido (ex.: empresa.com.br) para match_type "domain"';
}

/**
 * At least one destination must be set. Category 0 counts (it IS an override);
 * only null/undefined mean "no destination".
 * @param {object} rule
 * @returns {boolean}
 */
function hasAnyDestination(rule) {
  return (
    rule.bitrix_category_id != null ||
    rule.bitrix_stage_id != null ||
    rule.bitrix_responsible_id != null
  );
}

/**
 * Registers routing rule CRUD routes on the Fastify instance.
 * All routes require authentication and tenant access.
 * @param {import('fastify').FastifyInstance} fastify
 */
export default async function routingRulesRoutes(fastify) {
  /**
   * GET /tenants/:id/routing-rules
   * List all routing rules (active and inactive) of a tenant.
   */
  fastify.get('/tenants/:id/routing-rules', {
    preHandler: [requireTenantAccess],
  }, async (request, reply) => {
    const { id: tenantId } = request.params;
    const rules = await RoutingRuleRepo.findByTenant(tenantId);
    return reply.send(rules);
  });

  /**
   * POST /tenants/:id/routing-rules
   * Create a routing rule. Rejects duplicate ACTIVE (match_type, match_value).
   */
  fastify.post('/tenants/:id/routing-rules', {
    preHandler: [requireTenantAccess],
    schema: {
      body: {
        ...ruleBodySchema,
        required: ['match_type', 'match_value'],
      },
    },
  }, async (request, reply) => {
    const { id: tenantId } = request.params;

    const matchValue = normalizeMatchValue(request.body.match_type, request.body.match_value);
    if (matchValue === null) {
      return reply.code(400).send({ error: matchValueError(request.body.match_type) });
    }

    // Only fields present in the body — absent keys fall back to repo defaults
    const data = { match_type: request.body.match_type, match_value: matchValue };
    for (const field of FIELDS) {
      if (field !== 'match_type' && field !== 'match_value' && request.body[field] !== undefined) {
        data[field] = request.body[field];
      }
    }
    if (data.bitrix_stage_id === '') data.bitrix_stage_id = null;
    if (data.name === '') data.name = null;

    if (data.bitrix_responsible_id !== undefined && data.bitrix_responsible_id !== null && data.bitrix_responsible_id <= 0) {
      return reply.code(400).send({ error: 'bitrix_responsible_id must be a positive integer or null' });
    }

    if (!hasAnyDestination(data)) {
      return reply.code(400).send({ error: 'Pelo menos um destino (pipeline, estágio ou responsável) deve ser definido' });
    }

    const duplicate = await RoutingRuleRepo.findActiveByMatch(tenantId, data.match_type, data.match_value);
    if (duplicate) {
      return reply.code(409).send({ error: 'Já existe uma regra ativa para este remetente' });
    }

    let rule;
    try {
      rule = await RoutingRuleRepo.create({ tenant_id: tenantId, ...data });
    } catch (err) {
      if (isActiveMatchViolation(err)) {
        return reply.code(409).send({ error: 'Já existe uma regra ativa para este remetente' });
      }
      throw err;
    }
    return reply.code(201).send(rule);
  });

  /**
   * PATCH /tenants/:id/routing-rules/:ruleId
   * Partial update: ONLY the fields present in the body are sent to the repo —
   * an absent key preserves the current value, while 0/null are real writes.
   */
  fastify.patch('/tenants/:id/routing-rules/:ruleId', {
    preHandler: [requireTenantAccess],
    schema: { body: ruleBodySchema },
  }, async (request, reply) => {
    const { id: tenantId, ruleId } = request.params;
    const body = request.body || {};

    const rule = await RoutingRuleRepo.findById(ruleId);
    if (!rule || rule.tenant_id !== tenantId) {
      return reply.code(404).send({ error: 'Routing rule not found' });
    }

    // Effective match pair: the patch falls back to the stored rule values
    const effectiveType = body.match_type !== undefined ? body.match_type : rule.match_type;
    const matchValueInBody = body.match_value !== undefined;
    const normalizedMatchValue = matchValueInBody
      ? normalizeMatchValue(effectiveType, body.match_value)
      : null;
    if (matchValueInBody && normalizedMatchValue === null) {
      return reply.code(400).send({ error: matchValueError(effectiveType) });
    }
    // Changing only the type must still leave a valid stored (type, value) pair
    if (!matchValueInBody && body.match_type !== undefined && normalizeMatchValue(effectiveType, rule.match_value) === null) {
      return reply.code(400).send({ error: matchValueError(effectiveType) });
    }

    const patch = {};
    for (const field of FIELDS) {
      if (body[field] !== undefined) patch[field] = body[field];
    }
    if (patch.match_value !== undefined) patch.match_value = normalizedMatchValue;
    if (patch.bitrix_stage_id === '') patch.bitrix_stage_id = null;
    if (patch.name === '') patch.name = null;

    if (patch.bitrix_responsible_id !== undefined && patch.bitrix_responsible_id !== null && patch.bitrix_responsible_id <= 0) {
      return reply.code(400).send({ error: 'bitrix_responsible_id must be a positive integer or null' });
    }

    // The at-least-one-destination invariant is checked on the merged result
    if (!hasAnyDestination({ ...rule, ...patch })) {
      return reply.code(400).send({ error: 'Pelo menos um destino (pipeline, estágio ou responsável) deve ser definido' });
    }

    // Duplicate check whenever the (type, value) identity or the active flag
    // can change — always excluding the rule being edited
    if (body.match_type !== undefined || matchValueInBody || body.is_active === true) {
      const effectiveValue = matchValueInBody ? normalizedMatchValue : rule.match_value;
      const duplicate = await RoutingRuleRepo.findActiveByMatch(tenantId, effectiveType, effectiveValue, ruleId);
      if (duplicate) {
        return reply.code(409).send({ error: 'Já existe uma regra ativa para este remetente' });
      }
    }

    let updated;
    try {
      updated = await RoutingRuleRepo.update(ruleId, patch);
    } catch (err) {
      if (isActiveMatchViolation(err)) {
        return reply.code(409).send({ error: 'Já existe uma regra ativa para este remetente' });
      }
      throw err;
    }
    if (!updated) {
      return reply.code(404).send({ error: 'Routing rule not found' });
    }
    return reply.send(updated);
  });

  /**
   * DELETE /tenants/:id/routing-rules/:ruleId
   */
  fastify.delete('/tenants/:id/routing-rules/:ruleId', {
    preHandler: [requireTenantAccess],
  }, async (request, reply) => {
    const { id: tenantId, ruleId } = request.params;

    const rule = await RoutingRuleRepo.findById(ruleId);
    if (!rule || rule.tenant_id !== tenantId) {
      return reply.code(404).send({ error: 'Routing rule not found' });
    }

    const deleted = await RoutingRuleRepo.delete(ruleId);
    if (!deleted) {
      return reply.code(404).send({ error: 'Routing rule not found' });
    }

    return reply.code(204).send();
  });
}
