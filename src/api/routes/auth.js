import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { UserRepo } from '../../db/repos/UserRepo.js';
import * as TenantRepo from '../../db/repos/TenantRepo.js';
import { SubscriptionRepo } from '../../db/repos/SubscriptionRepo.js';
import logger from '../../logger.js';

const SUPER_ADMIN_EMAIL = process.env.SUPER_ADMIN_EMAIL || 'comercial@manda4.com.br';
// The super-admin identity is only trusted when the request comes from the
// official admin portal (and, when configured, the exact member_id) — the
// iframe body is client-controlled, so the email alone must never grant it.
const ADMIN_PORTAL_DOMAIN = process.env.ADMIN_PORTAL_DOMAIN || 'manda4.bitrix24.com.br';
const SUPER_ADMIN_MEMBER_ID = process.env.SUPER_ADMIN_MEMBER_ID || '';

/**
 * Registers the authentication routes on the Fastify instance.
 * POST /auth/login — public endpoint, no authentication required.
 * POST /auth/bitrix — auto-authenticate from Bitrix24 iframe with access control.
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

    // Resolve the user's primary tenant so this token works everywhere the
    // /auth/bitrix token works (e.g. GET /subscriptions/status reads
    // request.user.tenant_id). Falls back to null for tenant-less users.
    let tenantId = null;
    let isTenantAdmin = false;
    try {
      const tenants = await UserRepo.findTenantsByUser(user.id);
      if (tenants.length > 0) {
        tenantId = tenants[0].tenant_id;
        isTenantAdmin = tenants[0].is_admin === true || tenants[0].role === 'owner';
      }
    } catch (err) {
      logger.warn({ userId: user.id, error: err.message }, 'Could not resolve tenant for login token');
    }

    // Issue JWT with user payload
    const payload = {
      id: user.id,
      email: user.email,
      role: user.role,
      tenant_id: tenantId,
      is_admin: user.role === 'admin' || isTenantAdmin,
      is_super_admin: false,
    };
    const expiresIn = process.env.JWT_EXPIRES_IN || '8h';

    const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn });

    return reply.send({ token });
  });

  // POST /auth/bitrix — Auto-authenticate from Bitrix24 iframe with per-user access control
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
          // User-level info from BX24.callMethod("user.current")
          user_id: { type: 'string' },
          user_name: { type: 'string' },
          user_email: { type: 'string' },
          is_admin: { type: 'boolean' },
        },
      },
    },
  }, async (request, reply) => {
    const { domain, member_id, auth_id, refresh_id, server_endpoint, application_token, auth_expires } = request.body;
    const { user_id: bitrixUserId, user_name: userName, user_email: userEmail, is_admin: isBitrixAdmin } = request.body;

    // Validate application_token if configured (prevents forged auth requests).
    // When a token is configured, it MUST be present and match — omitting it
    // must NOT bypass the check.
    const expectedToken = process.env.BITRIX_APP_TOKEN;
    if (expectedToken && application_token !== expectedToken) {
      logger.warn({ domain, member_id, hasToken: !!application_token }, 'Invalid/missing application_token in /auth/bitrix');
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

    // Determine user identity — prefer Bitrix user_id, fallback to member_id
    const effectiveEmail = userEmail || (member_id + '@' + domain);
    const effectiveBitrixUserId = bitrixUserId || null;
    const effectiveDisplayName = userName || null;
    const effectiveIsBitrixAdmin = isBitrixAdmin === true;

    // Check if this is the super-admin: email match is only honored when the
    // request comes from the official admin portal (domain + optional
    // member_id pinning) — a random portal claiming the email gets nothing.
    const emailMatches = effectiveEmail.toLowerCase() === SUPER_ADMIN_EMAIL.toLowerCase();
    const fromAdminPortal = domain === ADMIN_PORTAL_DOMAIN
      && (!SUPER_ADMIN_MEMBER_ID || member_id === SUPER_ADMIN_MEMBER_ID);
    const isSuperAdmin = emailMatches && fromAdminPortal;
    if (isSuperAdmin) {
      logger.info({ domain, member_id }, 'Super-admin access granted (pinned to admin portal)');
    } else if (emailMatches && !fromAdminPortal) {
      logger.warn({ domain, member_id }, 'Super-admin email presented from NON-admin portal — denied');
    }

    // Find existing user by Bitrix user ID + tenant, or by email
    let user = null;
    if (effectiveBitrixUserId) {
      user = await UserRepo.findByBitrixUserIdAndTenant(effectiveBitrixUserId, tenant.id);
    }
    if (!user) {
      user = await UserRepo.findByEmail(effectiveEmail);
    }

    // If user doesn't exist yet, we need to decide if they get access
    if (!user) {
      // Access is granted if: super-admin, Bitrix admin, or portal is brand new (first user = owner)
      const existingUsers = await UserRepo.findUsersByTenant(tenant.id);
      const isFirstUser = existingUsers.length === 0;

      if (!isSuperAdmin && !effectiveIsBitrixAdmin && !isFirstUser) {
        // Check if there's a pre-granted entry (admin manually added this user by email/bitrix_id)
        // Since user doesn't exist yet, they have no access
        logger.warn({ effectiveEmail, domain, bitrixUserId: effectiveBitrixUserId }, 'Access denied - user not authorized');
        return reply.code(403).send({
          error: 'ACCESS_DENIED',
          message: 'Você não tem permissão para acessar este aplicativo. Solicite acesso ao administrador do portal.',
        });
      }

      // Create the user
      const hash = await bcrypt.hash(member_id + (effectiveBitrixUserId || ''), 10);
      user = await UserRepo.create({
        email: effectiveEmail,
        password_hash: hash,
        role: 'tenant_user',
        bitrix_user_id: effectiveBitrixUserId,
        display_name: effectiveDisplayName,
        is_bitrix_admin: effectiveIsBitrixAdmin,
      });

      // Grant access with appropriate role
      const grantAdmin = isSuperAdmin || effectiveIsBitrixAdmin || isFirstUser;
      await UserRepo.addTenantAccess(user.id, tenant.id, isFirstUser ? 'owner' : 'viewer', { is_admin: grantAdmin });
      logger.info({ userEmail: effectiveEmail, tenant_id: tenant.id, is_admin: grantAdmin }, 'Auto-created user with access');
    } else {
      // User exists — update Bitrix info
      await UserRepo.updateBitrixInfo(user.id, {
        bitrix_user_id: effectiveBitrixUserId || user.bitrix_user_id,
        display_name: effectiveDisplayName || user.display_name,
        is_bitrix_admin: effectiveIsBitrixAdmin,
      });

      // Ensure user has access to this tenant
      const hasAccess = await UserRepo.hasAccessToTenant(user.id, tenant.id);

      if (!hasAccess) {
        // User exists but doesn't have access to this specific tenant
        if (isSuperAdmin || effectiveIsBitrixAdmin) {
          // Auto-grant for super-admin and Bitrix admins
          await UserRepo.addTenantAccess(user.id, tenant.id, 'viewer', { is_admin: true });
          logger.info({ userEmail: effectiveEmail, tenant_id: tenant.id }, 'Auto-granted access to admin user');
        } else {
          logger.warn({ effectiveEmail, domain }, 'Access denied - user exists but no tenant access');
          return reply.code(403).send({
            error: 'ACCESS_DENIED',
            message: 'Você não tem permissão para acessar este aplicativo. Solicite acesso ao administrador do portal.',
          });
        }
      } else {
        // If user is Bitrix admin and wasn't already marked as admin in user_tenants, promote them
        if (effectiveIsBitrixAdmin) {
          const isAlreadyAdmin = await UserRepo.isAdminOfTenant(user.id, tenant.id);
          if (!isAlreadyAdmin) {
            await UserRepo.updateTenantRole(user.id, tenant.id, true);
          }
        }
      }
    }

    // Determine if user is tenant admin for JWT
    const isAdmin = isSuperAdmin || await UserRepo.isAdminOfTenant(user.id, tenant.id);

    // Issue JWT with tenant_id and admin status included
    const tokenPayload = {
      id: user.id,
      email: user.email,
      role: user.role,
      tenant_id: tenant.id,
      is_admin: isAdmin,
      is_super_admin: isSuperAdmin,
    };
    const expiresIn = process.env.JWT_EXPIRES_IN || '8h';
    const token = jwt.sign(tokenPayload, process.env.JWT_SECRET, { expiresIn });

    return reply.send({ token, tenant_id: tenant.id, is_admin: isAdmin });
  });
}
