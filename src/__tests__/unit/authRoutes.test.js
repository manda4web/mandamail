import { describe, it, expect, vi, beforeEach } from 'vitest';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';

// Mock environment
process.env.JWT_SECRET = 'test-secret-key-for-unit-tests';
process.env.JWT_EXPIRES_IN = '2h';

// Mock UserRepo
vi.mock('../../db/repos/UserRepo.js', () => ({
  UserRepo: {
    findByEmail: vi.fn(),
  },
}));

// Mock logger
vi.mock('../../logger.js', () => ({
  default: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

import { UserRepo } from '../../db/repos/UserRepo.js';
import authRoutes from '../../api/routes/auth.js';

// Simulate Fastify plugin registration
function createFastifyMock() {
  const routes = {};
  return {
    post(path, opts, handler) {
      routes[`POST ${path}`] = { opts, handler };
    },
    routes,
  };
}

describe('POST /auth/login', () => {
  let fastify;
  let handler;

  beforeEach(async () => {
    vi.clearAllMocks();
    fastify = createFastifyMock();
    await authRoutes(fastify);
    handler = fastify.routes['POST /auth/login'].handler;
  });

  it('returns 401 when user is not found', async () => {
    UserRepo.findByEmail.mockResolvedValue(null);

    const request = { body: { email: 'unknown@test.com', password: 'pass123' } };
    const reply = createMockReply();

    await handler(request, reply);

    expect(reply.statusCode).toBe(401);
    expect(reply.body.error).toBe('Invalid credentials');
  });

  it('returns 401 when password is incorrect', async () => {
    const passwordHash = await bcrypt.hash('correct-password', 10);
    UserRepo.findByEmail.mockResolvedValue({
      id: 'user-1',
      email: 'user@test.com',
      password_hash: passwordHash,
      role: 'admin',
    });

    const request = { body: { email: 'user@test.com', password: 'wrong-password' } };
    const reply = createMockReply();

    await handler(request, reply);

    expect(reply.statusCode).toBe(401);
    expect(reply.body.error).toBe('Invalid credentials');
  });

  it('returns JWT token on successful login', async () => {
    const passwordHash = await bcrypt.hash('correct-password', 10);
    UserRepo.findByEmail.mockResolvedValue({
      id: 'user-1',
      email: 'user@test.com',
      password_hash: passwordHash,
      role: 'admin',
    });

    const request = { body: { email: 'user@test.com', password: 'correct-password' } };
    const reply = createMockReply();

    await handler(request, reply);

    expect(reply.statusCode).toBeNull(); // no error
    expect(reply.body).toHaveProperty('token');

    // Verify the token is valid and contains correct payload
    const decoded = jwt.verify(reply.body.token, 'test-secret-key-for-unit-tests');
    expect(decoded.id).toBe('user-1');
    expect(decoded.email).toBe('user@test.com');
    expect(decoded.role).toBe('admin');
  });

  it('issues token with correct expiration from env var', async () => {
    const passwordHash = await bcrypt.hash('mypass', 10);
    UserRepo.findByEmail.mockResolvedValue({
      id: 'user-2',
      email: 'tenant@test.com',
      password_hash: passwordHash,
      role: 'tenant_user',
    });

    const request = { body: { email: 'tenant@test.com', password: 'mypass' } };
    const reply = createMockReply();

    await handler(request, reply);

    expect(reply.body).toHaveProperty('token');
    const decoded = jwt.decode(reply.body.token);
    // JWT_EXPIRES_IN is '2h', so exp should be ~2 hours from now
    const twoHoursFromNow = Math.floor(Date.now() / 1000) + 7200;
    expect(decoded.exp).toBeGreaterThan(twoHoursFromNow - 10);
    expect(decoded.exp).toBeLessThanOrEqual(twoHoursFromNow + 10);
  });
});

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
