# Requirements Document

## Introduction

Atualmente, o mapeamento de funil (pipeline, estágio, responsável, mapeamento de campos, modo de criação de deals e data de sincronização) é configurado no nível do TENANT — uma única configuração compartilhada por todas as contas IMAP. Esta feature migra essas configurações para o nível de cada conta IMAP individual, permitindo que diferentes caixas de e-mail dentro do mesmo tenant roteiem e-mails para pipelines, estágios e responsáveis distintos no Bitrix24.

## Glossary

- **Tenant**: Organização cliente que possui uma ou mais contas IMAP e conexão com um portal Bitrix24.
- **IMAP_Account**: Conta de e-mail IMAP individual configurada dentro de um Tenant (ex: balancete@empresa.com.br).
- **Mapping**: Conjunto de configurações que define como e-mails de uma conta são convertidos em negócios no Bitrix24: pipeline, estágio, responsável, mapeamento de campos, modo de deal e data de sync.
- **Pipeline**: Funil de vendas no Bitrix24, identificado por bitrix_category_id.
- **Stage**: Etapa dentro de um Pipeline no Bitrix24, identificado por bitrix_stage_id.
- **Responsible**: Usuário do Bitrix24 designado como responsável pelo negócio criado, identificado por bitrix_responsible_id.
- **Field_Mapping**: Objeto JSON que mapeia campos do e-mail (subject, body, domain, date, preview, source_id) para campos do negócio no Bitrix24.
- **Deal_Mode**: Modo de criação de negócios: "create_new" (sempre cria novo) ou "merge_by_contact" (reutiliza deal existente do contato).
- **Sync_Start_Date**: Data a partir da qual e-mails devem ser processados; e-mails anteriores a esta data são ignorados.
- **EmailPipeline**: Serviço que processa e-mails recebidos e executa a integração com o Bitrix24.
- **Fallback**: Comportamento de usar a configuração do Tenant quando a conta IMAP não possui configuração própria.

## Requirements

### Requirement 1: Migração do Schema do Banco de Dados

**User Story:** As a system administrator, I want the mapping columns added to the imap_accounts table, so that each account can store its own funnel mapping configuration.

#### Acceptance Criteria

1. THE Database_Migration SHALL add the columns bitrix_category_id (INTEGER, nullable), bitrix_stage_id (TEXT, nullable), bitrix_responsible_id (INTEGER, nullable), field_mapping (JSONB, nullable), deal_mode (TEXT, nullable, CHECK IN create_new/merge_by_contact), and sync_start_date (TIMESTAMPTZ, nullable) to the imap_accounts table.
2. THE Database_Migration SHALL preserve all existing data in the imap_accounts table without modification during the migration.
3. THE Database_Migration SHALL set all new columns to NULL by default, indicando que a conta usa a configuração do Tenant (fallback).

### Requirement 2: Fallback para Configuração do Tenant

**User Story:** As a system operator, I want accounts without their own mapping to fall back to the tenant-level configuration, so that existing behavior is preserved and new accounts work without immediate configuration.

#### Acceptance Criteria

1. WHEN the EmailPipeline processes an email from an IMAP_Account with NULL mapping columns, THE EmailPipeline SHALL use the corresponding Tenant-level mapping values.
2. WHEN the EmailPipeline processes an email from an IMAP_Account with non-NULL mapping columns, THE EmailPipeline SHALL use the account-level mapping values instead of the Tenant-level values.
3. THE EmailPipeline SHALL apply the fallback logic independently for each mapping field: bitrix_category_id, bitrix_stage_id, bitrix_responsible_id, field_mapping, deal_mode, and sync_start_date.

### Requirement 3: Herança de Configuração na Criação de Conta

**User Story:** As a tenant administrator, I want newly created IMAP accounts to inherit the current tenant mapping as defaults, so that accounts work correctly without requiring immediate manual configuration.

#### Acceptance Criteria

1. WHEN a new IMAP_Account is created, THE System SHALL copy the current Tenant-level values of bitrix_category_id, bitrix_stage_id, bitrix_responsible_id, field_mapping, deal_mode, and sync_start_date into the corresponding columns of the new IMAP_Account record.
2. WHEN a new IMAP_Account is created and the Tenant has no mapping configured for a specific field, THE System SHALL set the corresponding IMAP_Account column to NULL.

### Requirement 4: API para Atualização de Mapping por Conta

**User Story:** As a tenant administrator, I want an API endpoint to update the funnel mapping of a specific IMAP account, so that the UI can save per-account configurations.

#### Acceptance Criteria

1. THE API SHALL provide a PATCH endpoint at /tenants/:id/imap-accounts/:accountId/mapping that accepts only the fields: bitrix_category_id (integer or null), bitrix_stage_id (text or null, max 50 characters), bitrix_responsible_id (integer or null), field_mapping (JSON object or null, max 4096 bytes), deal_mode (text or null, restricted to "create_new" or "merge_by_contact"), and sync_start_date (ISO 8601 datetime string or null), rejecting any additional properties not in this list.
2. WHEN the PATCH endpoint receives valid mapping data, THE API SHALL update only the provided fields on the specified IMAP_Account record and return the full updated account object (excluding sensitive fields such as password).
3. WHEN the PATCH endpoint receives a field set to null explicitly, THE API SHALL set that field to NULL on the IMAP_Account, reactivating the fallback to Tenant-level configuration for that field.
4. IF the specified IMAP_Account does not exist or does not belong to the tenant identified by :id in the URL, THEN THE API SHALL return HTTP 404 with an error message indicating the account was not found.
5. THE API SHALL require authentication via JWT Bearer token and tenant access verification via user_tenants before processing the mapping update, returning HTTP 401 if the token is missing or invalid, and HTTP 403 if the user lacks access to the specified tenant.
6. IF the PATCH request body contains a deal_mode value other than "create_new" or "merge_by_contact", or a bitrix_category_id/bitrix_responsible_id that is not a positive integer, THEN THE API SHALL return HTTP 400 with an error message indicating the invalid field(s).
7. IF the PATCH request body is empty (no fields provided), THEN THE API SHALL return the current account record without performing any update.

