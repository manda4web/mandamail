/**
 * FilterEngine - Applies global and per-tenant ignore rules to emails.
 *
 * Global ignore lists filter out system/automated emails (mailer-daemon, delivery notices, etc.)
 * Tenant-level ignore lists allow per-organization customization.
 *
 * @module FilterEngine
 * Validates: Requirements 6.1, 6.2, 6.3, 6.4
 */

const GLOBAL_IGNORE_FROM = [
  'mailer-daemon',
  'postmaster',
  'noreply',
  'no-reply',
  'mail delivery',
  'bitrix24.com',
];

const GLOBAL_IGNORE_SUBJECT = [
  'mail delivery',
  'undelivered',
  'delivery status',
  'failure notice',
  'returned mail',
  'auto-reply',
  'automatic reply',
  'out of office',
  'fora do escritorio',
];

/**
 * Checks if an email should be ignored based on global and tenant rules.
 *
 * @param {Object} account - Account/tenant configuration with ignore_from and ignore_subject arrays
 * @param {Object} email - Parsed email data with fromEmail and subject fields
 * @returns {boolean} true if the email should be ignored, false if it passes
 */
function shouldIgnore(account, email) {
  const fromLower = (email.fromEmail || '').toLowerCase();
  const subjectLower = (email.subject ?? '').toLowerCase();

  // Check global from: substring match
  for (const entry of GLOBAL_IGNORE_FROM) {
    if (fromLower.includes(entry)) {
      return true;
    }
  }

  // Check global subject: substring match
  for (const entry of GLOBAL_IGNORE_SUBJECT) {
    if (subjectLower.includes(entry)) {
      return true;
    }
  }

  // Check tenant from: case-insensitive exact comparison
  const tenantIgnoreFrom = account.ignore_from || [];
  for (const entry of tenantIgnoreFrom) {
    if (fromLower === entry.toLowerCase()) {
      return true;
    }
  }

  // Check tenant subject: case-insensitive substring match
  const tenantIgnoreSubject = account.ignore_subject || [];
  for (const entry of tenantIgnoreSubject) {
    if (subjectLower.includes(entry.toLowerCase())) {
      return true;
    }
  }

  return false;
}

/**
 * Checks if an email should be filtered (ignored) based on tenant rules.
 * Design interface used by EmailPipeline.
 *
 * @param {Object} email - Parsed email data (EmailEventData)
 * @param {Object} tenant - Tenant configuration with ignore_from and ignore_subject
 * @returns {{isIgnored: boolean, reason: string|null}}
 */
function checkFilter(email, tenant) {
  const fromLower = (email.from_email || email.fromEmail || '').toLowerCase();
  const subjectLower = (email.subject ?? '').toLowerCase();

  // Check global from: substring match
  for (const entry of GLOBAL_IGNORE_FROM) {
    if (fromLower.includes(entry)) {
      return { isIgnored: true, reason: `Global from filter: "${entry}"` };
    }
  }

  // Check global subject: substring match
  for (const entry of GLOBAL_IGNORE_SUBJECT) {
    if (subjectLower.includes(entry)) {
      return { isIgnored: true, reason: `Global subject filter: "${entry}"` };
    }
  }

  // Check tenant from: case-insensitive exact comparison
  const tenantIgnoreFrom = tenant.ignore_from || [];
  for (const entry of tenantIgnoreFrom) {
    if (fromLower === entry.toLowerCase()) {
      return { isIgnored: true, reason: `Tenant from filter: "${entry}"` };
    }
  }

  // Check tenant subject: case-insensitive substring match
  const tenantIgnoreSubject = tenant.ignore_subject || [];
  for (const entry of tenantIgnoreSubject) {
    if (subjectLower.includes(entry.toLowerCase())) {
      return { isIgnored: true, reason: `Tenant subject filter: "${entry}"` };
    }
  }

  return { isIgnored: false, reason: null };
}

export const FilterEngine = {
  shouldIgnore,
  checkFilter,
  GLOBAL_IGNORE_FROM,
  GLOBAL_IGNORE_SUBJECT,
};

export { shouldIgnore, checkFilter, GLOBAL_IGNORE_FROM, GLOBAL_IGNORE_SUBJECT };
export default FilterEngine;
