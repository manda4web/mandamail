import pino from 'pino';

const logger = pino({ name: 'BitrixClient' });

/**
 * Error class for Bitrix24 API errors.
 */
export class BitrixError extends Error {
  /**
   * @param {string} message
   * @param {Object} options
   * @param {string} options.type - 'transient' or 'non-transient'
   * @param {number} options.statusCode - HTTP status code
   * @param {number} options.attempts - Number of attempts made
   */
  constructor(message, { type, statusCode, attempts } = {}) {
    super(message);
    this.name = 'BitrixError';
    this.type = type;
    this.statusCode = statusCode;
    this.attempts = attempts;
  }
}

/**
 * Classifies an HTTP status code as transient or non-transient.
 * Transient: 429, 5xx, connection/socket timeout
 * Non-transient: 400, 401, 403, 404
 * @param {number} statusCode
 * @returns {boolean} true if transient
 */
export function isTransientError(statusCode) {
  if (statusCode === 429) return true;
  if (statusCode >= 500 && statusCode <= 599) return true;
  return false;
}

// Module-level OAuth token cache: baseUrl → { authId, refreshId }.
// Concurrent BitrixClient instances of the same tenant share the freshest
// token and never run parallel refreshes (parallel refreshes rotate the
// refresh_token twice, which can break OAuth for the whole tenant).
const tokenCache = new Map();
const refreshInFlight = new Map(); // baseUrl → Promise<boolean>

/** Test helper — clears the module-level token cache between tests. */
export function _resetTokenCacheForTests() {
  tokenCache.clear();
  refreshInFlight.clear();
}

/**
 * HTTP client wrapper for Bitrix24 REST API.
 * Provides internal retry (3 attempts, 2s delay) for transient errors.
 */
export class BitrixClient {
  /**
   * @param {Object} tenant - Tenant configuration object
   * @param {string} tenant.bitrix_url - Bitrix24 base URL
   * @param {string} [tenant.bitrix_webhook_token] - Webhook token (legacy)
   * @param {string} [tenant.auth_id] - OAuth access token
   * @param {string} [tenant.id] - Tenant UUID (preferred for token persistence)
   * @param {string} [tenant.server_endpoint] - OAuth server endpoint
   */
  constructor(tenant) {
    this.tenant = tenant;
    this.baseUrl = tenant.bitrix_url.replace(/\/$/, '');
    this.token = tenant.bitrix_webhook_token;
    this.serverEndpoint = tenant.server_endpoint;
    // Prefer the module cache: another instance may have refreshed the token
    // after this tenant snapshot was loaded from the DB.
    const cached = tenant.auth_id ? tokenCache.get(this.baseUrl) : null;
    if (cached) {
      this.authId = cached.authId;
      this.tenant.auth_id = cached.authId;
      if (cached.refreshId) this.tenant.refresh_id = cached.refreshId;
    } else {
      this.authId = tenant.auth_id;
    }
    this.maxAttempts = 3;
    this.retryDelay = 2000; // 2 seconds
    this.timeout = 30000; // 30 seconds
  }

  /**
   * Makes an API call with internal retry (3 attempts, 2s delay).
   * Supports both OAuth (auth_id) and webhook (token) modes.
   * @param {string} method - Bitrix24 REST method (e.g., 'crm.deal.add')
   * @param {Object} params - Method parameters
   * @returns {Promise<Object>} API response result
   * @throws {BitrixError} After 3 failed attempts or on non-transient error
   */
  async call(method, params = {}) {
    let url;
    let body = params;

    if (this.authId) {
      // OAuth mode: auth token as query parameter
      const endpoint = this.baseUrl + '/rest';
      url = `${endpoint}/${method}?auth=${this.authId}`;
      body = params;
    } else if (this.token) {
      // Webhook mode (legacy)
      url = `${this.baseUrl}/${this.token}/${method}`;
    } else {
      throw new BitrixError('No authentication configured (neither OAuth nor webhook)', { type: 'non-transient', statusCode: 0, attempts: 0 });
    }

    let lastError;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.timeout);

        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          const statusCode = response.status;

          // Check if token expired (401) — try refresh
          if (statusCode === 401 && this.authId && this.tenant && this.tenant.refresh_id && !this._refreshed) {
            logger.info({ method }, 'Token expired, attempting refresh...');
            const refreshed = await this._refreshToken();
            if (refreshed) {
              this._refreshed = true; // prevent infinite refresh loop
              return this.call(method, params);
            }
          }

          if (!isTransientError(statusCode)) {
            // Non-transient error — propagate immediately
            const respBody = await response.text().catch(() => '');
            throw new BitrixError(
              `Bitrix24 API error: ${statusCode} - ${respBody}`,
              { type: 'non-transient', statusCode, attempts: attempt }
            );
          }

          // Transient error — retry
          lastError = new BitrixError(
            `Bitrix24 API transient error: ${statusCode}`,
            { type: 'transient', statusCode, attempts: attempt }
          );

          logger.warn({ method, statusCode, attempt }, 'Transient error, retrying...');

