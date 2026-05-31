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
 * Preserves CID image references and data URI images for email rendering.
 * Normalizes image sizes to max-width: 100%.
 *
 * @param {string} html - Raw HTML content
 * @param {Array} attachments - Parsed attachments with contentId and content
 * @returns {string} Cleaned HTML
 */
export function cleanHtml(html, attachments = []) {
  if (!html) return '';

  let cleaned = html;

  // Remove <script> tags and content
  cleaned = cleaned.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');

  // Remove <style> tags and content
  cleaned = cleaned.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '');

  // Replace CID references with base64 data URIs from attachments
  // This ensures images display correctly in the email body
  if (attachments && attachments.length > 0) {
    for (const att of attachments) {
      if (att.contentId && att.content) {
        const cid = att.contentId.replace(/^<|>$/g, '');
        const mimeType = att.contentType || att.mimeType || 'application/octet-stream';
        const base64Data = att.content.toString('base64');
        const dataUri = `data:${mimeType};base64,${base64Data}`;

        // Replace cid: references in src attributes
        const cidPattern = new RegExp(`(src=["'])cid:${escapeRegex(cid)}(["'])`, 'gi');
        cleaned = cleaned.replace(cidPattern, `$1${dataUri}$2`);
      }
    }
  }

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

  // Clean HTML body (converts CID to data URIs, removes scripts/styles)
  let bodyHtml = parsed.html || null;
  if (bodyHtml) {
    bodyHtml = cleanHtml(bodyHtml, rawAttachments);
    if (bodyHtml.length > MAX_BODY_HTML_LENGTH) {
      bodyHtml = bodyHtml.substring(0, MAX_BODY_HTML_LENGTH);
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
    messageId,
    fromEmail,
    fromName,
    replyTo,
    subject,
    bodyHtml,
    bodyText,
    toEmails,
    ccEmails,
    attachments,
    attachmentCount: attachments.length,
    date,
  };
}
