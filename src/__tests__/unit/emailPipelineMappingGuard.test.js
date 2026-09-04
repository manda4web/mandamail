import { describe, it, expect, vi, beforeEach } from 'vitest';

// The required-mapping guard lives in EmailPipeline._processInBitrix (not in
// process()), so it is enforced identically on the first run, on RetryWorker
// retries, and on manual reprocess — all of which re-enter through
// _processInBitrix. A missing bitrix_category_id must THROW (so the caller
// reschedules) instead of letting DealBuilder create a fallback deal in the
// wrong funnel. A null stage is a LEGITIMATE state and must NOT throw.

vi.mock('../../db/repos/EmailEventRepo.js', () => ({
  EmailEventRepo: { create: vi.fn(), setStatus: vi.fn() },
}));
vi.mock('../../db/repos/BitrixResultRepo.js', () => ({
  BitrixResultRepo: { findByEventId: vi.fn(), upsert: vi.fn(), setActivity: vi.fn(), setAttachmentsMarker: vi.fn() },
}));
vi.mock('../../db/repos/RetryJobRepo.js', () => ({ RetryJobRepo: { scheduleNext: vi.fn() } }));
vi.mock('../../db/repos/SubscriptionRepo.js', () => ({
  SubscriptionRepo: { checkAccess: vi.fn().mockResolvedValue({ allowed: true }) },
}));
vi.mock('../../db/repos/RoutingRuleRepo.js', () => ({
  RoutingRuleRepo: { findActiveByTenant: vi.fn().mockResolvedValue([]) },
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
vi.mock('../../logger.js', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { EmailPipeline } from '../../pipeline/EmailPipeline.js';
import { EmailEventRepo } from '../../db/repos/EmailEventRepo.js';
import { BitrixResultRepo } from '../../db/repos/BitrixResultRepo.js';
import { RoutingRuleRepo } from '../../db/repos/RoutingRuleRepo.js';
import { ContactResolver } from '../../bitrix/ContactResolver.js';
import { DealBuilder } from '../../bitrix/DealBuilder.js';
import { ActivityWriter } from '../../bitrix/ActivityWriter.js';

const baseAccount = {
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
  messageId: '<1@test>', fromEmail: 'client@x.com', fromName: 'Client',
  subject: 'Orçamento', bodyHtml: '<p>hi</p>', bodyText: 'hi',
  attachments: [], toEmails: [], ccEmails: [],
};
const event = { id: 'event-1', tenant_id: 'tenant-1', retry_count: 0 };

describe('EmailPipeline._processInBitrix — required-mapping guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ContactResolver.resolve.mockResolvedValue({ contactId: 111, wasCreated: true });
    DealBuilder.create.mockResolvedValue(222);
    ActivityWriter.write.mockResolvedValue(333);
    EmailEventRepo.setStatus.mockResolvedValue({});
    BitrixResultRepo.upsert.mockResolvedValue({});
    BitrixResultRepo.setActivity.mockResolvedValue({});
    BitrixResultRepo.findByEventId.mockResolvedValue(null);
    RoutingRuleRepo.findActiveByTenant.mockResolvedValue([]);
  });

  it('throws (no deal created) when bitrix_category_id is missing', async () => {
    const account = { ...baseAccount, bitrix_category_id: null };

    await expect(EmailPipeline._processInBitrix(account, email, event))
      .rejects.toThrow(/missing required mapping \(bitrix_category_id\)/);

    // Critical: NO deal is created in a fallback funnel.
    expect(DealBuilder.create).not.toHaveBeenCalled();
  });

  it('does NOT throw when category is 0 (legitimate default pipeline)', async () => {
    const account = { ...baseAccount, bitrix_category_id: 0 };

    await EmailPipeline._processInBitrix(account, email, event);

    expect(DealBuilder.create).toHaveBeenCalled();
    const tenant = DealBuilder.create.mock.calls[0][0];
    expect(tenant.bitrix_category_id).toBe(0);
  });

  it('does NOT throw when stage is null but category is present (Bitrix uses first stage)', async () => {
    const account = { ...baseAccount, bitrix_stage_id: null };

    await EmailPipeline._processInBitrix(account, email, event);

    expect(DealBuilder.create).toHaveBeenCalled();
  });

  it('a routing rule can supply the category the account lacks (no throw)', async () => {
    const account = { ...baseAccount, bitrix_category_id: null };
    RoutingRuleRepo.findActiveByTenant.mockResolvedValue([
      { id: 'r1', match_type: 'exact', match_value: 'client@x.com',
        bitrix_category_id: 4, bitrix_stage_id: null, bitrix_responsible_id: null },
    ]);

    await EmailPipeline._processInBitrix(account, email, event);

    expect(DealBuilder.create).toHaveBeenCalled();
    expect(DealBuilder.create.mock.calls[0][0].bitrix_category_id).toBe(4);
  });
});
