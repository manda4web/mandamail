import { describe, it, expect, vi, beforeEach } from 'vitest';

// Regression tests for the deal-duplication bug (reprocess/retry creating a
// second deal). The fix lives in EmailPipeline._processInBitrix: bitrix_results
// is written right after the deal is created, and a prior row makes retries
// reuse the deal/contact/activity and skip already-uploaded attachments.

vi.mock('../../db/repos/EmailEventRepo.js', () => ({
  EmailEventRepo: { create: vi.fn(), setStatus: vi.fn() },
}));
vi.mock('../../db/repos/BitrixResultRepo.js', () => ({
  BitrixResultRepo: { findByEventId: vi.fn(), upsert: vi.fn(), setActivity: vi.fn(), setAttachmentsMarker: vi.fn() },
}));
vi.mock('../../db/repos/RetryJobRepo.js', () => ({
  RetryJobRepo: { scheduleNext: vi.fn() },
}));
vi.mock('../../db/repos/SubscriptionRepo.js', () => ({
  SubscriptionRepo: { checkAccess: vi.fn().mockResolvedValue({ allowed: true }) },
}));
vi.mock('../../pipeline/DedupEngine.js', () => ({ DedupEngine: { isDuplicate: vi.fn() } }));
vi.mock('../../pipeline/FilterEngine.js', () => ({ FilterEngine: { shouldIgnore: vi.fn() } }));
vi.mock('../../imap/EmailParser.js', () => ({ parseRaw: vi.fn() }));
vi.mock('../../imap/OlxParser.js', () => ({ parseOlxLead: vi.fn(), applyOlxLead: vi.fn() }));
vi.mock('../../bitrix/ContactResolver.js', () => ({ ContactResolver: { resolve: vi.fn() } }));
vi.mock('../../bitrix/DealBuilder.js', () => ({ DealBuilder: { create: vi.fn() } }));
vi.mock('../../bitrix/ActivityWriter.js', () => ({ ActivityWriter: { write: vi.fn() } }));
vi.mock('../../bitrix/AttachmentUploader.js', () => ({
  uploadAttachments: vi.fn(),
  MAX_ATTACHMENT_SIZE_BYTES: 20 * 1024 * 1024,
}));
vi.mock('../../bitrix/BitrixClient.js', () => ({
  BitrixClient: vi.fn().mockImplementation(() => ({ call: vi.fn() })),
}));
vi.mock('../../logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { EmailPipeline } from '../../pipeline/EmailPipeline.js';
import { EmailEventRepo } from '../../db/repos/EmailEventRepo.js';
import { BitrixResultRepo } from '../../db/repos/BitrixResultRepo.js';
import { ContactResolver } from '../../bitrix/ContactResolver.js';
import { DealBuilder } from '../../bitrix/DealBuilder.js';
import { ActivityWriter } from '../../bitrix/ActivityWriter.js';
import { uploadAttachments } from '../../bitrix/AttachmentUploader.js';

const account = {
  id: 'acc-1',
  tenant_id: 'tenant-1',
  email: 'inbox@empresa.com.br',
  bitrix_url: 'https://test.bitrix24.com.br',
  bitrix_category_id: 9,
  bitrix_stage_id: 'C9:NEW',
  bitrix_responsible_id: 1,
  field_mapping: {},
  deal_mode: 'create_new',
  parser_type: 'standard',
};

const email = {
  messageId: '<1@test>',
  fromEmail: 'client@x.com',
  fromName: 'Client',
  subject: 'Orçamento',
  bodyHtml: '<p>hi</p>',
  bodyText: 'hi',
  attachments: [{ fileName: 'doc.pdf', fileData: 'AAAA' }],
  toEmails: [],
  ccEmails: [],
};

const event = { id: 'event-1', tenant_id: 'tenant-1', retry_count: 0 };

describe('EmailPipeline._processInBitrix — idempotency (deal duplication regression)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ContactResolver.resolve.mockResolvedValue({ contactId: 111, wasCreated: true });
    DealBuilder.create.mockResolvedValue(222);
    ActivityWriter.write.mockResolvedValue(333);
    uploadAttachments.mockResolvedValue({ uploaded: 1, skipped: 0, failed: 0 });
    EmailEventRepo.setStatus.mockResolvedValue({});
    BitrixResultRepo.upsert.mockResolvedValue({});
    BitrixResultRepo.setActivity.mockResolvedValue({});
  });

  it('first run: creates contact/deal/activity AND persists the deal reference immediately after creation', async () => {
    BitrixResultRepo.findByEventId.mockResolvedValue(null); // no prior run

    await EmailPipeline._processInBitrix(account, email, event);

    expect(ContactResolver.resolve).toHaveBeenCalledTimes(1);
    expect(ActivityWriter.write).toHaveBeenCalledTimes(1);
    expect(uploadAttachments).toHaveBeenCalledTimes(1);

    // The early upsert (deal persisted right after creation) must happen
    // BEFORE the activity step — a crash after deal.add must not orphan it.
    const earlyUpsert = BitrixResultRepo.upsert.mock.calls.find(
      ([d]) => d.bitrix_activity_id === null
    );
    expect(earlyUpsert).toBeDefined();
    expect(earlyUpsert[0]).toMatchObject({
      email_event_id: 'event-1',
      bitrix_deal_id: 222,
      bitrix_contact_id: 111,
      bitrix_activity_id: null,
    });
    // Final upsert carries the full api_log with the attachments marker
    const finalUpsert = BitrixResultRepo.upsert.mock.calls.at(-1)[0];
    expect(finalUpsert.api_log.attachments).toBeDefined();
    expect(EmailEventRepo.setStatus).toHaveBeenCalledWith('event-1', 'SUCESSO');
  });

  it('retry after partial failure (deal persisted, activity missing): reuses the deal, completes only the activity', async () => {
    BitrixResultRepo.findByEventId.mockResolvedValue({
      bitrix_deal_id: 222,
      bitrix_contact_id: 111,
      contact_was_created: true,
      bitrix_activity_id: null,
      api_log: {},
    });

    await EmailPipeline._processInBitrix(account, email, event);

    // THE regression: no second deal for the same email
    expect(DealBuilder.create).not.toHaveBeenCalled();
    expect(ContactResolver.resolve).not.toHaveBeenCalled();
    expect(ActivityWriter.write).toHaveBeenCalledWith(
      expect.anything(), email, 222, 111, account.email, expect.anything()
    );
    expect(BitrixResultRepo.setActivity).toHaveBeenCalledWith('event-1', 333);
  });

  it('reprocess of a fully successful event: total no-op (skips deal, activity AND attachments)', async () => {
    BitrixResultRepo.findByEventId.mockResolvedValue({
      bitrix_deal_id: 222,
      bitrix_contact_id: 111,
      contact_was_created: true,
      bitrix_activity_id: 333,
      api_log: { attachments: { uploaded: 1 } }, // attachments already done
    });

    await EmailPipeline._processInBitrix(account, email, event);

    expect(DealBuilder.create).not.toHaveBeenCalled();
    expect(ContactResolver.resolve).not.toHaveBeenCalled();
    expect(ActivityWriter.write).not.toHaveBeenCalled();
    expect(uploadAttachments).not.toHaveBeenCalled();
    expect(EmailEventRepo.setStatus).toHaveBeenCalledWith('event-1', 'SUCESSO');
  });

  it('prior without attachments marker re-runs the attachments step', async () => {
    BitrixResultRepo.findByEventId.mockResolvedValue({
      bitrix_deal_id: 222,
      bitrix_contact_id: 111,
      contact_was_created: false,
      bitrix_activity_id: 333,
      api_log: {}, // deal+activity done, attachments never completed
    });

    await EmailPipeline._processInBitrix(account, email, event);

    expect(uploadAttachments).toHaveBeenCalledTimes(1);
    expect(ActivityWriter.write).not.toHaveBeenCalled();
  });

  it('attachments marker survives successive reprocesses (stateful upsert, no re-send on 2nd click)', async () => {
    // Stateful mock replicating the real upsert semantics (api_log replaced
    // entirely) — regression for the marker-erosion bug where the first
    // reprocess was a no-op but silently dropped api_log.attachments, so the
    // SECOND reprocess re-uploaded everything.
    let row = null;
    BitrixResultRepo.findByEventId.mockImplementation(async () => row);
    BitrixResultRepo.upsert.mockImplementation(async (d) => {
      row = { ...row, ...d, api_log: d.api_log || {} };
      return row;
    });
    BitrixResultRepo.setActivity.mockImplementation(async (_id, activityId) => {
      row = { ...row, bitrix_activity_id: activityId };
      return row;
    });
    BitrixResultRepo.setAttachmentsMarker.mockImplementation(async (_id, att) => {
      row = { ...row, api_log: { ...(row?.api_log || {}), attachments: att } };
      return row;
    });

    // Run 1: fresh processing — uploads attachments, persists the marker
    await EmailPipeline._processInBitrix(account, email, event);
    expect(uploadAttachments).toHaveBeenCalledTimes(1);
    expect(row.api_log.attachments).toBeDefined();

    // Reprocess #1: full no-op (marker preserved through the final upsert)
    await EmailPipeline._processInBitrix(account, email, event);
    expect(uploadAttachments).toHaveBeenCalledTimes(1); // still one
    expect(row.api_log.attachments).toBeDefined(); // THE regression: marker must survive

    // Reprocess #2: still a no-op
    await EmailPipeline._processInBitrix(account, email, event);
    expect(uploadAttachments).toHaveBeenCalledTimes(1);
    expect(row.api_log.attachments).toBeDefined();
  });
});
