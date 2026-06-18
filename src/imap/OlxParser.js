import { htmlToText } from './EmailParser.js';
import logger from '../logger.js';

/**
 * OlxParser - Extracts the real customer lead data from OLX notification emails.
 *
 * OLX lead emails always come from a fixed OLX sender (e.g. noreply@olx.com.br),
 * so the actual customer (name, email, phone) and the advertised product
 * (title, price, photo) live INSIDE the email body. This parser extracts those
 * fields so the pipeline can create the contact/deal with the real customer data.
 *
 * @module OlxParser
 */

/**
 * Attempts to extract OLX lead data from a parsed email object.
 *
 * @param {Object} email - Parsed email (output of parseRaw) with bodyHtml/bodyText
 * @returns {Object|null} Extracted lead data, or null if this isn't a parseable OLX email
 *   {
 *     name: string,
 *     email: string|null,
 *     phone: string|null,
 *     adTitle: string|null,
 *     adPrice: string|null,
 *     photoUrl: string|null,
 *     leadId: string|null
 *   }
 */
export function parseOlxLead(email) {
  const html = email.bodyHtml || '';
  const text = email.bodyText || htmlToText(html);

  if (!text) return null;

  const lead = {
    name: extractField(text, ['Nome', 'Name']),
    email: extractEmail(text),
    phone: extractPhone(text),
    adTitle: extractAdTitle(text),
    adPrice: extractPrice(text),
    priceNumber: extractPriceNumber(text),
    photoUrl: extractPhotoUrl(html),
    leadId: extractLeadId(text),
  };

  // Must have at least a name or email to be considered a valid OLX lead
  if (!lead.name && !lead.email && !lead.phone) {
    logger.warn('[OlxParser] Could not extract lead data from OLX email');
    return null;
  }

  return lead;
}

/**
 * Extracts a labeled field value from text, e.g. "Nome: Fabricio".
 */
function extractField(text, labels) {
  for (const label of labels) {
    const re = new RegExp(label + '\\s*:?\\s*(.+)', 'i');
    const lines = text.split('\n');
    for (const line of lines) {
      const m = line.match(re);
      if (m && m[1]) {
        const value = m[1].trim();
        if (value) return value;
      }
    }
  }
  return null;
}

/**
 * Extracts the customer email from the body (not the OLX sender).
 * Ignores @olx.com.br addresses.
 */
function extractEmail(text) {
  const labeled = extractField(text, ['E-mail', 'Email', 'E\\-mail']);
  if (labeled) {
    const m = labeled.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
    if (m && !/olx\./i.test(m[0])) return m[0].toLowerCase();
  }
  // Fallback: first non-OLX email in the body
  const all = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || [];
  for (const e of all) {
    if (!/olx\./i.test(e) && !/noreply/i.test(e)) return e.toLowerCase();
  }
  return null;
}

/**
 * Extracts the customer phone number.
 * Normalizes to E.164-style with Brazil country code (55) when missing.
 */
function extractPhone(text) {
  const labeled = extractField(text, ['Telefone', 'Phone', 'Celular', 'Tel']);
  if (labeled) {
    let digits = labeled.replace(/\D/g, '');
    if (digits.length >= 10 && digits.length <= 13) {
      // If it already starts with country code 55 (12-13 digits), keep as is.
      // Otherwise (10-11 digits = DDD + number), prepend 55.
      if (!(digits.length >= 12 && digits.startsWith('55'))) {
        digits = '55' + digits;
      }
      return digits;
    }
  }
  return null;
}

/**
 * Extracts the advertisement title (the product name).
 */
function extractAdTitle(text) {
  // Common patterns: "Anúncio:" followed by the title on next lines
  const labeled = extractField(text, ['Anúncio', 'Anuncio', 'Produto']);
  if (labeled && labeled.length > 3) return labeled;

  // Heuristic: look for a line after "Anúncio:" that looks like a product
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const idx = lines.findIndex(l => /an[uú]ncio/i.test(l));
  if (idx >= 0 && lines[idx + 1] && lines[idx + 1].length > 3) {
    return lines[idx + 1];
  }
  return null;
}

