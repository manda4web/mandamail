// Inspect a deal UF field definition (type) to learn the correct upload format.
import * as ImapAccountRepo from '../src/db/repos/ImapAccountRepo.js';
import { BitrixClient } from '../src/bitrix/BitrixClient.js';

const ACCOUNT_ID = process.argv[2];
const UF_FIELD = process.argv[3];

const accounts = await ImapAccountRepo.findAllActive();
const acc = accounts.find(a => a.id === ACCOUNT_ID);
if (!acc) { console.error('account not found'); process.exit(1); }

const bx = new BitrixClient({
  bitrix_url: acc.bitrix_url,
  bitrix_webhook_token: acc.bitrix_webhook_token,
  auth_id: acc.auth_id,
  refresh_id: acc.refresh_id,
});

const list = await bx.call('crm.deal.userfield.list', {});
const f = (list || []).find(x => x.FIELD_NAME === UF_FIELD);
if (!f) {
  console.log('Field not found. Available file fields:');
  (list || []).filter(x => x.USER_TYPE_ID === 'file').forEach(x => console.log('  ', x.FIELD_NAME, '| label:', (x.EDIT_FORM_LABEL && (x.EDIT_FORM_LABEL.br || x.EDIT_FORM_LABEL.en)) || x.LIST_COLUMN_LABEL || ''));
} else {
  console.log('FIELD_NAME:', f.FIELD_NAME);
  console.log('USER_TYPE_ID:', f.USER_TYPE_ID);
  console.log('MULTIPLE:', f.MULTIPLE);
  console.log('label:', JSON.stringify(f.EDIT_FORM_LABEL));
}
process.exit(0);
