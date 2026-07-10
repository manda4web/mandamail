/**
 * EmailParser - Parses mailparser output into structured EmailEventData.
 *
 * Receives the output of mailparser's simpleParser (already parsed object)
 * and extracts all relevant fields for the email pipeline.
 *
 * @module EmailParser
 */

const MAX_BODY_HTML_LENGTH = 200_000;
const MAX_BODY_TEXT_LENGTH = 10_000;

/**
 * Removes <script> and <style> tags and their content from HTML.
 * Keeps CID references as-is (they will be resolved by ActivityWriter after upload).
 * Removes data: URI images (they will be extracted separately before this is called).
 * Normalizes image sizes to max-width: 100%.
 *
 * @param {string} html - Raw HTML content
 * @param {Array} attachments - Parsed attachments with contentId and content (unused now)
 * @returns {string} Cleaned HTML
 */
export function cleanHtml(html, attachments = []) {
  if (!html) return '';

  let cleaned = html;

  // Remove <script> tags and content
  cleaned = cleaned.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');

  // Remove <style> tags and content
  cleaned = cleaned.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '');

  // Keep CID references — ActivityWriter will replace with uploaded URLs
  // Keep data: URI images — ActivityWriter will extract and upload them

  // Normalize image sizes - add max-width style to images without it
  cleaned = cleaned.replace(/<img\b([^>]*)>/gi, (match, attrs) => {
    if (/max-width/i.test(attrs)) {
      return match;
    }
    if (/style\s*=/i.test(attrs)) {
      attrs = attrs.replace(/style\s*=\s*["']([^"']*)["']/i, 'style="$1; max-width: 100%;"');
    } else {
      attrs += ' style="max-width: 100%;"';
    }
    return `<img${attrs}>`;
  });

  return cleaned;
}

/**
 * Converts HTML to plain text.
 * Strips HTML tags, converts <br> and <p> to newlines, decodes HTML entities.
 *
 * @param {string} html - HTML content
 * @returns {string} Plain text
 */
export function htmlToText(html) {
  if (!html) return '';

  let text = html;

  // Convert <br> and <br/> to newlines
  text = text.replace(/<br\s*\/?>/gi, '\n');

  // Convert block-level elements to newlines
  text = text.replace(/<\/p>/gi, '\n\n');
  text = text.replace(/<\/div>/gi, '\n');
  text = text.replace(/<\/li>/gi, '\n');
  text = text.replace(/<\/tr>/gi, '\n');
  text = text.replace(/<\/h[1-6]>/gi, '\n\n');

  // Remove all remaining HTML tags
  text = text.replace(/<[^>]+>/g, '');

  // Decode common HTML entities
  text = decodeHtmlEntities(text);

  // Normalize whitespace: collapse multiple spaces (but preserve newlines)
  text = text.replace(/[^\S\n]+/g, ' ');

  // Collapse multiple consecutive newlines to max 2
  text = text.replace(/\n{3,}/g, '\n\n');

  // Trim
  text = text.trim();

  return text;
}

/**
 * Decodes common HTML entities.
 * @param {string} text
 * @returns {string}
 */
function decodeHtmlEntities(text) {
  const entities = {
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&#39;': "'",
    '&apos;': "'",
    '&nbsp;': ' ',
    '&copy;': '©',
    '&reg;': '®',
    '&trade;': '™',
    '&hellip;': '…',
    '&mdash;': '—',
    '&ndash;': '–',
    '&laquo;': '«',
    '&raquo;': '»',
  };

  let decoded = text;
  for (const [entity, char] of Object.entries(entities)) {
    decoded = decoded.replaceAll(entity, char);
  }

  // Decode numeric entities (&#123; or &#x1F;)
  decoded = decoded.replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)));
  decoded = decoded.replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));

  return decoded;
}

/**
 * Escapes special regex characters in a string.
 * @param {string} str
 * @returns {string}
 */
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Removes NUL bytes (\u0000) from a string. PostgreSQL cannot store NUL bytes
 * in text/varchar columns ("invalid byte sequence for encoding UTF8: 0x00"),
 * and some emails (especially with broken encodings) contain them. Stripping
 * them prevents a single malformed email from blocking the whole mailbox.
 * @param {string|null} str
 * @returns {string|null}
 */
function stripNull(str) {
  if (typeof str !== 'string') return str;
  // Remove NUL and other control chars that are invalid in Postgres text
  // (keep \t, \n, \r which are valid and meaningful).
  return str.replace(/\u0000/g, '').replace(/[\x01-\x08\x0B\x0C\x0E-\x1F]/g, '');
}

