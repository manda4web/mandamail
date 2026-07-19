// One-off: extract the data:URI image from a stored email body and upload it to
// a deal's file UF field, then read the deal back to confirm the field format.
// Usage: node scripts/fix-deal-image.js <eventId> <dealId> <ufField>
import { db } from '../src/db/client.js';
import * as ImapAccountRepo from '../src/db/repos/ImapAccountRepo.js';
import { BitrixClient } from '../src/bitrix/BitrixClient.js';
import { extractDataUriImageFiles } from '../src/imap/EmailParser.js';

const EVENT_ID = process.argv[2];
const DEAL_ID = process.argv[3];
const UF_FIELD = process.argv[4];

const { rows } = await db.query('SELECT imap_account_id, body_html FROM email_events WHERE id=$1', [EVENT_ID]);
if (!rows[0]) { console.error('event not found'); process.exit(1); }

const images = extractDataUriImageFiles(rows[0].body_html);
console.log('images found in body:', images.length, images.map(i => i.fileName + ' (' + Math.round(i.fileData.length*0.75/1024) + 'KB)').join(', '));
if (images.length === 0) { console.error('no data URI images'); process.exit(1); }

const accounts = await ImapAccountRepo.findAllActive();
const acc = accounts.find(a => a.id === rows[0].imap_account_id);
if (!acc) { console.error('account not found'); process.exit(1); }

const bx = new BitrixClient({
  bitrix_url: acc.bitrix_url,
  bitrix_webhook_token: acc.bitrix_webhook_token,
  auth_id: acc.auth_id,
  refresh_id: acc.refresh_id,
});

// Multiple-file UF field format: array of [fileName, base64] pairs.
const fileValue = images.map(img => [img.fileName, img.fileData]);

const fields = {};
fields[UF_FIELD] = fileValue;
try {
  const upd = await bx.call('crm.deal.update', { id: DEAL_ID, fields });
  console.log('crm.deal.update result:', JSON.stringify(upd));
} catch (e) {
  console.log('update failed:', e.message);
}

// Read back to confirm
try {
  const deal = await bx.call('crm.deal.get', { id: DEAL_ID });
  console.log(UF_FIELD, '=', JSON.stringify(deal[UF_FIELD]));
} catch (e) {
  console.log('get failed:', e.message);
}
process.exit(0);
