-- 006_create_alert_configs.sql
-- Create alert_configs table

CREATE TABLE IF NOT EXISTS alert_configs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    alert_type TEXT NOT NULL CHECK (alert_type IN ('EMAIL', 'WEBHOOK', 'SLACK')),
    destination TEXT NOT NULL,
    sla_minutes INTEGER NOT NULL DEFAULT 15,
    active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
