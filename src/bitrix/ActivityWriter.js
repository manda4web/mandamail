import { BitrixClient } from './BitrixClient.js';

export const ActivityWriter = {
  async write(tenant, email, dealId, contactId) {
    const bx = new BitrixClient(tenant);
    const body = email.bodyHtml || email.bodyText || '';

    // Use reply_to, fallback to fromEmail (Req 10.3)
    const replyTo = email.replyTo || email.fromEmail;
    const fromFmt = `${email.fromName} <${email.fromEmail}>`;
    const toFmt = (email.toEmails ?? []).join(', ');
    const ccFmt = (email.ccEmails ?? []).join(', ');

    const bindings = [{ OWNER_TYPE_ID: 2, OWNER_ID: dealId }];
    if (contactId) bindings.push({ OWNER_TYPE_ID: 3, OWNER_ID: contactId });

    // Create email activity (Req 10.1)
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

    // Add timeline comment with reply-to info (Req 10.2)
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
