-- 019: processing_started_at — when the event LAST entered PROCESSANDO.
-- Needed by the stale-event recovery: retries with long backoff (30/60min)
-- legitimately run long after created_at, and using created_at as the
-- staleness clock caused false positives (retry attempt 4+ was "recovered"
-- while still running). The clock now restarts on every PROCESSANDO transition.

ALTER TABLE email_events ADD COLUMN IF NOT EXISTS processing_started_at TIMESTAMPTZ;

-- Supporting index for the monthly email-quota count (tenant_id + month)
CREATE INDEX IF NOT EXISTS idx_events_tenant_created
    ON email_events (tenant_id, created_at DESC);

-- Supporting index for the stale-event scan
CREATE INDEX IF NOT EXISTS idx_events_stale_scan
    ON email_events (status, created_at)
    WHERE status IN ('PROCESSANDO', 'RECEBIDO');
