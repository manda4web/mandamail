import { requireRole, requireTenantAccess } from '../middleware/auth.js';
import * as TenantRepo from '../../db/repos/TenantRepo.js';
import * as ImapAccountRepo from '../../db/repos/ImapAccountRepo.js';
import { SubscriptionRepo } from '../../db/repos/SubscriptionRepo.js';
import { TenantScheduler } from '../../imap/TenantScheduler.js';
import { BitrixClient } from '../../bitrix/BitrixClient.js';
import { ImapFlow } from 'imapflow';
import logger from '../../logger.js';

/**
 * Blocks connection tests against internal/private network targets (SSRF
 * mitigation for test-bitrix / test-imap, which accept arbitrary hosts).
 */
function assertPublicHost(host) {
  const h = String(host || '').toLowerCase().trim();
  const blocked =
    h === 'localhost' ||
    h === '::1' ||
    h.endsWith('.internal') ||
    h.endsWith('.local') ||
    /^127\./.test(h) ||
    /^10\./.test(h) ||
    /^192\.168\./.test(h) ||
    /^169\.254\./.test(h) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h) ||
    /^0\./.test(h);
  if (blocked) {
    throw new Error('Host interno não é permitido em testes de conexão');
  }
}

/**
 * Registers tenant management routes on the Fastify instance.
 * All routes require authentication.
 * @param {import('fastify').FastifyInstance} fastify
 */
