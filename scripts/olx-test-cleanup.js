// Cleanup TEST artifacts: remove the injected [TESTE MANDA] email from the IMAP
// folder and delete the test deal + contact from Bitrix.
import { ImapFlow } from 'imapflow';
import * as ImapAccountRepo from '../src/db/repos/ImapAccountRepo.js';
import { BitrixClient } from '../src/bitrix/BitrixClient.js';

const EMAIL = process.argv[2] || 'autovillejf@gmail.com';
const DEAL_ID = process.argv[3];
const CONTACT_ID = process.argv[4];

const accounts = await ImapAccountRepo.findAllActive();
const acc = accounts.find(a => a.email === EMAIL);
if (!acc) { console.error('Account not found:', EMAIL); process.exit(1); }

// 1. Delete injected test email(s) from the folder
const client = new ImapFlow({
  host: acc.host, port: acc.port, secure: acc.use_ssl,
  auth: { user: acc.username, pass: acc.password }, logger: false,
});
await client.connect();
const lock = await client.getMailboxLock(acc.mailbox);
try {
  const uids = await client.search({ body: '[TESTE MANDA]' }, { uid: true });
  if (uids && uids.length > 0) {
    await client.messageDelete(uids, { uid: true });
    console.log('Deleted test email(s) from folder, uids:', uids.join(','));
  } else {
    console.log('No test email found in folder.');
  }
} finally {
  lock.release();
}
await client.logout();

// 2. Delete test deal + contact from Bitrix
const tenant = {
  bitrix_url: acc.bitrix_url,
  bitrix_webhook_token: acc.bitrix_webhook_token,
  auth_id: acc.auth_id,
  refresh_id: acc.refresh_id,
};
const bx = new BitrixClient(tenant);
if (DEAL_ID) {
  try { await bx.call('crm.deal.delete', { id: DEAL_ID }); console.log('Deleted deal', DEAL_ID); }
  catch (e) { console.log('Deal delete failed:', e.message); }
}
if (CONTACT_ID) {
  try { await bx.call('crm.contact.delete', { id: CONTACT_ID }); console.log('Deleted contact', CONTACT_ID); }
  catch (e) { console.log('Contact delete failed:', e.message); }
}
process.exit(0);
