-- 016_fix_status_and_seed_trials.sql
-- 1. Add PLANO_INATIVO to the email_events status CHECK constraint
-- 2. Create trial subscriptions for any active tenant that still has none

ALTER TABLE email_events DROP CONSTRAINT IF EXISTS email_events_status_check;
ALTER TABLE email_events ADD CONSTRAINT email_events_status_check CHECK (status IN (
    'RECEBIDO', 'PROCESSANDO', 'SUCESSO', 'DUPLICADO', 'IGNORADO', 'ERRO', 'FALHA_DEFINITIVA', 'PLANO_INATIVO'
));

-- Seed trial for tenants without a subscription (e.g. portals installed before trial auto-provisioning)
INSERT INTO subscriptions (tenant_id, status, trial_ends_at)
SELECT t.id, 'trial', NOW() + INTERVAL '14 days'
FROM tenants t
WHERE t.active = true
  AND NOT EXISTS (SELECT 1 FROM subscriptions s WHERE s.tenant_id = t.id);
