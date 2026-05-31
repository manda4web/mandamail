import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { encrypt, decrypt, loadEncryptionKey, _resetKeyCache } from '../../crypto/passwords.js';

// Valid 32-byte key (64 hex chars)
const VALID_KEY = 'a'.repeat(64);

describe('CryptoModule', () => {
  beforeEach(() => {
    _resetKeyCache();
    process.env.ENCRYPTION_KEY = VALID_KEY;
  });

  afterEach(() => {
    _resetKeyCache();
    delete process.env.ENCRYPTION_KEY;
  });

  describe('loadEncryptionKey()', () => {
    it('should return a 32-byte Buffer for a valid 64-char hex key', () => {
      const key = loadEncryptionKey();
      expect(key).toBeInstanceOf(Buffer);
      expect(key.length).toBe(32);
    });

    it('should throw if ENCRYPTION_KEY is missing', () => {
      delete process.env.ENCRYPTION_KEY;
      expect(() => loadEncryptionKey()).toThrow(/missing/i);
    });

    it('should throw if ENCRYPTION_KEY is too short', () => {
      process.env.ENCRYPTION_KEY = 'abcdef';
      expect(() => loadEncryptionKey()).toThrow(/64/);
    });

    it('should throw if ENCRYPTION_KEY is too long', () => {
      process.env.ENCRYPTION_KEY = 'a'.repeat(128);
      expect(() => loadEncryptionKey()).toThrow(/64/);
    });

    it('should throw if ENCRYPTION_KEY contains non-hex characters', () => {
      process.env.ENCRYPTION_KEY = 'g'.repeat(64);
      expect(() => loadEncryptionKey()).toThrow(/hexadecimal/i);
    });
  });

  describe('encrypt()', () => {
    it('should return a base64 string', () => {
      const result = encrypt('hello');
      expect(typeof result).toBe('string');
      // Verify it's valid base64
      expect(() => Buffer.from(result, 'base64')).not.toThrow();
    });

    it('should produce different ciphertext for the same plaintext (unique IV)', () => {
      const result1 = encrypt('same-password');
      const result2 = encrypt('same-password');
      expect(result1).not.toBe(result2);
    });

    it('should handle empty-like single character', () => {
      const result = encrypt('x');
      expect(typeof result).toBe('string');
    });

    it('should handle long passwords (512 chars)', () => {
      const longPassword = 'A'.repeat(512);
      const result = encrypt(longPassword);
      expect(typeof result).toBe('string');
    });
  });

  describe('decrypt()', () => {
    it('should decrypt back to original plaintext', () => {
      const plaintext = 'my-secret-password';
      const encrypted = encrypt(plaintext);
      const decrypted = decrypt(encrypted);
      expect(decrypted).toBe(plaintext);
    });

    it('should handle unicode characters', () => {
      const plaintext = 'contraseña-日本語-émojis-🔑';
      const encrypted = encrypt(plaintext);
      const decrypted = decrypt(encrypted);
      expect(decrypted).toBe(plaintext);
    });

    it('should throw on corrupted ciphertext', () => {
      const encrypted = encrypt('test');
      const corrupted = encrypted.slice(0, -4) + 'XXXX';
      expect(() => decrypt(corrupted)).toThrow(/Decryption failed/);
    });

    it('should throw on too-short input', () => {
      const shortData = Buffer.alloc(10).toString('base64');
      expect(() => decrypt(shortData)).toThrow(/too short/);
    });

    it('should throw when key changes between encrypt and decrypt', () => {
      const encrypted = encrypt('test');
      _resetKeyCache();
      process.env.ENCRYPTION_KEY = 'b'.repeat(64);
      expect(() => decrypt(encrypted)).toThrow(/Decryption failed/);
    });

    it('should not expose key or ciphertext content in error messages', () => {
      const encrypted = encrypt('secret-data');
      _resetKeyCache();
      process.env.ENCRYPTION_KEY = 'b'.repeat(64);
      try {
        decrypt(encrypted);
      } catch (err) {
        expect(err.message).not.toContain('secret-data');
        expect(err.message).not.toContain(VALID_KEY);
        expect(err.message).not.toContain(encrypted);
      }
    });
  });

  describe('lazy key loading', () => {
    it('should throw on first encrypt call if key is invalid', () => {
      _resetKeyCache();
      process.env.ENCRYPTION_KEY = 'invalid';
      expect(() => encrypt('test')).toThrow();
    });

    it('should throw on first decrypt call if key is invalid', () => {
      _resetKeyCache();
      process.env.ENCRYPTION_KEY = 'short';
      expect(() => decrypt('dGVzdA==')).toThrow();
    });
  });
});