/**
 * Extracts the price (e.g. "R$ 75900,00").
 */
function extractPrice(text) {
  const m = text.match(/R\$\s*[\d.]+,\d{2}/);
  return m ? m[0].replace(/\s+/g, ' ').trim() : null;
}

/**
 * Extracts the price as a number (e.g. "R$ 75900,00" -> 75900.00).
 * Returns null if no price found.
 */
function extractPriceNumber(text) {
  const m = text.match(/R\$\s*([\d.]+,\d{2})/);
  if (!m) return null;
  // "75.900,00" or "75900,00" -> remove thousand dots, replace comma with dot
  const normalized = m[1].replace(/\./g, '').replace(',', '.');
  const num = parseFloat(normalized);
  return isNaN(num) ? null : num;
}

/**
 * Extracts the product photo URL from the HTML body.
 * Looks for img tags that point to OLX image CDNs.
 */
function extractPhotoUrl(html) {
  if (!html) return null;
  const imgs = [...html.matchAll(/<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi)];
  for (const m of imgs) {
    const src = m[1];
    // OLX product images are usually on img.olx.com.br / olxbr-images / autocosmos etc.
    if (/olx|img\.|images|cdn|amazonaws/i.test(src) && /^https?:\/\//i.test(src)) {
      return src;
    }
  }
  // Fallback: first http image
  for (const m of imgs) {
    if (/^https?:\/\//i.test(m[1])) return m[1];
  }
  return null;
}

/**
 * Extracts the OLX lead identifier (UUID at the bottom of the email).
 */
function extractLeadId(text) {
  const labeled = extractField(text, ['Identificador do lead', 'Lead ID', 'Identificador']);
  if (labeled) {
    const m = labeled.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    if (m) return m[0];
  }
  const m = text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  return m ? m[0] : null;
}

/**
 * Applies OLX lead data to an email object, returning a NEW email object
 * where the customer (not OLX) becomes the "from" and the deal content
 * reflects the advertised product. The original email is not mutated.
 *
 * @param {Object} email - Original parsed email
 * @param {Object} lead - Extracted OLX lead data
 * @returns {Object} Transformed email object for the pipeline
 */
export function applyOlxLead(email, lead) {
  const customerEmail = lead.email || email.fromEmail;
  const customerName = lead.name || (customerEmail ? customerEmail.split('@')[0] : 'Lead OLX');

  // Build deal description: ad title + customer/contact info + product photo
  let descParts = [];
  if (lead.adTitle) descParts.push('<b>Anúncio:</b> ' + escapeHtml(lead.adTitle));
  if (lead.adPrice) descParts.push('<b>Preço:</b> ' + escapeHtml(lead.adPrice));
  if (lead.phone) descParts.push('<b>Telefone:</b> ' + escapeHtml(lead.phone));
  if (lead.email) descParts.push('<b>E-mail:</b> ' + escapeHtml(lead.email));
  if (lead.leadId) descParts.push('<b>Lead OLX:</b> ' + escapeHtml(lead.leadId));
  let productHtml = descParts.join('<br>');
  if (lead.photoUrl) {
    productHtml += '<br><br><img src="' + lead.photoUrl + '" style="max-width:100%;border-radius:8px" />';
  }

  // Deal title = ad title (the product), fallback to customer name
  const dealTitle = lead.adTitle || ('Lead OLX - ' + customerName);

  return {
    ...email,
    fromEmail: customerEmail,
    fromName: customerName,
    replyTo: customerEmail,
    phone: lead.phone || null,
    subject: dealTitle,
    bodyHtml: productHtml || email.bodyHtml,
    bodyText: descParts.map(p => p.replace(/<[^>]+>/g, '')).join('\n') || email.bodyText,
    dealValue: lead.priceNumber || null,
    olxLead: lead,
  };
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