export async function tenantsRoutes(fastify) {
  // GET /tenants — list tenants (admin: all, tenant_user: own tenants)
  fastify.get('/tenants', {
    preHandler: [requireRole('admin', 'tenant_user')],
  }, async (request, reply) => {
    if (request.user.role === 'admin') {
      return TenantRepo.findAllActive();
    }
    // For tenant_user, get their associated tenants
    const { UserRepo } = await import('../../db/repos/UserRepo.js');
    const userTenants = await UserRepo.findTenantsByUser(request.user.id);
    const tenantIds = userTenants.map(ut => ut.tenant_id);
    const allTenants = await TenantRepo.findAllActive();
    return allTenants.filter(t => tenantIds.includes(t.id));
  });

  // POST /tenants — create tenant with unique bitrix_url validation
  fastify.post('/tenants', {
    preHandler: [requireRole('admin')],
  }, async (request, reply) => {
    const { name, bitrix_url, bitrix_webhook_token } = request.body || {};

    // Validate required fields
    const missing = [];
    if (!name) missing.push('name');
    if (!bitrix_url) missing.push('bitrix_url');
    if (!bitrix_webhook_token) missing.push('bitrix_webhook_token');

    if (missing.length > 0) {
      return reply.code(400).send({
        error: 'Missing required fields',
        fields: missing,
      });
    }

    // Check unique bitrix_url
    const existing = await TenantRepo.findByBitrixUrl(bitrix_url);
    if (existing) {
      return reply.code(409).send({
        error: 'bitrix_url already in use',
        bitrix_url,
      });
    }

    const tenant = await TenantRepo.create(request.body);

    // Every tenant starts with a trial subscription (same as /auth/bitrix
    // installs) — without it checkAccess returns NO_SUBSCRIPTION and the
    // tenant's workers never start.
    try {
      await SubscriptionRepo.createTrial(tenant.id);
    } catch (err) {
      logger.error({ tenantId: tenant.id, error: err.message }, 'Failed to create trial for new tenant');
    }

    return reply.code(201).send(tenant);
  });

  // PATCH /tenants/:id — update tenant fields
  fastify.patch('/tenants/:id', {
    preHandler: [requireRole('admin', 'tenant_user'), requireTenantAccess],
  }, async (request, reply) => {
    const { id } = request.params;

    const existing = await TenantRepo.findById(id);
    if (!existing) {
      return reply.code(404).send({ error: 'Tenant not found' });
    }

    const data = request.body || {};

    // If bitrix_url is being changed, check uniqueness
    if (data.bitrix_url && data.bitrix_url !== existing.bitrix_url) {
      const conflict = await TenantRepo.findByBitrixUrl(data.bitrix_url);
      if (conflict) {
        return reply.code(409).send({
          error: 'bitrix_url already in use',
          bitrix_url: data.bitrix_url,
        });
      }
    }

    const updated = await TenantRepo.update(id, data);

    const urlChanged = data.bitrix_url && data.bitrix_url !== existing.bitrix_url;
    const tokenChanged = data.bitrix_webhook_token && data.bitrix_webhook_token !== existing.bitrix_webhook_token;
    // Behavior fields the running workers hold as a snapshot from startup —
    // filters, mapping and deal mode only take effect after a worker restart.
    const behaviorChanged = [
      'ignore_from', 'ignore_subject', 'field_mapping', 'deal_mode',
      'sync_start_date', 'bitrix_category_id', 'bitrix_stage_id', 'bitrix_responsible_id',
    ].some(f => data[f] !== undefined && JSON.stringify(data[f]) !== JSON.stringify(existing[f]));

    if (data.active === false) {
      // Deactivating the tenant stops its workers (spec Req 1.5)
      await TenantScheduler.stopTenant(id);
    } else if (data.active === true || urlChanged || tokenChanged || behaviorChanged) {
      // (Re)start workers so they pick up the new configuration.
      await TenantScheduler.stopTenant(id);
      try {
        await TenantScheduler.startTenant(id);
      } catch (err) {
        logger.error({ tenantId: id, error: err.message }, 'Failed to restart workers after tenant update');
      }
    }

    return updated;
  });

  // POST /tenants/test-bitrix — test Bitrix webhook connection (10s timeout)
  fastify.post('/tenants/test-bitrix', {
    preHandler: [requireRole('admin', 'tenant_user')],
  }, async (request, reply) => {
    const { bitrix_url, bitrix_webhook_token } = request.body || {};

    if (!bitrix_url || !bitrix_webhook_token) {
      return reply.code(400).send({
        error: 'Missing required fields',
        fields: [
          ...(!bitrix_url ? ['bitrix_url'] : []),
          ...(!bitrix_webhook_token ? ['bitrix_webhook_token'] : []),
        ],
      });
    }

    try {
      assertPublicHost(new URL(bitrix_url).hostname);
      const client = new BitrixClient({ bitrix_url, bitrix_webhook_token });
      // Override timeout to 10s for test connection
      client.timeout = 10000;
      client.maxAttempts = 1;

      const result = await client.call('app.info');
      return { success: true, result };
    } catch (err) {
      return reply.code(502).send({
        success: false,
        error: err.message,
      });
    }
  });

  // POST /tenants/test-imap — test IMAP connection (15s timeout)
  fastify.post('/tenants/test-imap', {
    preHandler: [requireRole('admin', 'tenant_user')],
  }, async (request, reply) => {
    const { host, port, username, password, use_ssl, mailbox } = request.body || {};

    if (!host || !username || !password) {
      return reply.code(400).send({
        error: 'Missing required fields',
        fields: [
          ...(!host ? ['host'] : []),
          ...(!username ? ['username'] : []),
          ...(!password ? ['password'] : []),
        ],
      });
    }

    try {
      assertPublicHost(host);
    } catch (err) {
      return reply.code(400).send({ success: false, error: err.message });
    }

    let imapClient;
    try {
      imapClient = new ImapFlow({
        host,
        port: port || 993,
        secure: use_ssl !== false,
        auth: { user: username, pass: password },
        logger: false,
        greetTimeout: 15000,
        socketTimeout: 15000,
      });

      // Race against a 15s overall timeout
      const timeout = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('IMAP connection timeout (15s)')), 15000)
      );

      const connect = (async () => {
        await imapClient.connect();
        const lock = await imapClient.getMailboxLock(mailbox || 'INBOX');
        try {
          const messageCount = imapClient.mailbox.exists;
          return { success: true, messageCount };
        } finally {
          lock.release();
        }
      })();

      const result = await Promise.race([connect, timeout]);
      return result;
    } catch (err) {
      return reply.code(502).send({
        success: false,
        error: err.message,
      });
    } finally {
      if (imapClient) {
        try {
          await imapClient.logout();
        } catch {
          // ignore logout errors
        }
      }
    }
  });

  // GET /admin/workers — return TenantScheduler.status() (admin only)
  fastify.get('/admin/workers', {
    preHandler: [requireRole('admin')],
  }, async (request, reply) => {
    return TenantScheduler.status();
  });
}

export default tenantsRoutes;
