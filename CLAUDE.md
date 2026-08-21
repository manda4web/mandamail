# CLAUDE.md — Manda Mail (email-bitrix-app)

> Gerado em 2026-08-20 migrando `.kiro/specs/` (Kiro) + mapeamento do código real (118 commits).
> As specs originais ficam em `.kiro/specs/` como referência histórica; **este arquivo descreve o código como ele é**.

## O que é

App multi-tenant Node.js 20 (ES modules puro, sem TS) que monitora caixas IMAP e cria deals/contatos/atividades no Bitrix24. Substituiu um workflow n8n. Modelo: **1 tenant = 1 portal Bitrix24 (`bitrix_url`) com N contas IMAP (limite 50)**. Também é app de marketplace Bitrix24 (iframe com SPA servido pelo backend) com billing via Stripe (trial 14 dias → planos pagos).

## Comandos

```bash
npm start            # node src/index.js (sobe API + workers + migrations)
npm run dev          # node --watch
npm test             # vitest run (só unit/ tem testes reais)
npm run migrate      # node src/db/migrate.js
```

- Deploy: `deploy/deploy.sh` (Lightsail: clone github.com/manda4web/mandamail → docker compose up -d --build). Caddy roda no host via systemd (`deploy/setup-caddy-service.sh`), fora do compose.
- `scripts/` = manutenção/E2E contra sistemas REAIS (DB, IMAP e Bitrix de verdade — injeta e limpa leads de teste). Conferir antes de rodar.

## Stack real

Fastify 5 (+cors origin:true, helmet com CSP/frameguard **off** p/ iframe Bitrix24, rate-limit 200/min/IP) · pg Pool (max 20) · pino · imapflow + mailparser · jsonwebtoken + bcrypt · stripe · nodemailer · Docker (app + postgres:16 + redis:7).

- **Redis é só health-check de startup** (ioredis ping/quit). **BullMQ está no package.json mas NÃO é usado** — retry é tabela `retry_jobs` + setInterval.
- UI do app Bitrix24 é um SPA **embutido em strings** em `src/api/routes/bitrixApp.js` (~3200 linhas: HTML+JS+CSS gerados por template). Não existe `public/` servido.

## Pipeline de email — ordem REAL (`src/pipeline/EmailPipeline.js`)

`ImapListener` chama `EmailPipeline.process(account, parsedMail)`:

0. **Plano** — `SubscriptionRepo.checkAccess`; bloqueado → evento `PLANO_INATIVO` e para. Erro de DB → **fail-open** (não perde lead).
1. **Persiste evento `RECEBIDO` antes de qualquer chamada Bitrix** (regra de ouro: email nunca se perde).
2. **Dedup** — `message_id` (janela 24h) e `subject+from` (janela 2min, case-insensitive), escopo `imap_account_id`; subject+from é pulado para contas `parser_type='olx'`. Extra: `existsByMessageId` (deal já criado → não recria).
3. **Filtros** — listas globais (mailer-daemon, noreply, bitrix24.com, auto-reply) + `ignore_from` (exato CI) / `ignore_subject` (substring CI) do tenant. Pulados para parser olx.
4. `sync_start_date` — emails anteriores ao valor efetivo são ignorados.
5. Valida mapping (category/stage presentes; senão ERRO sem retry).
6. `_processInBitrix`: `OlxParser.applyOlxLead` (se olx: cliente real vira from, título do anúncio vira subject, preço vira dealValue, telefone +55) → **regra de roteamento por remetente** (`RoutingRuleRepo.findActiveByTenant` + `RoutingEngine.matchRoutingRule`, **pós-OLX**, fail-open em erro de DB; primeira regra ativa ordenada por `(priority, created_at)` — match `exact` (email completo CI) ou `domain` (igualdade de domínio, não sufixo) — sobrescreve APENAS os campos preenchidos de category/stage/responsible; regra que troca o funil sem estágio **descarta o estágio da conta** (deal nasce no 1º estágio do funil alvo — `crm.deal.*` ancora no CATEGORY_ID e ignora STAGE_ID estranho); regra aplicada é auditada em `bitrix_results.api_log.routing_rule` (`applied:false`/histórico preservado quando o deal é reusado)) → `ContactResolver` (`crm.duplicate.findbycomm` → 1º resultado; senão `crm.contact.add` com nome = from_name || local-part; completa PHONE se faltar) → `DealBuilder` (`crm.deal.add`; TITLE = subject ≤300; campos mapeados subject/body/domain/date/preview/source_id; `deal_mode='merge_by_contact'` reusa deal aberto do contato; OPPORTUNITY BRL p/ OLX; `crm.deal.contact.add` explícito) → `ActivityWriter` (`crm.activity.add` tipo email + `crm.timeline.comment.add` com headers; imagens data:URI/CID sobem via `disk.storage.uploadfile` e viram URLs no corpo) → **anexos**: com `field_mapping.attachment_field` vão como `fileData` num campo UF file do deal (`crm.deal.get`+`update` preservando arquivos existentes); sem o campo → timeline comments (≤20MB cada).
7. Sucesso → `SUCESSO` + registro em `bitrix_results`. Falha → `ERRO` + `retry_jobs` (≤5 tentativas, backoff **[2,5,15,30,60] min**) → exaurido → `FALHA_DEFINITIVA`.

