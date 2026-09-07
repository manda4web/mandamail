import { describe, it, expect, vi, beforeEach } from 'vitest';

// Regression test for the "stuck cursor across a UID gap" bug: when a run of
// deleted UIDs (larger than the fetch WINDOW) sits between the saved cursor and
// the real new mail, the finite-window loop used to stop on the first empty
// window and freeze the cursor forever. _fetchNew must skip the gap (using
// uidNext) and reach the newer messages.

vi.mock('imapflow', () => ({ ImapFlow: vi.fn() }));
vi.mock('mailparser', () => ({ simpleParser: vi.fn(async (src) => ({ _src: src })) }));

const processed = [];
vi.mock('../../pipeline/EmailPipeline.js', () => ({
  EmailPipeline: { process: vi.fn(async () => {}) },
}));

const savedCursors = [];
vi.mock('../../db/repos/ImapAccountRepo.js', () => ({
  updateLastPoll: vi.fn().mockResolvedValue(undefined),
  updateUidState: vi.fn(async (id, uidValidity, lastUid) => { savedCursors.push(lastUid); }),
  updateUidNext: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { ImapListener } from '../../imap/ImapListener.js';
import { EmailPipeline } from '../../pipeline/EmailPipeline.js';

/**
 * Builds a fake ImapFlow client whose fetch(range) returns only the messages
 * whose UID falls inside the requested "a:b" range, from a fixed set of UIDs
 * that actually exist in the mailbox.
 */
function makeClient(existingUids, uidValidity, uidNext) {
  return {
    usable: true,
    mailbox: { uidValidity, uidNext },
    getMailboxLock: vi.fn(async () => ({ release() {} })),
    messageFlagsAdd: vi.fn(async () => {}),
    async *fetch(range) {
      const [a, b] = String(range).split(':').map(Number);
      for (const uid of existingUids) {
        if (uid >= a && uid <= b) {
          yield { uid, source: Buffer.from('msg-' + uid) };
        }
      }
    },
  };
}

describe('ImapListener._fetchNew — UID gap skipping', () => {
  let listener;

  beforeEach(() => {
    vi.clearAllMocks();
    processed.length = 0;
    savedCursors.length = 0;
    EmailPipeline.process.mockImplementation(async (acc, parsed) => { processed.push(parsed._src.toString()); });
    listener = new ImapListener({
      id: 'acc-1', email: 'x@x.com', host: 'h', port: 993, use_ssl: true,
      username: 'u', password: 'p', mailbox: 'INBOX', poll_mode: 'poll',
      uid_validity: 1771622021, last_seen_uid: 149872,
    });
    listener.running = true;
  });

  it('skips a large deleted-UID gap and reaches the newer messages', async () => {
    // Real mail sits at 150021-150032, far beyond the cursor 149872, behind a
    // ~148-UID gap (149873..150020 all deleted). uidNext = 150034.
    const existing = [150021, 150022, 150027, 150028, 150029, 150030, 150031, 150032];
    listener.client = makeClient(existing, 1771622021, 150034);

    await listener._fetchNew();

    // Every existing message beyond the cursor must have been processed.
    expect(processed.length).toBe(existing.length);
    // Cursor must have advanced to the last real message.
    expect(savedCursors[savedCursors.length - 1]).toBe(150032);
  });

  it('stops cleanly when the mailbox has no messages beyond the cursor', async () => {
    // No messages beyond cursor; uidNext just past cursor -> nothing to do.
    listener.client = makeClient([], 1771622021, 149873);

    await listener._fetchNew();

    expect(processed.length).toBe(0);
  });

  it('processes a dense backlog with no gaps', async () => {
    var uids = [];
    for (var u = 149873; u <= 149920; u++) uids.push(u);
    listener.client = makeClient(uids, 1771622021, 149921);

    await listener._fetchNew();

    expect(processed.length).toBe(uids.length);
    expect(savedCursors[savedCursors.length - 1]).toBe(149920);
  });
});
