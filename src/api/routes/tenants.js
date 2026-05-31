import { requireRole, requireTenantAccess } from '../middleware/auth.js';
import * as TenantRepo from '../../db/repos/TenantRepo.js';
import * as ImapAccountRepo from '../../db/repos/ImapAccountRepo.js';
import { TenantScheduler } from '../../imap/TenantScheduler.js';
import { BitrixClient } from '../../bitrix/BitrixClient.js';
import { ImapFlow } from 'imapflow';

/**
 * Registers tenant management routes on the Fastify instance.
 * All routes require authentication.
 * @param {import('fastify').FastifyInstance} fastify
 */
export async function tenantsRoutes(fastify) {
  // GET /tenants — list all active tenants (admin only)
  fastify.get('/tenants', {
    preHandler: [requireRole('admin')],
  }, async (request, reply) => {
    const tenants = await TenantRepo.findAllActive();
    return tenants;
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
    return reply.code(201).send(tenant);
  });

  // PATCH /tenants/:id — update tenant fields
  fastify.patch('/tenants/:id', {
    preHandler: [requireRole('admin')],
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

    // If bitrix_url or bitrix_webhook_token changed, restart workers for this tenant
    const urlChanged = data.bitrix_url && data.bitrix_url !== existing.bitrix_url;
    const tokenChanged = data.bitrix_webhook_token && data.bitrix_webhook_token !== existing.bitrix_webhook_token;

    if (urlChanged || tokenChanged) {
      await TenantScheduler.stopTenant(id);
      const accounts = await ImapAccountRepo.findAllActiveByTenant(id);
      for (const account of accounts) {
        await TenantScheduler.startAccount(account);
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
