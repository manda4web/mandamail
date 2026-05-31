import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ContactResolver } from '../../bitrix/ContactResolver.js';

// Mock the BitrixClient module
vi.mock('../../bitrix/BitrixClient.js', () => {
  return {
    BitrixClient: vi.fn(),
  };
});

import { BitrixClient } from '../../bitrix/BitrixClient.js';

describe('ContactResolver', () => {
  let mockCall;
  const tenant = {
    bitrix_url: 'https://example.bitrix24.com/rest/1/abc123',
    bitrix_webhook_token: 'abc123',
  };

  beforeEach(() => {
    mockCall = vi.fn();
    BitrixClient.mockImplementation(() => ({ call: mockCall }));
  });

  describe('resolve - existing contact found (Req 8.1, 8.2)', () => {
    it('returns existing contact when found by email', async () => {
      mockCall.mockResolvedValueOnce({ CONTACT: [42] });

      const result = await ContactResolver.resolve(tenant, {
        fromEmail: 'john@example.com',
        fromName: 'John Doe',
      });

      expect(result).toEqual({ contactId: 42, wasCreated: false });
      expect(mockCall).toHaveBeenCalledWith('crm.duplicate.findbycomm', {
        entity_type: 'CONTACT',
        type: 'EMAIL',
        values: ['john@example.com'],
      });
    });

    it('uses first contact when multiple are found (Req 8.2)', async () => {
      mockCall.mockResolvedValueOnce({ CONTACT: [10, 20, 30] });

      const result = await ContactResolver.resolve(tenant, {
        fromEmail: 'multi@example.com',
        fromName: 'Multi User',
      });

      expect(result).toEqual({ contactId: 10, wasCreated: false });
    });
  });

  describe('resolve - no contact found, creates new (Req 8.3)', () => {
    it('creates a new contact with name and email', async () => {
      mockCall
        .mockResolvedValueOnce({ CONTACT: [] }) // findbycomm returns empty
        .mockResolvedValueOnce(99); // crm.contact.add returns new ID

      const result = await ContactResolver.resolve(tenant, {
        fromEmail: 'new@example.com',
        fromName: 'New User',
      });

      expect(result).toEqual({ contactId: 99, wasCreated: true });
      expect(mockCall).toHaveBeenCalledWith('crm.contact.add', {
        fields: {
          NAME: 'New User',
          EMAIL: [{ VALUE: 'new@example.com', VALUE_TYPE: 'WORK' }],
        },
      });
    });

    it('creates contact when findbycomm returns null CONTACT', async () => {
      mockCall
        .mockResolvedValueOnce({}) // no CONTACT key
        .mockResolvedValueOnce(55);

      const result = await ContactResolver.resolve(tenant, {
        fromEmail: 'test@example.com',
        fromName: 'Test',
      });

      expect(result).toEqual({ contactId: 55, wasCreated: true });
    });

    it('creates contact when findbycomm returns null result', async () => {
      mockCall
        .mockResolvedValueOnce(null) // null response
        .mockResolvedValueOnce(77);

      const result = await ContactResolver.resolve(tenant, {
        fromEmail: 'null@example.com',
        fromName: 'Null Test',
      });

      expect(result).toEqual({ contactId: 77, wasCreated: true });
    });
  });

  describe('resolve - name fallback to email local part (Req 8.4)', () => {
    it('uses email local part when fromName is null', async () => {
      mockCall
        .mockResolvedValueOnce({ CONTACT: [] })
        .mockResolvedValueOnce(101);

      const result = await ContactResolver.resolve(tenant, {
        fromEmail: 'jane.doe@company.com',
        fromName: null,
      });

      expect(result).toEqual({ contactId: 101, wasCreated: true });
      expect(mockCall).toHaveBeenCalledWith('crm.contact.add', {
        fields: {
          NAME: 'jane.doe',
          EMAIL: [{ VALUE: 'jane.doe@company.com', VALUE_TYPE: 'WORK' }],
        },
      });
    });

    it('uses email local part when fromName is empty string', async () => {
      mockCall
        .mockResolvedValueOnce({ CONTACT: [] })
        .mockResolvedValueOnce(102);

      const result = await ContactResolver.resolve(tenant, {
        fromEmail: 'bob@domain.org',
        fromName: '',
      });

      expect(result).toEqual({ contactId: 102, wasCreated: true });
      expect(mockCall).toHaveBeenCalledWith('crm.contact.add', {
        fields: {
          NAME: 'bob',
          EMAIL: [{ VALUE: 'bob@domain.org', VALUE_TYPE: 'WORK' }],
        },
      });
    });

    it('uses email local part when fromName is undefined', async () => {
      mockCall
        .mockResolvedValueOnce({ CONTACT: [] })
        .mockResolvedValueOnce(103);

      const result = await ContactResolver.resolve(tenant, {
        fromEmail: 'admin@server.net',
      });

      expect(result).toEqual({ contactId: 103, wasCreated: true });
      expect(mockCall).toHaveBeenCalledWith('crm.contact.add', {
        fields: {
          NAME: 'admin',
          EMAIL: [{ VALUE: 'admin@server.net', VALUE_TYPE: 'WORK' }],
        },
      });
    });
  });

  describe('resolve - records wasCreated flag (Req 8.5)', () => {
    it('returns wasCreated: false when contact exists', async () => {
      mockCall.mockResolvedValueOnce({ CONTACT: [1] });

      const result = await ContactResolver.resolve(tenant, {
        fromEmail: 'existing@test.com',
        fromName: 'Existing',
      });

      expect(result.wasCreated).toBe(false);
    });

    it('returns wasCreated: true when contact is created', async () => {
      mockCall
        .mockResolvedValueOnce({ CONTACT: [] })
        .mockResolvedValueOnce(200);

      const result = await ContactResolver.resolve(tenant, {
        fromEmail: 'new@test.com',
        fromName: 'New',
      });

      expect(result.wasCreated).toBe(true);
    });
  });
});
