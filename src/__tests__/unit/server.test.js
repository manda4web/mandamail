import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

// Mock environment variables before importing modules
vi.stubEnv('JWT_SECRET', 'test-secret-key-for-testing-purposes');
vi.stubEnv('JWT_EXPIRES_IN', '1h');

// Mock UserRepo to avoid DB dependency
vi.mock('../../db/repos/UserRepo.js', () => ({
  UserRepo: {
    findByEmail: vi.fn(),
    hasAccessToTenant: vi.fn(),
  },
}));

import { buildApp } from '../../api/server.js';

describe('buildApp', () => {
  let app;

  beforeAll(async () => {
    app = buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('should create a Fastify instance', () => {
    expect(app).toBeDefined();
    expect(app.server).toBeDefined();
  });

  it('should register /auth/login route (public)', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'test@example.com', password: 'password123' },
    });

    // Should reach the handler (401 because user doesn't exist in mock)
    expect(response.statusCode).toBe(401);
    const body = JSON.parse(response.body);
    expect(body.error).toBe('Invalid credentials');
  });

  it('should require authentication for protected routes', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/tenants',
    });

    expect(response.statusCode).toBe(401);
    const body = JSON.parse(response.body);
    expect(body.error).toBe('Authentication required');
  });

  it('should reject invalid JWT tokens on protected routes', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/tenants',
      headers: {
        authorization: 'Bearer invalid-token',
      },
    });

    expect(response.statusCode).toBe(401);
    const body = JSON.parse(response.body);
    expect(body.error).toBe('Invalid or expired token');
  });

  it('should return structured JSON errors from error handler', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { invalid: 'data' },
    });

    // Fastify schema validation returns 400
    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body);
    expect(body.statusCode).toBeDefined();
    expect(body.error).toBeDefined();
  });

  it('should allow access to /auth routes without authentication', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'user@test.com', password: 'pass' },
    });

    // Should not get 401 for missing auth — it reaches the handler
    // (returns 401 only because credentials are invalid, not because auth is required)
    expect(response.statusCode).toBe(401);
    const body = JSON.parse(response.body);
    expect(body.error).toBe('Invalid credentials');
  });
});
