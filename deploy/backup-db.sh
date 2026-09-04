#!/bin/bash
# =============================================================
# PostgreSQL backup — run on the Lightsail server (cron or manual)
#
# Dumps the app database from the running `postgres` compose service using
# pg_dump, compresses it, and prunes backups older than the retention window.
#
# SECURITY NOTE:
#   The dump contains IMAP passwords in ENCRYPTED form (AES-256-GCM). The
#   ENCRYPTION_KEY lives ONLY in the .env file and is deliberately NOT part of
#   this backup — a leaked dump alone cannot decrypt the passwords. Keep the
#   key backed up SEPARATELY (e.g. a password manager / secrets vault), never
#   in the same location as these dumps.
# =============================================================

set -euo pipefail

APP_DIR="${APP_DIR:-/opt/mandamail}"
BACKUP_DIR="${BACKUP_DIR:-/opt/mandamail-backups}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
POSTGRES_USER="${POSTGRES_USER:-emailbitrix}"
POSTGRES_DB="${POSTGRES_DB:-emailbitrix}"

cd "$APP_DIR"

# Load POSTGRES_USER/DB overrides from .env if present (matches docker-compose).
if [ -f "$APP_DIR/.env" ]; then
  # shellcheck disable=SC1091
  set -a; . "$APP_DIR/.env"; set +a
fi

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
OUTFILE="$BACKUP_DIR/${POSTGRES_DB}-${TIMESTAMP}.sql.gz"
TMPFILE="${OUTFILE}.partial"

echo "=== PostgreSQL backup ==="
echo "Database: $POSTGRES_DB   User: $POSTGRES_USER"
echo "Target:   $OUTFILE"

# Never leave a half-written .partial behind on failure/interruption.
cleanup() { rm -f "$TMPFILE"; }
trap cleanup EXIT

# Dump into a .partial file first; it only becomes the real backup after the
# pipeline succeeds AND passes the size check. --clean --if-exists lets the
# dump restore onto an existing database. The plaintext dump is gzipped in
# flight so it never lands on disk uncompressed.
#
# `set -e`/`pipefail` would abort the script if pg_dump fails, but the EXIT
# trap still removes the .partial, so a broken dump is never promoted. We
# disable the auto-exit around the pipeline to emit a clearer message.
set +e
docker compose exec -T postgres \
  pg_dump --clean --if-exists --no-owner --no-privileges \
  -U "$POSTGRES_USER" "$POSTGRES_DB" \
  | gzip -9 > "$TMPFILE"
DUMP_STATUS="${PIPESTATUS[0]}"
GZIP_STATUS="${PIPESTATUS[1]}"
set -e

if [ "$DUMP_STATUS" -ne 0 ] || [ "$GZIP_STATUS" -ne 0 ]; then
  echo "ERROR: pg_dump/gzip failed (pg_dump=$DUMP_STATUS gzip=$GZIP_STATUS). No backup written." >&2
  exit 1
fi

# Guard against a "successful" but suspiciously small dump.
MIN_BYTES=1024
ACTUAL_BYTES="$(stat -c%s "$TMPFILE" 2>/dev/null || stat -f%z "$TMPFILE")"
if [ "$ACTUAL_BYTES" -lt "$MIN_BYTES" ]; then
  echo "ERROR: dump is only ${ACTUAL_BYTES} bytes — likely failed. Discarding." >&2
  exit 1
fi

# Promote the validated dump to its final name.
mv "$TMPFILE" "$OUTFILE"
chmod 600 "$OUTFILE"
echo "Backup OK (${ACTUAL_BYTES} bytes)."

# Retention: delete dumps older than RETENTION_DAYS.
echo "Pruning backups older than ${RETENTION_DAYS} days..."
find "$BACKUP_DIR" -name "${POSTGRES_DB}-*.sql.gz" -type f -mtime +"$RETENTION_DAYS" -print -delete || true

echo "=== Backup complete ==="
echo "Kept backups:"
ls -1sh "$BACKUP_DIR"/"${POSTGRES_DB}"-*.sql.gz 2>/dev/null || echo "(none)"
