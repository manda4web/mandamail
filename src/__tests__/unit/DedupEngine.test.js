import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DedupEngine } from '../../pipeline/DedupEngine.js';
import { EmailEventRepo } from '../../db/repos/EmailEventRepo.js';

vi.mock('../../db/repos/EmailEventRepo.js', () => ({
  EmailEventRepo: {
    findByMessageId: vi.fn(),
    findBySubjectFrom: vi.fn(),
  },
}));

describe('DedupEngine', () => {
  const account = { id: 'account-123' };
  const currentEventId = 'event-current';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('isDuplicate', () => {
    it('returns true when message_id matches a different event', async () => {
      const email = { messageId: '<msg@example.com>', subject: 'Hello', fromEmail: 'sender@example.com' };
      EmailEventRepo.findByMessageId.mockResolvedValue({ id: 'event-other' });

      const result = await DedupEngine.isDuplicate(account, email, currentEventId);

      expect(result).toBe(true);
      expect(EmailEventRepo.findByMessageId).toHaveBeenCalledWith('account-123', '<msg@example.com>');
    });

    it('returns false when message_id matches the current event itself', async () => {
      const email = { messageId: '<msg@example.com>', subject: '', fromEmail: 'sender@example.com' };
      EmailEventRepo.findByMessageId.mockResolvedValue({ id: currentEventId });
      EmailEventRepo.findBySubjectFrom.mockResolvedValue(null);

      const result = await DedupEngine.isDuplicate(account, email, currentEventId);

      expect(result).toBe(false);
    });

    it('skips message_id check when messageId is null', async () => {
      const email = { messageId: null, subject: 'Hello', fromEmail: 'sender@example.com' };
      EmailEventRepo.findBySubjectFrom.mockResolvedValue(null);

      const result = await DedupEngine.isDuplicate(account, email, currentEventId);

      expect(result).toBe(false);
      expect(EmailEventRepo.findByMessageId).not.toHaveBeenCalled();
    });

    it('skips message_id check when messageId is empty string', async () => {
      const email = { messageId: '', subject: 'Hello', fromEmail: 'sender@example.com' };
      EmailEventRepo.findBySubjectFrom.mockResolvedValue(null);

      const result = await DedupEngine.isDuplicate(account, email, currentEventId);

      expect(result).toBe(false);
      expect(EmailEventRepo.findByMessageId).not.toHaveBeenCalled();
    });

    it('returns true when subject+from matches a different event', async () => {
      const email = { messageId: null, subject: 'Hello World', fromEmail: 'sender@example.com' };
      EmailEventRepo.findBySubjectFrom.mockResolvedValue({ id: 'event-other' });

      const result = await DedupEngine.isDuplicate(account, email, currentEventId);

      expect(result).toBe(true);
      expect(EmailEventRepo.findBySubjectFrom).toHaveBeenCalledWith('account-123', 'Hello World', 'sender@example.com');
    });

    it('returns false when subject+from matches the current event itself', async () => {
      const email = { messageId: null, subject: 'Hello', fromEmail: 'sender@example.com' };
      EmailEventRepo.findBySubjectFrom.mockResolvedValue({ id: currentEventId });

      const result = await DedupEngine.isDuplicate(account, email, currentEventId);

      expect(result).toBe(false);
    });

    it('skips subject+from check when subject is empty', async () => {
      const email = { messageId: null, subject: '', fromEmail: 'sender@example.com' };

      const result = await DedupEngine.isDuplicate(account, email, currentEventId);

      expect(result).toBe(false);
      expect(EmailEventRepo.findBySubjectFrom).not.toHaveBeenCalled();
    });

    it('skips subject+from check when subject is null', async () => {
      const email = { messageId: null, subject: null, fromEmail: 'sender@example.com' };

      const result = await DedupEngine.isDuplicate(account, email, currentEventId);

      expect(result).toBe(false);
      expect(EmailEventRepo.findBySubjectFrom).not.toHaveBeenCalled();
    });

    it('returns false when no duplicates are found', async () => {
      const email = { messageId: '<unique@example.com>', subject: 'Unique Subject', fromEmail: 'sender@example.com' };
      EmailEventRepo.findByMessageId.mockResolvedValue(null);
      EmailEventRepo.findBySubjectFrom.mockResolvedValue(null);

      const result = await DedupEngine.isDuplicate(account, email, currentEventId);

      expect(result).toBe(false);
    });

    it('checks message_id first and returns early if duplicate found', async () => {
      const email = { messageId: '<msg@example.com>', subject: 'Hello', fromEmail: 'sender@example.com' };
      EmailEventRepo.findByMessageId.mockResolvedValue({ id: 'event-other' });

      const result = await DedupEngine.isDuplicate(account, email, currentEventId);

      expect(result).toBe(true);
      // Should not check subject+from since message_id already matched
      expect(EmailEventRepo.findBySubjectFrom).not.toHaveBeenCalled();
    });

    it('falls through to subject+from check when message_id has no match', async () => {
      const email = { messageId: '<msg@example.com>', subject: 'Hello', fromEmail: 'sender@example.com' };
      EmailEventRepo.findByMessageId.mockResolvedValue(null);
      EmailEventRepo.findBySubjectFrom.mockResolvedValue({ id: 'event-other' });

      const result = await DedupEngine.isDuplicate(account, email, currentEventId);

      expect(result).toBe(true);
      expect(EmailEventRepo.findByMessageId).toHaveBeenCalled();
      expect(EmailEventRepo.findBySubjectFrom).toHaveBeenCalled();
    });
  });
});