### Requirement 5: API para Leitura de Mapping Efetivo por Conta

**User Story:** As a frontend application, I want to retrieve the effective mapping for a specific IMAP account (with fallback resolution applied), so that the UI can display the currently active configuration.

#### Acceptance Criteria

1. THE API SHALL provide a GET endpoint at /tenants/:id/imap-accounts/:accountId/mapping that returns the effective mapping configuration for the specified account.
2. THE GET endpoint SHALL return each field with the account-level value if non-NULL, or the Tenant-level value as fallback.
3. THE GET endpoint SHALL include a metadata field indicating, for each mapping property, whether the value is "account" (configuração própria) or "tenant" (fallback).

### Requirement 6: Interface de Seleção de Conta no Mapeamento de Funil

**User Story:** As a tenant administrator, I want the "Mapeamento de Funil" UI page to show a selector for which IMAP account to configure, so that I can set different mappings per account.

#### Acceptance Criteria

1. THE UI SHALL display a dropdown selector at the top of the "Mapeamento de Funil" page listing all IMAP accounts of the tenant, where each option displays the account label followed by the email address in parentheses (e.g., "Vendas (vendas@empresa.com.br)").
2. WHEN the "Mapeamento de Funil" page loads, THE UI SHALL automatically select the first IMAP account in the dropdown and load its effective mapping configuration.
3. WHEN the user selects an IMAP_Account from the dropdown, THE UI SHALL load and display the effective mapping configuration for that specific account, showing a loading indicator until the data is retrieved from the GET /tenants/:id/imap-accounts/:accountId/mapping endpoint.
4. WHEN the user saves the mapping configuration, THE UI SHALL send the update to the per-account mapping endpoint for the currently selected account and display a success toast notification upon successful response, or an error toast notification if the request fails.
5. THE UI SHALL visually indicate which fields are using the account's own configuration versus the tenant fallback by displaying a "Padrão do tenant" badge next to each field whose metadata source value is "tenant".
6. THE UI SHALL provide a "Restaurar padrão do tenant" action button next to each individual mapping field that has an account-level override, and WHEN clicked, THE UI SHALL set that specific field to NULL (reactivating the fallback) and save the change immediately.
7. IF the tenant has no IMAP accounts configured, THEN THE UI SHALL display an empty state message directing the user to add an IMAP account before configuring the mapping.

### Requirement 7: Resolução de Mapping no EmailPipeline

**User Story:** As the email processing system, I want to use per-account mapping when available, so that emails from different accounts are routed to the correct pipelines and stages.

#### Acceptance Criteria

1. WHEN building the tenant configuration object for Bitrix integration, THE EmailPipeline SHALL use the IMAP_Account's own bitrix_category_id, bitrix_stage_id, bitrix_responsible_id, field_mapping, deal_mode, and sync_start_date when those columns are non-NULL.
2. WHEN an IMAP_Account mapping column is NULL, THE EmailPipeline SHALL use the corresponding value from the joined Tenant record, applying fallback independently for each of the 6 mapping fields.
3. WHEN both the IMAP_Account column and the corresponding Tenant column are NULL for field_mapping, THE EmailPipeline SHALL use an empty object as the resolved value for that field.
4. IF both the IMAP_Account and Tenant values are NULL for bitrix_category_id or bitrix_stage_id, THEN THE EmailPipeline SHALL skip deal creation, set the email event status to ERRO, and log an error message indicating the missing required mapping configuration.
5. WHEN both the IMAP_Account and the Tenant have non-NULL field_mapping values, THE EmailPipeline SHALL use the IMAP_Account's field_mapping as a full replacement (not a key-level merge with the Tenant's field_mapping).
6. WHEN processing an email, THE EmailPipeline SHALL resolve all 6 mapping fields into a single configuration object before passing it to ContactResolver, DealBuilder, and ActivityWriter.

### Requirement 8: Atualização das Queries do Repositório

**User Story:** As a developer, I want the ImapAccountRepo queries to include the new account-level mapping columns, so that the Pipeline and API have access to the per-account data.

#### Acceptance Criteria

1. THE ImapAccountRepo findAllActive query SHALL include the new columns (bitrix_category_id, bitrix_stage_id, bitrix_responsible_id, field_mapping, deal_mode, sync_start_date) from imap_accounts in the SELECT clause.
2. THE ImapAccountRepo findById query SHALL include the new account-level columns in addition to the existing tenant-level columns.
3. WHEN returning account data, THE ImapAccountRepo SHALL use COALESCE to resolve account-level values with tenant-level fallback for each mapping field.

### Requirement 9: Compatibilidade Retroativa

**User Story:** As an existing user, I want the system to continue working exactly as before if no per-account mapping is configured, so that the migration does not disrupt existing operations.

#### Acceptance Criteria

1. WHILE all IMAP_Account mapping columns remain NULL, THE EmailPipeline SHALL produce identical results to the pre-migration behavior using Tenant-level configuration.
2. THE existing tenant-level mapping API endpoints SHALL continue to function without modification.
3. WHEN the Tenant-level mapping is updated, THE change SHALL be reflected for all accounts that have NULL in their corresponding per-account fields.
