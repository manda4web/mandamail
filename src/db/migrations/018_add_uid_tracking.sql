-- Track processed messages by IMAP UID instead of relying on the \Seen flag.
-- Relying on \Seen loses emails when the user (or another mail client) reads
-- them before the worker processes them. UID tracking is authoritative and
-- independent of read state.
ALTER TABLE imap_accounts ADD COLUMN IF NOT EXISTS uid_validity BIGINT;
ALTER TABLE imap_accounts ADD COLUMN IF NOT EXISTS last_seen_uid BIGINT;
