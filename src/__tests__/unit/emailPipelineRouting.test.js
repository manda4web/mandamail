import { describe, it, expect, vi, beforeEach } from 'vitest';

// Routing rules in EmailPipeline._processInBitrix: the first active rule
// matching the sender overrides the account mapping (category/stage/
// responsible). Critical semantics under test:
//  - bitrix_category_id 0 = LEGITIMATE override (force the default pipeline);
//    null = "no override" (keep the account value). They must stay distinct
//    through the whole chain (regression case below).
//  - Fail-open: a DB error fetching rules must never lose the lead.
//  - Rules run AFTER the OLX rewrite, matching the real customer address.
// RoutingEngine is intentionally NOT mocked — the real pure matcher runs.

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
vi.mock('../../logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { EmailPipeline } from '../../pipeline/EmailPipeline.js';
import { EmailEventRepo } from '../../db/repos/EmailEventRepo.js';
import { BitrixResultRepo } from '../../db/repos/BitrixResultRepo.js';
import { RoutingRuleRepo } from '../../db/repos/RoutingRuleRepo.js';
import { ContactResolver } from '../../bitrix/ContactResolver.js';
import { DealBuilder } from '../../bitrix/DealBuilder.js';
import { ActivityWriter } from '../../bitrix/ActivityWriter.js';
import { uploadAttachments } from '../../bitrix/AttachmentUploader.js';
import { parseOlxLead, applyOlxLead } from '../../imap/OlxParser.js';
import logger from '../../logger.js';

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
  attachments: [],
  toEmails: [],
  ccEmails: [],
};

const event = { id: 'event-1', tenant_id: 'tenant-1', retry_count: 0 };

// routing_rules row shape (defaults = "no override on any destination").
const rule = (overrides = {}) => ({
  id: 'rule-1',
  name: 'Client X',
  match_type: 'exact',
  match_value: 'client@x.com',
  bitrix_category_id: null,
  bitrix_stage_id: null,
  bitrix_responsible_id: null,
  priority: 100,
  is_active: true,
  created_at: '2026-01-01T00:00:00Z',
  ...overrides,
});

