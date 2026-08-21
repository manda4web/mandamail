import { EmailEventRepo } from '../db/repos/EmailEventRepo.js';
import { BitrixResultRepo } from '../db/repos/BitrixResultRepo.js';
import { RetryJobRepo } from '../db/repos/RetryJobRepo.js';
import { SubscriptionRepo } from '../db/repos/SubscriptionRepo.js';
import { DedupEngine } from './DedupEngine.js';
import { FilterEngine } from './FilterEngine.js';
import { parseRaw } from '../imap/EmailParser.js';
import { parseOlxLead, applyOlxLead } from '../imap/OlxParser.js';
import { ContactResolver } from '../bitrix/ContactResolver.js';
import { DealBuilder } from '../bitrix/DealBuilder.js';
import { ActivityWriter } from '../bitrix/ActivityWriter.js';
import { uploadAttachments, MAX_ATTACHMENT_SIZE_BYTES } from '../bitrix/AttachmentUploader.js';
import { BitrixClient } from '../bitrix/BitrixClient.js';
import { RoutingRuleRepo } from '../db/repos/RoutingRuleRepo.js';
import { matchRoutingRule } from './RoutingEngine.js';
import logger from '../logger.js';

export const EmailPipeline = {
  async process(account, parsedMail) {
    // STEP 0: Verify active plan AND monthly email quota before any processing
    try {
      const access = await SubscriptionRepo.checkAccess(account.tenant_id);
      const quota = await SubscriptionRepo.checkQuota(account.tenant_id);
      if (!access.allowed || !quota.allowed) {
        const reason = !access.allowed ? access.reason : quota.reason;
        logger.warn(`[Pipeline][${account.email}] PLANO_INATIVO tenant=${account.tenant_id} reason=${reason}`);
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
      // On a transient DB error during the subscription check, DO NOT drop the
      // email (it was already marked \Seen in IMAP and would be lost). Fail open:
      // log and continue processing so a paying customer's lead is never lost.
      logger.error(`[Pipeline][${account.email}] Subscription check failed (proceeding to avoid lead loss): ${err.message}`);
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
      // (Reprocessing the SAME event also reuses the deal — see the
      // idempotency logic in _processInBitrix.)
      if (email.messageId) {
        const alreadyProcessed = await BitrixResultRepo.existsByMessageId(account.id, email.messageId, event.id);
        if (alreadyProcessed) {
          await EmailEventRepo.setStatus(event.id, 'DUPLICADO');
          logger.info(`[Pipeline] DUPLICADO (deal já criado anteriormente) id=${event.id} messageId=${email.messageId}`);
          return;
        }
      }

      // STEP 3: Filtering (Req 6)
      // OLX accounts always receive from noreply@olx.com.br, which the global
      // filter would block — skip sender/subject filtering for OLX parsers.
      if (account.parser_type !== 'olx' && FilterEngine.shouldIgnore(account, email)) {
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

  // Called by Pipeline, RetryWorker and the manual Reprocess route
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

    // Routing rules: the first active rule matching the sender overrides the
    // account mapping (category/stage/responsible). Runs AFTER the OLX block
    // so rules match the rewritten customer address, not noreply@olx.com.br.
    // Fail-open: a DB error here must never lose the lead — proceed with the
    // account mapping (no rules).
    let routingRule = null;
    try {
      const routingRules = await RoutingRuleRepo.findActiveByTenant(account.tenant_id);
      routingRule = matchRoutingRule(routingRules, email.fromEmail);
    } catch (err) {
      logger.warn(`[Pipeline][${account.email}] routing rules unavailable, proceeding with account mapping: ${err.message}`);
    }

    const tenant = {
      id: account.tenant_id, // lets BitrixClient persist refreshed tokens by tenant id
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

    if (routingRule) {
      // Loose != null on purpose: bitrix_category_id 0 is a LEGITIMATE override
      // (force the deal into the default pipeline) and must not be confused
      // with null (= "no override", keep the account value).
      if (routingRule.bitrix_category_id != null) {
        tenant.bitrix_category_id = routingRule.bitrix_category_id;
        // A rule that changes the funnel without setting a stage leaves the
        // account stage foreign to the target funnel. crm.deal.* anchors on
        // CATEGORY_ID and silently ignores a foreign STAGE_ID — we drop it so
        // the deal (and its audit trail) is born on the target funnel's first
        // stage instead of claiming a stage it will not get.
        if (routingRule.bitrix_stage_id == null) tenant.bitrix_stage_id = null;
      }
      if (routingRule.bitrix_stage_id != null) tenant.bitrix_stage_id = routingRule.bitrix_stage_id;
      if (routingRule.bitrix_responsible_id != null) tenant.bitrix_responsible_id = routingRule.bitrix_responsible_id;
      logger.info(`[Pipeline][${account.email}] routing rule ${routingRule.id} (${routingRule.match_type}:${routingRule.match_value}) applied: category=${tenant.bitrix_category_id} stage=${tenant.bitrix_stage_id} responsible=${tenant.bitrix_responsible_id}`);
    }

    const apiLog = {};
    if (routingRule) {
      // Audit trail: which rule shaped this deal. The final upsert persists
      // the whole apiLog — nothing else needs to change for this to be saved.
      apiLog.routing_rule = {
        id: routingRule.id,
        name: routingRule.name ?? null,
        match_type: routingRule.match_type,
        match_value: routingRule.match_value,
        category_id: routingRule.bitrix_category_id ?? null,
        stage_id: routingRule.bitrix_stage_id ?? null,
        responsible_id: routingRule.bitrix_responsible_id ?? null,
        applied: true,
      };
    }

    // One shared client for the whole processing — all steps see the same
    // OAuth token and a refresh (single-flight per tenant) applies to all.
    const bx = new BitrixClient(tenant);

    // Idempotency: a bitrix_results row is written RIGHT AFTER the deal is
    // created (see below), so if the run fails on any later step (activity,
    // attachments, DB) the retry/reprocess finds the existing deal and
    // completes only the missing steps — never a duplicate deal.
    const prior = await BitrixResultRepo.findByEventId(event.id);

    let contactId;
    let wasCreated = false;
    let dealId;
    let activityId;
    let attachmentsDone = false;

    if (prior && prior.bitrix_deal_id) {
      contactId = prior.bitrix_contact_id;
      wasCreated = prior.contact_was_created;
      dealId = prior.bitrix_deal_id;
      activityId = prior.bitrix_activity_id ?? null;
      // api_log.attachments is the marker that the attachments step already
      // completed for this deal — re-running it would duplicate files/comments.
      attachmentsDone = !!(prior.api_log && prior.api_log.attachments);
      apiLog.reused = { dealId, contactId, activityId };
      apiLog.contact = { contactId, wasCreated };
      apiLog.deal = { dealId };
      if (activityId) apiLog.activity = { activityId };
      // Carry the marker into the FINAL upsert — it replaces api_log entirely,
      // so dropping it here would make the NEXT reprocess re-send attachments.
      if (attachmentsDone) apiLog.attachments = prior.api_log.attachments;
      // Audit truth on a reused deal: the CURRENT rule match shaped nothing —
      // the deal already exists and is not moved. Keep the record from the run
      // that created it when we have it; otherwise mark the current match as
      // not applied so the trail never claims a routing that did not happen.
      if (prior.api_log && prior.api_log.routing_rule) {
        apiLog.routing_rule = prior.api_log.routing_rule;
      } else if (apiLog.routing_rule) {
        apiLog.routing_rule.applied = false;
      }
      logger.info(`[Pipeline] reutilizando deal=${dealId} do processamento anterior (id=${event.id})`);
    } else {
      // Contact resolution (Req 8)
      const resolved = await ContactResolver.resolve(tenant, email, bx);
      contactId = resolved.contactId;
      wasCreated = resolved.wasCreated;
      apiLog.contact = { contactId, wasCreated };

      // Deal creation (Req 9)
      dealId = await DealBuilder.create(tenant, email, contactId, bx);
      apiLog.deal = { dealId };

      // Persist the deal reference IMMEDIATELY — if anything fails from here
      // on, the retry must reuse this deal instead of creating another one.
      await BitrixResultRepo.upsert({
        email_event_id: event.id,
        tenant_id: account.tenant_id,
        bitrix_contact_id: contactId,
        contact_was_created: wasCreated,
        bitrix_deal_id: dealId,
        bitrix_activity_id: null,
        api_log: {},
      });

      activityId = null;
    }

    // Activity + timeline comment (Req 10) — skipped when a previous run
    // already created it (retries would duplicate the timeline entry).
    if (!activityId) {
      activityId = await ActivityWriter.write(tenant, email, dealId, contactId, account.email, bx);
      apiLog.activity = { activityId };
      await BitrixResultRepo.setActivity(event.id, activityId);
    }

    // Attachments (Req 11). Includes files pasted into the body (data: URIs),
    // which the parser now exposes as real attachments. Skipped when a
    // previous run already uploaded them (api_log.attachments marker) —
    // re-running would duplicate files in the deal field / timeline comments.
    if (!attachmentsDone && email.attachments && email.attachments.length > 0) {
      const attachmentField = tenant.field_mapping && tenant.field_mapping.attachment_field;

      if (attachmentField) {
        // Route attachments into a configured deal file field (UF_CRM_*),
        // preserving any files already present on the deal.
        try {
          const files = [];
          let skippedLarge = 0;
          for (const att of email.attachments) {
            if (!att.fileData) continue;
            // Same 20MB limit as the timeline route — a huge base64 payload
            // would blow up crm.deal.update.
            if (Buffer.byteLength(att.fileData, 'base64') > MAX_ATTACHMENT_SIZE_BYTES) {
              skippedLarge++;
              logger.warn(`[Pipeline] skipping ${att.fileName}: exceeds 20MB limit (campo ${attachmentField})`);
              continue;
            }
            files.push({ fileData: [att.fileName, att.fileData] });
          }

          if (files.length > 0) {
            let existing = [];
            try {
              const deal = await bx.call('crm.deal.get', { id: dealId });
              const cur = deal ? deal[attachmentField] : null;
              if (Array.isArray(cur)) existing = cur.map(f => f.id || f.ID).filter(Boolean);
            } catch { /* new deal or unreadable — start fresh */ }

            const fieldsUpd = {};
            fieldsUpd[attachmentField] = [...existing, ...files];
            await bx.call('crm.deal.update', { id: dealId, fields: fieldsUpd });
            apiLog.attachments = { field: attachmentField, added: files.length, kept: existing.length, skipped_too_large: skippedLarge };
            logger.info(`[Pipeline] ${files.length} anexo(s) enviados ao campo ${attachmentField} do deal ${dealId}`);
          } else if (skippedLarge > 0) {
            apiLog.attachments = { field: attachmentField, added: 0, skipped_too_large: skippedLarge };
          }
        } catch (err) {
          logger.warn(`[Pipeline] falha ao anexar no campo ${attachmentField}, usando timeline: ${err.message}`);
          apiLog.attachments = await uploadAttachments(bx, dealId, email.attachments);
        }
      } else {
        const attResults = await uploadAttachments(bx, dealId, email.attachments);
        apiLog.attachments = attResults;
      }

      // Persist the attachments marker IMMEDIATELY (like setActivity): if a
      // later write fails and a retry runs, it must see that attachments
      // were already uploaded instead of duplicating them.
      if (apiLog.attachments) {
        await BitrixResultRepo.setAttachmentsMarker(event.id, apiLog.attachments);
      }
    }

    // Mark success (Req 12)
    await EmailEventRepo.setStatus(event.id, 'SUCESSO');

    // Final write — atomic upsert (no DELETE window) with the full api_log,
    // including the attachments marker that makes future reprocesses no-ops.
    await BitrixResultRepo.upsert({
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