**Status de `email_events` (8):** `RECEBIDO, PROCESSANDO, SUCESSO, DUPLICADO, IGNORADO, ERRO, FALHA_DEFINITIVA, PLANO_INATIVO`.

## Workers IMAP (`src/imap/`)

- **1 `ImapListener` por conta**, gerenciado pelo `TenantScheduler` (Map accountId→listener). Loop supervisor **não-recursivo 24/7**: reconecta com backoff exponencial 5s×2ⁿ (teto 5min) e **nunca desiste**.
- **Cursor UID, não flag \Seen** (migration 018: `uid_validity` + `last_seen_uid`): email lido no celular/webmail não é perdido. UIDVALIDITY mudou → re-scan de 3 dias (dedup do DB protege contra deals duplicados).
- Marca `\Seen` **só depois** de persistir o evento. Poison message: 3 falhas consecutivas do mesmo UID → skip.
- Modos `idle` (evento `exists` + keep-alive 30s) ou `poll` (`poll_interval_sec` 30–3600).
- `TenantScheduler.startSupervisor` (2min) ressuscita workers mortos e para workers de tenant sem plano.

## Mapping por conta (spec `per-account-mapping` — IMPLEMENTADA)

- 6 colunas em `imap_accounts` (NULL = herda do tenant): `bitrix_category_id, bitrix_stage_id, bitrix_responsible_id, field_mapping, deal_mode, sync_start_date`.
- **Resolução via COALESCE no SQL** (`ImapAccountRepo.findAllActive/findById`) — não existe `resolveMapping.js` (a spec planejava; implementação ficou no SQL). `field_mapping` é **full replacement** (sem merge de chaves) e aceita `attachment_field`.
- `GET .../mapping` → `{effective, sources: account|tenant}`; `PATCH .../mapping` (campo `null` = volta a herdar) **reinicia o worker**. Conta nova herda mapping atual do tenant.

## Regras de roteamento por remetente (`routing_rules`, migration 020 — IMPLEMENTADA)

- **Tenant-wide** (vale para todas as caixas): regra = `match_type` exact|domain + `match_value` (normalizado lowercase/trim, domain sem `@`) + destinos **individualmente opcionais** `bitrix_category_id`/`bitrix_stage_id`/`bitrix_responsible_id` (≥1 obrigatório; **category `0` = forçar pipeline padrão, `NULL` = herdar — semântica distinta em rota/repo/pipeline**).
- **Lidas do DB a cada email** (sem snapshot, sem restart de worker) — vale no próximo email após criar/editar, e cobre listener + retry + reprocess. Erro de DB → fail-open.
- Rotas `GET/POST/PATCH/DELETE /tenants/:id/routing-rules` (`routingRules.js`): 409 por duplicata ativa (com `excludeId` no PATCH; race coberta tratando `23505` do partial unique); SPA página **🧭 Regras** (dropdowns via BX24 SDK; edição faz **PATCH parcial por diff** e injeta option sintética para valor salvo fora da lista — nunca apaga override por falha de carregamento).
- Mudar regra **não re-routa deals existentes** (idempotência reusa o deal).

