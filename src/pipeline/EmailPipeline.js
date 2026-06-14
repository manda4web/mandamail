import { EmailEventRepo } from '../db/repos/EmailEventRepo.js';
import { BitrixResultRepo } from '../db/repos/BitrixResultRepo.js';
import { RetryJobRepo } from '../db/repos/RetryJobRepo.js';
import { SubscriptionRepo } from '../db/repos/SubscriptionRepo.js';
import { db } from '../db/client.js';
import { DedupEngine } from './DedupEngine.js';
import { FilterEngine } from './FilterEngine.js';
import { parseRaw } from '../imap/EmailParser.js';
import { parseOlxLead, applyOlxLead } from '../imap/OlxParser.js';
import { ContactResolver } from '../bitrix/ContactResolver.js';
import { DealBuilder } from '../bitrix/DealBuilder.js';
import { ActivityWriter } from '../bitrix/ActivityWriter.js';
import { uploadAttachments } from '../bitrix/AttachmentUploader.js';
import { BitrixClient } from '../bitrix/BitrixClient.js';
import logger from '../logger.js';

export const EmailPipeline = {
  async process(account, parsedMail) {
    // STEP 0: Verify active plan before any processing
    try {
      const access = await SubscriptionRepo.checkAccess(account.tenant_id);
      if (!access.allowed) {
        logger.warn(`[Pipeline][${account.email}] PLANO_INATIVO tenant=${account.tenant_id} reason=${access.reason}`);
        // Save event with PLANO_INATIVO status (no further processing)
        const email = parseRaw(parsedMail);
        await EmailEventRepo.create({
          tenant_id: account.tenant_id,
          imap_account_id: account.id,
          message_id: email.messageId,
          from_email: email.fromEmail,
          from_name: email.fromName,
          subject: email.subject,
          body_text: email.bodyText,
          to_emails: email.toEmails,
          received_at: email.date,
          status: 'PLANO_INATIVO',
        });
        return;
      }
    } catch (err) {
      logger.error(`[Pipeline][${account.email}] Subscription check failed: ${err.message}`);
      // On DB error, reject and let retry handle it
      throw err;
    }

    const email = parseRaw(parsedMail);

    // STEP 1: Save as RECEBIDO BEFORE any Bitrix call (Req 7.1, 7.2)
    // Truncate body_html for DB storage (images are processed by ActivityWriter, not stored)
    const bodyHtmlForDb = email.bodyHtml && email.bodyHtml.length > 500_000
      ? email.bodyHtml.substring(0, 500_000)
      : email.bodyHtml;

    const event = await EmailEventRepo.create({
      tenant_id: account.tenant_id,
      imap_account_id: account.id,
      message_id: email.messageId,
      from_email: email.fromEmail,
      from_name: email.fromName,
      reply_to: email.replyTo,
      subject: email.subject,
      body_html: bodyHtmlForDb,
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

      // STEP 2.5: Check if this email already generated a deal previously.
      // Prevents re-creating deals on IMAP reconnections or re-fetches.
      // Only manual "Reprocess" from logs should create a new deal.
      if (email.messageId) {
        const alreadyProcessed = await BitrixResultRepo.existsByMessageId(account.id, email.messageId, event.id);
        if (alreadyProcessed) {
          await EmailEventRepo.setStatus(event.id, 'DUPLICADO');
          logger.info(`[Pipeline] DUPLICADO (deal já criado anteriormente) id=${event.id} messageId=${email.messageId}`);
          return;
        }
      }

      // STEP 3: Filtering (Req 6)
      if (FilterEngine.shouldIgnore(account, email)) {
        await EmailEventRepo.setStatus(event.id, 'IGNORADO');
        logger.info(`[Pipeline] IGNORADO id=${event.id}`);
        return;
      }

      // STEP 3.5: Check sync_start_date — ignore emails before configured date
      if (account.sync_start_date) {
        const syncDate = new Date(account.sync_start_date);
        const emailDate = new Date(email.date || event.received_at);
        if (emailDate < syncDate) {
          await EmailEventRepo.setStatus(event.id, 'IGNORADO');
          logger.info(`[Pipeline] IGNORADO (antes de sync_start_date) id=${event.id}`);
          return;
        }
      }

      // STEP 4: Validate required mapping fields before Bitrix integration
      if (!account.bitrix_category_id && account.bitrix_category_id !== 0) {
        logger.error(`[Pipeline] Missing required mapping (bitrix_category_id) for account=${account.id}`);
        await EmailEventRepo.setStatus(event.id, 'ERRO');
        return;
      }
      if (!account.bitrix_stage_id) {
        logger.error(`[Pipeline] Missing required mapping (bitrix_stage_id) for account=${account.id}`);
        await EmailEventRepo.setStatus(event.id, 'ERRO');
        return;
      }

      // STEP 5: Bitrix integration (Req 7.3)
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
    // OLX parser: when this account is an OLX lead inbox, extract the real
    // customer data from the email body. Standard accounts are untouched.
    if (account.parser_type === 'olx') {
      const lead = parseOlxLead(email);
      if (lead) {
        email = applyOlxLead(email, lead);
        logger.info(`[Pipeline][OLX] lead extracted: ${email.fromName} <${email.fromEmail}> phone=${lead.phone || '-'} ad=${lead.adTitle || '-'}`);
      } else {
        logger.warn(`[Pipeline][OLX] could not parse OLX lead for event=${event.id}, falling back to standard`);
      }
    }

    const tenant = {
      bitrix_url: account.bitrix_url,
      bitrix_webhook_token: account.bitrix_webhook_token,
      bitrix_category_id: account.bitrix_category_id,
      bitrix_stage_id: account.bitrix_stage_id,
      bitrix_responsible_id: account.bitrix_responsible_id,
      auth_id: account.auth_id,
      refresh_id: account.refresh_id,
      field_mapping: account.field_mapping,
      deal_mode: account.deal_mode,
    };

    const apiLog = {};

    // Contact resolution (Req 8)
    const { contactId, wasCreated } = await ContactResolver.resolve(tenant, email);
    apiLog.contact = { contactId, wasCreated };

    // Deal creation (Req 9)
    const dealId = await DealBuilder.create(tenant, email, contactId);
    apiLog.deal = { dealId };

    // Activity + timeline comment (Req 10)
    const activityId = await ActivityWriter.write(tenant, email, dealId, contactId, account.email);
    apiLog.activity = { activityId };

    // Attachments (Req 11)
    if (email.attachments && email.attachments.length > 0) {
      const bx = new BitrixClient(tenant);
      const attResults = await uploadAttachments(bx, dealId, email.attachments);
      apiLog.attachments = attResults;
    }

    // Mark success (Req 12)
    await EmailEventRepo.setStatus(event.id, 'SUCESSO');

    // Delete old bitrix_result if exists (for reprocessing)
    await db.query('DELETE FROM bitrix_results WHERE email_event_id = $1', [event.id]);

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
