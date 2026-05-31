-- 003_create_email_events.sql
-- Create email_events table with indexes

CREATE TABLE IF NOT EXISTS email_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    imap_account_id UUID NOT NULL REFERENCES imap_accounts(id),
    message_id TEXT,
    from_email TEXT NOT NULL,
    from_name TEXT,
    reply_to TEXT,
    subject TEXT,
    body_html TEXT,
    body_text TEXT,
    to_emails JSONB DEFAULT '[]',
    cc_emails JSONB DEFAULT '[]',
    attachment_count INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'RECEBIDO' CHECK (status IN (
        'RECEBIDO', 'PROCESSANDO', 'SUCESSO', 'DUPLICADO', 'IGNORADO', 'ERRO', 'FALHA_DEFINITIVA'
    )),
    retry_count INTEGER NOT NULL DEFAULT 0,
    received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    processed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index for tenant-based queries
CREATE INDEX idx_events_tenant ON email_events (tenant_id);

-- Index for account-based queries
CREATE INDEX idx_events_account ON email_events (imap_account_id);

-- Index for status filtering
CREATE INDEX idx_events_status ON email_events (status);

-- Index for ordering by creation date descending
CREATE INDEX idx_events_created ON email_events (created_at DESC);

-- Partial index for message_id dedup (only where message_id is not null)
CREATE INDEX idx_events_msgid ON email_events (imap_account_id, message_id, created_at)
    WHERE message_id IS NOT NULL;

-- Partial index for stuck emails (SLA checks and retry processing)
CREATE INDEX idx_events_stuck ON email_events (tenant_id, status, received_at)
    WHERE status IN ('RECEBIDO', 'PROCESSANDO', 'ERRO');
