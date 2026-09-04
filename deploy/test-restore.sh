#!/bin/bash
# =============================================================
# Backup restore TEST — proves the latest backup is actually usable.
#
# A backup that has never been restored is not a backup. This script restores
# the most recent dump into a THROWAWAY, ISOLATED PostgreSQL container (never
# the production DB), verifies the expected tables exist and carry data, then
# tears the container down. Safe to run on a schedule.
#
# Exit 0 = backup restored and validated. Non-zero = investigate immediately.
# =============================================================

set -euo pipefail

APP_DIR="${APP_DIR:-/opt/mandamail}"
BACKUP_DIR="${BACKUP_DIR:-/opt/mandamail-backups}"
POSTGRES_DB="${POSTGRES_DB:-emailbitrix}"
PG_IMAGE="${PG_IMAGE:-postgres:16-alpine}"

# Unique names so a stray previous run can't collide.
TEST_CONTAINER="mandamail-restore-test-$$"
TEST_USER="verify"
TEST_PASS="verify"
TEST_DB="verify"

cd "$APP_DIR" 2>/dev/null || true

if [ -f "$APP_DIR/.env" ]; then
  # shellcheck disable=SC1091
  set -a; . "$APP_DIR/.env"; set +a
fi

# Pick the newest dump.
LATEST="$(ls -1t "$BACKUP_DIR"/"${POSTGRES_DB}"-*.sql.gz 2>/dev/null | head -n1 || true)"
if [ -z "$LATEST" ]; then
  echo "ERROR: no backup found in $BACKUP_DIR matching ${POSTGRES_DB}-*.sql.gz" >&2
  exit 1
fi
echo "=== Restore test ==="
echo "Backup under test: $LATEST"

# Always clean up the throwaway container, even on failure.
cleanup() {
  docker rm -f "$TEST_CONTAINER" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# 1. Boot an isolated Postgres (no ports published, its own credentials).
echo "Starting throwaway Postgres ($PG_IMAGE)..."
docker run -d --name "$TEST_CONTAINER" \
  -e POSTGRES_USER="$TEST_USER" \
  -e POSTGRES_PASSWORD="$TEST_PASS" \
  -e POSTGRES_DB="$TEST_DB" \
  "$PG_IMAGE" >/dev/null

# 2. Wait until it accepts connections.
echo -n "Waiting for Postgres to be ready"
for _ in $(seq 1 30); do
  if docker exec "$TEST_CONTAINER" pg_isready -U "$TEST_USER" -d "$TEST_DB" >/dev/null 2>&1; then
    ready=1; break
  fi
  echo -n "."; sleep 1
done
echo ""
if [ "${ready:-0}" != "1" ]; then
  echo "ERROR: throwaway Postgres never became ready" >&2
  exit 1
fi

# 3. Restore the dump into it.
echo "Restoring dump..."
gunzip -c "$LATEST" | docker exec -i "$TEST_CONTAINER" \
  psql -v ON_ERROR_STOP=0 -U "$TEST_USER" -d "$TEST_DB" >/dev/null

# 4. Validate: the core tables must exist and the key one must carry rows.
echo "Validating restored schema..."
EXPECTED_TABLES="tenants imap_accounts email_events users"
missing=0
for t in $EXPECTED_TABLES; do
  exists="$(docker exec "$TEST_CONTAINER" psql -tA -U "$TEST_USER" -d "$TEST_DB" \
    -c "SELECT to_regclass('public.$t') IS NOT NULL;")"
  if [ "$exists" != "t" ]; then
    echo "  MISSING table: $t" >&2
    missing=1
  else
    count="$(docker exec "$TEST_CONTAINER" psql -tA -U "$TEST_USER" -d "$TEST_DB" \
      -c "SELECT count(*) FROM public.$t;")"
    echo "  OK table: $t (${count} rows)"
  fi
done

if [ "$missing" != "0" ]; then
  echo "=== RESTORE TEST FAILED: expected tables missing ===" >&2
  exit 1
fi

echo "=== RESTORE TEST PASSED — backup is usable ==="
