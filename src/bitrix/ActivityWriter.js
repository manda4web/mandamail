import { BitrixClient } from './BitrixClient.js';
import logger from '../logger.js';

/**
 * Extracts data URI images from HTML using string parsing (handles large base64).
 * Returns cleaned HTML with placeholders and the extracted image data.
 */
function extractDataUriImages(html) {
  if (!html) return { html: '', images: [] };

  const images = [];
  let result = '';
  let searchFrom = 0;

  while (true) {
    const imgStart = html.indexOf('<img', searchFrom);
    if (imgStart === -1) { result += html.slice(searchFrom); break; }

    const imgTagEnd = html.indexOf('>', imgStart);
    if (imgTagEnd === -1) { result += html.slice(searchFrom); break; }

    // Check if src contains data:image
    const srcIdx = html.indexOf('src=', imgStart);
    if (srcIdx === -1 || srcIdx > imgTagEnd) {
      result += html.slice(searchFrom, imgTagEnd + 1);
      searchFrom = imgTagEnd + 1;
      continue;
    }

    const quoteChar = html.charAt(srcIdx + 4); // " or '
    if (quoteChar !== '"' && quoteChar !== "'") {
      result += html.slice(searchFrom, imgTagEnd + 1);
      searchFrom = imgTagEnd + 1;
      continue;
    }

    const srcStart = srcIdx + 5; // after src="
    const dataPrefix = 'data:image/';
    if (!html.startsWith(dataPrefix, srcStart)) {
      result += html.slice(searchFrom, imgTagEnd + 1);
      searchFrom = imgTagEnd + 1;
      continue;
    }

    // Found a data URI image — find the end quote
    const srcEnd = html.indexOf(quoteChar, srcStart);
    if (srcEnd === -1) { result += html.slice(searchFrom); break; }

    // Extract mime type and base64
    const dataUri = html.slice(srcStart, srcEnd);
    const semiIdx = dataUri.indexOf(';base64,');
    if (semiIdx === -1) {
      result += html.slice(searchFrom, imgTagEnd + 1);
      searchFrom = imgTagEnd + 1;
      continue;
    }

    const mimeType = dataUri.slice(5, semiIdx); // after "data:"
    const base64Data = dataUri.slice(semiIdx + 8); // after ";base64,"

    const idx = images.length + 1;
    const ext = (mimeType.split('/')[1] || 'png').replace(/[^a-z]/g, '');
    images.push({ name: `inline_${idx}.${ext}`, data: base64Data.replace(/\s/g, '') });

    // Add everything before this img, then placeholder
    result += html.slice(searchFrom, imgStart);
    result += `<!--IMG_PLACEHOLDER_${idx}-->`;

    // Skip past the entire img tag
    const fullImgEnd = html.indexOf('>', srcEnd);
    searchFrom = (fullImgEnd !== -1 ? fullImgEnd : imgTagEnd) + 1;
  }

  return { html: result, images };
}

