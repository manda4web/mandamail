import { describe, it, expect, vi, beforeEach } from 'vitest';
import jwt from 'jsonwebtoken';

// Mock environment
process.env.JWT_SECRET = 'test-secret-key-for-unit-tests';
process.env.JWT_EXPIRES_IN = '1h';

// Mock UserRepo
vi.mock('../../db/repos/UserRepo.js', () => ({
  UserRepo: {
    findByEmail: vi.fn(),
    hasAccessToTenant: vi.fn(),
  },
}));

// Mock logger
vi.mock('../../logger.js', () => ({
  default: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

import { authenticate, requireRole, requireTenantAccess } from '../../api/middleware/auth.js';
import { UserRepo } from '../../db/repos/UserRepo.js';

function createMockRequest(overrides = {}) {
  return {
    headers: { authorization: undefined },
    params: {},
    user: undefined,
    ...overrides,
  };
}

function createMockReply() {
  const reply = {
    statusCode: null,
    body: null,
    code(status) {
      reply.statusCode = status;
      return reply;
    },
    send(data) {
      reply.body = data;
      return reply;
    },
  };
  return reply;
}

describe('authenticate middleware', () => {
  it('returns 401 when no Authorization header is present', async () => {
    const request = createMockRequest();
    const reply = createMockReply();

    await authenticate(request, reply);

    expect(reply.statusCode).toBe(401);
    expect(reply.body.error).toBe('Authentication required');
  });

  it('returns 401 when Authorization header does not start with Bearer', async () => {
    const request = createMockRequest({ headers: { authorization: 'Basic abc123' } });
    const reply = createMockReply();

    await authenticate(request, reply);

    expect(reply.statusCode).toBe(401);
    expect(reply.body.error).toBe('Authentication required');
  });

  it('returns 401 when token is invalid', async () => {
    const request = createMockRequest({ headers: { authorization: 'Bearer invalid-token' } });
    const reply = createMockReply();

    await authenticate(request, reply);

    expect(reply.statusCode).toBe(401);
    expect(reply.body.error).toBe('Invalid or expired token');
  });

  it('returns 401 when token is expired', async () => {
    const token = jwt.sign({ id: '1', email: 'a@b.com', role: 'admin' }, 'test-secret-key-for-unit-tests', { expiresIn: '-1s' });
    const request = createMockRequest({ headers: { authorization: `Bearer ${token}` } });
    const reply = createMockReply();

    await authenticate(request, reply);

    expect(reply.statusCode).toBe(401);
    expect(reply.body.error).toBe('Invalid or expired token');
  });

  it('attaches decoded user to request on valid token', async () => {
    const payload = { id: 'user-123', email: 'admin@test.com', role: 'admin' };
    const token = jwt.sign(payload, 'test-secret-key-for-unit-tests', { expiresIn: '1h' });
    const request = createMockRequest({ headers: { authorization: `Bearer ${token}` } });
    const reply = createMockReply();

    await authenticate(request, reply);

    expect(request.user).toEqual({ id: 'user-123', email: 'admin@test.com', role: 'admin' });
    expect(reply.statusCode).toBeNull(); // no error response sent
  });
});

describe('requireRole middleware', () => {
  it('returns 403 when user role is not in allowed roles', async () => {
    const handler = requireRole('admin');
    const request = createMockRequest();
    request.user = { id: '1', email: 'user@test.com', role: 'tenant_user' };
    const reply = createMockReply();

    await handler(request, reply);

    expect(reply.statusCode).toBe(403);
    expect(reply.body.error).toBe('Insufficient permissions');
  });

  it('passes when user role is in allowed roles', async () => {
    const handler = requireRole('admin', 'tenant_user');
    const request = createMockRequest();
    request.user = { id: '1', email: 'user@test.com', role: 'tenant_user' };
    const reply = createMockReply();

    const result = await handler(request, reply);

    expect(reply.statusCode).toBeNull();
  });

  it('returns 403 when no user is attached to request', async () => {
    const handler = requireRole('admin');
    const request = createMockRequest();
    const reply = createMockReply();

    await handler(request, reply);

    expect(reply.statusCode).toBe(403);
  });
});

describe('requireTenantAccess middleware', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('allows admin to access any tenant', async () => {
    const request = createMockRequest({ params: { id: 'tenant-abc' } });
    request.user = { id: '1', email: 'admin@test.com', role: 'admin' };
    const reply = createMockReply();

    await requireTenantAccess(request, reply);

    expect(reply.statusCode).toBeNull();
    expect(UserRepo.hasAccessToTenant).not.toHaveBeenCalled();
  });

  it('returns 403 when tenant_user has no access', async () => {
    UserRepo.hasAccessToTenant.mockResolvedValue(false);
    const request = createMockRequest({ params: { id: 'tenant-abc' } });
    request.user = { id: 'user-1', email: 'user@test.com', role: 'tenant_user' };
    const reply = createMockReply();

    await requireTenantAccess(request, reply);

    expect(reply.statusCode).toBe(403);
    expect(reply.body.error).toBe('Access denied to this tenant');
    expect(UserRepo.hasAccessToTenant).toHaveBeenCalledWith('user-1', 'tenant-abc');
  });

  it('allows tenant_user with access to the tenant', async () => {
    UserRepo.hasAccessToTenant.mockResolvedValue(true);
    const request = createMockRequest({ params: { id: 'tenant-abc' } });
    request.user = { id: 'user-1', email: 'user@test.com', role: 'tenant_user' };
    const reply = createMockReply();

    await requireTenantAccess(request, reply);

    expect(reply.statusCode).toBeNull();
    expect(UserRepo.hasAccessToTenant).toHaveBeenCalledWith('user-1', 'tenant-abc');
  });

  it('returns 401 when no user is attached', async () => {
    const request = createMockRequest({ params: { id: 'tenant-abc' } });
    const reply = createMockReply();

    await requireTenantAccess(request, reply);

    expect(reply.statusCode).toBe(401);
  });
});
