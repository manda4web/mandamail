import { EmailEventRepo } from '../db/repos/EmailEventRepo.js';
import { BitrixResultRepo } from '../db/repos/BitrixResultRepo.js';
import { RetryJobRepo } from '../db/repos/RetryJobRepo.js';
import { DedupEngine } from './DedupEngine.js';
import { FilterEngine } from './FilterEngine.js';
import { parseRaw } from '../imap/EmailParser.js';
import { ContactResolver } from '../bitrix/ContactResolver.js';
import { DealBuilder } from '../bitrix/DealBuilder.js';
import { ActivityWriter } from '../bitrix/ActivityWriter.js';
import { uploadAttachments } from '../bitrix/AttachmentUploader.js';
import { BitrixClient } from '../bitrix/BitrixClient.js';
import logger from '../logger.js';

export const EmailPipeline = {
  async process(account, parsedMail) {
    const email = parseRaw(parsedMail);

    // STEP 1: Save as RECEBIDO BEFORE any Bitrix call (Req 7.1, 7.2)
    const event = await EmailEventRepo.create({
      tenant_id: account.tenant_id,
      imap_account_id: account.id,
      message_id: email.messageId,
      from_email: email.fromEmail,
      from_name: email.fromName,
      reply_to: email.replyTo,
      subject: email.subject,
      body_html: email.bodyHtml,
      body_text: email.bodyText,
      to_emails: email.toEmails,
      cc_emails: email.ccEmails,
      attachment_count: email.attachments.length,
      received_at: email.date,
    });

    logger.info(`[Pipeline][${account.email}] RECEBIDO id=${event.id} from=${email.fromEmail}`);

    try {
      // STEP 2: Deduplication (Req 5)
      if (await DedupEngine.isDuplicate(account, email, event.id)) {
        await EmailEventRepo.setStatus(event.id, 'DUPLICADO');
        logger.info(`[Pipeline] DUPLICADO id=${event.id}`);
        return;
      }

      // STEP 3: Filtering (Req 6)
      if (FilterEngine.shouldIgnore(account, email)) {
        await EmailEventRepo.setStatus(event.id, 'IGNORADO');
        logger.info(`[Pipeline] IGNORADO id=${event.id}`);
        return;
      }

      // STEP 4: Bitrix integration (Req 7.3)
      await EmailEventRepo.setStatus(event.id, 'PROCESSANDO');
      await this._processInBitrix(account, email, event);
    } catch (err) {
      logger.error(`[Pipeline] ERRO id=${event.id}: ${err.message}`);
      await EmailEventRepo.setStatus(event.id, 'ERRO', { incrementRetry: true });

      const nextAttempt = (event.retry_count ?? 0) + 1;
      if (nextAttempt <= 5) {
        await RetryJobRepo.scheduleNext(event.id, nextAttempt, err);
        logger.info(`[Pipeline] retry scheduled: attempt ${nextAttempt} for id=${event.id}`);
      } else {
        await EmailEventRepo.setStatus(event.id, 'FALHA_DEFINITIVA');
        logger.error(`[Pipeline] FALHA_DEFINITIVA id=${event.id}`);
      }
    }
  },

  // Called by Pipeline and RetryWorker
  async _processInBitrix(account, email, event) {
    const tenant = {
      bitrix_url: account.bitrix_url,
      bitrix_webhook_token: account.bitrix_webhook_token,
      bitrix_category_id: account.bitrix_category_id,
      bitrix_stage_id: account.bitrix_stage_id,
      bitrix_responsible_id: account.bitrix_responsible_id,
    };

    const apiLog = {};

    // Contact resolution (Req 8)
    const { contactId, wasCreated } = await ContactResolver.resolve(tenant, email);
    apiLog.contact = { contactId, wasCreated };

    // Deal creation (Req 9)
    const dealId = await DealBuilder.create(tenant, email, contactId);
    apiLog.deal = { dealId };

    // Activity + timeline comment (Req 10)
    const activityId = await ActivityWriter.write(tenant, email, dealId, contactId);
    apiLog.activity = { activityId };

    // Attachments (Req 11)
    if (email.attachments && email.attachments.length > 0) {
      const bx = new BitrixClient(tenant);
      const attResults = await uploadAttachments(bx, dealId, email.attachments);
      apiLog.attachments = attResults;
    }

    // Mark success (Req 12)
    await EmailEventRepo.setStatus(event.id, 'SUCESSO');
    await BitrixResultRepo.create({
      email_event_id: event.id,
      tenant_id: account.tenant_id,
      bitrix_contact_id: contactId,
      contact_was_created: wasCreated,
      bitrix_deal_id: dealId,
      bitrix_activity_id: activityId,
      api_log: apiLog,
    });

    logger.info(`[Pipeline] SUCESSO id=${event.id} deal=${dealId} contact=${contactId}`);
  },
};
