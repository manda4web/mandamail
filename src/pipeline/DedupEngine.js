import { EmailEventRepo } from '../db/repos/EmailEventRepo.js';

export const DedupEngine = {
  /**
   * Checks if an email is a duplicate.
   * Dedup is scoped to imap_account_id (not tenant-wide).
   * - message_id check uses 24-hour window
   * - subject+from check uses 2-minute window, case-insensitive
   *
   * @param {Object} account - IMAP account object with at least { id }
   * @param {Object} email - Parsed email data with messageId, subject, fromEmail
   * @param {string} currentEventId - The current email event ID to exclude from checks
   * @returns {Promise<boolean>} true if duplicate, false otherwise
   */
  async isDuplicate(account, email, currentEventId) {
    // 1. Check by message_id if non-empty (24-hour window)
    if (email.messageId) {
      const found = await EmailEventRepo.findByMessageId(account.id, email.messageId);
      if (found && found.id !== currentEventId) {
        return true;
      }
    }

    // 2. Check by subject + from_email if subject is non-empty (2-minute window, case-insensitive)
    if (email.subject) {
      const found = await EmailEventRepo.findBySubjectFrom(account.id, email.subject, email.fromEmail);
      if (found && found.id !== currentEventId) {
        return true;
      }
    }

    // 3. Not a duplicate
    return false;
  },
};
