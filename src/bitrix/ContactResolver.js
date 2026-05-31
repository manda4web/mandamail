import { BitrixClient } from './BitrixClient.js';

export const ContactResolver = {
  /**
   * Finds or creates a Bitrix24 contact by email.
   * - Searches via crm.duplicate.findbycomm (Req 8.1)
   * - Uses first contact if multiple found (Req 8.2)
   * - Creates new contact if not found (Req 8.3)
   * - Falls back to email local part when from_name is empty/null (Req 8.4)
   * - Returns contactId and wasCreated flag (Req 8.5)
   *
   * @param {Object} tenant - Tenant configuration with bitrix_url and bitrix_webhook_token
   * @param {Object} email - Email data with fromEmail and fromName fields
   * @returns {Promise<{contactId: number, wasCreated: boolean}>}
   */
  async resolve(tenant, email) {
    const bx = new BitrixClient(tenant);

    // Search for existing contact by email (Req 8.1)
    const res = await bx.call('crm.duplicate.findbycomm', {
      entity_type: 'CONTACT',
      type: 'EMAIL',
      values: [email.fromEmail],
    });

    const contacts = res?.CONTACT ?? [];
    if (contacts.length > 0) {
      // Use first contact if multiple found (Req 8.2)
      return { contactId: contacts[0], wasCreated: false };
    }

    // Contact not found — create new one (Req 8.3)
    // Use email local part as name when from_name is empty/null (Req 8.4)
    const contactName = email.fromName || email.fromEmail.split('@')[0];

    const contactId = await bx.call('crm.contact.add', {
      fields: {
        NAME: contactName,
        EMAIL: [{ VALUE: email.fromEmail, VALUE_TYPE: 'WORK' }],
      },
    });

    return { contactId, wasCreated: true };
  },
};
