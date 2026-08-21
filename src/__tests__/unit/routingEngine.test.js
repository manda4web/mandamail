import { describe, it, expect } from 'vitest';
import { RoutingEngine, extractDomain, matchRoutingRule } from '../../pipeline/RoutingEngine.js';

function rule(overrides = {}) {
  return {
    id: 'rule-1',
    name: null,
    match_type: 'exact',
    match_value: 'cliente@empresa.com.br',
    bitrix_category_id: 12,
    bitrix_stage_id: null,
    bitrix_responsible_id: 25,
    priority: 100,
    is_active: true,
    created_at: '2026-08-20T10:00:00Z',
    ...overrides,
  };
}

describe('RoutingEngine', () => {
  describe('extractDomain', () => {
    it('extracts the lowercased domain of a plain address', () => {
      expect(extractDomain('Cliente@Empresa.com.br')).toBe('empresa.com.br');
    });

    it('uses the part after the LAST @ (multi-@ addresses)', () => {
      expect(extractDomain('weird@a@empresa.com')).toBe('empresa.com');
    });

    it('returns null when there is no @', () => {
      expect(extractDomain('not-an-email')).toBeNull();
    });

    it('returns null when nothing follows the @', () => {
      expect(extractDomain('user@')).toBeNull();
    });

    it('returns null for empty/undefined/null input', () => {
      expect(extractDomain('')).toBeNull();
      expect(extractDomain(undefined)).toBeNull();
      expect(extractDomain(null)).toBeNull();
    });

    it('trims surrounding whitespace before extracting', () => {
      expect(extractDomain('  user@empresa.com  ')).toBe('empresa.com');
    });
  });

  describe('matchRoutingRule — exact', () => {
    it('matches the full address case-insensitively', () => {
      const r = rule();
      expect(matchRoutingRule([r], 'Cliente@EMPRESA.com.br')).toBe(r);
    });

    it('does not match a different address', () => {
      expect(matchRoutingRule([rule()], 'outro@empresa.com.br')).toBeNull();
    });

    it('does not match a substring of the address', () => {
      expect(matchRoutingRule([rule({ match_value: 'cliente@' })], 'cliente@empresa.com.br')).toBeNull();
    });

    it('plus-addressing requires the exact full address', () => {
      const r = rule({ match_value: 'a+b@x.com' });
      expect(matchRoutingRule([r], 'a+b@x.com')).toBe(r);
      expect(matchRoutingRule([r], 'a@x.com')).toBeNull();
    });

    it('never matches an empty sender', () => {
      expect(matchRoutingRule([rule()], '')).toBeNull();
      expect(matchRoutingRule([rule()], undefined)).toBeNull();
    });
  });

  describe('matchRoutingRule — domain', () => {
    it('matches every address of the domain, case-insensitively', () => {
      const r = rule({ match_type: 'domain', match_value: 'empresa.com.br' });
      expect(matchRoutingRule([r], 'qualquer@Empresa.com.br')).toBe(r);
      expect(matchRoutingRule([r], 'outra@EMPRESA.COM.BR')).toBe(r);
    });

    it('does NOT match a subdomain (exact equality, not suffix)', () => {
      const r = rule({ match_type: 'domain', match_value: 'empresa.com.br' });
      expect(matchRoutingRule([r], 'a@sub.empresa.com.br')).toBeNull();
    });

    it('does not match a different domain sharing a suffix', () => {
      const r = rule({ match_type: 'domain', match_value: 'empresa.com.br' });
      expect(matchRoutingRule([r], 'a@naoempresa.com.br')).toBeNull();
    });

    it('covers plus-addressing variants of the domain', () => {
      const r = rule({ match_type: 'domain', match_value: 'x.com' });
      expect(matchRoutingRule([r], 'user+tag@x.com')).toBe(r);
    });

    it('never matches a sender without @', () => {
      expect(matchRoutingRule([rule({ match_type: 'domain', match_value: 'x.com' })], 'x.com')).toBeNull();
    });
  });

  describe('matchRoutingRule — ordering and activation', () => {
    it('returns the first match ordered by priority ASC', () => {
      const later = rule({ id: 'later', match_type: 'domain', match_value: 'empresa.com.br', priority: 200 });
      const first = rule({ id: 'first', match_type: 'domain', match_value: 'empresa.com.br', priority: 50 });
      expect(matchRoutingRule([later, first], 'a@empresa.com.br')).toBe(first);
    });

    it('breaks priority ties by created_at ASC', () => {
      const older = rule({ id: 'older', created_at: '2026-08-01T00:00:00Z' });
      const newer = rule({ id: 'newer', created_at: '2026-08-19T00:00:00Z' });
      expect(matchRoutingRule([newer, older], 'cliente@empresa.com.br')).toBe(older);
    });

    it('accepts created_at as Date objects (pg rows)', () => {
      const older = rule({ id: 'older', created_at: new Date('2026-08-01T00:00:00Z') });
      const newer = rule({ id: 'newer', created_at: new Date('2026-08-19T00:00:00Z') });
      expect(matchRoutingRule([newer, older], 'cliente@empresa.com.br')).toBe(older);
    });

    it('skips inactive rules even when they match', () => {
      const inactive = rule({ is_active: false });
      const active = rule({ id: 'active', priority: 200, match_type: 'domain', match_value: 'empresa.com.br' });
      expect(matchRoutingRule([inactive, active], 'cliente@empresa.com.br')).toBe(active);
    });

    it('returns null when only an inactive rule matches', () => {
      expect(matchRoutingRule([rule({ is_active: false })], 'cliente@empresa.com.br')).toBeNull();
    });

    it('decides between exact and domain rules that both match by (priority, created_at)', () => {
      const domainRule = rule({ id: 'domain', match_type: 'domain', match_value: 'empresa.com.br', priority: 10 });
      const exactRule = rule({ id: 'exact', priority: 20 });
      expect(matchRoutingRule([domainRule, exactRule], 'cliente@empresa.com.br')).toBe(domainRule);
      expect(matchRoutingRule([exactRule, domainRule], 'cliente@empresa.com.br')).toBe(domainRule);
    });

    it('does not mutate the input array', () => {
      const a = rule({ id: 'a', priority: 200 });
      const b = rule({ id: 'b', priority: 50 });
      const input = [a, b];
      matchRoutingRule(input, 'cliente@empresa.com.br');
      expect(input).toEqual([a, b]);
    });
  });

  describe('matchRoutingRule — defensive inputs', () => {
    it('returns null for an empty rules array', () => {
      expect(matchRoutingRule([], 'a@b.com')).toBeNull();
    });

    it('returns null for a non-array rules value', () => {
      expect(matchRoutingRule(null, 'a@b.com')).toBeNull();
      expect(matchRoutingRule(undefined, 'a@b.com')).toBeNull();
    });

    it('skips rules with empty match_value', () => {
      expect(matchRoutingRule([rule({ match_value: '' })], 'cliente@empresa.com.br')).toBeNull();
    });

    it('skips unknown match_type values', () => {
      expect(matchRoutingRule([rule({ match_type: 'weird' })], 'cliente@empresa.com.br')).toBeNull();
    });

    it('normalizes a hand-edited uppercase match_value (defense in depth)', () => {
      const r = rule({ match_value: 'Cliente@Empresa.com.br' });
      expect(matchRoutingRule([r], 'cliente@empresa.com.br')).toBe(r);
    });
  });

  it('exposes the named exports through the RoutingEngine object', () => {
    expect(RoutingEngine.extractDomain).toBe(extractDomain);
    expect(RoutingEngine.matchRoutingRule).toBe(matchRoutingRule);
  });
});
