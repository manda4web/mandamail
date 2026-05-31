import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { UserRepo } from '../../db/repos/UserRepo.js';
import * as TenantRepo from '../../db/repos/TenantRepo.js';
import logger from '../../logger.js';

/**
 * Registers the authentication routes on the Fastify instance.
 * POST /auth/login — public endpoint, no authentication required.
 * @param {import('fastify').FastifyInstance} fastify
 */
export default async function authRoutes(fastify) {
  fastify.post('/auth/login', {
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
        },
      },
    },
  }, async (request, reply) => {
    const { domain, member_id, auth_id } = request.body;

    const bitrixUrl = 'https://' + domain;

    // Find or create tenant for this Bitrix24 portal
    let tenant = await TenantRepo.findByBitrixUrl(bitrixUrl);
    if (!tenant) {
      logger.info({ domain, member_id }, 'Auto-creating tenant from Bitrix24 install');
      tenant = await TenantRepo.create({
        name: domain,
        bitrix_url: bitrixUrl,
        bitrix_webhook_token: 'pending-configuration',
        bitrix_responsible_id: 1,
      });
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
