-- 009_add_field_mapping.sql
-- Add field_mapping JSONB column to tenants table

ALTER TABLE tenants ADD COLUMN IF NOT EXISTS field_mapping JSONB DEFAULT '{}';
