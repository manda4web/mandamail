import jwt from 'jsonwebtoken';
import { UserRepo } from '../../db/repos/UserRepo.js';
import logger from '../../logger.js';

/**
 * Fastify preHandler that verifies JWT from Authorization: Bearer header.
 * Attaches decoded user (id, email, role) to request.user.
 * Returns 401 if token is missing, invalid, or expired.
 */
export async function authenticate(request, reply) {
  const authHeader = request.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return reply.code(401).send({ error: 'Authentication required' });
  }

  const token = authHeader.slice(7);

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    request.user = { id: decoded.id, email: decoded.email, role: decoded.role, tenant_id: decoded.tenant_id };
  } catch (err) {
    logger.warn({ err: err.message }, 'JWT verification failed');
    return reply.code(401).send({ error: 'Invalid or expired token' });
  }
}

/**
 * Returns a Fastify preHandler that checks if request.user.role is in the allowed roles.
 * Returns 403 if user role is not permitted.
 * @param  {...string} roles - Allowed roles
 */
export function requireRole(...roles) {
  return async function (request, reply) {
    if (!request.user || !roles.includes(request.user.role)) {
      return reply.code(403).send({ error: 'Insufficient permissions' });
    }
  };
}

/**
 * Fastify preHandler that enforces tenant access:
 * - admin role can access any tenant
 * - tenant_user role must have an entry in user_tenants for the requested tenant
 * Returns 403 if user doesn't have access to the requested tenant (from params.id).
 */
export async function requireTenantAccess(request, reply) {
  if (!request.user) {
    return reply.code(401).send({ error: 'Authentication required' });
  }

  // Admins can access any tenant
  if (request.user.role === 'admin') {
    return;
  }

  const tenantId = request.params.id;

  if (!tenantId) {
    return reply.code(400).send({ error: 'Tenant ID is required' });
  }

  const hasAccess = await UserRepo.hasAccessToTenant(request.user.id, tenantId);

  if (!hasAccess) {
    return reply.code(403).send({ error: 'Access denied to this tenant' });
  }
}
