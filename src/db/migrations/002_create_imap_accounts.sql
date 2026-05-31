-- 002_create_imap_accounts.sql
-- Create imap_accounts table with indexes

CREATE TABLE IF NOT EXISTS imap_accounts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    label TEXT,
    email TEXT NOT NULL,
    host TEXT NOT NULL,
    port INTEGER NOT NULL DEFAULT 993,
    username TEXT NOT NULL,
    password_enc TEXT NOT NULL,
    use_ssl BOOLEAN NOT NULL DEFAULT true,
    mailbox TEXT NOT NULL DEFAULT 'INBOX',
    poll_mode TEXT NOT NULL DEFAULT 'idle' CHECK (poll_mode IN ('idle', 'poll')),
    poll_interval_sec INTEGER NOT NULL DEFAULT 60 CHECK (poll_interval_sec BETWEEN 30 AND 3600),
    active BOOLEAN NOT NULL DEFAULT true,
    last_poll_at TIMESTAMPTZ,
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(tenant_id, email)
);

CREATE INDEX idx_imap_accounts_tenant ON imap_accounts (tenant_id);
CREATE INDEX idx_imap_accounts_active ON imap_accounts (tenant_id, active) WHERE active = true;
