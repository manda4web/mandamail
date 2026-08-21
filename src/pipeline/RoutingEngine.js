/**
 * RoutingEngine - Matches sender-based routing rules against an email sender.
 *
 * A routing rule overrides the account mapping (pipeline / stage / responsible)
 * when the email comes from a specific sender:
 *  - match_type 'exact':  full email address, case-insensitive exact match
 *  - match_type 'domain': exact domain equality (part after the LAST '@'),
 *                         NOT a suffix match — sub.empresa.com.br != empresa.com.br
 *
 * Rules are ordered by (priority ASC, created_at ASC); the first active match
 * wins. Inactive rules are skipped here as defense in depth (the repo already
 * filters them).
 *
 * @module RoutingEngine
 */

/**
 * Extracts the domain of an email address: everything after the LAST '@',
 * lowercased. Returns null when there is no '@' or nothing after it — such
 * senders can never match a domain rule.
 *
 * @param {string} fromEmail
 * @returns {string|null}
 */
function extractDomain(fromEmail) {
  const normalized = String(fromEmail || '').trim().toLowerCase();
  const atIndex = normalized.lastIndexOf('@');
  if (atIndex === -1 || atIndex === normalized.length - 1) return null;
  return normalized.slice(atIndex + 1);
}

/**
 * Returns the first active rule matching the sender, or null.
 *
 * @param {Array<Object>} rules - routing_rules rows (active or not; inactive are skipped)
 * @param {string} fromEmail
 * @returns {Object|null}
 */
function matchRoutingRule(rules, fromEmail) {
  if (!Array.isArray(rules) || rules.length === 0) return null;

  const from = String(fromEmail || '').trim().toLowerCase();
  const domain = extractDomain(from);

  // Sort a copy — do not trust (nor mutate) the caller's ordering.
  // created_at may arrive as Date (pg) or ISO string; Date() handles both.
  const ordered = [...rules].sort((a, b) => {
    const pa = Number(a.priority ?? 100);
    const pb = Number(b.priority ?? 100);
    if (pa !== pb) return pa - pb;
    return new Date(a.created_at ?? 0).getTime() - new Date(b.created_at ?? 0).getTime();
  });

  for (const rule of ordered) {
    if (rule.is_active === false) continue;
    // Defense in depth: the route normalizes match_value on write, but a
    // hand-edited row must not silently stop matching.
    const value = String(rule.match_value || '').trim().toLowerCase();
    if (!value) continue;

    if (rule.match_type === 'exact') {
      if (from && from === value) return rule;
    } else if (rule.match_type === 'domain') {
      if (domain && domain === value) return rule;
    }
  }

  return null;
}

export const RoutingEngine = { extractDomain, matchRoutingRule };
export { extractDomain, matchRoutingRule };
export default RoutingEngine;
