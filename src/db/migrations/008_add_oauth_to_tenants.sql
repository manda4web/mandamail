-- 008_add_oauth_to_tenants.sql
-- Add OAuth token fields for Bitrix24 Marketplace apps

ALTER TABLE tenants ADD COLUMN IF NOT EXISTS auth_id TEXT;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS refresh_id TEXT;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS auth_expires_at TIMESTAMPTZ;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS server_endpoint TEXT;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS application_token TEXT;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS member_id TEXT;

-- Make bitrix_webhook_token nullable (not needed for OAuth apps)
ALTER TABLE tenants ALTER COLUMN bitrix_webhook_token DROP NOT NULL;
ALTER TABLE tenants ALTER COLUMN bitrix_responsible_id DROP NOT NULL;
