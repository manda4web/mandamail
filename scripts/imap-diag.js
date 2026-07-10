// Diagnostic: inspect an IMAP account's mailbox — total messages, unseen count,
// and the most recent messages (date, subject, seen flag) across relevant folders.
import { ImapFlow } from 'imapflow';
import * as ImapAccountRepo from '../src/db/repos/ImapAccountRepo.js';

const EMAIL = process.argv[2] || 'autovillejf@gmail.com';

const accounts = await ImapAccountRepo.findAllActive();
const acc = accounts.find(a => a.email === EMAIL);
if (!acc) {
  console.error('Account not found:', EMAIL);
  process.exit(1);
}

const client = new ImapFlow({
  host: acc.host,
  port: acc.port,
  secure: acc.use_ssl,
  auth: { user: acc.username, pass: acc.password },
  logger: false,
});

await client.connect();
console.log('Connected OK. Configured mailbox:', acc.mailbox);

// List all folders
console.log('\n=== FOLDERS ===');
const boxes = await client.list();
for (const box of boxes) {
  console.log(` - ${box.path}${box.specialUse ? ' ' + box.specialUse : ''}`);
}

async function inspect(folder) {
  try {
    const lock = await client.getMailboxLock(folder);
    try {
      const status = await client.status(folder, { messages: true, unseen: true, recent: true });
      console.log(`\n=== ${folder} === total=${status.messages} unseen=${status.unseen} recent=${status.recent}`);
      // last 8 messages
      const total = status.messages || 0;
      if (total > 0) {
        const from = Math.max(1, total - 7);
        for await (const msg of client.fetch(`${from}:*`, { envelope: true, flags: true, internalDate: true })) {
          const seen = msg.flags && msg.flags.has('\\Seen') ? 'SEEN ' : 'UNSEEN';
          const date = msg.internalDate ? msg.internalDate.toISOString() : '?';
          const subj = msg.envelope?.subject || '(no subject)';
          const fromAddr = msg.envelope?.from?.[0]?.address || '?';
          console.log(`   [${seen}] ${date} | ${fromAddr} | ${subj.substring(0, 60)}`);
        }
      }
    } finally {
      lock.release();
    }
  } catch (e) {
    console.log(`\n=== ${folder} === ERROR: ${e.message}`);
  }
}

await inspect(acc.mailbox);
await inspect('INBOX');

await client.logout();
process.exit(0);
