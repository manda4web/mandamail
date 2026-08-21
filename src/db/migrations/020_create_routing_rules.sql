-- 020: routing_rules — sender-based routing. When an email arrives from a
-- specific sender (exact address or domain), the matching rule overrides the
-- account mapping for the created deal (pipeline / stage / responsible).
-- Tenant-wide: applies to every IMAP account of the tenant.
--
-- Semantics of the target columns: NULL = do not override (inherit the
-- account mapping); bitrix_category_id 0 IS a legitimate override (Bitrix24
-- default pipeline) — never conflate 0 with NULL on this table.

CREATE TABLE IF NOT EXISTS routing_rules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name TEXT,
    match_type TEXT NOT NULL CHECK (match_type IN ('exact', 'domain')),
    match_value TEXT NOT NULL,              -- normalized: lowercase+trim; domain stored WITHOUT '@'
    bitrix_category_id INTEGER,             -- NULL = keep account mapping; 0 = default pipeline override
    bitrix_stage_id TEXT,                   -- NULL = keep account mapping
    bitrix_responsible_id INTEGER,          -- NULL = keep account mapping
    priority INTEGER NOT NULL DEFAULT 100 CHECK (priority BETWEEN 1 AND 9999),
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT routing_rules_at_least_one_target CHECK (
        bitrix_category_id IS NOT NULL
        OR bitrix_stage_id IS NOT NULL
        OR bitrix_responsible_id IS NOT NULL
    )
);

-- Pipeline lookup: active rules of a tenant, already in application order.
CREATE INDEX IF NOT EXISTS idx_routing_rules_tenant_active
    ON routing_rules (tenant_id, priority, created_at)
    WHERE is_active;

-- No two ACTIVE rules with the same (match_type, match_value) per tenant.
-- Partial (WHERE is_active) so an inactive rule never blocks re-creating
-- or re-activating the same match.
CREATE UNIQUE INDEX IF NOT EXISTS uq_routing_rules_active_match
    ON routing_rules (tenant_id, match_type, match_value)
    WHERE is_active;
