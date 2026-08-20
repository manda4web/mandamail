import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Regression tests for the OAuth refresh race: concurrent BitrixClient
// instances of the same tenant must share ONE refresh call, and every waiter
// must adopt the fresh token afterwards (a waiter that kept the stale token
// would fail its retried call and burn one of the event's 5 attempts).

import { BitrixClient, _resetTokenCacheForTests } from '../../bitrix/BitrixClient.js';

const tenant = {
  id: 'tenant-1',
  bitrix_url: 'https://race.bitrix24.com.br',
  auth_id: 'TOKEN_OLD',
  refresh_id: 'REFRESH_OLD',
};

function stubFetch(handlers) {
  const calls = [];
  const fn = vi.fn(async (url) => {
    calls.push(String(url));
    for (const [match, response] of handlers) {
      if (String(url).includes(match)) return new Response(JSON.stringify(response), { status: 200 });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  vi.stubGlobal('fetch', fn);
  return { fn, calls };
}

describe('BitrixClient OAuth token refresh — single-flight per tenant', () => {
  const savedEnv = {};
  const ENV_KEYS = ['BITRIX_CLIENT_ID', 'BITRIX_CLIENT_SECRET'];

  beforeEach(() => {
    _resetTokenCacheForTests();
    for (const k of ENV_KEYS) { savedEnv[k] = process.env[k]; process.env[k] = 'test-client'; }
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  it('concurrent instances perform exactly ONE refresh and BOTH adopt the new token', async () => {
    let refreshCalls = 0;
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const s = String(url);
      if (s.includes('oauth.bitrix.info')) {
        refreshCalls++;
        // One microtask tick before resolving: enough for the second caller
        // to reach the refreshInFlight check, without real-timer flakiness.
        await Promise.resolve();
        return new Response(JSON.stringify({
          access_token: 'TOKEN_NEW',
          refresh_token: 'REFRESH_NEW',
          expires_in: 3600,
        }), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${s}`);
    }));
    const { db } = await import('../../db/client.js');
    vi.spyOn(db, 'query').mockResolvedValue({ rows: [] });

    const a = new BitrixClient({ ...tenant });
    const b = new BitrixClient({ ...tenant });

    const [okA, okB] = await Promise.all([a._refreshToken(), b._refreshToken()]);

    expect(refreshCalls).toBe(1); // single-flight
    expect(okA).toBe(true);
    expect(okB).toBe(true);
    // THE regression: the waiter must not keep the stale token
    expect(a.authId).toBe('TOKEN_NEW');
    expect(b.authId).toBe('TOKEN_NEW');
    expect(a.tenant.refresh_id).toBe('REFRESH_NEW');
    expect(b.tenant.refresh_id).toBe('REFRESH_NEW');

    db.query.mockRestore();
  });

  it('a third instance created after the refresh picks the cached token in its constructor', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (String(url).includes('oauth.bitrix.info')) {
        return new Response(JSON.stringify({
          access_token: 'TOKEN_NEW2',
          refresh_token: 'REFRESH_NEW2',
        }), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }));
    const { db } = await import('../../db/client.js');
    vi.spyOn(db, 'query').mockResolvedValue({ rows: [] });

    const first = new BitrixClient({ ...tenant });
    await first._refreshToken();

    const late = new BitrixClient({ ...tenant, auth_id: 'TOKEN_STALE_FROM_DB' });
    expect(late.authId).toBe('TOKEN_NEW2'); // constructor prefers the module cache

    db.query.mockRestore();
  });

  it('an instance whose refresh failed keeps its token and reports false', async () => {
    const { calls } = stubFetch([['oauth.bitrix.info', { error: 'invalid_grant' }]]);

    const a = new BitrixClient({ ...tenant });
    const ok = await a._refreshToken();

    expect(ok).toBe(false);
    expect(a.authId).toBe('TOKEN_OLD');
    expect(calls.length).toBe(1);
  });
});
