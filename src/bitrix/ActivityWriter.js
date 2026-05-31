import { BitrixClient } from './BitrixClient.js';
import logger from '../logger.js';

/**
 * Extracts data URI images from HTML, returning clean HTML and file data.
 * @param {string} html
 * @returns {{ html: string, images: Array<{name: string, data: string}> }}
 */
function extractDataUriImages(html) {
  if (!html) return { html: '', images: [] };

  const images = [];
  let idx = 0;

  const cleaned = html.replace(
    /<img[^>]*\ssrc\s*=\s*["'](data:([^;]+);base64,([^"']+))["'][^>]*\/?>/gi,
    (match, fullDataUri, mimeType, base64) => {
      idx++;
      const ext = (mimeType.split('/')[1] || 'png').replace(/[^a-z]/g, '');
      const name = `inline_${idx}.${ext}`;
      images.push({ name, data: base64.replace(/\s/g, '') });
      // Leave a placeholder — will be removed if upload fails
      return `<!--IMG_PLACEHOLDER_${idx}-->`;
    }
  );

  return { html: cleaned, images };
}

export const ActivityWriter = {
  async write(tenant, email, dealId, contactId, accountEmail) {
    const bx = new BitrixClient(tenant);
    let body = email.bodyHtml || email.bodyText || '';
    let inlineImages = [];

    // Extract data URI images from HTML
    if (email.bodyHtml && body.includes('data:image')) {
      const extracted = extractDataUriImages(body);
      body = extracted.html;
      inlineImages = extracted.images;
    }

    // Upload inline images to Bitrix24 and get URLs
    // Use disk.storage.getforapp to get the app's own storage
    if (inlineImages.length > 0) {
      let storageId = null;

      try {
        const appStorage = await bx.call('disk.storage.getforapp', {});
        storageId = appStorage?.ID;
      } catch (e) {
        logger.warn(`[ActivityWriter] disk.storage.getforapp failed: ${e.message}`);
      }

      // Fallback: try to get any writable storage
      if (!storageId) {
        try {
          const storages = await bx.call('disk.storage.getlist', {});
          if (storages && storages.length > 0) {
            storageId = storages[0].ID;
          }
        } catch (e) {
          logger.warn(`[ActivityWriter] disk.storage.getlist failed: ${e.message}`);
        }
      }

      for (let i = 0; i < inlineImages.length; i++) {
        const img = inlineImages[i];
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

            // If no DOWNLOAD_URL directly, try disk.file.get
            if (!downloadUrl && uploaded?.ID) {
              const fileInfo = await bx.call('disk.file.get', { id: uploaded.ID });
              downloadUrl = fileInfo?.DOWNLOAD_URL;
            }

            if (downloadUrl) {
              body = body.replace(placeholder, `<img src="${downloadUrl}" style="max-width:100%">`);
              replaced = true;
              logger.info(`[ActivityWriter] Uploaded inline image ${img.name} → ${downloadUrl}`);
            }
          } catch (err) {
            logger.warn(`[ActivityWriter] Upload failed for ${img.name}: ${err.message}`);
          }
        }

        // If upload failed, remove placeholder
        if (!replaced) {
          body = body.replace(placeholder, '');
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
