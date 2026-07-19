// Try several REST payload formats to populate a MULTIPLE file UF field.
import { db } from '../src/db/client.js';
import * as ImapAccountRepo from '../src/db/repos/ImapAccountRepo.js';
import { BitrixClient } from '../src/bitrix/BitrixClient.js';
import { extractDataUriImageFiles } from '../src/imap/EmailParser.js';

const EVENT_ID = process.argv[2];
const DEAL_ID = process.argv[3];
const UF = process.argv[4];

const { rows } = await db.query('SELECT imap_account_id, body_html FROM email_events WHERE id=$1', [EVENT_ID]);
const images = extractDataUriImageFiles(rows[0].body_html);
const img = images[0];
console.log('image:', img.fileName, Math.round(img.fileData.length*0.75/1024)+'KB');

const accounts = await ImapAccountRepo.findAllActive();
const acc = accounts.find(a => a.id === rows[0].imap_account_id);
const bx = new BitrixClient({ bitrix_url: acc.bitrix_url, bitrix_webhook_token: acc.bitrix_webhook_token, auth_id: acc.auth_id, refresh_id: acc.refresh_id });

async function tryFormat(label, value) {
  try {
    const fields = {}; fields[UF] = value;
    const r = await bx.call('crm.deal.update', { id: DEAL_ID, fields });
    const deal = await bx.call('crm.deal.get', { id: DEAL_ID });
    const stored = deal[UF];
    const ok = Array.isArray(stored) ? stored.length > 0 : !!stored;
    console.log(`[${ok ? 'OK ' : 'FAIL'}] ${label} -> update=${JSON.stringify(r)} stored=${JSON.stringify(stored).substring(0,120)}`);
    return ok;
  } catch (e) {
    console.log(`[ERR ] ${label} -> ${e.message}`);
    return false;
  }
}

// Reset first
await tryFormat('reset-empty', '');

if (await tryFormat('A: [[name,b64]]', [[img.fileName, img.fileData]])) process.exit(0);
if (await tryFormat('B: [{fileData:[name,b64]}]', [{ fileData: [img.fileName, img.fileData] }])) process.exit(0);
if (await tryFormat('C: {fileData:[name,b64]}', { fileData: [img.fileName, img.fileData] })) process.exit(0);
if (await tryFormat('D: [name,b64] (flat)', [img.fileName, img.fileData])) process.exit(0);

console.log('All formats failed.');
process.exit(0);
