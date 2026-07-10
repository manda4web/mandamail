// TEST: inject a realistic OLX lead email into the account's folder, already
// marked as \Seen (read), to prove the pipeline picks up READ emails via UID
// tracking and creates the deal in Bitrix. The lead is clearly marked [TESTE].
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

const stamp = Date.now();
const messageId = `<teste-manda-${stamp}@olx.com.br>`;
const dateHeader = new Date().toUTCString();

// Realistic OLX lead body. The parser extracts:
//  - title = the line right before the price
//  - price = R$ ...
//  - Nome / E-mail / Telefone labeled fields
const body = [
  'Ola! Voce tem um novo cliente interessado em um de seus anuncios na OLX.',
  '',
  '[TESTE MANDA] HONDA CIVIC EXL 2.0 FLEXONE 16V 4P AUT. 2019',
  'R$ 98900,00',
  '',
  'Dados do cliente:',
  'Nome: TESTE MANDA Cliente OLX',
  'E-mail: cliente.teste.manda@gmail.com',
  'Telefone: (32) 98888-7777',
  '',
  'Identificador do lead: 11111111-2222-3333-4444-555555555555',
].join('\r\n');

const raw = [
  'From: OLX <noreply@olx.com.br>',
  `To: ${acc.email}`,
  'Subject: Tem cliente interessado em um de seus anuncios!',
  `Message-ID: ${messageId}`,
  `Date: ${dateHeader}`,
  'MIME-Version: 1.0',
  'Content-Type: text/plain; charset=utf-8',
  '',
  body,
].join('\r\n');

const res = await client.append(acc.mailbox, raw, ['\\Seen'], new Date());
console.log('APPEND result:', JSON.stringify(res));
console.log('Injected messageId:', messageId);
console.log('Folder:', acc.mailbox, '| flags: \\Seen (marcado como LIDO)');

await client.logout();
process.exit(0);
