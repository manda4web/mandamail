import { BitrixClient } from './BitrixClient.js';

const MAX_TITLE_LENGTH = 300;

export const DealBuilder = {
  async create(tenant, email, contactId) {
    const bx = new BitrixClient(tenant);

    // Check deal_mode: merge_by_contact = find existing deal for this contact
    if (tenant.deal_mode === 'merge_by_contact' && contactId) {
      try {
        const existingDeals = await bx.call('crm.deal.list', {
          filter: {
            CONTACT_ID: contactId,
            CATEGORY_ID: tenant.bitrix_category_id || 0,
            '!STAGE_SEMANTIC_ID': 'S', // exclude won deals
          },
          select: ['ID'],
          order: { ID: 'DESC' },
        });
        if (existingDeals && existingDeals.length > 0) {
          // Deal exists for this contact — return existing deal ID (don't create new)
          return existingDeals[0].ID;
        }
      } catch (e) {
        // If search fails, fall through to create new deal
      }
    }

    // Get field mapping from tenant config
    const mapping = tenant.field_mapping || {};

    // Deal title: email subject truncated to 300 chars, fallback to from_email
    let title = email.subject || email.fromEmail;
    if (title.length > MAX_TITLE_LENGTH) {
      title = title.substring(0, MAX_TITLE_LENGTH);
    }

    const body = email.bodyHtml || email.bodyText || '';
    const domain = email.fromEmail ? email.fromEmail.split('@')[1] || '' : '';
    const preview = (email.bodyText || '').substring(0, 200);
    const emailDate = email.date ? new Date(email.date).toISOString() : new Date().toISOString();

    // Build fields object based on mapping
    const fields = {
      STAGE_ID: tenant.bitrix_stage_id || 'NEW',
      CATEGORY_ID: tenant.bitrix_category_id || 0,
      CONTACT_IDS: [contactId],
      ASSIGNED_BY_ID: tenant.bitrix_responsible_id || 1,
    };

    // Apply mapped fields (or defaults)
    const subjectField = mapping.subject || 'TITLE';
    const bodyField = mapping.body || 'COMMENTS';
    const domainField = mapping.domain || '';
    const dateField = mapping.date || '';
    const previewField = mapping.preview || '';
    const sourceId = mapping.source_id || '';

    // Always set TITLE (required for deal)
    fields.TITLE = title;

    // Map subject to configured field (if different from TITLE)
    if (subjectField && subjectField !== 'TITLE') {
      fields[subjectField] = title;
    }

    // Map body to configured field
    if (bodyField) {
      fields[bodyField] = body;
    }

    // Map domain to configured field
    if (domainField && domain) {
      fields[domainField] = domain;
    }

    // Map date to configured field
    if (dateField && emailDate) {
      fields[dateField] = emailDate;
    }

    // Map preview to configured field
    if (previewField && preview) {
      fields[previewField] = preview;
    }

    // Set source if configured
    if (sourceId) {
      fields.SOURCE_ID = sourceId;
    }

    const dealId = await bx.call('crm.deal.add', { fields });

    // Explicitly link contact to deal (CONTACT_IDS in crm.deal.add doesn't always work)
    if (contactId) {
      try {
        await bx.call('crm.deal.contact.add', {
          id: dealId,
          fields: { CONTACT_ID: contactId },
        });
      } catch (e) {
        // Non-fatal: deal was created, contact link is a bonus
      }
    }

    return dealId;
  },
};
