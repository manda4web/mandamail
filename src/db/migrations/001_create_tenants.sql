-- 001_create_tenants.sql
-- Create pgcrypto extension and tenants table

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS tenants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    bitrix_url TEXT NOT NULL UNIQUE,
    bitrix_webhook_token TEXT NOT NULL,
    bitrix_responsible_id INTEGER NOT NULL,
    bitrix_category_id INTEGER NOT NULL DEFAULT 9,
    bitrix_stage_id TEXT NOT NULL DEFAULT 'C9:NEW',
    ignore_from TEXT[] DEFAULT '{}',
    ignore_subject TEXT[] DEFAULT '{}',
    plan TEXT DEFAULT 'basic',
    active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
