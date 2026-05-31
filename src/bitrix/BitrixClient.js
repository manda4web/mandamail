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
   * @param {string} [tenant.server_endpoint] - OAuth server endpoint
   */
  constructor(tenant) {
    this.tenant = tenant;
    this.baseUrl = tenant.bitrix_url.replace(/\/$/, '');
    this.token = tenant.bitrix_webhook_token;
    this.authId = tenant.auth_id;
    this.serverEndpoint = tenant.server_endpoint;
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
      // OAuth mode: use server_endpoint or construct from domain
      const endpoint = this.serverEndpoint || (this.baseUrl + '/rest');
      url = `${endpoint}/${method}`;
      body = { ...params, auth: this.authId };
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

          if (!isTransientError(statusCode)) {
            // Non-transient error — propagate immediately
            const body = await response.text().catch(() => '');
            throw new BitrixError(
              `Bitrix24 API error: ${statusCode} - ${body}`,
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
}