          if (attempt < this.maxAttempts) {
            await this._delay(this.retryDelay);
          }
          continue;
        }

        const data = await response.json();

        // Bitrix24 frequently answers HTTP 200 with an application-level
        // error body ({error, error_description}). Treating that as success
        // caused duplicate contacts and invalid deal/activity ids.
        if (data && data.error && data.result === undefined) {
          const errCode = String(data.error);

          // Expired OAuth token in a 200 body — same recovery as the 401 path
          if (errCode === 'EXPIRED_TOKEN' && this.authId && this.tenant && this.tenant.refresh_id && !this._refreshed) {
            const refreshed = await this._refreshToken();
            if (refreshed) {
              this._refreshed = true;
              return this.call(method, params);
            }
          }

          const transientApiErrors = [
            'QUERY_LIMIT_EXCEEDED',
            'AUTHORIZER_ERROR',
            'INTERNAL_SERVER_ERROR',
            'SOCKET_IO_ERROR',
          ];
          if (transientApiErrors.includes(errCode)) {
            lastError = new BitrixError(
              `Bitrix24 API transient error: ${errCode} - ${data.error_description || ''}`,
              { type: 'transient', statusCode: 200, attempts: attempt }
            );
            logger.warn({ method, errCode, attempt }, 'Transient API error, retrying...');
            if (attempt < this.maxAttempts) {
              await this._delay(this.retryDelay);
            }
            continue;
          }

          throw new BitrixError(
            `Bitrix24 API error: ${errCode} - ${data.error_description || ''}`,
            { type: 'non-transient', statusCode: 200, attempts: attempt }
          );
        }

        return data.result !== undefined ? data.result : data;
      } catch (error) {
        if (error instanceof BitrixError && error.type === 'non-transient') {
          throw error;
        }

        // Connection timeout or network error — treat as transient
        const isTimeout = error.name === 'AbortError' || error.code === 'ECONNABORTED';
        lastError = new BitrixError(
          `Bitrix24 API ${isTimeout ? 'timeout' : 'connection error'}: ${error.message}`,
          { type: 'transient', statusCode: null, attempts: attempt }
        );

        logger.warn({ method, attempt, error: error.message }, 'Connection error, retrying...');

        if (attempt < this.maxAttempts) {
          await this._delay(this.retryDelay);
        }
      }
    }

    // All retries exhausted
    lastError.attempts = this.maxAttempts;
    throw lastError;
  }

  /**
   * @param {number} ms
   * @returns {Promise<void>}
   */
  async _delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Refreshes the OAuth token using the refresh_id — single-flight per tenant.
   * Concurrent instances wait on the same promise; if another instance already
   * refreshed, the new token is adopted without hitting the OAuth server again.
   * @returns {Promise<boolean>} true if a fresh token is available
   */
  async _refreshToken() {
    const key = this.baseUrl;

    // Another instance already refreshed — adopt the newer token, no API call.
    const cached = tokenCache.get(key);
    if (cached && cached.authId !== this.authId) {
      this.authId = cached.authId;
      this.tenant.auth_id = cached.authId;
      if (cached.refreshId) this.tenant.refresh_id = cached.refreshId;
      return true;
    }

    // Single-flight: concurrent refreshes for the same tenant share one call.
    if (refreshInFlight.has(key)) {
      const ok = await refreshInFlight.get(key);
      if (ok) {
        // The winner refreshed while we waited — adopt its token before
        // returning, otherwise the caller would retry with the stale one.
        const fresh = tokenCache.get(key);
        if (fresh && fresh.authId !== this.authId) {
          this.authId = fresh.authId;
          this.tenant.auth_id = fresh.authId;
          if (fresh.refreshId) this.tenant.refresh_id = fresh.refreshId;
        }
      }
      return ok;
    }

    const promise = this._doRefresh().finally(() => refreshInFlight.delete(key));
    refreshInFlight.set(key, promise);
    return promise;
  }

  /**
   * Performs the actual OAuth refresh call and persists the new tokens.
   * Only called through _refreshToken (single-flight).
   * @returns {Promise<boolean>} true if refresh succeeded
   */
  async _doRefresh() {
    const clientId = process.env.BITRIX_CLIENT_ID;
    const clientSecret = process.env.BITRIX_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
      logger.error('Cannot refresh token: BITRIX_CLIENT_ID or BITRIX_CLIENT_SECRET not configured');
      return false;
    }

    try {
      const refreshUrl = `https://oauth.bitrix.info/oauth/token/?grant_type=refresh_token&client_id=${clientId}&client_secret=${clientSecret}&refresh_token=${this.tenant.refresh_id}`;

      const res = await fetch(refreshUrl, { signal: AbortSignal.timeout(15000) });
      const data = await res.json();

      if (data.error) {
        logger.error({ error: data.error, description: data.error_description }, 'Token refresh failed');
        return false;
      }

      if (data.access_token) {
        const newRefreshId = data.refresh_token || this.tenant.refresh_id;

        // Update in-memory + module cache
        this.authId = data.access_token;
        this.tenant.auth_id = data.access_token;
        this.tenant.refresh_id = newRefreshId;
        tokenCache.set(this.baseUrl, { authId: data.access_token, refreshId: newRefreshId });

        // Update in database — by tenant id when available (bitrix_url match
        // can hit the wrong row if the URL was ever reused/renamed)
        try {
          const { db } = await import('../db/client.js');
          const expiresSec = parseInt(data.expires_in, 10) || 3600;
          if (this.tenant.id) {
            await db.query(
              'UPDATE tenants SET auth_id = $1, refresh_id = $2, auth_expires_at = NOW() + ($3 || \' seconds\')::interval WHERE id = $4',
              [data.access_token, newRefreshId, expiresSec, this.tenant.id]
            );
          } else {
            await db.query(
              'UPDATE tenants SET auth_id = $1, refresh_id = $2, auth_expires_at = NOW() + ($3 || \' seconds\')::interval WHERE bitrix_url = $4',
              [data.access_token, newRefreshId, expiresSec, this.baseUrl]
            );
          }
          logger.info({ domain: this.baseUrl }, 'OAuth token refreshed successfully');
        } catch (dbErr) {
          logger.error({ error: dbErr.message }, 'Failed to save refreshed token to DB');
        }

        return true;
      }

      return false;
    } catch (err) {
      logger.error({ error: err.message }, 'Token refresh request failed');
      return false;
    }
  }
}
