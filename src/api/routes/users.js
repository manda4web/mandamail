import { UserRepo } from '../../db/repos/UserRepo.js';
import { requireTenantAccess } from '../middleware/auth.js';
import bcrypt from 'bcrypt';
import logger from '../../logger.js';

const SUPER_ADMIN_EMAIL = process.env.SUPER_ADMIN_EMAIL || 'comercial@manda4.com.br';

/**
 * Registers user management routes for tenant access control.
 * All routes require authentication + tenant admin privileges.
 * @param {import('fastify').FastifyInstance} fastify
 */
export default async function userRoutes(fastify) {

  // GET /tenants/:id/users — List users with access to this tenant
  fastify.get('/tenants/:id/users', {
    preHandler: [requireTenantAccess],
  }, async (request, reply) => {
    const tenantId = request.params.id;

    // Only admins can list users
    const isAdmin = await UserRepo.isAdminOfTenant(request.user.id, tenantId);
    const isSuperAdmin = request.user.email && request.user.email.toLowerCase() === SUPER_ADMIN_EMAIL.toLowerCase();

    if (!isAdmin && !isSuperAdmin) {
      return reply.code(403).send({ error: 'Only admins can manage users' });
    }

    const users = await UserRepo.findUsersByTenant(tenantId);
    return users.map(u => ({
      id: u.id,
      email: u.email,
      display_name: u.display_name,
      bitrix_user_id: u.bitrix_user_id,
      is_bitrix_admin: u.is_bitrix_admin,
      role: u.role,
      is_admin: u.is_admin,
      granted_at: u.granted_at,
      is_super_admin: u.email.toLowerCase() === SUPER_ADMIN_EMAIL.toLowerCase(),
    }));
  });

  // POST /tenants/:id/users — Grant access to a user
  fastify.post('/tenants/:id/users', {
    preHandler: [requireTenantAccess],
    schema: {
      body: {
        type: 'object',
        required: ['email'],
        properties: {
          email: { type: 'string', minLength: 1 },
          bitrix_user_id: { type: 'string' },
          display_name: { type: 'string' },
          is_admin: { type: 'boolean' },
        },
      },
    },
  }, async (request, reply) => {
    const tenantId = request.params.id;

    // Only admins can add users
    const isAdmin = await UserRepo.isAdminOfTenant(request.user.id, tenantId);
    const isSuperAdmin = request.user.email && request.user.email.toLowerCase() === SUPER_ADMIN_EMAIL.toLowerCase();

    if (!isAdmin && !isSuperAdmin) {
      return reply.code(403).send({ error: 'Only admins can manage users' });
    }

    const { email, bitrix_user_id, display_name, is_admin: grantAdmin } = request.body;

    // Find or create user
    let user = await UserRepo.findByEmail(email);
    if (!user) {
      // Create user with a random password hash (they'll auth via Bitrix)
      const hash = await bcrypt.hash(Math.random().toString(36), 10);
      user = await UserRepo.create({
        email,
        password_hash: hash,
        role: 'tenant_user',
        bitrix_user_id: bitrix_user_id || null,
        display_name: display_name || null,
        is_bitrix_admin: false,
      });
    }

    // Check if user already has access
    const hasAccess = await UserRepo.hasAccessToTenant(user.id, tenantId);
    if (hasAccess) {
      return reply.code(409).send({ error: 'Usuário já tem acesso a este portal' });
    }

    // Grant access
    await UserRepo.addTenantAccess(user.id, tenantId, 'viewer', {
      is_admin: grantAdmin || false,
      granted_by: request.user.id,
    });

    logger.info({ email, tenant_id: tenantId, granted_by: request.user.email }, 'User access granted');

    return reply.code(201).send({
      id: user.id,
      email: user.email,
      display_name: user.display_name || display_name,
      is_admin: grantAdmin || false,
    });
  });

  // DELETE /tenants/:id/users/:userId — Revoke access
  fastify.delete('/tenants/:id/users/:userId', {
    preHandler: [requireTenantAccess],
  }, async (request, reply) => {
    const tenantId = request.params.id;
    const targetUserId = request.params.userId;

    // Only admins can remove users
    const isAdmin = await UserRepo.isAdminOfTenant(request.user.id, tenantId);
    const isSuperAdmin = request.user.email && request.user.email.toLowerCase() === SUPER_ADMIN_EMAIL.toLowerCase();

    if (!isAdmin && !isSuperAdmin) {
      return reply.code(403).send({ error: 'Only admins can manage users' });
    }

    // Can't remove yourself
    if (targetUserId === request.user.id) {
      return reply.code(400).send({ error: 'Você não pode remover seu próprio acesso' });
    }

    // Can't remove the super-admin
    const targetUser = await UserRepo.findById(targetUserId);
    if (targetUser && targetUser.email.toLowerCase() === SUPER_ADMIN_EMAIL.toLowerCase()) {
      return reply.code(400).send({ error: 'Não é possível remover o super-administrador' });
    }

    const removed = await UserRepo.removeTenantAccess(targetUserId, tenantId);
    if (!removed) {
      return reply.code(404).send({ error: 'Usuário não encontrado neste portal' });
    }

    logger.info({ targetUserId, tenant_id: tenantId, removed_by: request.user.email }, 'User access revoked');
    return reply.code(204).send();
  });

  // PATCH /tenants/:id/users/:userId — Toggle admin status
  fastify.patch('/tenants/:id/users/:userId', {
    preHandler: [requireTenantAccess],
    schema: {
      body: {
        type: 'object',
        required: ['is_admin'],
        properties: {
          is_admin: { type: 'boolean' },
        },
      },
    },
  }, async (request, reply) => {
    const tenantId = request.params.id;
    const targetUserId = request.params.userId;
    const { is_admin: newAdminStatus } = request.body;

    // Only admins can change roles
    const isAdmin = await UserRepo.isAdminOfTenant(request.user.id, tenantId);
    const isSuperAdmin = request.user.email && request.user.email.toLowerCase() === SUPER_ADMIN_EMAIL.toLowerCase();

    if (!isAdmin && !isSuperAdmin) {
      return reply.code(403).send({ error: 'Only admins can manage users' });
    }

    // Can't demote the super-admin
    const targetUser = await UserRepo.findById(targetUserId);
    if (targetUser && targetUser.email.toLowerCase() === SUPER_ADMIN_EMAIL.toLowerCase() && !newAdminStatus) {
      return reply.code(400).send({ error: 'Não é possível remover privilégios do super-administrador' });
    }

    const updated = await UserRepo.updateTenantRole(targetUserId, tenantId, newAdminStatus);
    if (!updated) {
      return reply.code(404).send({ error: 'Usuário não encontrado neste portal' });
    }

    logger.info({ targetUserId, tenant_id: tenantId, is_admin: newAdminStatus, changed_by: request.user.email }, 'User role updated');
    return updated;
  });
}
