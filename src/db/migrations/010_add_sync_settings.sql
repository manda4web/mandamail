-- 010_add_sync_settings.sql
-- Add sync settings for deal creation mode and sync start date

ALTER TABLE tenants ADD COLUMN IF NOT EXISTS deal_mode TEXT DEFAULT 'create_new' CHECK (deal_mode IN ('create_new', 'merge_by_contact'));
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS sync_start_date TIMESTAMPTZ DEFAULT NOW();
