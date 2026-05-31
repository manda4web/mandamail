import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BitrixClient, BitrixError, isTransientError } from '../../bitrix/BitrixClient.js';

// Mock pino to suppress output during tests
vi.mock('pino', () => ({
  default: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() }),
}));

describe('BitrixClient', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  describe('isTransientError', () => {
    it('classifies 429 as transient', () => {
      expect(isTransientError(429)).toBe(true);
    });

    it('classifies 500 as transient', () => {
      expect(isTransientError(500)).toBe(true);
    });

    it('classifies 502 as transient', () => {
      expect(isTransientError(502)).toBe(true);
    });

    it('classifies 503 as transient', () => {
      expect(isTransientError(503)).toBe(true);
    });

    it('classifies 599 as transient', () => {
      expect(isTransientError(599)).toBe(true);
    });

    it('classifies 400 as non-transient', () => {
      expect(isTransientError(400)).toBe(false);
    });

    it('classifies 401 as non-transient', () => {
      expect(isTransientError(401)).toBe(false);
    });

    it('classifies 403 as non-transient', () => {
      expect(isTransientError(403)).toBe(false);
    });

    it('classifies 404 as non-transient', () => {
      expect(isTransientError(404)).toBe(false);
    });

    it('classifies 200 as non-transient', () => {
      expect(isTransientError(200)).toBe(false);
    });
  });

  describe('constructor', () => {
    it('stores baseUrl without trailing slash', () => {
      const client = new BitrixClient({
        bitrix_url: 'https://example.bitrix24.com/',
        bitrix_webhook_token: 'abc123',
      });
      expect(client.baseUrl).toBe('https://example.bitrix24.com');
      expect(client.token).toBe('abc123');
    });

    it('handles URL without trailing slash', () => {
      const client = new BitrixClient({
        bitrix_url: 'https://example.bitrix24.com',
        bitrix_webhook_token: 'abc123',
      });
      expect(client.baseUrl).toBe('https://example.bitrix24.com');
    });

    it('sets default timeout to 30s', () => {
      const client = new BitrixClient({
        bitrix_url: 'https://example.bitrix24.com',
        bitrix_webhook_token: 'abc123',
      });
      expect(client.timeout).toBe(30000);
    });

    it('sets max attempts to 3', () => {
      const client = new BitrixClient({
        bitrix_url: 'https://example.bitrix24.com',
        bitrix_webhook_token: 'abc123',
      });
      expect(client.maxAttempts).toBe(3);
    });
  });

  describe('call()', () => {
    const tenant = {
      bitrix_url: 'https://test.bitrix24.com',
      bitrix_webhook_token: 'token123',
    };

    it('returns result on successful API call', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ result: { id: 42 } }),
      });

      const client = new BitrixClient(tenant);
      const result = await client.call('crm.deal.add', { fields: {} });

      expect(result).toEqual({ id: 42 });
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it('returns full data when result field is undefined', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ total: 5, items: [] }),
      });

      const client = new BitrixClient(tenant);
      const result = await client.call('crm.deal.list');

      expect(result).toEqual({ total: 5, items: [] });
    });

    it('propagates non-transient HTTP errors immediately without retry', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        text: () => Promise.resolve('Unauthorized'),
      });

      const client = new BitrixClient(tenant);
      await expect(client.call('crm.deal.add')).rejects.toThrow(BitrixError);
      await expect(client.call('crm.deal.add')).rejects.toMatchObject({
        type: 'non-transient',
        statusCode: 401,
      });
      // Only 2 calls because we called it twice
      expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    it('retries transient HTTP errors (5xx) up to 3 times', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        text: () => Promise.resolve('Server Error'),
      });

      const client = new BitrixClient(tenant);
      const error = await client.call('crm.deal.add').catch(e => e);

      expect(error).toBeInstanceOf(BitrixError);
      expect(error.type).toBe('transient');
      expect(error.attempts).toBe(3);
      expect(global.fetch).toHaveBeenCalledTimes(3);
    });

    it('retries transient HTTP 429 errors', async () => {
      global.fetch = vi.fn()
        .mockResolvedValueOnce({
          ok: false,
          status: 429,
          statusText: 'Too Many Requests',
          text: () => Promise.resolve('Rate limited'),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ result: 'ok' }),
        });

      const client = new BitrixClient(tenant);
      const result = await client.call('crm.deal.add');

      expect(result).toBe('ok');
      expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    it('retries on network errors', async () => {
      global.fetch = vi.fn()
        .mockRejectedValueOnce(new Error('fetch failed'))
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ result: 'recovered' }),
        });

      const client = new BitrixClient(tenant);
      const result = await client.call('crm.deal.add');

      expect(result).toBe('recovered');
      expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    it('does not retry 400 errors', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        text: () => Promise.resolve('Bad Request'),
      });

      const client = new BitrixClient(tenant);
      const error = await client.call('crm.deal.add').catch(e => e);

      expect(error).toBeInstanceOf(BitrixError);
      expect(error.type).toBe('non-transient');
      expect(error.statusCode).toBe(400);
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it('does not retry 403 errors', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        statusText: 'Forbidden',
        text: () => Promise.resolve('Forbidden'),
      });

      const client = new BitrixClient(tenant);
      const error = await client.call('crm.deal.add').catch(e => e);

      expect(error).toBeInstanceOf(BitrixError);
      expect(error.type).toBe('non-transient');
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it('does not retry 404 errors', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        text: () => Promise.resolve('Not Found'),
      });

      const client = new BitrixClient(tenant);
      const error = await client.call('crm.deal.add').catch(e => e);

      expect(error).toBeInstanceOf(BitrixError);
      expect(error.type).toBe('non-transient');
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it('includes attempt count in error for exhausted retries', async () => {
      global.fetch = vi.fn().mockRejectedValue(new Error('network down'));

      const client = new BitrixClient(tenant);
      const error = await client.call('crm.deal.add').catch(e => e);

      expect(error).toBeInstanceOf(BitrixError);
      expect(error.attempts).toBe(3);
    });

    it('constructs correct URL from tenant config', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ result: {} }),
      });

      const client = new BitrixClient(tenant);
      await client.call('crm.deal.add', { fields: { TITLE: 'Test' } });

      expect(global.fetch).toHaveBeenCalledWith(
        'https://test.bitrix24.com/token123/crm.deal.add',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fields: { TITLE: 'Test' } }),
        }),
      );
    });
  });
});
