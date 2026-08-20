import logger from '../logger.js';

// Shared limit — also enforced by EmailPipeline when routing attachments to
// a deal file field (field_mapping.attachment_field).
export const MAX_ATTACHMENT_SIZE_BYTES = 20 * 1024 * 1024; // 20MB

/**
 * Uploads attachments as timeline comments in Bitrix24.
 * @param {import('./BitrixClient.js').BitrixClient} client - Bitrix24 API client
 * @param {number} dealId - Bitrix24 deal ID
 * @param {Array<{fileName: string, fileData: string}>} attachments - Base64-encoded attachments
 * @returns {Promise<{uploaded: number, skipped: number, failed: number, details: Array}>}
 */
export async function uploadAttachments(client, dealId, attachments) {
  const details = [];
  let uploaded = 0;
  let skipped = 0;
  let failed = 0;

  if (!attachments || attachments.length === 0) {
    return { uploaded, skipped, failed, details };
  }

  for (const att of attachments) {
    if (!att.fileData) {
      skipped++;
      details.push({ fileName: att.fileName, success: false, skipped: true, reason: 'no_data' });
      continue;
    }

    // Check size: skip if > 20MB (Req 11.4)
    const sizeBytes = Buffer.byteLength(att.fileData, 'base64');
    if (sizeBytes > MAX_ATTACHMENT_SIZE_BYTES) {
      logger.warn(`[AttachmentUploader] skipping ${att.fileName}: ${sizeBytes} bytes exceeds 20MB limit`);
      skipped++;
      details.push({ fileName: att.fileName, success: false, skipped: true, reason: 'too_large' });
      continue;
    }

    try {
      // Upload as timeline comment with base64 file (Req 11.1)
      const result = await client.call('crm.timeline.comment.add', {
        fields: {
          ENTITY_ID: dealId,
          ENTITY_TYPE: 'deal',
          COMMENT: `Anexo: ${att.fileName}`,
          FILES: {
            fileData: [att.fileName, att.fileData],
          },
        },
      });
      uploaded++;
      details.push({ fileName: att.fileName, commentId: result, success: true });
    } catch (err) {
      // Log error but continue with remaining attachments (Req 11.3)
      logger.error(`[AttachmentUploader] failed to upload ${att.fileName}: ${err.message}`);
      failed++;
      details.push({ fileName: att.fileName, success: false, error: err.message });
    }
  }

  return { uploaded, skipped, failed, details };
}
