import * as ImapAccountRepo from '../../db/repos/ImapAccountRepo.js';
import { TenantScheduler } from '../../imap/TenantScheduler.js';
import { requireTenantAccess } from '../middleware/auth.js';
import logger from '../../logger.js';

/**
 * Registers IMAP account management routes on the Fastify instance.
 * All routes require authentication and tenant access.
 * @param {import('fastify').FastifyInstance} fastify
 */
export default async function imapAccountsRoutes(fastify) {
  /**
   * GET /tenants/:id/imap-accounts
   * List active IMAP accounts for a tenant (password removed from response).
   * Requirements: 2.1
   */
  fastify.get('/tenants/:id/imap-accounts', {
    preHandler: [requireTenantAccess],
  }, async (request, reply) => {
    const { id: tenantId } = request.params;

    // Show ALL accounts (active and paused)
    const { db } = await import('../../db/client.js');
    const { rows } = await db.query(
      'SELECT * FROM imap_accounts WHERE tenant_id = $1 ORDER BY created_at',
      [tenantId]
    );

    // Remove password from each account in the response
    const sanitized = rows.map(({ password_enc, ...rest }) => rest);

    return reply.send(sanitized);
  });

  /**
   * POST /tenants/:id/imap-accounts
   * Create a new IMAP account. Enforces 50 account limit per tenant.
   * Starts the IMAP worker immediately via TenantScheduler.
   * Requirements: 2.1, 2.2
   */
  fastify.post('/tenants/:id/imap-accounts', {
    preHandler: [requireTenantAccess],
    schema: {
      body: {
        type: 'object',
        required: ['email', 'host', 'username', 'password'],
        properties: {
          email: { type: 'string' },
          host: { type: 'string' },
          username: { type: 'string' },
          password: { type: 'string' },
          label: { type: 'string' },
          port: { type: 'integer' },
          use_ssl: { type: 'boolean' },
          mailbox: { type: 'string' },
          poll_mode: { type: 'string', enum: ['idle', 'poll'] },
          poll_interval_sec: { type: 'integer', minimum: 30, maximum: 3600 },
        },
      },
    },
  }, async (request, reply) => {
    const { id: tenantId } = request.params;

    // Enforce 50 account limit per tenant
    const currentCount = await ImapAccountRepo.countByTenant(tenantId);
    if (currentCount >= 50) {
      return reply.code(400).send({
        error: 'Maximum account limit reached. A tenant can have at most 50 IMAP accounts.',
      });
    }

    // Create the account
    const account = await ImapAccountRepo.create(tenantId, request.body);

    // Start the IMAP worker immediately
    try {
      const fullAccount = await ImapAccountRepo.findById(account.id);
      if (fullAccount) {
        await TenantScheduler.startAccount(fullAccount);
      }
    } catch (err) {
      logger.error({ accountId: account.id, err: err.message }, 'Failed to start IMAP worker after account creation');
    }

    return reply.code(201).send(account);
  });

  /**
   * PATCH /tenants/:id/imap-accounts/:accountId/toggle
   * Toggle (pause/resume) an IMAP account worker.
   * Body: { active: boolean }
   * Requirements: 2.3
   */
  fastify.patch('/tenants/:id/imap-accounts/:accountId/toggle', {
    preHandler: [requireTenantAccess],
    schema: {
      body: {
        type: 'object',
        required: ['active'],
        properties: {
          active: { type: 'boolean' },
        },
      },
    },
  }, async (request, reply) => {
    const { accountId } = request.params;
    const { active } = request.body;

    // Update the active status in the database
    const updated = await ImapAccountRepo.setActive(accountId, active);

    if (!updated) {
      return reply.code(404).send({ error: 'IMAP account not found' });
    }

    // Pause or resume the worker
    if (active) {
      const fullAccount = await ImapAccountRepo.findById(accountId);
      if (fullAccount) {
        await TenantScheduler.startAccount(fullAccount);
      }
    } else {
      await TenantScheduler.stopAccount(accountId);
    }

    return reply.send(updated);
  });

  /**
   * DELETE /tenants/:id/imap-accounts/:accountId
   * Stop the IMAP worker and deactivate the account.
   * Requirements: 2.4
   */
  fastify.delete('/tenants/:id/imap-accounts/:accountId', {
    preHandler: [requireTenantAccess],
  }, async (request, reply) => {
    const { accountId } = request.params;

    // Stop the worker first
    await TenantScheduler.stopAccount(accountId);

    // Deactivate the account in the database
    await ImapAccountRepo.setActive(accountId, false);

    return reply.code(204).send();
  });

  /**
   * POST /tenants/:id/imap-accounts/:accountId/test
   * Test IMAP connection using stored credentials (decrypted from DB).
   */
  fastify.post('/tenants/:id/imap-accounts/:accountId/test', {
    preHandler: [requireTenantAccess],
  }, async (request, reply) => {
    const { accountId } = request.params;

    const account = await ImapAccountRepo.findById(accountId);
    if (!account) {
      return reply.code(404).send({ error: 'IMAP account not found' });
    }

    const { ImapFlow } = await import('imapflow');
    let imapClient;
    try {
      imapClient = new ImapFlow({
        host: account.host,
        port: account.port || 993,
        secure: account.use_ssl !== false,
        auth: { user: account.username, pass: account.password },
        logger: false,
        greetTimeout: 15000,
        socketTimeout: 15000,
      });

      await imapClient.connect();
      const lock = await imapClient.getMailboxLock(account.mailbox || 'INBOX');
      const messageCount = imapClient.mailbox.exists;
      lock.release();
      await imapClient.logout();

      return { success: true, messageCount, host: account.host };
    } catch (err) {
      logger.error({ accountId, error: err.message }, 'IMAP test failed');
      return reply.code(502).send({ success: false, error: err.message });
    } finally {
      if (imapClient) {
        try { await imapClient.logout(); } catch {}
      }
    }
  });

  /**
   * PATCH /tenants/:id/imap-accounts/:accountId
   * Update IMAP account fields (host, port, password, label, etc.)
   */
  fastify.patch('/tenants/:id/imap-accounts/:accountId', {
    preHandler: [requireTenantAccess],
    schema: {
      body: {
        type: 'object',
        properties: {
          email: { type: 'string' },
          host: { type: 'string' },
          username: { type: 'string' },
          password: { type: 'string' },
          label: { type: 'string' },
          port: { type: 'integer', minimum: 1, maximum: 65535 },
          use_ssl: { type: 'boolean' },
          mailbox: { type: 'string' },
          poll_mode: { type: 'string', enum: ['idle', 'poll'] },
          poll_interval_sec: { type: 'integer', minimum: 30, maximum: 3600 },
          active: { type: 'boolean' },
        },
        additionalProperties: false,
      },
    },
  }, async (request, reply) => {
    const { accountId } = request.params;
    const data = request.body || {};

    const existing = await ImapAccountRepo.findById(accountId);
    if (!existing) {
      return reply.code(404).send({ error: 'IMAP account not found' });
    }

    const updated = await ImapAccountRepo.update(accountId, data);

    // Restart worker if connection settings changed
    if (data.host || data.port || data.password || data.username || data.use_ssl !== undefined) {
      await TenantScheduler.stopAccount(accountId);
      const refreshed = await ImapAccountRepo.findById(accountId);
      if (refreshed && refreshed.active) {
        await TenantScheduler.startAccount(refreshed);
      }
    }

    // Remove password from response
    const { password, ...safe } = updated || {};
    return safe;
  });
}