describe('EmailPipeline._processInBitrix — routing rules', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ContactResolver.resolve.mockResolvedValue({ contactId: 111, wasCreated: true });
    DealBuilder.create.mockResolvedValue(222);
    ActivityWriter.write.mockResolvedValue(333);
    uploadAttachments.mockResolvedValue({ uploaded: 0, skipped: 0, failed: 0 });
    EmailEventRepo.setStatus.mockResolvedValue({});
    BitrixResultRepo.upsert.mockResolvedValue({});
    BitrixResultRepo.setActivity.mockResolvedValue({});
    BitrixResultRepo.findByEventId.mockResolvedValue(null);
    RoutingRuleRepo.findActiveByTenant.mockResolvedValue([]);
  });

  it('rule with all 3 destination fields overrides category, stage and responsible', async () => {
    RoutingRuleRepo.findActiveByTenant.mockResolvedValue([
      rule({ bitrix_category_id: 7, bitrix_stage_id: 'C7:PREJURI', bitrix_responsible_id: 42 }),
    ]);

    await EmailPipeline._processInBitrix(account, email, event);

    const tenant = DealBuilder.create.mock.calls[0][0];
    expect(tenant.bitrix_category_id).toBe(7);
    expect(tenant.bitrix_stage_id).toBe('C7:PREJURI');
    expect(tenant.bitrix_responsible_id).toBe(42);
  });

  it('rule with only bitrix_responsible_id preserves account category/stage', async () => {
    RoutingRuleRepo.findActiveByTenant.mockResolvedValue([
      rule({ bitrix_responsible_id: 55 }),
    ]);

    await EmailPipeline._processInBitrix(account, email, event);

    const tenant = DealBuilder.create.mock.calls[0][0];
    expect(tenant.bitrix_responsible_id).toBe(55);
    expect(tenant.bitrix_category_id).toBe(9);
    expect(tenant.bitrix_stage_id).toBe('C9:NEW');
  });

  it('REGRESSION null-vs-0: rule with bitrix_category_id 0 reaches DealBuilder as strict 0 (default pipeline), not dropped and not null', async () => {
    RoutingRuleRepo.findActiveByTenant.mockResolvedValue([
      rule({ bitrix_category_id: 0, bitrix_stage_id: null, bitrix_responsible_id: null }),
    ]);

    await EmailPipeline._processInBitrix(account, email, event);

    const tenant = DealBuilder.create.mock.calls[0][0];
    // Strict equality: 0 must survive the override chain as 0. A truthiness
    // check here (the historical bug class of this feature) would either
    // drop the override (9) or coerce to null.
    expect(tenant.bitrix_category_id).toBe(0);
    // Category override without a stage DROPS the account stage: 'C9:NEW'
    // belongs to funnel 9 and would be silently ignored by the Bitrix on
    // funnel 0 — the deal is born on the target funnel's first stage instead.
    expect(tenant.bitrix_stage_id).toBeNull();
    expect(tenant.bitrix_responsible_id).toBe(1);
  });

  it('fail-open: RoutingRuleRepo error proceeds with account mapping, warns and still succeeds', async () => {
    RoutingRuleRepo.findActiveByTenant.mockRejectedValue(new Error('db down'));

    await EmailPipeline._processInBitrix(account, email, event);

    const tenant = DealBuilder.create.mock.calls[0][0];
    expect(tenant.bitrix_category_id).toBe(9);
    expect(tenant.bitrix_stage_id).toBe('C9:NEW');
    expect(tenant.bitrix_responsible_id).toBe(1);
    expect(logger.warn).toHaveBeenCalled();
    expect(EmailEventRepo.setStatus).toHaveBeenCalledWith('event-1', 'SUCESSO');
  });

  it('no rules: DealBuilder receives exactly the account mapping; rules are fetched by tenant_id', async () => {
    RoutingRuleRepo.findActiveByTenant.mockResolvedValue([]);

    await EmailPipeline._processInBitrix(account, email, event);

    expect(RoutingRuleRepo.findActiveByTenant).toHaveBeenCalledWith('tenant-1');
    const tenant = DealBuilder.create.mock.calls[0][0];
    expect(tenant.bitrix_category_id).toBe(9);
    expect(tenant.bitrix_stage_id).toBe('C9:NEW');
    expect(tenant.bitrix_responsible_id).toBe(1);
  });

  it('OLX: rule matches the REWRITTEN customer address, not noreply@olx', async () => {
    const olxAccount = { ...account, parser_type: 'olx' };
    const rewritten = { ...email, fromEmail: 'cliente@real.com', fromName: 'Cliente Real' };
    parseOlxLead.mockReturnValue({ phone: '11999998888', adTitle: 'Carro Usado' });
    applyOlxLead.mockReturnValue(rewritten);
    // The rule matches ONLY the rewritten address. If matching ran BEFORE the
    // OLX block it would see 'client@x.com', not match, and category would
    // stay 9 — category 5 proves it matched the rewritten 'cliente@real.com'.
    RoutingRuleRepo.findActiveByTenant.mockResolvedValue([
      rule({ match_value: 'cliente@real.com', bitrix_category_id: 5 }),
    ]);

    await EmailPipeline._processInBitrix(olxAccount, email, event);

    const tenant = DealBuilder.create.mock.calls[0][0];
    expect(tenant.bitrix_category_id).toBe(5);
    // Category 5 without a rule stage drops the account stage ('C9:NEW' is
    // foreign to funnel 5) — first stage of funnel 5 instead.
    expect(tenant.bitrix_stage_id).toBeNull();
  });

  it('rule changing category KEEPS a rule-provided stage even when the account stage exists', async () => {
    RoutingRuleRepo.findActiveByTenant.mockResolvedValue([
      rule({ bitrix_category_id: 7, bitrix_stage_id: 'C7:PREJURI' }),
    ]);

    await EmailPipeline._processInBitrix(account, email, event);

    const tenant = DealBuilder.create.mock.calls[0][0];
    expect(tenant.bitrix_category_id).toBe(7);
    expect(tenant.bitrix_stage_id).toBe('C7:PREJURI');
  });

  it('rule changing category without stage is audited with the actual (dropped) stage semantics', async () => {
    RoutingRuleRepo.findActiveByTenant.mockResolvedValue([
      rule({ bitrix_category_id: 7, bitrix_stage_id: null }),
    ]);

    await EmailPipeline._processInBitrix(account, email, event);

    const finalUpsert = BitrixResultRepo.upsert.mock.calls.at(-1)[0];
    expect(finalUpsert.api_log.routing_rule).toMatchObject({ id: 'rule-1', category_id: 7, stage_id: null, applied: true });
  });

  it('reused deal (prior bitrix_result): DealBuilder NOT called, but api_log.routing_rule is persisted', async () => {
    RoutingRuleRepo.findActiveByTenant.mockResolvedValue([
      rule({ bitrix_responsible_id: 77 }),
    ]);
    BitrixResultRepo.findByEventId.mockResolvedValue({
      bitrix_deal_id: 222,
      bitrix_contact_id: 111,
      contact_was_created: true,
      bitrix_activity_id: 333,
      api_log: { attachments: { uploaded: 1 } }, // fully done → total reuse path
    });

    await EmailPipeline._processInBitrix(account, email, event);

    expect(DealBuilder.create).not.toHaveBeenCalled();
    const finalUpsert = BitrixResultRepo.upsert.mock.calls.at(-1)[0];
    expect(finalUpsert.api_log.routing_rule).toBeDefined();
    expect(finalUpsert.api_log.routing_rule.id).toBe('rule-1');
    // prior has no routing_rule history → the current match is recorded as
    // NOT applied (the reused deal was not moved by it).
    expect(finalUpsert.api_log.routing_rule.applied).toBe(false);
  });

  it('reused deal: historical routing_rule from the creating run survives over the current match', async () => {
    RoutingRuleRepo.findActiveByTenant.mockResolvedValue([
      rule({ id: 'rule-edited', bitrix_responsible_id: 77, bitrix_category_id: 8 }),
    ]);
    BitrixResultRepo.findByEventId.mockResolvedValue({
      bitrix_deal_id: 222,
      bitrix_contact_id: 111,
      contact_was_created: true,
      bitrix_activity_id: 333,
      api_log: {
        attachments: { uploaded: 1 },
        routing_rule: { id: 'rule-1', match_type: 'exact', match_value: 'client@x.com', category_id: 7, applied: true },
      },
    });

    await EmailPipeline._processInBitrix(account, email, event);

    expect(DealBuilder.create).not.toHaveBeenCalled();
    const finalUpsert = BitrixResultRepo.upsert.mock.calls.at(-1)[0];
    // The audit keeps the rule that ACTUALLY created the deal (category 7),
    // not the currently-matching edited version (category 8).
    expect(finalUpsert.api_log.routing_rule).toMatchObject({ id: 'rule-1', category_id: 7, applied: true });
    expect(finalUpsert.api_log.routing_rule.id).not.toBe('rule-edited');
  });

  it('applied rule is recorded in api_log.routing_rule of the final upsert (domain match)', async () => {
    RoutingRuleRepo.findActiveByTenant.mockResolvedValue([
      rule({ id: 'rule-42', match_type: 'domain', match_value: 'x.com', bitrix_category_id: 3 }),
    ]);

    await EmailPipeline._processInBitrix(account, email, event);

    const finalUpsert = BitrixResultRepo.upsert.mock.calls.at(-1)[0];
    expect(finalUpsert.api_log.routing_rule).toMatchObject({
      id: 'rule-42',
      match_type: 'domain',
      match_value: 'x.com',
      category_id: 3,
    });
  });
});
