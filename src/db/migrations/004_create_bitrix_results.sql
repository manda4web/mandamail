-- 004_create_bitrix_results.sql
-- Create bitrix_results table with indexes

CREATE TABLE IF NOT EXISTS bitrix_results (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email_event_id UUID NOT NULL UNIQUE REFERENCES email_events(id),
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    bitrix_contact_id INTEGER,
    contact_was_created BOOLEAN DEFAULT false,
    bitrix_deal_id INTEGER,
    bitrix_activity_id INTEGER,
    api_log JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index for tenant-based queries
CREATE INDEX idx_results_tenant ON bitrix_results (tenant_id);

-- Partial index for deal lookups (only where deal_id is not null)
CREATE INDEX idx_results_deal ON bitrix_results (bitrix_deal_id) WHERE bitrix_deal_id IS NOT NULL;
