import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Regression for the silent-corruption bug: Bitrix24 answers many errors as
// HTTP 200 + {error, error_description}, and call() returned that object as
// if it were a success result (duplicate contacts, "dealId" = error object).

import { BitrixClient, BitrixError, _resetTokenCacheForTests } from '../../bitrix/BitrixClient.js';

const tenant = {
  id: 'tenant-1',
  bitrix_url: 'https://apierr.bitrix24.com.br',
  bitrix_webhook_token: 'wh-token', // webhook mode: no OAuth refresh involved
};

function stub200(body) {
  vi.stubGlobal('fetch', vi.fn(async () =>
    new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
  ));
}

describe('BitrixClient.call() — HTTP 200 with application-level error', () => {
  beforeEach(() => { _resetTokenCacheForTests(); });

  afterEach(() => { vi.unstubAllGlobals(); });

  it('throws non-transient BitrixError on validation errors instead of returning the error object', async () => {
    stub200({ error: 'ERROR_VALIDATION', error_description: 'stage not found' });
    const bx = new BitrixClient({ ...tenant });

    await expect(bx.call('crm.deal.add', { fields: {} })).rejects.toMatchObject({
      name: 'BitrixError',
      type: 'non-transient',
    });
  });

  it('retries QUERY_LIMIT_EXCEEDED as transient and fails after 3 attempts', async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn(async () =>
        new Response(JSON.stringify({ error: 'QUERY_LIMIT_EXCEEDED' }), { status: 200 })
      );
      vi.stubGlobal('fetch', fetchMock);
      const bx = new BitrixClient({ ...tenant });
      const promise = bx.call('crm.deal.list', {});
      // advance past the 2s retry delays
      promise.catch(() => {});
      await vi.advanceTimersByTimeAsync(5000);
      await expect(promise).rejects.toMatchObject({ type: 'transient' });
      expect(fetchMock).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('still returns the real result when the body is a success', async () => {
    stub200({ result: 12345 });
    const bx = new BitrixClient({ ...tenant });
    await expect(bx.call('crm.deal.add', {})).resolves.toBe(12345);
  });
});
