import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ActivityWriter } from '../../bitrix/ActivityWriter.js';

// Mock BitrixClient
vi.mock('../../bitrix/BitrixClient.js', () => ({
  BitrixClient: vi.fn().mockImplementation(() => ({
    call: vi.fn().mockResolvedValue(42),
  })),
}));

import { BitrixClient } from '../../bitrix/BitrixClient.js';

describe('ActivityWriter', () => {
  const tenant = {
    bitrix_url: 'https://test.bitrix24.com',
    bitrix_webhook_token: 'token123',
    bitrix_responsible_id: 1,
  };

  const baseEmail = {
    fromEmail: 'sender@example.com',
    fromName: 'John Doe',
    toEmails: ['recipient@example.com'],
    ccEmails: ['cc@example.com'],
    subject: 'Test Subject',
    bodyHtml: '<p>Hello</p>',
    bodyText: 'Hello',
    replyTo: 'reply@example.com',
    messageId: '<msg-001@example.com>',
  };

  let mockCall;

  beforeEach(() => {
    vi.clearAllMocks();
    mockCall = vi.fn().mockResolvedValue(42);
    BitrixClient.mockImplementation(() => ({ call: mockCall }));
  });

  it('should create an email activity linked to the deal (Req 10.1)', async () => {
    const activityId = await ActivityWriter.write(tenant, baseEmail, 100, 200);

    expect(activityId).toBe(42);
    expect(mockCall).toHaveBeenCalledTimes(2);

    const [method, params] = mockCall.mock.calls[0];
    expect(method).toBe('crm.activity.add');
    expect(params.fields.OWNER_TYPE_ID).toBe(2);
    expect(params.fields.OWNER_ID).toBe(100);
    expect(params.fields.SUBJECT).toBe('Test Subject');
    expect(params.fields.DESCRIPTION).toBe('<p>Hello</p>');
    expect(params.fields.DESCRIPTION_TYPE).toBe(3); // HTML
    expect(params.fields.RESPONSIBLE_ID).toBe(1);
  });

  it('should add timeline comment with reply-to info (Req 10.2)', async () => {
    await ActivityWriter.write(tenant, baseEmail, 100, 200);

    const [method, params] = mockCall.mock.calls[1];
    expect(method).toBe('crm.timeline.comment.add');
    expect(params.fields.ENTITY_ID).toBe(100);
    expect(params.fields.ENTITY_TYPE).toBe('deal');
    expect(params.fields.COMMENT).toContain('reply@example.com');
    expect(params.fields.COMMENT).toContain('[b]Reply-To:[/b]');
  });

  it('should fallback to fromEmail when replyTo is absent (Req 10.3)', async () => {
    const emailNoReply = { ...baseEmail, replyTo: null };
    await ActivityWriter.write(tenant, emailNoReply, 100, 200);

    const [, activityParams] = mockCall.mock.calls[0];
    expect(activityParams.fields.SETTINGS.EMAIL_META.replyTo).toBe('sender@example.com');
    expect(activityParams.fields.SETTINGS.MESSAGE_HEADERS['Reply-To']).toBe('sender@example.com');

    const [, commentParams] = mockCall.mock.calls[1];
    expect(commentParams.fields.COMMENT).toContain('sender@example.com');
    // Should NOT show Reply-To line when replyTo equals fromEmail
    expect(commentParams.fields.COMMENT).not.toContain('[b]Reply-To:[/b]');
  });

  it('should return the activityId (Req 10.4)', async () => {
    mockCall.mockResolvedValueOnce(999);
    const activityId = await ActivityWriter.write(tenant, baseEmail, 100, 200);
    expect(activityId).toBe(999);
  });

  it('should use bodyText when bodyHtml is absent', async () => {
    const emailTextOnly = { ...baseEmail, bodyHtml: null };
    await ActivityWriter.write(tenant, emailTextOnly, 100, 200);

    const [, params] = mockCall.mock.calls[0];
    expect(params.fields.DESCRIPTION).toBe('Hello');
    expect(params.fields.DESCRIPTION_TYPE).toBe(1); // plain text
  });

  it('should use "Sem assunto" when subject is empty', async () => {
    const emailNoSubject = { ...baseEmail, subject: '' };
    await ActivityWriter.write(tenant, emailNoSubject, 100, 200);

    const [, params] = mockCall.mock.calls[0];
    expect(params.fields.SUBJECT).toBe('Sem assunto');
  });

  it('should include contact binding when contactId is provided', async () => {
    await ActivityWriter.write(tenant, baseEmail, 100, 200);

    const [, params] = mockCall.mock.calls[0];
    expect(params.fields.BINDINGS).toEqual([
      { OWNER_TYPE_ID: 2, OWNER_ID: 100 },
      { OWNER_TYPE_ID: 3, OWNER_ID: 200 },
    ]);
  });

  it('should not include contact binding when contactId is falsy', async () => {
    await ActivityWriter.write(tenant, baseEmail, 100, null);

    const [, params] = mockCall.mock.calls[0];
    expect(params.fields.BINDINGS).toEqual([
      { OWNER_TYPE_ID: 2, OWNER_ID: 100 },
    ]);
  });

  it('should handle empty toEmails and ccEmails', async () => {
    const emailNoRecipients = { ...baseEmail, toEmails: [], ccEmails: [] };
    await ActivityWriter.write(tenant, emailNoRecipients, 100, 200);

    const [, params] = mockCall.mock.calls[0];
    expect(params.fields.SETTINGS.MESSAGE_TO).toBe('');
    expect(params.fields.SETTINGS.MESSAGE_CC).toBe('');
  });
});
