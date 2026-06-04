# Implementation Plan

## Overview

Implementação do mapeamento por conta IMAP — migrar configurações de funil (pipeline, estágio, responsável, field_mapping, deal_mode, sync_start_date) do nível do Tenant para o nível de cada conta IMAP individual, com fallback para o tenant quando a conta não tem configuração própria.

## Tasks

- [ ] 1. Create database migration `src/db/migrations/013_add_account_mapping.sql`
  - Add columns to imap_accounts: bitrix_category_id (INTEGER nullable), bitrix_stage_id (TEXT nullable), bitrix_responsible_id (INTEGER nullable), field_mapping (JSONB nullable), deal_mode (TEXT nullable CHECK IN create_new/merge_by_contact), sync_start_date (TIMESTAMPTZ nullable)
  - All columns default to NULL (conta usa fallback do tenant)
  - Verify migration preserves existing data
  - Requirements: 1.1, 1.2, 1.3

- [ ] 2. Create mapping resolution function `src/pipeline/resolveMapping.js`
  - Implement `resolveMapping(account, tenant)` — returns resolved config using account value when non-null, tenant value when null
  - For field_mapping: default to `{}` if both null; for deal_mode: default to `'create_new'` if both null
  - Implement `resolveMappingWithSources(account, tenant)` — returns `{ effective, sources }` with source metadata ('account'|'tenant')
  - field_mapping resolution is FULL REPLACEMENT (no key-level merge with tenant)
  - Requirements: 2.1, 2.2, 2.3, 7.1, 7.2, 7.3, 7.5, 7.6, 9.1

- [ ] 3. Write property-based tests for mapping resolution `src/__tests__/properties/resolveMapping.prop.test.js`
  - Property 1: For any account/tenant pair with random NULL patterns across 6 fields, resolved value equals account when non-null, tenant when null
  - Property 2: For any two non-null field_mapping objects, resolved equals account's exactly (no merge)
  - Minimum 100 iterations per property using fast-check
  - Tag: Feature: per-account-mapping, Property 1/2
  - Requirements: 2.1, 2.2, 2.3, 7.5

- [ ] 4. Write unit tests for mapping resolution `src/__tests__/unit/resolveMapping.test.js`
  - Test all-null account → tenant values used
  - Test all-non-null account → account values used
  - Test mixed NULL pattern → independent per field
  - Test both null field_mapping → returns {}
  - Test both null category/stage → returns null
  - Requirements: 2.1, 2.2, 2.3, 7.3

- [ ] 5. Update ImapAccountRepo queries with COALESCE fallback
  - Update `findAllActive()`: use COALESCE(ia.col, t.col) for the 6 mapping fields
  - Update `findById()`: same COALESCE pattern
  - Add `updateMapping(id, data)` method for the 6 mapping fields only (handles NULL and JSONB)
  - Add `findRawById(id)` method returning raw account + raw tenant values (no COALESCE)
  - Update `create()` to accept the 6 mapping columns in INSERT
  - Requirements: 8.1, 8.2, 8.3

- [ ] 6. Update account creation to inherit tenant mapping
  - In POST /tenants/:id/imap-accounts: fetch tenant, copy bitrix_category_id, bitrix_stage_id, bitrix_responsible_id, field_mapping, deal_mode, sync_start_date to account creation payload
  - If tenant field is NULL, account field is also NULL
  - Requirements: 3.1, 3.2

- [ ] 7. Add PATCH /tenants/:id/imap-accounts/:accountId/mapping endpoint
  - Require JWT auth + tenant access (requireTenantAccess)
  - Validate schema: only 6 mapping fields allowed, reject additionalProperties
  - Validate deal_mode enum, positive integers for IDs, max 50 chars for stage, max 4096 bytes for field_mapping
  - If body empty → return current account (no update)
  - If account not found or wrong tenant → 404
  - Call ImapAccountRepo.updateMapping, return full account sans password
  - Setting field to null reactivates tenant fallback
  - Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7

- [ ] 8. Add GET /tenants/:id/imap-accounts/:accountId/mapping endpoint
  - Require JWT auth + tenant access
  - Call findRawById + resolveMappingWithSources
  - Return { effective: {...}, sources: {...} }
  - Account not found → 404
  - Requirements: 5.1, 5.2, 5.3

- [ ] 9. Write property-based test for mapping validation `src/__tests__/properties/mappingValidation.prop.test.js`
  - Property 3: For any invalid deal_mode or non-positive integer for IDs, validation rejects with 400
  - Minimum 100 iterations using fast-check
  - Tag: Feature: per-account-mapping, Property 3
  - Requirements: 4.6

- [ ] 10. Write integration tests for PATCH and GET mapping endpoints
  - PATCH: valid update → 200, null field → resets, empty body → no-op, invalid → 400, not found → 404, no auth → 401
  - GET: all overrides → sources "account", all null → sources "tenant", mixed → correct metadata
  - Requirements: 4.1-4.7, 5.1-5.3

- [ ] 11. Add required mapping validation in EmailPipeline
  - Before _processInBitrix: check account.bitrix_category_id and account.bitrix_stage_id are non-null
  - If either null: set event status ERRO, log error, return (don't retry)
  - Verify _processInBitrix already uses account fields (works with COALESCE values from repo)
  - Requirements: 7.4, 7.6

- [ ] 12. Update UI — account selector and per-account mapping in bitrixApp.js
  - Add account selector dropdown at top of Mapeamento de Funil page (format: "label (email)")
  - Auto-select first account on load, fetch GET /mapping for selected account
  - Update save to PATCH per-account endpoint, show success/error toasts
  - Add "Padrão do tenant" badge next to fields with source === "tenant"
  - Add "Restaurar padrão do tenant" button for fields with source === "account" (sets to null on click)
  - Add empty state when no IMAP accounts exist
  - Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7

- [ ] 13. Retrocompatibility verification and final test run
  - Verify accounts with all NULL mapping columns produce identical pipeline behavior to pre-migration
  - Verify existing tenant-level API endpoints (PATCH /tenants/:id) still work
  - Verify tenant mapping updates reflect for accounts with NULL overrides
  - Run full test suite: `npm run test`
  - Requirements: 9.1, 9.2, 9.3

## Task Dependency Graph

```json
[
  [1, 2],
  [3, 4, 5],
  [6, 7, 8, 11],
  [9, 10],
  [12],
  [13]
]
```

## Notes

- A migration 013 é non-destructive (ADD COLUMN IF NOT EXISTS, nullable) — safe para rollback
- O EmailPipeline não precisa de mudanças na lógica core porque as queries COALESCE já resolvem o fallback no SQL
- O field_mapping usa FULL REPLACEMENT (sem deep merge) para simplicidade e previsibilidade
- A UI em bitrixApp.js é um SPA server-rendered; as mudanças são no HTML/JS inline gerado pelo backend
