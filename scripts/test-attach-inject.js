// TEST: inject a standard email with an inline data:URI image (marked \Seen)
// to verify the body image is uploaded to the configured deal file field.
import { ImapFlow } from 'imapflow';
import * as ImapAccountRepo from '../src/db/repos/ImapAccountRepo.js';

const EMAIL = process.argv[2] || 'informatica@mlimoveis.com.br';
const accounts = await ImapAccountRepo.findAllActive();
const acc = accounts.find(a => a.email === EMAIL);
if (!acc) { console.error('Account not found:', EMAIL); process.exit(1); }

const client = new ImapFlow({
  host: acc.host, port: acc.port, secure: acc.use_ssl,
  auth: { user: acc.username, pass: acc.password }, logger: false,
});
await client.connect();

const stamp = Date.now();
const messageId = `<teste-anexo-${stamp}@mmaiaadvogados.com.br>`;
// 1x1 transparent PNG
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const html = `<html><body><p>Prezados, boa tarde!</p><p>Solicito, por gentileza, a <b>inclusao da sigla AJ</b> na unidade abaixo:</p><p><img src="data:image/png;base64,${png}" alt="tabela" /></p><p>Obrigada. [TESTE ANEXO MANDA]</p></body></html>`;

const raw = [
  'From: Teste Anexo <teste.anexo.manda@mmaiaadvogados.com.br>',
  `To: ${acc.email}`,
  'Subject: [TESTE ANEXO MANDA] Inclusao sigla AJ',
  `Message-ID: ${messageId}`,
  `Date: ${new Date().toUTCString()}`,
  'MIME-Version: 1.0',
  'Content-Type: text/html; charset=utf-8',
  '',
  html,
].join('\r\n');

await client.append(acc.mailbox, raw, ['\\Seen'], new Date());
console.log('Injected (as READ):', messageId, '-> folder', acc.mailbox);
await client.logout();
process.exit(0);
