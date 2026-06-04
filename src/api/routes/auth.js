import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { UserRepo } from '../../db/repos/UserRepo.js';
import * as TenantRepo from '../../db/repos/TenantRepo.js';
import { SubscriptionRepo } from '../../db/repos/SubscriptionRepo.js';
import logger from '../../logger.js';

/**
 * Registers the authentication routes on the Fastify instance.
 * POST /auth/login — public endpoint, no authentication required.
 * @param {import('fastify').FastifyInstance} fastify
 */
export default async function authRoutes(fastify) {
  fastify.post('/auth/login', {
    config: {
      rateLimit: {
        max: 5, // 5 attempts per minute per IP
        timeWindow: '1 minute',
      },
    },
    schema: {
      body: {
        type: 'object',
        required: ['email', 'password'],
        properties: {
          email: { type: 'string', format: 'email' },
          password: { type: 'string', minLength: 1 },
        },
      },
    },
  }, async (request, reply) => {
    const { email, password } = request.body;

    // Find user by email
    const user = await UserRepo.findByEmail(email);

    if (!user) {
      logger.warn({ email }, 'Login attempt for non-existent user');
      return reply.code(401).send({ error: 'Invalid credentials' });
    }

    // Compare password with bcrypt hash (cost factor >= 10)
    const isValid = await bcrypt.compare(password, user.password_hash);

    if (!isValid) {
      logger.warn({ email }, 'Login attempt with invalid password');
      return reply.code(401).send({ error: 'Invalid credentials' });
    }

    // Issue JWT with user payload
    const payload = { id: user.id, email: user.email, role: user.role };
    const expiresIn = process.env.JWT_EXPIRES_IN || '8h';

    const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn });

    return reply.send({ token });
  });

  // POST /auth/bitrix — Auto-authenticate from Bitrix24 iframe
  fastify.post('/auth/bitrix', {
    schema: {
      body: {
        type: 'object',
        required: ['domain', 'member_id'],
        properties: {
          domain: { type: 'string', minLength: 1 },
          member_id: { type: 'string', minLength: 1 },
          auth_id: { type: 'string' },
          refresh_id: { type: 'string' },
          server_endpoint: { type: 'string' },
          application_token: { type: 'string' },
          auth_expires: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const { domain, member_id, auth_id, refresh_id, server_endpoint, application_token, auth_expires } = request.body;

    // Validate application_token if configured (prevents forged auth requests)
    const expectedToken = process.env.BITRIX_APP_TOKEN;
    if (expectedToken && application_token && application_token !== expectedToken) {
      logger.warn({ domain, member_id }, 'Invalid application_token in /auth/bitrix');
      return reply.code(403).send({ error: 'Invalid application token' });
    }

    const bitrixUrl = 'https://' + domain;

    // Find or create tenant for this Bitrix24 portal
    let tenant = await TenantRepo.findByBitrixUrl(bitrixUrl);
    if (!tenant) {
      logger.info({ domain, member_id }, 'Auto-creating tenant from Bitrix24 install');
      tenant = await TenantRepo.create({
        name: domain,
        bitrix_url: bitrixUrl,
        bitrix_webhook_token: null,
        bitrix_responsible_id: null,
        member_id: member_id,
      });

      // Create trial subscription for new tenant (14 days)
      await SubscriptionRepo.createTrial(tenant.id);
      logger.info({ tenant_id: tenant.id }, 'Trial subscription created (14 days)');
    }

    // Update OAuth tokens if provided
    if (auth_id) {
      const oauthData = { auth_id, member_id };
      if (refresh_id) oauthData.refresh_id = refresh_id;
      if (server_endpoint) oauthData.server_endpoint = server_endpoint;
      if (application_token) oauthData.application_token = application_token;
      if (auth_expires) {
        oauthData.auth_expires_at = new Date(Date.now() + parseInt(auth_expires) * 1000);
      }
      await TenantRepo.update(tenant.id, oauthData);
      logger.info({ tenant_id: tenant.id, domain }, 'OAuth tokens updated');
    }

    // Find or create user for this portal member
    const userEmail = member_id + '@' + domain;
    let user = await UserRepo.findByEmail(userEmail);
    if (!user) {
      logger.info({ userEmail, tenant_id: tenant.id }, 'Auto-creating user from Bitrix24');
      const hash = await bcrypt.hash(member_id, 10);
      user = await UserRepo.create({ email: userEmail, password_hash: hash, role: 'tenant_user' });
      await UserRepo.addTenantAccess(user.id, tenant.id, 'owner');
    }

    // Issue JWT with tenant_id included
    const tokenPayload = { id: user.id, email: user.email, role: user.role, tenant_id: tenant.id };
    const expiresIn = process.env.JWT_EXPIRES_IN || '8h';
    const token = jwt.sign(tokenPayload, process.env.JWT_SECRET, { expiresIn });

    return reply.send({ token, tenant_id: tenant.id });
  });
}
