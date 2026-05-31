import crypto from 'node:crypto';

const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const KEY_HEX_LENGTH = 64; // 32 bytes = 64 hex chars

/** @type {Buffer|null} */
let cachedKey = null;

/**
 * Validates and loads the ENCRYPTION_KEY environment variable.
 * @returns {Buffer} 32-byte key buffer
 * @throws {Error} If key is missing or not a valid 64-char hex string (32 bytes)
 */
export function loadEncryptionKey() {
  const keyHex = process.env.ENCRYPTION_KEY;

  if (!keyHex) {
    throw new Error(
      'ENCRYPTION_KEY environment variable is missing. A 64-character hex string (32 bytes) is required.'
    );
  }

  if (keyHex.length !== KEY_HEX_LENGTH) {
    throw new Error(
      `ENCRYPTION_KEY must be exactly ${KEY_HEX_LENGTH} hex characters (32 bytes). Got ${keyHex.length} characters.`
    );
  }

  if (!/^[0-9a-fA-F]+$/.test(keyHex)) {
    throw new Error(
      'ENCRYPTION_KEY must be a valid hexadecimal string (characters 0-9, a-f, A-F only).'
    );
  }

  return Buffer.from(keyHex, 'hex');
}

/**
 * Returns the cached encryption key, loading it on first call.
 * @returns {Buffer} 32-byte key buffer
 */
function getKey() {
  if (!cachedKey) {
    cachedKey = loadEncryptionKey();
  }
  return cachedKey;
}

/**
 * Encrypts a plaintext password using AES-256-GCM.
 * @param {string} plaintext - Password to encrypt (1-512 chars)
 * @returns {string} Base64-encoded string containing: IV (12 bytes) + authTag (16 bytes) + ciphertext
 */
export function encrypt(plaintext) {
  const key = getKey();

  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);

  const authTag = cipher.getAuthTag();

  // Concatenate: IV (12) + authTag (16) + ciphertext
  const combined = Buffer.concat([iv, authTag, encrypted]);

  return combined.toString('base64');
}

/**
 * Decrypts a previously encrypted password.
 * @param {string} ciphertext - Base64-encoded string from encrypt()
 * @returns {string} Original plaintext password
 * @throws {Error} If decryption fails (invalid key, corrupted data, tag mismatch)
 */
export function decrypt(ciphertext) {
  const key = getKey();

  let combined;
  try {
    combined = Buffer.from(ciphertext, 'base64');
  } catch {
    throw new Error('Decryption failed: invalid base64 input.');
  }

  if (combined.length < IV_LENGTH + AUTH_TAG_LENGTH + 1) {
    throw new Error('Decryption failed: ciphertext is too short.');
  }

  const iv = combined.subarray(0, IV_LENGTH);
  const authTag = combined.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const data = combined.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);

    const decrypted = Buffer.concat([
      decipher.update(data),
      decipher.final(),
    ]);

    return decrypted.toString('utf8');
  } catch {
    throw new Error('Decryption failed: unable to decrypt data. The key may be incorrect or the data may be corrupted.');
  }
}

/**
 * Resets the cached key (useful for testing).
 */
export function _resetKeyCache() {
  cachedKey = null;
}
