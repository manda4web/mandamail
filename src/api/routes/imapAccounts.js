import * as ImapAccountRepo from '../../db/repos/ImapAccountRepo.js';
import * as TenantRepo from '../../db/repos/TenantRepo.js';
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
   * Inherits tenant mapping values on creation (Requirement 3).
   * Starts the IMAP worker immediately via TenantScheduler.
   * Requirements: 2.1, 2.2, 3.1, 3.2
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

    // Inherit tenant mapping values (Task 4: Requirement 3)
    const tenant = await TenantRepo.findById(tenantId);
    const accountData = {
      ...request.body,
      bitrix_category_id: tenant ? tenant.bitrix_category_id : null,
      bitrix_stage_id: tenant ? tenant.bitrix_stage_id : null,
      bitrix_responsible_id: tenant ? tenant.bitrix_responsible_id : null,
      field_mapping: tenant ? tenant.field_mapping : null,
      deal_mode: tenant ? tenant.deal_mode : null,
      sync_start_date: tenant ? tenant.sync_start_date : null,
    };

    // Create the account with inherited mapping
    const account = await ImapAccountRepo.create(tenantId, accountData);

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
   * GET /tenants/:id/imap-accounts/:accountId/mapping
   * Returns effective mapping with source metadata.
   * Requirements: 5.1, 5.2, 5.3
   */
  fastify.get('/tenants/:id/imap-accounts/:accountId/mapping', {
    preHandler: [requireTenantAccess],
  }, async (request, reply) => {
    const { id: tenantId, accountId } = request.params;

    const raw = await ImapAccountRepo.findRawById(accountId);
    if (!raw || raw.tenant_id !== tenantId) {
      return reply.code(404).send({ error: 'IMAP account not found' });
    }

    const mappingFields = [
      'bitrix_category_id',
      'bitrix_stage_id',
      'bitrix_responsible_id',
      'field_mapping',
      'deal_mode',
      'sync_start_date',
    ];

    const effective = {};
    const sources = {};

    for (const field of mappingFields) {
      const accountValue = raw[`account_${field}`];
      const tenantValue = raw[`tenant_${field}`];

      if (accountValue !== null && accountValue !== undefined) {
        effective[field] = accountValue;
        sources[field] = 'account';
      } else if (tenantValue !== null && tenantValue !== undefined) {
        effective[field] = tenantValue;
        sources[field] = 'tenant';
      } else {
        effective[field] = field === 'field_mapping' ? {} : null;
        sources[field] = 'tenant';
      }
    }

    return reply.send({ effective, sources });
  });

  /**
   * PATCH /tenants/:id/imap-accounts/:accountId/mapping
   * Updates account-level mapping fields.
   * Requirements: 4.1 - 4.7
   */
  fastify.patch('/tenants/:id/imap-accounts/:accountId/mapping', {
    preHandler: [requireTenantAccess],
    schema: {
      body: {
        type: 'object',
        properties: {
          bitrix_category_id: { type: ['integer', 'null'] },
          bitrix_stage_id: { type: ['string', 'null'], maxLength: 50 },
          bitrix_responsible_id: { type: ['integer', 'null'] },
          field_mapping: { type: ['object', 'null'] },
          deal_mode: { type: ['string', 'null'], enum: ['create_new', 'merge_by_contact', null] },
          sync_start_date: { type: ['string', 'null'] },
        },
        additionalProperties: false,
      },
    },
  }, async (request, reply) => {
    const { id: tenantId, accountId } = request.params;
    const data = request.body || {};

    // Verify account exists and belongs to tenant
    const raw = await ImapAccountRepo.findRawById(accountId);
    if (!raw || raw.tenant_id !== tenantId) {
      return reply.code(404).send({ error: 'IMAP account not found' });
    }

    // Validate positive integers for IDs
    if (data.bitrix_category_id !== undefined && data.bitrix_category_id !== null) {
      if (!Number.isInteger(data.bitrix_category_id) || data.bitrix_category_id < 0) {
        return reply.code(400).send({ error: 'bitrix_category_id must be a non-negative integer or null' });
      }
    }
    if (data.bitrix_responsible_id !== undefined && data.bitrix_responsible_id !== null) {
      if (!Number.isInteger(data.bitrix_responsible_id) || data.bitrix_responsible_id <= 0) {
        return reply.code(400).send({ error: 'bitrix_responsible_id must be a positive integer or null' });
      }
    }

    // Validate field_mapping size
    if (data.field_mapping !== undefined && data.field_mapping !== null) {
      const jsonSize = JSON.stringify(data.field_mapping).length;
      if (jsonSize > 4096) {
        return reply.code(400).send({ error: 'field_mapping exceeds maximum size of 4096 bytes' });
      }
    }

    // If empty body, return current record without update
    if (Object.keys(data).length === 0) {
      const { password_enc, ...safe } = raw;
      return reply.send(safe);
    }

    const updated = await ImapAccountRepo.updateMapping(accountId, data);
    if (!updated) {
      return reply.code(404).send({ error: 'IMAP account not found' });
    }

    // Remove password from response
    const { password_enc, ...safe } = updated;
    return reply.send(safe);
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

    // Delete related data then the account
    const { db } = await import('../../db/client.js');
    await db.query('DELETE FROM retry_jobs WHERE email_event_id IN (SELECT id FROM email_events WHERE imap_account_id = $1)', [accountId]);
    await db.query('DELETE FROM bitrix_results WHERE email_event_id IN (SELECT id FROM email_events WHERE imap_account_id = $1)', [accountId]);
    await db.query('DELETE FROM email_events WHERE imap_account_id = $1', [accountId]);
    await db.query('DELETE FROM imap_accounts WHERE id = $1', [accountId]);

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