/**
 * Parses the output of mailparser's simpleParser into a structured EmailEventData object.
 *
 * @param {Object} parsed - The output of mailparser's simpleParser
 * @returns {Object} EmailEventData with all extracted fields
 * @throws {Error} If message_id or from_email is missing
 */
export function parseRaw(parsed) {
  // Extract messageId
  const messageId = parsed.messageId || null;

  // Extract from email and name
  const fromEmail = parsed.from?.value?.[0]?.address?.toLowerCase() || null;
  const rawFromName = parsed.from?.value?.[0]?.name || null;

  // Validate required fields
  if (!messageId) {
    throw new Error('Email parsing failed: missing message_id (Message-ID header)');
  }

  if (!fromEmail) {
    throw new Error('Email parsing failed: missing from_email (From header)');
  }

  // fromName: fallback to email local part
  const fromName = rawFromName || fromEmail.split('@')[0];

  // replyTo: fallback to fromEmail
  const replyTo = parsed.replyTo?.value?.[0]?.address || fromEmail;

  // subject: fallback to 'Sem assunto'
  const subject = parsed.subject || 'Sem assunto';

  // Process attachments (raw from mailparser)
  const rawAttachments = parsed.attachments || [];

  // Build inline images map from CID attachments (for ActivityWriter to upload)
  const inlineImages = [];
  if (rawAttachments && rawAttachments.length > 0) {
    for (const att of rawAttachments) {
      if (att.contentId && att.content) {
        const cid = att.contentId.replace(/^<|>$/g, '');
        const mimeType = att.contentType || att.mimeType || 'image/png';
        inlineImages.push({
          cid,
          fileName: att.filename || `cid_${cid}.${mimeType.split('/')[1] || 'png'}`,
          mimeType,
          data: att.content.toString('base64'),
        });
      }
    }
  }

  // Clean HTML body (removes scripts/styles, keeps CID refs and data URIs)
  let bodyHtml = parsed.html || null;
  if (bodyHtml) {
    bodyHtml = cleanHtml(bodyHtml, rawAttachments);
    // Note: bodyHtml is NOT truncated here — ActivityWriter extracts images first
    // Cap at 25MB to prevent memory issues
    if (bodyHtml.length > 25_000_000) {
      bodyHtml = bodyHtml.substring(0, 25_000_000);
    }
  }

  // Text body: use parsed.text or convert from HTML
  let bodyText = parsed.text || null;
  if (!bodyText && bodyHtml) {
    bodyText = htmlToText(bodyHtml);
  }
  if (bodyText && bodyText.length > MAX_BODY_TEXT_LENGTH) {
    bodyText = bodyText.substring(0, MAX_BODY_TEXT_LENGTH);
  }

  // Extract to emails
  const toEmails = [];
  if (parsed.to?.value) {
    for (const addr of parsed.to.value) {
      if (addr.address) {
        toEmails.push(addr.address.toLowerCase());
      }
    }
  }

  // Extract cc emails
  const ccEmails = [];
  if (parsed.cc?.value) {
    for (const addr of parsed.cc.value) {
      if (addr.address) {
        ccEmails.push(addr.address.toLowerCase());
      }
    }
  }

  // Process attachments: separate inline CID images from regular attachments
  // Inline CID images will be uploaded separately by ActivityWriter
  const regularAttachments = [];
  const inlineAttachments = [];

  for (const att of rawAttachments) {
    if (att.contentId && att.contentDisposition === 'inline' && att.content) {
      // Inline CID image — will be sent as FILES in the activity for inline rendering
      const cid = att.contentId.replace(/^<|>$/g, '');
      inlineAttachments.push({
        fileName: att.filename || `inline_${cid}.${(att.contentType || 'image/png').split('/')[1] || 'png'}`,
        mimeType: att.contentType || 'image/png',
        fileData: att.content.toString('base64'),
        contentId: cid,
      });
    } else if (att.content) {
      // Regular attachment
      regularAttachments.push({
        fileName: att.filename || 'unnamed',
        mimeType: att.contentType || 'application/octet-stream',
        fileData: att.content.toString('base64'),
      });
    }
  }

  const attachments = [...regularAttachments, ...inlineAttachments];

  // Extract date
  const date = parsed.date || new Date();

  return {
    messageId: stripNull(messageId),
    fromEmail: stripNull(fromEmail),
    fromName: stripNull(fromName),
    replyTo: stripNull(replyTo),
    subject: stripNull(subject),
    bodyHtml: stripNull(bodyHtml),
    bodyText: stripNull(bodyText),
    toEmails: toEmails.map(stripNull),
    ccEmails: ccEmails.map(stripNull),
    attachments,
    attachmentCount: attachments.length,
    inlineImages,
    date,
  };
}
