import { describe, it, expect } from 'vitest';
import { FilterEngine, shouldIgnore, checkFilter } from '../../pipeline/FilterEngine.js';

describe('FilterEngine', () => {
  describe('shouldIgnore', () => {
    const emptyAccount = { ignore_from: [], ignore_subject: [] };

    it('returns false for a normal email with empty ignore lists', () => {
      const email = { fromEmail: 'user@example.com', subject: 'Hello' };
      expect(shouldIgnore(emptyAccount, email)).toBe(false);
    });

    describe('global from filters', () => {
      it('ignores mailer-daemon', () => {
        const email = { fromEmail: 'mailer-daemon@server.com', subject: 'Test' };
        expect(shouldIgnore(emptyAccount, email)).toBe(true);
      });

      it('ignores postmaster', () => {
        const email = { fromEmail: 'postmaster@domain.com', subject: 'Test' };
        expect(shouldIgnore(emptyAccount, email)).toBe(true);
      });

      it('ignores noreply', () => {
        const email = { fromEmail: 'noreply@company.com', subject: 'Test' };
        expect(shouldIgnore(emptyAccount, email)).toBe(true);
      });

      it('ignores no-reply', () => {
        const email = { fromEmail: 'no-reply@company.com', subject: 'Test' };
        expect(shouldIgnore(emptyAccount, email)).toBe(true);
      });

      it('ignores bitrix24.com sender', () => {
        const email = { fromEmail: 'notifications@bitrix24.com', subject: 'Test' };
        expect(shouldIgnore(emptyAccount, email)).toBe(true);
      });

      it('is case-insensitive for global from', () => {
        const email = { fromEmail: 'MAILER-DAEMON@server.com', subject: 'Test' };
        expect(shouldIgnore(emptyAccount, email)).toBe(true);
      });
    });

    describe('global subject filters', () => {
      it('ignores mail delivery subjects', () => {
        const email = { fromEmail: 'user@test.com', subject: 'Mail Delivery Failed' };
        expect(shouldIgnore(emptyAccount, email)).toBe(true);
      });

      it('ignores undelivered subjects', () => {
        const email = { fromEmail: 'user@test.com', subject: 'Undelivered Mail Returned' };
        expect(shouldIgnore(emptyAccount, email)).toBe(true);
      });

      it('ignores out of office subjects', () => {
        const email = { fromEmail: 'user@test.com', subject: 'Out of Office: Meeting' };
        expect(shouldIgnore(emptyAccount, email)).toBe(true);
      });

      it('ignores auto-reply subjects', () => {
        const email = { fromEmail: 'user@test.com', subject: 'Auto-Reply: I am away' };
        expect(shouldIgnore(emptyAccount, email)).toBe(true);
      });

      it('ignores fora do escritorio subjects', () => {
        const email = { fromEmail: 'user@test.com', subject: 'Fora do Escritorio' };
        expect(shouldIgnore(emptyAccount, email)).toBe(true);
      });

      it('is case-insensitive for global subject', () => {
        const email = { fromEmail: 'user@test.com', subject: 'DELIVERY STATUS notification' };
        expect(shouldIgnore(emptyAccount, email)).toBe(true);
      });
    });

    describe('tenant from filters', () => {
      it('ignores email matching tenant ignore_from (exact, case-insensitive)', () => {
        const account = { ignore_from: ['spam@example.com'], ignore_subject: [] };
        const email = { fromEmail: 'SPAM@example.com', subject: 'Buy now' };
        expect(shouldIgnore(account, email)).toBe(true);
      });

      it('does not ignore partial match for tenant ignore_from', () => {
        const account = { ignore_from: ['spam@example.com'], ignore_subject: [] };
        const email = { fromEmail: 'notspam@example.com', subject: 'Hello' };
        expect(shouldIgnore(account, email)).toBe(false);
      });

      it('handles multiple entries in ignore_from', () => {
        const account = { ignore_from: ['a@test.com', 'b@test.com'], ignore_subject: [] };
        const email = { fromEmail: 'b@test.com', subject: 'Hello' };
        expect(shouldIgnore(account, email)).toBe(true);
      });
    });

    describe('tenant subject filters', () => {
      it('ignores email with subject containing tenant ignore_subject entry', () => {
        const account = { ignore_from: [], ignore_subject: ['newsletter'] };
        const email = { fromEmail: 'user@test.com', subject: 'Weekly Newsletter Update' };
        expect(shouldIgnore(account, email)).toBe(true);
      });

      it('is case-insensitive for tenant subject', () => {
        const account = { ignore_from: [], ignore_subject: ['PROMO'] };
        const email = { fromEmail: 'user@test.com', subject: 'Special promo offer' };
        expect(shouldIgnore(account, email)).toBe(true);
      });

      it('does not ignore when subject does not contain entry', () => {
        const account = { ignore_from: [], ignore_subject: ['newsletter'] };
        const email = { fromEmail: 'user@test.com', subject: 'Important meeting' };
        expect(shouldIgnore(account, email)).toBe(false);
      });
    });

    describe('edge cases', () => {
      it('handles null subject', () => {
        const email = { fromEmail: 'user@test.com', subject: null };
        expect(shouldIgnore(emptyAccount, email)).toBe(false);
      });

      it('handles undefined subject', () => {
        const email = { fromEmail: 'user@test.com' };
        expect(shouldIgnore(emptyAccount, email)).toBe(false);
      });

      it('handles missing ignore_from and ignore_subject on account', () => {
        const account = {};
        const email = { fromEmail: 'user@test.com', subject: 'Hello' };
        expect(shouldIgnore(account, email)).toBe(false);
      });

      it('passes all emails when both lists are empty (Req 6.4)', () => {
        const account = { ignore_from: [], ignore_subject: [] };
        const email = { fromEmail: 'anyone@anywhere.com', subject: 'Anything' };
        expect(shouldIgnore(account, email)).toBe(false);
      });
    });
  });

  describe('checkFilter', () => {
    it('returns isIgnored: false with reason null for passing email', () => {
      const tenant = { ignore_from: [], ignore_subject: [] };
      const email = { from_email: 'user@test.com', subject: 'Hello' };
      const result = checkFilter(email, tenant);
      expect(result).toEqual({ isIgnored: false, reason: null });
    });

    it('returns isIgnored: true with reason for global from match', () => {
      const tenant = { ignore_from: [], ignore_subject: [] };
      const email = { from_email: 'noreply@company.com', subject: 'Hello' };
      const result = checkFilter(email, tenant);
      expect(result.isIgnored).toBe(true);
      expect(result.reason).toContain('noreply');
    });

    it('returns isIgnored: true with reason for tenant from match', () => {
      const tenant = { ignore_from: ['blocked@test.com'], ignore_subject: [] };
      const email = { from_email: 'blocked@test.com', subject: 'Hello' };
      const result = checkFilter(email, tenant);
      expect(result.isIgnored).toBe(true);
      expect(result.reason).toContain('Tenant from filter');
    });

    it('returns isIgnored: true with reason for tenant subject match', () => {
      const tenant = { ignore_from: [], ignore_subject: ['spam'] };
      const email = { from_email: 'user@test.com', subject: 'This is spam content' };
      const result = checkFilter(email, tenant);
      expect(result.isIgnored).toBe(true);
      expect(result.reason).toContain('Tenant subject filter');
    });

    it('supports fromEmail field name as well', () => {
      const tenant = { ignore_from: ['blocked@test.com'], ignore_subject: [] };
      const email = { fromEmail: 'blocked@test.com', subject: 'Hello' };
      const result = checkFilter(email, tenant);
      expect(result.isIgnored).toBe(true);
    });
  });

  describe('exported constants', () => {
    it('exports GLOBAL_IGNORE_FROM with expected entries', () => {
      expect(FilterEngine.GLOBAL_IGNORE_FROM).toContain('mailer-daemon');
      expect(FilterEngine.GLOBAL_IGNORE_FROM).toContain('postmaster');
      expect(FilterEngine.GLOBAL_IGNORE_FROM).toContain('noreply');
      expect(FilterEngine.GLOBAL_IGNORE_FROM).toContain('no-reply');
      expect(FilterEngine.GLOBAL_IGNORE_FROM).toContain('mail delivery');
      expect(FilterEngine.GLOBAL_IGNORE_FROM).toContain('bitrix24.com');
    });

    it('exports GLOBAL_IGNORE_SUBJECT with expected entries', () => {
      expect(FilterEngine.GLOBAL_IGNORE_SUBJECT).toContain('mail delivery');
      expect(FilterEngine.GLOBAL_IGNORE_SUBJECT).toContain('undelivered');
      expect(FilterEngine.GLOBAL_IGNORE_SUBJECT).toContain('delivery status');
      expect(FilterEngine.GLOBAL_IGNORE_SUBJECT).toContain('failure notice');
      expect(FilterEngine.GLOBAL_IGNORE_SUBJECT).toContain('returned mail');
      expect(FilterEngine.GLOBAL_IGNORE_SUBJECT).toContain('auto-reply');
      expect(FilterEngine.GLOBAL_IGNORE_SUBJECT).toContain('automatic reply');
      expect(FilterEngine.GLOBAL_IGNORE_SUBJECT).toContain('out of office');
      expect(FilterEngine.GLOBAL_IGNORE_SUBJECT).toContain('fora do escritorio');
    });
  });
});