## Billing (`plans`/`coupons`/`subscriptions`, Stripe)

- Trial 14d criado automaticamente na 1ª instalação (`POST /auth/bitrix`); 1 subscription por tenant (UNIQUE).
- `SubscriptionRepo.checkAccess`: `active` | `trial` (expira lazy) | `past_due` + carência 7d após period_end | `canceled`/`expired`/sem registro → bloqueado.
- Rotas: `POST /stripe/checkout` (sessão + cupom on-the-fly), `POST /stripe/webhook` (assinatura verificada, **idempotente** via `processed_stripe_events`; liga/desliga workers), `POST /stripe/portal`, `POST /stripe/cancel`. Admin: `/admin/plans`, `/admin/coupons`, `/admin/subscriptions` (guard: tenant do portal `manda4.bitrix24.com.br` ou role admin).

## Auth (`src/api/middleware/auth.js`)

- `POST /auth/bitrix` — auto-auth do iframe: valida `BITRIX_APP_TOKEN`, cria tenant (por `bitrix_url`) + trial + usuário (super-admin = `SUPER_ADMIN_EMAIL`; bitrix-admin; 1º usuário = owner), emite JWT **com** `tenant_id/is_admin/is_super_admin`.
- `POST /auth/login` — email/senha, emite JWT com `tenant_id` do primeiro tenant do usuário (`user_tenants` ordenado por `granted_at`) + `is_admin`. Usuário sem tenant → `tenant_id: null`.
- Middleware: `authenticate` (Bearer) → `requireRole('admin')` → `requireTenantAccess` (admin global passa; senão checa `user_tenants`). Rate-limit: 200/min/IP global, `/auth/login` 5/min, `/bitrix/*` e `/auth/bitrix` allowlisted.

## Banco (`src/db/`) — 20 migrations SQL, forward-only

Runner: tabela `_migrations`, cada `.sql` numa transação (`src/db/migrate.js`, single-source — lê o diretório; `src/index.js` só chama `runMigrations()`). Tabelas: `tenants` (OAuth: `auth_id/refresh_id/member_id/application_token/server_endpoint`; webhook_token nullable), `imap_accounts` (mapping por conta, `parser_type` standard|olx, cursor UID; senha AES-256-GCM via `ENCRYPTION_KEY` 64-hex), `email_events` (8 status), `bitrix_results` (1:1 com evento, `api_log` JSONB), `retry_jobs`, `alert_configs`, `users`+`user_tenants` (is_admin por tenant, bitrix_user_id), `plans`, `coupons`, `subscriptions`, `processed_stripe_events`, `routing_rules` (roteamento por remetente; partial unique ativo `(tenant_id, match_type, match_value)`).

Repos (`src/db/repos/`, 9): TenantRepo e ImapAccountRepo exportam funções nomeadas; os demais exportam objeto. `ImapAccountRepo` é o maior (COALESCE, encrypt/decrypt, `updateUidState`).

## Bitrix24 (`src/bitrix/`)

`BitrixClient`: OAuth (`auth_id` como query param em `/rest`) ou webhook legado; retry interno 3×2s para transitórios (429, 5xx, timeout 30s); 4xx propaga direto; auto-refresh de token em 401 (`oauth.bitrix.info`, persiste em tenants). Métodos usados: `crm.duplicate.findbycomm`, `crm.contact.add/get/update`, `crm.deal.add/list/get/update`, `crm.deal.contact.add`, `crm.activity.add`, `crm.timeline.comment.add`, `disk.storage.getforapp/getlist/uploadfile`, `disk.file.get`, `app.info`, `user.*`, `crm.category.list`, `crm.status.list`, `crm.deal.fields`. Consultar `b24-dev-mcp` antes de escrever/chamar qualquer método REST novo.

