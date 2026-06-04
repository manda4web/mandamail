-- 013_add_account_mapping.sql
-- Add per-account mapping columns to imap_accounts
ALTER TABLE imap_accounts ADD COLUMN IF NOT EXISTS bitrix_category_id INTEGER;
ALTER TABLE imap_accounts ADD COLUMN IF NOT EXISTS bitrix_stage_id TEXT;
ALTER TABLE imap_accounts ADD COLUMN IF NOT EXISTS bitrix_responsible_id INTEGER;
ALTER TABLE imap_accounts ADD COLUMN IF NOT EXISTS field_mapping JSONB;
ALTER TABLE imap_accounts ADD COLUMN IF NOT EXISTS deal_mode TEXT CHECK (deal_mode IS NULL OR deal_mode IN ('create_new', 'merge_by_contact'));
ALTER TABLE imap_accounts ADD COLUMN IF NOT EXISTS sync_start_date TIMESTAMPTZ;
