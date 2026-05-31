import { BitrixClient } from './BitrixClient.js';

const MAX_TITLE_LENGTH = 300;

export const DealBuilder = {
  async create(tenant, email, contactId) {
    const bx = new BitrixClient(tenant);

    // Deal title: email subject truncated to 300 chars, fallback to from_email (Req 9.3, 9.4)
    let title = email.subject || email.fromEmail;
    if (title.length > MAX_TITLE_LENGTH) {
      title = title.substring(0, MAX_TITLE_LENGTH);
    }

    const body = email.bodyHtml || email.bodyText || '';

    const dealId = await bx.call('crm.deal.add', {
      fields: {
        TITLE: title,
        STAGE_ID: tenant.bitrix_stage_id,
        CATEGORY_ID: tenant.bitrix_category_id,
        CONTACT_IDS: [contactId],
        COMMENTS: body,
        ASSIGNED_BY_ID: tenant.bitrix_responsible_id,
      },
    });

    return dealId;
  },
};
