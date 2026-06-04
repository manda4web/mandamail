-- 012_seed_trial_subscriptions.sql
-- Create trial subscriptions for existing tenants that don't have one yet.
-- This ensures all tenants have a subscription record after the plan verification feature is deployed.

INSERT INTO subscriptions (tenant_id, status, trial_ends_at)
SELECT t.id, 'trial', NOW() + INTERVAL '14 days'
FROM tenants t
WHERE t.active = true
  AND NOT EXISTS (SELECT 1 FROM subscriptions s WHERE s.tenant_id = t.id)
ON CONFLICT (tenant_id) DO NOTHING;
