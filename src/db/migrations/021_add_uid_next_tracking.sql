-- 021_add_uid_next_tracking.sql
-- Records the mailbox "top" (uidNext) observed on each poll, so a stuck cursor
-- can be detected purely from the DB (no extra IMAP connection): an account is
-- stuck when it is still polling (last_poll_at recent) but last_uid_next is
-- well ahead of last_seen_uid and it hasn't advanced for a while — i.e. there
-- is mail waiting that never gets processed. A near-empty mailbox
-- (uid_next = last_seen_uid + 1) is NOT flagged, avoiding false positives on
-- low-volume accounts.
ALTER TABLE imap_accounts ADD COLUMN IF NOT EXISTS last_uid_next BIGINT;
