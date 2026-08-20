import logger from '../logger.js';

/**
 * Fetches the original email (with attachments and full body) from the IMAP
 * server by Message-ID. Used by reprocess and retry flows so the pipeline
 * works with the real email instead of the truncated DB copy (body_html is
 * capped at 500KB and attachments are not stored at all).
 *
 * Never throws — returns null when the email cannot be fetched so callers
 * can fall back to the DB reconstruction.
 *
 * @param {Object} account - IMAP account (from ImapAccountRepo, with decrypted password)
 * @param {string} messageId - Email Message-ID header
 * @returns {Promise<Object|null>} Parsed email (EmailParser format) or null
 */
export async function fetchOriginalEmail(account, messageId) {
  if (!messageId) return null;

  let imapClient = null;
  try {
    const { ImapFlow } = await import('imapflow');
    const { simpleParser } = await import('mailparser');
    const { parseRaw } = await import('./EmailParser.js');

    imapClient = new ImapFlow({
      host: account.host,
      port: account.port || 993,
      secure: account.use_ssl !== false,
      auth: { user: account.username, pass: account.password },
      logger: false,
      greetTimeout: 15000,
      socketTimeout: 15000,
    });

    await imapClient.connect();
    const lock = await imapClient.getMailboxLock(account.mailbox || 'INBOX');

    try {
      // Search for the email by Message-ID
      const uids = await imapClient.search({ header: { 'message-id': messageId } });
      if (!uids || uids.length === 0) return null;

      const msg = await imapClient.fetchOne(uids[0], { source: true }, { uid: true });
      if (!msg || !msg.source) return null;

      const parsed = await simpleParser(msg.source);
      return parseRaw(parsed);
    } finally {
      lock.release();
      await imapClient.logout();
    }
  } catch (err) {
    logger.warn({ accountId: account.id, messageId, error: err.message }, 'fetchOriginalEmail: could not fetch from IMAP');
    try { imapClient?.close(); } catch { /* already closed */ }
    return null;
  }
}
