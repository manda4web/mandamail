import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock dependencies before importing the module under test
vi.mock('../../db/repos/RetryJobRepo.js', () => ({
  RetryJobRepo: {
    findPending: vi.fn(),
    markSuccess: vi.fn(),
    markFailed: vi.fn(),
    scheduleNext: vi.fn(),
  },
}));

vi.mock('../../db/repos/EmailEventRepo.js', () => ({
  EmailEventRepo: {
    findById: vi.fn(),
    setStatus: vi.fn(),
    findStale: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock('../../db/repos/ImapAccountRepo.js', () => ({
  findById: vi.fn(),
}));

vi.mock('../../pipeline/EmailPipeline.js', () => ({
  EmailPipeline: {
    _processInBitrix: vi.fn(),
  },
}));

vi.mock('../../imap/fetchOriginalEmail.js', () => ({
  fetchOriginalEmail: vi.fn().mockResolvedValue(null),
}));

vi.mock('../../logger.js', () => ({
  default: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  },
}));

import { RetryWorker } from '../../jobs/RetryWorker.js';
import { RetryJobRepo } from '../../db/repos/RetryJobRepo.js';
import { EmailEventRepo } from '../../db/repos/EmailEventRepo.js';
import * as ImapAccountRepo from '../../db/repos/ImapAccountRepo.js';
import { EmailPipeline } from '../../pipeline/EmailPipeline.js';
import { fetchOriginalEmail } from '../../imap/fetchOriginalEmail.js';

describe('RetryWorker', () => {
  let worker;

  beforeEach(() => {
    vi.useFakeTimers();
    worker = new RetryWorker();
    vi.clearAllMocks();
  });

  afterEach(() => {
    worker.stop();
    vi.useRealTimers();
  });

  describe('start/stop lifecycle', () => {
    it('should set running to true on start', () => {
      RetryJobRepo.findPending.mockResolvedValue([]);
      worker.start();
      expect(worker.running).toBe(true);
    });

    it('should set running to false on stop', () => {
      RetryJobRepo.findPending.mockResolvedValue([]);
      worker.start();
      worker.stop();
      expect(worker.running).toBe(false);
      expect(worker.intervalId).toBeNull();
    });

    it('should run immediately on start', async () => {
      RetryJobRepo.findPending.mockResolvedValue([]);
      EmailEventRepo.findStale.mockResolvedValue([]);
      worker.start();
      // _runPending awaits the stale-event recovery before polling, so the
      // first findPending call happens on a later microtask.
      await vi.waitFor(() => expect(RetryJobRepo.findPending).toHaveBeenCalledTimes(1));
    });
  });

  describe('_executeJob', () => {
    const mockJob = {
      id: 'job-1',
      email_event_id: 'event-1',
      attempt_number: 1,
    };

    const mockEvent = {
      id: 'event-1',
      imap_account_id: 'account-1',
      message_id: '<msg@test.com>',
      from_email: 'sender@test.com',
      from_name: 'Sender',
      reply_to: 'reply@test.com',
      subject: 'Test Subject',
      body_html: '<p>Hello</p>',
      body_text: 'Hello',
      to_emails: ['to@test.com'],
      cc_emails: [],
      received_at: new Date('2024-01-01'),
    };

    const mockAccount = {
      id: 'account-1',
      tenant_id: 'tenant-1',
      bitrix_url: 'https://bitrix.example.com',
    };

    it('should mark job failed if email_event not found', async () => {
      EmailEventRepo.findById.mockResolvedValue(null);

      await worker._executeJob(mockJob);

      expect(RetryJobRepo.markFailed).toHaveBeenCalledWith('job-1', 'email_event not found');
    });

    it('should mark FALHA_DEFINITIVA if attempt_number > 5', async () => {
      const jobOver5 = { ...mockJob, attempt_number: 6 };
      EmailEventRepo.findById.mockResolvedValue(mockEvent);

      await worker._executeJob(jobOver5);

      expect(EmailEventRepo.setStatus).toHaveBeenCalledWith('event-1', 'FALHA_DEFINITIVA');
      expect(RetryJobRepo.markFailed).toHaveBeenCalledWith('job-1', 'max 5 attempts reached');
    });

    it('should defer the job (leave pending) when event is PROCESSANDO (manual reprocess in flight)', async () => {
      const processing = { ...mockEvent, status: 'PROCESSANDO' };
      EmailEventRepo.findById.mockResolvedValue(processing);

      await worker._executeJob(mockJob);

      expect(EmailPipeline._processInBitrix).not.toHaveBeenCalled();
      expect(RetryJobRepo.markFailed).not.toHaveBeenCalled();
      expect(RetryJobRepo.markSuccess).not.toHaveBeenCalled(); // stays pending
    });

    it('should close the job without reprocessing when event is already SUCESSO', async () => {
      const done = { ...mockEvent, status: 'SUCESSO' };
      EmailEventRepo.findById.mockResolvedValue(done);

      await worker._executeJob(mockJob);

      expect(RetryJobRepo.markSuccess).toHaveBeenCalledWith('job-1');
      expect(EmailPipeline._processInBitrix).not.toHaveBeenCalled();
    });

    it('should mark the event PROCESSANDO before executing (blocks concurrent reprocess)', async () => {
      EmailEventRepo.findById.mockResolvedValue(mockEvent);
      ImapAccountRepo.findById.mockResolvedValue(mockAccount);
      EmailPipeline._processInBitrix.mockResolvedValue(undefined);
      fetchOriginalEmail.mockResolvedValue(null);

      await worker._executeJob(mockJob);

      expect(EmailEventRepo.setStatus).toHaveBeenCalledWith('event-1', 'PROCESSANDO');
    });

    it('should mark job failed if imap_account not found', async () => {
      EmailEventRepo.findById.mockResolvedValue(mockEvent);
      ImapAccountRepo.findById.mockResolvedValue(null);

      await worker._executeJob(mockJob);

      expect(RetryJobRepo.markFailed).toHaveBeenCalledWith('job-1', 'imap_account not found');
    });

    it('should call _processInBitrix and mark success on success', async () => {
      EmailEventRepo.findById.mockResolvedValue(mockEvent);
      ImapAccountRepo.findById.mockResolvedValue(mockAccount);
      EmailPipeline._processInBitrix.mockResolvedValue(undefined);

      await worker._executeJob(mockJob);

      expect(EmailPipeline._processInBitrix).toHaveBeenCalledWith(
        mockAccount,
        expect.objectContaining({
          messageId: mockEvent.message_id,
          fromEmail: mockEvent.from_email,
          subject: mockEvent.subject,
        }),
        mockEvent
      );
      expect(RetryJobRepo.markSuccess).toHaveBeenCalledWith('job-1');
    });

    it('should schedule next retry on failure when attempts < 5', async () => {
      const error = new Error('Bitrix API timeout');
      EmailEventRepo.findById.mockResolvedValue(mockEvent);
      ImapAccountRepo.findById.mockResolvedValue(mockAccount);
      EmailPipeline._processInBitrix.mockRejectedValue(error);

      await worker._executeJob(mockJob);

      expect(RetryJobRepo.markFailed).toHaveBeenCalledWith('job-1', 'Bitrix API timeout');
      expect(RetryJobRepo.scheduleNext).toHaveBeenCalledWith('event-1', 2, error);
      expect(EmailEventRepo.setStatus).toHaveBeenCalledWith('event-1', 'ERRO', { incrementRetry: true });
    });

    it('should mark FALHA_DEFINITIVA on failure when attempts >= 5', async () => {
      const jobAttempt5 = { ...mockJob, attempt_number: 5 };
      const error = new Error('Bitrix API timeout');
      EmailEventRepo.findById.mockResolvedValue(mockEvent);
      ImapAccountRepo.findById.mockResolvedValue(mockAccount);
      EmailPipeline._processInBitrix.mockRejectedValue(error);

      await worker._executeJob(jobAttempt5);

      expect(RetryJobRepo.markFailed).toHaveBeenCalledWith('job-1', 'Bitrix API timeout');
      expect(EmailEventRepo.setStatus).toHaveBeenCalledWith('event-1', 'FALHA_DEFINITIVA');
      expect(RetryJobRepo.scheduleNext).not.toHaveBeenCalled();
    });

    it('should reconstruct email object with empty attachments on retry', async () => {
      EmailEventRepo.findById.mockResolvedValue(mockEvent);
      ImapAccountRepo.findById.mockResolvedValue(mockAccount);
      EmailPipeline._processInBitrix.mockResolvedValue(undefined);
      fetchOriginalEmail.mockResolvedValue(null); // IMAP refetch unavailable

      await worker._executeJob(mockJob);

      const emailArg = EmailPipeline._processInBitrix.mock.calls[0][1];
      expect(emailArg.attachments).toEqual([]);
      expect(emailArg.bodyHtml).toBe('<p>Hello</p>');
      expect(emailArg.bodyText).toBe('Hello');
      expect(emailArg.toEmails).toEqual(['to@test.com']);
    });

    it('should use the original email from IMAP (with attachments) when refetch succeeds', async () => {
      EmailEventRepo.findById.mockResolvedValue(mockEvent);
      ImapAccountRepo.findById.mockResolvedValue(mockAccount);
      EmailPipeline._processInBitrix.mockResolvedValue(undefined);
      fetchOriginalEmail.mockResolvedValue({
        messageId: mockEvent.message_id,
        fromEmail: mockEvent.from_email,
        subject: mockEvent.subject,
        bodyHtml: '<p>Full body</p>',
        attachments: [{ fileName: 'contract.pdf', fileData: 'base64...' }],
      });

      await worker._executeJob(mockJob);

      const emailArg = EmailPipeline._processInBitrix.mock.calls[0][1];
      expect(fetchOriginalEmail).toHaveBeenCalledWith(mockAccount, mockEvent.message_id);
      expect(emailArg.attachments).toEqual([{ fileName: 'contract.pdf', fileData: 'base64...' }]);
      expect(emailArg.bodyHtml).toBe('<p>Full body</p>');
    });
  });

  describe('_runPending', () => {
    it('should do nothing when no pending jobs', async () => {
      RetryJobRepo.findPending.mockResolvedValue([]);
      EmailEventRepo.findStale.mockResolvedValue([]);

      await worker._runPending();

      expect(RetryJobRepo.markSuccess).not.toHaveBeenCalled();
      expect(RetryJobRepo.markFailed).not.toHaveBeenCalled();
    });

    it('should recover stale PROCESSANDO events (crash recovery)', async () => {
      const staleEvent = { id: 'stale-1', status: 'PROCESSANDO', retry_count: 0 };
      EmailEventRepo.findStale.mockResolvedValue([staleEvent]);
      RetryJobRepo.findPending.mockResolvedValue([]);
      RetryJobRepo.scheduleNext.mockResolvedValue({});

      await worker._runPending();

      expect(EmailEventRepo.setStatus).toHaveBeenCalledWith('stale-1', 'ERRO', { incrementRetry: true });
      expect(RetryJobRepo.scheduleNext).toHaveBeenCalledWith('stale-1', 1, expect.any(Error));
    });

    it('should mark stale events as FALHA_DEFINITIVA when retry budget is exhausted', async () => {
      const staleEvent = { id: 'stale-2', status: 'PROCESSANDO', retry_count: 5 };
      EmailEventRepo.findStale.mockResolvedValue([staleEvent]);
      RetryJobRepo.findPending.mockResolvedValue([]);

      await worker._runPending();

      expect(EmailEventRepo.setStatus).toHaveBeenCalledWith('stale-2', 'FALHA_DEFINITIVA');
      expect(RetryJobRepo.scheduleNext).not.toHaveBeenCalled();
    });

    it('should process all pending jobs', async () => {
      const jobs = [
        { id: 'job-1', email_event_id: 'event-1', attempt_number: 1 },
        { id: 'job-2', email_event_id: 'event-2', attempt_number: 2 },
      ];
      RetryJobRepo.findPending.mockResolvedValue(jobs);
      EmailEventRepo.findById.mockResolvedValue(null); // both will fail with "not found"

      await worker._runPending();

      expect(RetryJobRepo.markFailed).toHaveBeenCalledTimes(2);
    });

    it('should catch and log errors from findPending', async () => {
      RetryJobRepo.findPending.mockRejectedValue(new Error('DB connection lost'));

      await worker._runPending();

      // Should not throw — error is caught and logged
    });
  });
});
