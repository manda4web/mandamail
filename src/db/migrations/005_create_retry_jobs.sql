-- 005_create_retry_jobs.sql
-- Create retry_jobs table with indexes

CREATE TABLE IF NOT EXISTS retry_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email_event_id UUID NOT NULL REFERENCES email_events(id),
    attempt_number INTEGER NOT NULL DEFAULT 1,
    error_message TEXT,
    error_stack TEXT,
    scheduled_at TIMESTAMPTZ NOT NULL,
    executed_at TIMESTAMPTZ,
    success BOOLEAN,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index for event-based lookups
CREATE INDEX idx_retry_event ON retry_jobs (email_event_id);

-- Partial index for pending jobs (RetryWorker polling)
CREATE INDEX idx_retry_pending ON retry_jobs (scheduled_at) WHERE success IS NULL;
