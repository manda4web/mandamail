-- 015_add_parser_type.sql
-- Add parser_type to imap_accounts to support specialized email parsers (e.g. OLX leads).
-- Default 'standard' preserves the existing behavior for all current accounts.

ALTER TABLE imap_accounts ADD COLUMN IF NOT EXISTS parser_type TEXT NOT NULL DEFAULT 'standard'
  CHECK (parser_type IN ('standard', 'olx'));
