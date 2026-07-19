// Verify a deal file field then clean up test artifacts (email, deal, contact, db rows).
import { db } from '../src/db/client.js';
import { ImapFlow } from 'imapflow';
import * as ImapAccountRepo from '../src/db/repos/ImapAccountRepo.js';
import { BitrixClient } from '../src/bitrix/BitrixClient.js';

const ACCOUNT_ID = process.argv[2];
const DEAL_ID = process.argv[3];
const CONTACT_ID = process.argv[4];
const EVENT_ID = process.argv[5];
const SEARCH = process.argv[6] || 'TESTE ANEXO MANDA';
const UF = 'UF_CRM_1769077277749';

const accounts = await ImapAccountRepo.findAllActive();
const acc = accounts.find(a => a.id === ACCOUNT_ID);
const bx = new BitrixClient({ bitrix_url: acc.bitrix_url, bitrix_webhook_token: acc.bitrix_webhook_token, auth_id: acc.auth_id, refresh_id: acc.refresh_id });

// 1. Verify
try {
  const deal = await bx.call('crm.deal.get', { id: DEAL_ID });
  console.log('VERIFY', UF, '=', JSON.stringify(deal[UF]).substring(0, 160));
} catch (e) { console.log('verify failed:', e.message); }

// 2. Delete email from folder
const client = new ImapFlow({ host: acc.host, port: acc.port, secure: acc.use_ssl, auth: { user: acc.username, pass: acc.password }, logger: false });
await client.connect();
const lock = await client.getMailboxLock(acc.mailbox);
try {
  const uids = await client.search({ body: SEARCH }, { uid: true });
  if (uids && uids.length) { await client.messageDelete(uids, { uid: true }); console.log('deleted email uids:', uids.join(',')); }
  else console.log('no test email found');
} finally { lock.release(); }
await client.logout();

// 3. Delete deal + contact
try { await bx.call('crm.deal.delete', { id: DEAL_ID }); console.log('deleted deal', DEAL_ID); } catch (e) { console.log('deal del:', e.message); }
if (CONTACT_ID) { try { await bx.call('crm.contact.delete', { id: CONTACT_ID }); console.log('deleted contact', CONTACT_ID); } catch (e) { console.log('contact del:', e.message); } }

// 4. Delete DB rows
if (EVENT_ID) {
  await db.query('DELETE FROM bitrix_results WHERE email_event_id=$1', [EVENT_ID]);
  await db.query('DELETE FROM email_events WHERE id=$1', [EVENT_ID]);
  console.log('deleted db rows for', EVENT_ID);
}
process.exit(0);