## Background jobs (`src/jobs/`, `src/alerts/`)

- `RetryWorker` (30s): pega até 50 pendentes, **reconstrói o email do DB sem anexos** e chama `_processInBitrix` direto (pula dedup/filtro/plano).
- `AlertService` (60s, `ALERT_CHECK_INTERVAL_SEC`): eventos presos (RECEBIDO/PROCESSANDO/ERRO) acima do SLA → EMAIL (SMTP)/WEBHOOK/SLACK; dedup por evento:status; 3 tentativas/30s.
- `CleanupWorker` (24h): DELETE eventos >30d (com filhos), `body_html=NULL` >7d.

## Testes

`src/__tests__/unit/` — 23 arquivos, 295 casos (crypto, parser, dedup, filter, **RoutingEngine + regras no pipeline**, BitrixClient + token refresh single-flight, contactResolver, activityWriter, attachmentUploader, retryWorker + recovery, auth, rotas, **idempotência do EmailPipeline**). **`properties/`, `integration/`, `helpers/` estão vazios** (.gitkeep) — `npm run test:props` roda vazio; `fast-check` instalado sem uso. Regra do usuário: teste de regressão vai ONDE o bug foi encontrado (ver skill `ai-regression-patterns`).

## Armadilhas conhecidas (não reintroduzir / considerar em mudanças)

> Corrigidas em 2026-08-20 (batch de fixes com verificação adversarial): idempotência de reprocess/retry (deal duplicado) + persistência incremental de `bitrix_results`, anexos duplicados no reuso (marker `api_log.attachments`), refresh OAuth single-flight por tenant com cache de módulo, `findStale` por `created_at` (não `received_at`), limite 20MB no `attachment_field`, `PLANO_INATIVO` em `VALID_STATUSES`/`FINAL_STATUSES`, shutdown graceful completo + recovery de eventos presos, JWT do `/auth/login` com `tenant_id`, boot sem `STRIPE_SECRET_KEY`, migrations single-source, timeouts SMTP.

1. `existsByMessageId` (anti deal duplicado em re-fetch) só cobre **30 dias** — o `CleanupWorker` apaga eventos >30d; janela de re-scan UID é 3 dias (gap pequeno, aceito).
2. `tokenCache` do `BitrixClient` e o `Map` do `TenantScheduler` são **por processo** — o refresh single-flight e a coordenação de workers só valem para o deploy atual single-instance.
3. `RetryJobRepo.findPending` não tem `FOR UPDATE SKIP LOCKED` — múltiplas instâncias do app no mesmo DB executariam o mesmo job (deploy atual é 1 instância).
4. Compose publica PG/Redis com `expose` (sem `ports`) — os hosts `localhost` do `.env.example` servem para dev com o app fora do compose; dentro da rede do compose usar `postgres`/`redis`.
5. `bullmq` + `ioredis` instalados e sem uso runtime (Redis é só health-check de startup); `npm run test:props` roda vazio (`properties/` só tem `.gitkeep`).
6. `temp_check.js` (raiz) é cópia antiga do JS do painel admin — não é script de check. `chave/` tem PEM de Lightsail (gitignored) — nunca commitar.
7. `scripts/` roda contra sistemas REAIS (DB/IMAP/Bitrix de produção) — conferir cada script antes de executar.

## Estado das specs `.kiro`

| Spec | Status |
|---|---|
| `email-bitrix-app` | Implementada (commit 58f02a7) e muito evoluída — spec descrevia só webhook token; hoje há OAuth, marketplace, Stripe, OLX, UID tracking. Property-based tests (req. 4.5, 19.x) nunca foram escritos. |
| `per-account-mapping` | Implementada (migration 013). Divergência: resolução via COALESCE no SQL, sem `resolveMapping.js` no pipeline. |
| `subscription-plans` | Implementada no backend + pipeline + scheduler + página Plan do SPA (inclui `PLANO_INATIVO`). |
