-- 014_add_access_control.sql
-- Add access control columns for per-user permission management

-- Track Bitrix user info on users table
ALTER TABLE users ADD COLUMN IF NOT EXISTS bitrix_user_id TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_bitrix_admin BOOLEAN DEFAULT false;

-- Add access control columns to user_tenants
ALTER TABLE user_tenants ADD COLUMN IF NOT EXISTS is_admin BOOLEAN DEFAULT false;
ALTER TABLE user_tenants ADD COLUMN IF NOT EXISTS granted_by UUID REFERENCES users(id);
ALTER TABLE user_tenants ADD COLUMN IF NOT EXISTS granted_at TIMESTAMPTZ DEFAULT now();

-- Index for looking up users by bitrix_user_id within a tenant context
CREATE INDEX IF NOT EXISTS idx_users_bitrix_user_id ON users(bitrix_user_id);