export const ActivityWriter = {
  /**
   * @param {Object} tenant - Tenant configuration
   * @param {Object} email - Email data
   * @param {number} dealId - Bitrix24 deal ID
   * @param {number} contactId - Bitrix24 contact ID
   * @param {string} accountEmail - IMAP account email (for logs)
   * @param {Object} [client] - Shared BitrixClient (created when omitted)
   */
  async write(tenant, email, dealId, contactId, accountEmail, client) {
    const bx = client || new BitrixClient(tenant);
    let body = email.bodyHtml || email.bodyText || '';
    let dataUriImages = [];

    // Step 1: Extract data URI images from HTML (pasted images)
    if (email.bodyHtml && body.includes('data:image')) {
      logger.info(`[ActivityWriter] Found data:image in body (${body.length} chars), extracting...`);
      const extracted = extractDataUriImages(body);
      body = extracted.html;
      dataUriImages = extracted.images;
      logger.info(`[ActivityWriter] Extracted ${dataUriImages.length} data URI image(s)`);
    }

    // Step 2: Get storage for uploads
    let storageId = null;
    const hasCidImages = email.inlineImages && email.inlineImages.length > 0;
    const needsUpload = dataUriImages.length > 0 || hasCidImages;

    if (needsUpload) {
      try {
        const appStorage = await bx.call('disk.storage.getforapp', {});
        storageId = appStorage?.ID;
        logger.info(`[ActivityWriter] App storage ID: ${storageId}`);
      } catch (e) {
        logger.warn(`[ActivityWriter] disk.storage.getforapp failed: ${e.message}`);
      }

      if (!storageId) {
        try {
          const storages = await bx.call('disk.storage.getlist', {});
          if (storages && storages.length > 0) {
            storageId = storages[0].ID;
            logger.info(`[ActivityWriter] Using first available storage ID: ${storageId}`);
          }
        } catch (e) {
          logger.warn(`[ActivityWriter] disk.storage.getlist failed: ${e.message}`);
        }
      }
    }

    // Step 3: Upload data URI images and replace placeholders
    for (let i = 0; i < dataUriImages.length; i++) {
      const img = dataUriImages[i];
      const placeholder = `<!--IMG_PLACEHOLDER_${i + 1}-->`;
      let replaced = false;

      if (storageId) {
        try {
          const uploaded = await bx.call('disk.storage.uploadfile', {
            id: storageId,
            data: { NAME: img.name },
            fileContent: [img.name, img.data],
            generateUniqueName: true,
          });

          let downloadUrl = uploaded?.DOWNLOAD_URL;
          if (!downloadUrl && uploaded?.ID) {
            const fileInfo = await bx.call('disk.file.get', { id: uploaded.ID });
            downloadUrl = fileInfo?.DOWNLOAD_URL;
          }

          if (downloadUrl) {
            body = body.replace(placeholder, `<img src="${downloadUrl}" style="max-width:600px; width:100%; height:auto;">`);
            replaced = true;
            logger.info({ image: img.name, url: downloadUrl }, '[ActivityWriter] Uploaded data URI image');
          } else {
            logger.warn({ image: img.name, result: JSON.stringify(uploaded).substring(0, 300) }, '[ActivityWriter] No DOWNLOAD_URL');
          }
        } catch (err) {
          logger.warn(`[ActivityWriter] Upload failed for ${img.name}: ${err.message}`);
        }
      }

      if (!replaced) body = body.replace(placeholder, '');
    }

    // Step 4: Upload CID images and replace cid: references
    if (storageId && hasCidImages) {
      for (const img of email.inlineImages) {
        try {
          const uploaded = await bx.call('disk.storage.uploadfile', {
            id: storageId,
            data: { NAME: img.fileName },
            fileContent: [img.fileName, img.data],
            generateUniqueName: true,
          });

          let downloadUrl = uploaded?.DOWNLOAD_URL;
          if (!downloadUrl && uploaded?.ID) {
            const fileInfo = await bx.call('disk.file.get', { id: uploaded.ID });
            downloadUrl = fileInfo?.DOWNLOAD_URL;
          }

          if (downloadUrl) {
            const escaped = img.cid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            body = body.replace(new RegExp(`<img[^>]*src=["']cid:${escaped}["'][^>]*/?>`, 'gi'), `<img src="${downloadUrl}" style="max-width:600px; width:100%; height:auto;">`);
            logger.info({ image: img.fileName, cid: img.cid, url: downloadUrl }, '[ActivityWriter] Uploaded CID image');
          }
        } catch (err) {
          logger.warn(`[ActivityWriter] CID upload failed for ${img.fileName}: ${err.message}`);
          // Remove unresolvable CID image
          const escaped = img.cid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          body = body.replace(new RegExp(`<img[^>]*src=["']cid:${escaped}["'][^>]*/?>`, 'gi'), '');
        }
      }
    }

    // Use reply_to, fallback to fromEmail
    const replyTo = email.replyTo || email.fromEmail;
    const fromFmt = `${email.fromName} <${email.fromEmail}>`;
    const toFmt = (email.toEmails ?? []).join(', ');
    const ccFmt = (email.ccEmails ?? []).join(', ');

    const bindings = [{ OWNER_TYPE_ID: 2, OWNER_ID: dealId }];
    if (contactId) bindings.push({ OWNER_TYPE_ID: 3, OWNER_ID: contactId });

    // Create email activity
    const activityId = await bx.call('crm.activity.add', {
      fields: {
        OWNER_TYPE_ID: 2,
        OWNER_ID: dealId,
        BINDINGS: bindings,
        TYPE_ID: 4,
        PROVIDER_ID: 'CRM_EMAIL',
        PROVIDER_TYPE_ID: 'EMAIL',
        SUBJECT: email.subject || 'Sem assunto',
        DESCRIPTION: body,
        DESCRIPTION_TYPE: email.bodyHtml ? 3 : 1,
        DIRECTION: 1,
        COMPLETED: 'N',
        RESPONSIBLE_ID: tenant.bitrix_responsible_id,
        COMMUNICATIONS: [{
          VALUE: email.fromEmail,
          ENTITY_ID: contactId,
          ENTITY_TYPE_ID: 3,
          TYPE: 'EMAIL',
        }],
        SETTINGS: {
          MESSAGE_FROM: fromFmt,
          MESSAGE_TO: toFmt,
          MESSAGE_CC: ccFmt,
          MESSAGE_ID: email.messageId || '',
          MESSAGE_HEADERS: {
            'Message-Id': email.messageId || '',
            'Reply-To': replyTo,
            'From': fromFmt,
            'To': toFmt,
            'Cc': ccFmt,
          },
          EMAIL_META: {
            from: fromFmt,
            replyTo: replyTo,
            to: toFmt,
            cc: ccFmt,
          },
        },
      },
    });

    // Add timeline comment with reply-to info
    const replyLine = replyTo !== email.fromEmail
      ? `\n[b]Reply-To:[/b] ${replyTo}` : '';

    await bx.call('crm.timeline.comment.add', {
      fields: {
        ENTITY_ID: dealId,
        ENTITY_TYPE: 'deal',
        COMMENT:
          `[b]De:[/b] ${fromFmt}${replyLine}\n` +
          `[b]Para:[/b] ${toFmt}` +
          (ccFmt ? `\n[b]CC:[/b] ${ccFmt}` : '') +
          `\n\n[i]Responda para: ${replyTo}[/i]`,
      },
    });

    return activityId;
  },
};
