-- 017_stripe_events.sql
-- Track processed Stripe webhook event IDs for idempotency (avoid double-processing
-- on Stripe retries — e.g. inflating coupon usage counts).

CREATE TABLE IF NOT EXISTS processed_stripe_events (
    event_id TEXT PRIMARY KEY,
    type TEXT,
    processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
